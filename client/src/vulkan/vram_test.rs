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

/// Runs fill/verify passes against a DEVICE_LOCAL buffer sized to
/// `test_fraction` of total VRAM (never 100%: the driver/OS needs headroom,
/// and Vulkan allocations that eat the whole heap tend to fail outright)
/// until `min_duration` has elapsed, varying the seed each pass so repeated
/// runs don't alias onto the same addresses in the same order. `on_pass` is
/// invoked after every fill+verify pass with the running (passes_run,
/// total_errors, elapsed) so far, mirroring stress::run's on_tick — this is
/// what the GUI polls to show live progress (including a real elapsed/
/// min_duration progress bar, not just a pass counter) during a 10-minute
/// test.
pub fn run(
    ctx: &VulkanContext,
    vram_total_bytes: u64,
    test_fraction: f64,
    min_duration: Duration,
    mut on_pass: impl FnMut(u32, u64, Duration) -> bool,
) -> anyhow::Result<VramTestResult> {
    let element_count = ((vram_total_bytes as f64 * test_fraction) / 4.0) as u32;
    let buffer_size = (element_count as u64) * 4;

    let data_buffer = GpuBuffer::new(
        ctx,
        buffer_size,
        vk::BufferUsageFlags::STORAGE_BUFFER,
        ctx.device_local_memory_type,
    )?;
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

    // A buffer this large needs more workgroups than a single vkCmdDispatch
    // can safely request. Confirmed on real hardware (RX 6600): exceeding
    // VkPhysicalDeviceLimits::maxComputeWorkGroupCount[0] in one dispatch
    // call isn't a clean error or an honest clamp — it silently executes
    // something other than the requested work (the corrupted-looking
    // results this whole diagnostic detour was chasing turned out to be
    // this, not a shader logic bug). Chunk every fill/verify dispatch into
    // calls that each stay within the real limit, using `offset` so each
    // chunk's shader invocations compute the correct absolute index.
    if ctx.max_compute_workgroups_x == 0 {
        anyhow::bail!("driver reports maxComputeWorkGroupCount[0] = 0 — can't dispatch anything");
    }
    let max_elements_per_dispatch = ctx.max_compute_workgroups_x.saturating_mul(WORKGROUP_SIZE);
    println!(
        "  (VRAM test: {} chunk(s) per pass, driver's max dispatch is {} workgroups)",
        element_count.div_ceil(max_elements_per_dispatch.max(1)),
        ctx.max_compute_workgroups_x
    );
    let dispatch_chunks: Vec<(u32, u32)> = {
        let mut chunks = Vec::new();
        let mut offset = 0u32;
        while offset < element_count {
            let chunk_len = (element_count - offset).min(max_elements_per_dispatch);
            chunks.push((offset, chunk_len));
            offset += chunk_len;
        }
        chunks
    };

    let started = Instant::now();
    let mut passes_run = 0u32;
    let mut total_errors = 0u64;
    let mut aborted_for_safety = false;

    let result = (|| -> anyhow::Result<()> {
        while started.elapsed() < min_duration {
            let seed = (started.elapsed().as_nanos() as u32) ^ passes_run.wrapping_mul(0x9E3779B9);

            reset_error_counter(ctx, &error_buffer)?;
            reset_first_mismatch(ctx, &first_mismatch_buffer)?;

            for &(offset, chunk_len) in &dispatch_chunks {
                let fill_push = PushConstants { mode: MODE_FILL, seed, length: element_count, offset };
                kernel.dispatch(
                    ctx,
                    &[&data_buffer, &error_buffer, &first_mismatch_buffer],
                    as_bytes(&fill_push),
                    chunk_len.div_ceil(WORKGROUP_SIZE),
                )?;
            }

            for &(offset, chunk_len) in &dispatch_chunks {
                let verify_push = PushConstants { mode: MODE_VERIFY, seed, length: element_count, offset };
                kernel.dispatch(
                    ctx,
                    &[&data_buffer, &error_buffer, &first_mismatch_buffer],
                    as_bytes(&verify_push),
                    chunk_len.div_ceil(WORKGROUP_SIZE),
                )?;
            }

            let pass_errors = read_error_counter(ctx, &error_buffer)?;
            total_errors += pass_errors as u64;
            passes_run += 1;
            if pass_errors > 0 {
                let [idx, actual, expected] = read_first_mismatch(ctx, &first_mismatch_buffer)?;
                println!(
                    "\n  pass {passes_run}: {pass_errors} error(s), seed=0x{seed:08x}, first at idx={idx} \
                     (of {element_count}) actual=0x{actual:08x} expected=0x{expected:08x} xor=0x{:08x}",
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
    data_buffer.destroy(ctx);
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
