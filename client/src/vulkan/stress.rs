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
const ITERATIONS_PER_DISPATCH: u32 = 10_000;

#[repr(C)]
struct PushConstants {
    iterations: u32,
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

    let kernel = ComputeKernel::new(
        ctx,
        STRESS_COMP_SPV,
        1,
        std::mem::size_of::<PushConstants>() as u32,
    )?;

    let workgroups = ELEMENT_COUNT.div_ceil(WORKGROUP_SIZE);
    let push = PushConstants { iterations: ITERATIONS_PER_DISPATCH };
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
            kernel.dispatch(ctx, &[&data_buffer], push_bytes, workgroups)?;
            dispatch_count += 1;
            if !on_tick(started.elapsed()) {
                aborted_for_safety = true;
                break;
            }
        }
        Ok(())
    })();

    kernel.destroy(ctx);
    data_buffer.destroy(ctx);
    result?;

    Ok(StressRunResult { dispatch_count, aborted_for_safety })
}
