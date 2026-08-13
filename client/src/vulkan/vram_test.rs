//! Active VRAM pattern test — fill DEVICE_LOCAL memory with a deterministic
//! per-address pattern, then verify it, counting mismatches. Ported
//! conceptually from GpuZelenograd/memtest_vulkan (zlib license). This is
//! the only way to catch mining-induced GDDR6/GDDR6X degradation: NVML/ADLX
//! telemetry cannot see it since real ECC isn't exposed on consumer cards
//! (see the research doc). Run for 10+ minutes across multiple passes with
//! varying seeds/offsets for a real signal — a single fill/verify pass
//! mainly catches gross failures, not marginal cells.

use ash::vk;
use std::time::{Duration, Instant};

use super::compute::{ComputeKernel, GpuBuffer};
use super::device::VulkanContext;
use super::VRAM_PATTERN_COMP_SPV;

const MODE_FILL: u32 = 0;
const MODE_VERIFY: u32 = 1;
const WORKGROUP_SIZE: u32 = 256;
const BYTES_PER_ELEMENT: u64 = 4;

/// Ceiling on one segment's buffer, applied on top of (never instead of) the
/// device's own reported limits. 1 GiB is small enough that a card with
/// fragmented VRAM can still place several, and small enough that backing off
/// after a failed allocation loses little coverage.
const SEGMENT_CAP_BYTES: u64 = 1 << 30;

/// Smallest segment worth allocating. Below this the per-dispatch overhead
/// starts to dominate and the halving retry should give up instead.
const MIN_SEGMENT_BYTES: u64 = 64 << 20;

/// Cap on the workgroups in any single vkCmdDispatch. The spec's required
/// minimum for maxComputeWorkGroupCount[0] is 65535 and every real driver
/// reports far more, so this is not about the limit: it keeps one dispatch
/// short enough (~67 MB of traffic, a few ms) that Windows' TDR watchdog,
/// which resets the GPU after ~2s without a response, never fires mid-test.
const DISPATCH_CHUNK_WORKGROUPS: u32 = 65_535;

#[repr(C)]
struct PushConstants {
    mode: u32,
    seed: u32,
    length: u32,
    offset: u32,
}

pub struct VramTestResult {
    pub passes_run: u32,
    pub total_errors: u64,
    pub bytes_tested: u64,
    pub duration: Duration,
    /// True if `on_pass`'s temperature watchdog tripped and the loop
    /// stopped before `min_duration` elapsed — see safety.rs.
    pub aborted_for_safety: bool,
}

/// One slice of the tested VRAM. The region under test is deliberately split
/// across several buffers rather than allocated as one: a storage buffer's
/// bindable range is capped at `maxStorageBufferRange` (a `uint32_t`, so
/// never more than 4 GiB-1 on any device ever), and a single allocation is
/// capped at `maxMemoryAllocationSize` — 3.5 GiB on an RX 6600 with 8 GiB of
/// VRAM. Neither limit reports a clean failure when exceeded; the range
/// simply truncates and everything past it silently reads back as zero.
struct Segment {
    buffer: GpuBuffer,
    element_count: u32,
}

/// Runs fill/verify passes across DEVICE_LOCAL memory totalling roughly
/// `test_fraction` of VRAM (never 100%: the driver/OS needs headroom, and
/// allocations that eat the whole heap tend to fail outright) until
/// `min_duration` has elapsed, varying the seed each pass so repeated runs
/// don't alias onto the same addresses in the same order. `on_pass` is
/// invoked after every fill+verify pass with the running (passes_run,
/// total_errors, elapsed) so far, mirroring stress::run's on_tick — this is
/// what drives the live progress line during a 10-minute test.
///
/// Every segment is filled before any segment is verified, rather than
/// fill/verify per segment. Verifying a segment straight after writing it
/// invites a read that never leaves cache, which is exactly the false pass
/// this test exists to rule out.
pub fn run(
    ctx: &VulkanContext,
    vram_total_bytes: u64,
    test_fraction: f64,
    min_duration: Duration,
    mut on_pass: impl FnMut(u32, u64, Duration) -> bool,
) -> anyhow::Result<VramTestResult> {
    let segments = allocate_segments(ctx, vram_total_bytes, test_fraction)?;
    let buffer_size: u64 = segments.iter().map(|s| s.buffer.size).sum();
    let element_count: u64 = segments.iter().map(|s| s.element_count as u64).sum();

    let error_buffer = GpuBuffer::new(
        ctx,
        4,
        vk::BufferUsageFlags::STORAGE_BUFFER,
        ctx.host_visible_memory_type,
    )?;
    // Diagnostic-only (idx, actual, expected) for the first mismatch a pass
    // finds — see the shader for why this is worth the extra buffer.
    let first_mismatch_buffer = GpuBuffer::new(
        ctx,
        12,
        vk::BufferUsageFlags::STORAGE_BUFFER,
        ctx.host_visible_memory_type,
    )?;

    let kernel = ComputeKernel::new(
        ctx,
        VRAM_PATTERN_COMP_SPV,
        3,
        std::mem::size_of::<PushConstants>() as u32,
    )?;

    if ctx.max_compute_workgroups_x == 0 {
        anyhow::bail!("driver reports maxComputeWorkGroupCount[0] = 0 — can't dispatch anything");
    }
    let max_workgroups_per_dispatch = ctx.max_compute_workgroups_x.min(DISPATCH_CHUNK_WORKGROUPS);
    let max_elements_per_dispatch = max_workgroups_per_dispatch.saturating_mul(WORKGROUP_SIZE);
    println!(
        "  (VRAM test: {} MB across {} segment(s), max {} MB per segment; \
         device limits: maxStorageBufferRange {} MB, maxMemoryAllocationSize {} MB)",
        buffer_size / 1_048_576,
        segments.len(),
        segments.iter().map(|s| s.buffer.size).max().unwrap_or(0) / 1_048_576,
        ctx.max_storage_buffer_range as u64 / 1_048_576,
        ctx.max_memory_allocation_size / 1_048_576,
    );

    let started = Instant::now();
    let mut passes_run = 0u32;
    let mut total_errors = 0u64;
    let mut aborted_for_safety = false;

    let result = (|| -> anyhow::Result<()> {
        // Issues however many dispatches one segment needs, each staying
        // within `max_elements_per_dispatch`. `offset` is the element index
        // inside this segment's own buffer, so the shader indexes from zero
        // per segment and never needs an index wider than the buffer it is
        // bound to — which is what keeps this correct on a 48 GB card, where
        // a single global element index would overflow the u32 the shader
        // uses.
        let dispatch_segment = |mode: u32, seg: &Segment, seg_seed: u32| -> anyhow::Result<()> {
            let mut offset = 0u32;
            while offset < seg.element_count {
                let chunk_len = (seg.element_count - offset).min(max_elements_per_dispatch);
                let push =
                    PushConstants { mode, seed: seg_seed, length: seg.element_count, offset };
                kernel.dispatch(
                    ctx,
                    &[&seg.buffer, &error_buffer, &first_mismatch_buffer],
                    as_bytes(&push),
                    chunk_len.div_ceil(WORKGROUP_SIZE),
                )?;
                offset += chunk_len;
            }
            Ok(())
        };

        while started.elapsed() < min_duration {
            let seed = (started.elapsed().as_nanos() as u32) ^ passes_run.wrapping_mul(0x9E3779B9);
            let mut pass_errors = 0u64;
            let mut first_failure: Option<(usize, [u32; 3])> = None;

            for (i, seg) in segments.iter().enumerate() {
                dispatch_segment(MODE_FILL, seg, segment_seed(seed, i))?;
            }

            // Only after every segment is written, so a verify can't be
            // served out of cache from a fill that just happened.
            for (i, seg) in segments.iter().enumerate() {
                // Reset per segment, not per pass: the counter is a u32, and
                // a fully failing 48 GB card would overflow one if it had to
                // hold the whole pass. Per segment it is bounded by the
                // segment's own element count, and the u64 running total
                // below is what accumulates across them.
                reset_error_counter(ctx, &error_buffer)?;
                reset_first_mismatch(ctx, &first_mismatch_buffer)?;

                dispatch_segment(MODE_VERIFY, seg, segment_seed(seed, i))?;

                let segment_errors = read_error_counter(ctx, &error_buffer)?;
                if segment_errors > 0 {
                    pass_errors += segment_errors as u64;
                    if first_failure.is_none() {
                        first_failure = Some((i, read_first_mismatch(ctx, &first_mismatch_buffer)?));
                    }
                }
            }

            total_errors += pass_errors;
            passes_run += 1;
            if let Some((seg_index, [idx, actual, expected])) = first_failure {
                println!(
                    "\n  pass {passes_run}: {pass_errors} error(s) across {element_count} elements, \
                     seed=0x{seed:08x}, first in segment {seg_index} at idx={idx} \
                     actual=0x{actual:08x} expected=0x{expected:08x} xor=0x{:08x}",
                    actual ^ expected
                );
            }
            if !on_pass(passes_run, total_errors, started.elapsed()) {
                aborted_for_safety = true;
                break;
            }
        }
        Ok(())
    })();

    kernel.destroy(ctx);
    for seg in &segments {
        seg.buffer.destroy(ctx);
    }
    error_buffer.destroy(ctx);
    first_mismatch_buffer.destroy(ctx);

    result?;

    Ok(VramTestResult {
        passes_run,
        total_errors,
        bytes_tested: buffer_size,
        duration: started.elapsed(),
        aborted_for_safety,
    })
}

/// Gives every segment its own pattern, so two segments are never holding
/// identical bytes at the same moment. Without this, an address-line fault
/// that aliases one segment's memory onto another's could read back the
/// value it expected and score as a pass.
fn segment_seed(pass_seed: u32, segment_index: usize) -> u32 {
    pass_seed ^ (segment_index as u32).wrapping_mul(0x9E37_79B9)
}

/// Carves the target region into as many device-local buffers as it takes,
/// each sized within every limit that actually applies:
///
/// - `maxStorageBufferRange`, because a descriptor's range is a `uint32_t`
///   and a larger binding silently truncates instead of failing,
/// - `maxMemoryAllocationSize`, the per-allocation ceiling, which on an
///   RX 6600 is 3.5 GiB against 8 GiB of VRAM,
/// - the device-local heap's own size, and
/// - `SEGMENT_CAP_BYTES`.
///
/// Allocation failure is expected, not exceptional: how much VRAM is free
/// depends on what else is running (a compositor, a browser, another game),
/// and no reported number accounts for that. So a failure halves the request
/// and retries, and once it can't place even `MIN_SEGMENT_BYTES` the test
/// proceeds with whatever it did get. Testing 60% of a card is a useful
/// result; refusing to run because 85% wasn't available is not.
fn allocate_segments(
    ctx: &VulkanContext,
    vram_total_bytes: u64,
    test_fraction: f64,
) -> anyhow::Result<Vec<Segment>> {
    // The heap size is what Vulkan will actually hand out; the vendor
    // telemetry's total counts memory it won't. Trust the smaller.
    let reported_target = (vram_total_bytes as f64 * test_fraction) as u64;
    let heap_target = (ctx.device_local_heap_size as f64 * test_fraction) as u64;
    let target = reported_target.min(heap_target);

    // Whole workgroups only, so no dispatch has a partially-covered tail.
    let bytes_per_workgroup = WORKGROUP_SIZE as u64 * BYTES_PER_ELEMENT;
    let align_down = |n: u64| n - (n % bytes_per_workgroup);

    let segment_cap = align_down(
        SEGMENT_CAP_BYTES
            .min(ctx.max_storage_buffer_range as u64)
            .min(ctx.max_memory_allocation_size)
            .min(ctx.device_local_heap_size),
    );
    if segment_cap == 0 {
        anyhow::bail!(
            "this device can't host a usable test buffer (maxStorageBufferRange {}, \
             maxMemoryAllocationSize {}, device-local heap {})",
            ctx.max_storage_buffer_range,
            ctx.max_memory_allocation_size,
            ctx.device_local_heap_size
        );
    }

    let mut segments: Vec<Segment> = Vec::new();
    let mut allocated = 0u64;
    while allocated < target {
        let mut want = align_down((target - allocated).min(segment_cap));
        if want == 0 {
            break;
        }
        loop {
            match GpuBuffer::new(
                ctx,
                want,
                vk::BufferUsageFlags::STORAGE_BUFFER,
                ctx.device_local_memory_type,
            ) {
                Ok(buffer) => {
                    allocated += want;
                    segments.push(Segment {
                        element_count: (want / BYTES_PER_ELEMENT) as u32,
                        buffer,
                    });
                    break;
                }
                Err(_) if want / 2 >= MIN_SEGMENT_BYTES => {
                    want = align_down(want / 2);
                }
                Err(_) => {
                    // Out of room. Test what we have.
                    return finish_segments(segments);
                }
            }
        }
    }

    finish_segments(segments)
}

fn finish_segments(segments: Vec<Segment>) -> anyhow::Result<Vec<Segment>> {
    if segments.is_empty() {
        anyhow::bail!(
            "couldn't allocate any device-local memory to test — close other GPU applications and \
             try again"
        );
    }
    Ok(segments)
}

fn as_bytes<T>(v: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts((v as *const T) as *const u8, std::mem::size_of::<T>()) }
}

fn reset_error_counter(ctx: &VulkanContext, buf: &GpuBuffer) -> anyhow::Result<()> {
    unsafe {
        let ptr = ctx
            .device
            .map_memory(buf.memory, 0, buf.size, vk::MemoryMapFlags::empty())
            .map_err(|e| anyhow::anyhow!("vkMapMemory failed: {e:?}"))?;
        std::ptr::write(ptr as *mut u32, 0);
        ctx.device.unmap_memory(buf.memory);
    }
    Ok(())
}

fn read_error_counter(ctx: &VulkanContext, buf: &GpuBuffer) -> anyhow::Result<u32> {
    unsafe {
        let ptr = ctx
            .device
            .map_memory(buf.memory, 0, buf.size, vk::MemoryMapFlags::empty())
            .map_err(|e| anyhow::anyhow!("vkMapMemory failed: {e:?}"))?;
        let value = std::ptr::read(ptr as *const u32);
        ctx.device.unmap_memory(buf.memory);
        Ok(value)
    }
}

fn reset_first_mismatch(ctx: &VulkanContext, buf: &GpuBuffer) -> anyhow::Result<()> {
    unsafe {
        let ptr = ctx
            .device
            .map_memory(buf.memory, 0, buf.size, vk::MemoryMapFlags::empty())
            .map_err(|e| anyhow::anyhow!("vkMapMemory failed: {e:?}"))?;
        std::ptr::write_bytes(ptr as *mut u8, 0, buf.size as usize);
        ctx.device.unmap_memory(buf.memory);
    }
    Ok(())
}

fn read_first_mismatch(ctx: &VulkanContext, buf: &GpuBuffer) -> anyhow::Result<[u32; 3]> {
    unsafe {
        let ptr = ctx
            .device
            .map_memory(buf.memory, 0, buf.size, vk::MemoryMapFlags::empty())
            .map_err(|e| anyhow::anyhow!("vkMapMemory failed: {e:?}"))?;
        let values = std::ptr::read(ptr as *const [u32; 3]);
        ctx.device.unmap_memory(buf.memory);
        Ok(values)
    }
}
