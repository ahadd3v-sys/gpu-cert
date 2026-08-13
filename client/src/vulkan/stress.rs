//! Sustained compute load test, repeated dispatches of the FMA-heavy
//! stress kernel to hold every ALU lane busy for `duration`, long enough to
//! expose thermal throttling and power-limit clock drops. Paired with
//! telemetry sampling (caller reads NVML/ADL temp+power+clock in between
//! dispatches) to produce the time-series the backend stores per report.

use ash::vk;
use std::time::{Duration, Instant};

use super::compute::{ComputeKernel, GpuBuffer};
use super::device::VulkanContext;
use super::STRESS_COMP_SPV;

const WORKGROUP_SIZE: u32 = 256;
const ELEMENT_COUNT: u32 = 1 << 20; // 1M floats, large enough to saturate a compute unit, small enough to fit any card's VRAM budget

/// The streaming buffer the kernel walks, deliberately far larger than any
/// cache on any card this will meet.
///
/// The compute buffer above is 4 MiB, which fits in an RTX 3070's 4 MB L2 and
/// well inside an RX 6600's 32 MB Infinity Cache, so the old kernel touched
/// VRAM once and then never again. Board power is core plus memory plus the
/// rest, so a thermal test that skips the memory subsystem cannot approach a
/// card's rated draw however well it feeds the ALUs, and on this product the
/// memory is the part being certified.
///
/// 512 MiB clears the largest consumer Infinity Cache (128 MB) by four times.
/// It is reduced on cards that cannot spare it, and the run is not failed over
/// it: a smaller stream is a weaker load, not a wrong one.
const STREAM_TARGET_BYTES: u64 = 512 << 20;
const STREAM_MIN_BYTES: u64 = 32 << 20;
/// Halved when the kernel gained instruction-level parallelism.
///
/// The work per iteration went from two serial FMAs to sixteen independent
/// ones, so at the old count a single dispatch does roughly eight times the
/// arithmetic. Measured against the RTX 3070's old figures (34 ms a dispatch)
/// that lands near 32 ms, which is fine, but the same arithmetic on a weak
/// card is not: a GT 710 class GPU would sit close to Windows' two second TDR
/// timeout, and tripping that kills the run with a device-lost error rather
/// than a result.
///
/// Halving keeps dispatch length in the range that has already been shown to
/// work on the slowest card tested, and costs nothing: the extra power comes
/// from the parallelism inside each iteration, not from doing more of them per
/// dispatch. Telemetry is time-throttled now, so the extra dispatches do not
/// inflate the report either.
/// Blocks per dispatch, where a block is 128 FMAs plus one streamed load and
/// store.
///
/// Sized so neither half starves the other and neither runs long enough to
/// trouble Windows' two second TDR timeout, which would end a run with a
/// device-lost error instead of a result:
///
///   RTX 3070   ~16 ms of arithmetic, ~22 ms of memory
///   RX 6600    ~36 ms,               ~45 ms
///   GTX 960   ~133 ms,               ~89 ms
///
/// The slowest card tested therefore sits around a fifth of a second, an order
/// of magnitude inside the timeout.
const BLOCKS_PER_DISPATCH: u32 = 1_250;

#[repr(C)]
struct PushConstants {
    blocks: u32,
    /// Elements minus one. A power of two so the kernel wraps with a mask
    /// rather than a modulo, which would be an integer divide in the loop.
    stream_mask: u32,
    /// Total threads, so each block advances the whole grid one stride through
    /// the buffer and the walk stays coalesced.
    stride: u32,
}

pub struct StressRunResult {
    pub dispatch_count: u32,
    /// True if the caller's `on_tick` returned false (its own temperature
    /// watchdog tripped) and the loop stopped before `duration` elapsed
    /// rather than let the card keep taking sustained load.
    pub aborted_for_safety: bool,
}

/// Runs stress dispatches back to back until `duration` elapses, invoking
/// `on_tick` after every dispatch so the caller can sample GPU telemetry
/// mid-run, that per-tick sampling is what produces the thermal/clock
/// time-series the report is actually judged on, not just a pass/fail.
/// `on_tick` returns whether to keep going: the caller's safety watchdog
/// (see `safety.rs`) can return `false` to abort the run early.
pub fn run(
    ctx: &VulkanContext,
    duration: Duration,
    mut on_tick: impl FnMut(Duration) -> bool,
) -> anyhow::Result<StressRunResult> {
    let buffer_size = (ELEMENT_COUNT as u64) * 4;
    let data_buffer =
        GpuBuffer::device_local(ctx, buffer_size, vk::BufferUsageFlags::STORAGE_BUFFER)?;

    let (stream_buffer, stream_bytes) = allocate_stream(ctx)?;
    crate::diag::record(format!(
        "stress: {} MB compute buffer, {} MB streaming buffer, {BLOCKS_PER_DISPATCH} blocks/dispatch",
        buffer_size / 1_048_576,
        stream_bytes / 1_048_576,
    ));

    let kernel = ComputeKernel::new(
        ctx,
        STRESS_COMP_SPV,
        2,
        std::mem::size_of::<PushConstants>() as u32,
    )?;

    let workgroups = ELEMENT_COUNT.div_ceil(WORKGROUP_SIZE);
    let push = PushConstants {
        blocks: BLOCKS_PER_DISPATCH,
        stream_mask: ((stream_bytes / 4) - 1) as u32,
        stride: ELEMENT_COUNT,
    };
    let push_bytes = unsafe {
        std::slice::from_raw_parts(
            (&push as *const PushConstants) as *const u8,
            std::mem::size_of::<PushConstants>(),
        )
    };

    let started = Instant::now();
    let mut dispatch_count = 0u32;
    let mut aborted_for_safety = false;

    let result = (|| -> anyhow::Result<()> {
        while started.elapsed() < duration {
            kernel.dispatch(ctx, &[&data_buffer, &stream_buffer], push_bytes, workgroups)?;
            dispatch_count += 1;
            if !on_tick(started.elapsed()) {
                aborted_for_safety = true;
                break;
            }
        }
        Ok(())
    })();

    kernel.destroy(ctx);
    stream_buffer.destroy(ctx);
    data_buffer.destroy(ctx);
    result?;

    Ok(StressRunResult { dispatch_count, aborted_for_safety })
}

/// Takes the largest streaming buffer the card will actually give, halving on
/// refusal rather than failing the run.
///
/// The size below is an estimate, and on a driver without VK_EXT_memory_budget
/// it is an estimate against the total heap rather than free memory, because
/// that is all there is to go on. So it can ask for more than the card can
/// spare, and until this existed that refusal killed the whole run before a
/// single test had executed. The stress test needed 4 MiB before v0.6.0 and
/// now wants up to 512 MiB, so the failure mode is new and entirely
/// self-inflicted.
///
/// A smaller stream is a weaker load, not a wrong one, which is exactly the
/// trade to make here: a run that tests the card slightly less hard beats no
/// run at all. If even the floor is refused, that is a real problem and the
/// error stands.
fn allocate_stream(ctx: &VulkanContext) -> anyhow::Result<(GpuBuffer, u64)> {
    let mut size = stream_buffer_bytes(ctx);
    loop {
        match GpuBuffer::device_local(ctx, size, vk::BufferUsageFlags::STORAGE_BUFFER) {
            Ok(buffer) => return Ok((buffer, size)),
            Err(e) if size > STREAM_MIN_BYTES => {
                crate::diag::record(format!(
                    "stress: {} MB streaming buffer refused ({e}), halving",
                    size / 1_048_576
                ));
                size /= 2;
            }
            Err(e) => {
                return Err(e.context(format!(
                    "could not allocate even a {} MB streaming buffer for the stress test",
                    STREAM_MIN_BYTES / 1_048_576
                )))
            }
        }
    }
}

/// Largest power-of-two streaming buffer this card can comfortably spare.
///
/// A power of two because the kernel wraps its offset with a mask. Capped
/// against what the driver says is free rather than against the heap, since
/// the heap is not the constraint on a machine with a browser open, and capped
/// again by maxMemoryAllocationSize because a single allocation is bounded
/// separately from the heap.
fn stream_buffer_bytes(ctx: &VulkanContext) -> u64 {
    let spare = ctx
        .available_device_local_bytes()
        .unwrap_or(ctx.device_local_heap_size)
        // A quarter, so the stress test never competes with whatever else the
        // machine is doing, and never becomes the reason a run cannot start.
        / 4;

    let ceiling = STREAM_TARGET_BYTES
        .min(spare)
        .min(ctx.max_memory_allocation_size)
        // maxStorageBufferRange is a uint32, so a single descriptor can never
        // cover more than 4 GiB anyway. Far above the target, but stated so
        // the reason is not rediscovered later.
        .min(ctx.max_storage_buffer_range as u64);

    let rounded = if ceiling < STREAM_MIN_BYTES {
        STREAM_MIN_BYTES
    } else {
        // Largest power of two at or below the ceiling.
        1u64 << (63 - ceiling.leading_zeros().min(63))
    };
    rounded.max(STREAM_MIN_BYTES)
}

#[cfg(test)]
mod tests {
    /// The kernel wraps its offset with a mask, so a non-power-of-two size
    /// would silently read and write outside the buffer it was told about.
    #[test]
    fn stream_size_is_always_a_power_of_two() {
        for ceiling in [
            32u64 << 20,
            100 << 20,
            511 << 20,
            512 << 20,
            3_000 << 20,
            u64::MAX / 2,
        ] {
            let rounded = 1u64 << (63 - ceiling.leading_zeros().min(63));
            assert!(rounded.is_power_of_two(), "{ceiling} rounded to {rounded}");
            assert!(rounded <= ceiling, "{rounded} exceeds its ceiling {ceiling}");
        }
    }

    /// Halving must terminate at the floor rather than running to zero, which
    /// would make the mask 0xFFFFFFFF and send every access out of bounds.
    #[test]
    fn halving_stops_at_the_floor() {
        let mut size = super::STREAM_TARGET_BYTES;
        let mut steps = 0;
        while size > super::STREAM_MIN_BYTES {
            size /= 2;
            steps += 1;
            assert!(steps < 64, "halving did not converge");
        }
        assert_eq!(size, super::STREAM_MIN_BYTES);
        assert!(size.is_power_of_two());
    }

    /// A card with almost nothing free must still get a usable buffer rather
    /// than a zero-sized one, which would make the mask 0xFFFFFFFF and send
    /// every access out of bounds.
    #[test]
    fn a_starved_card_still_gets_a_floor() {
        let ceiling = 1u64 << 20; // 1 MiB spare
        let rounded = if ceiling < super::STREAM_MIN_BYTES {
            super::STREAM_MIN_BYTES
        } else {
            1u64 << (63 - ceiling.leading_zeros().min(63))
        };
        assert_eq!(rounded, super::STREAM_MIN_BYTES);
        assert!(((rounded / 4) - 1) as u32 > 0);
    }
}
