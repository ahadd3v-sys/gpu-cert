//! Sustained compute load test — repeated dispatches of the FMA-heavy
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
const ELEMENT_COUNT: u32 = 1 << 20; // 1M floats — large enough to saturate a compute unit, small enough to fit any card's VRAM budget
const ITERATIONS_PER_DISPATCH: u32 = 20_000;

#[repr(C)]
struct PushConstants {
    iterations: u32,
}

/// Runs stress dispatches back to back until `duration` elapses, invoking
/// `on_tick` after every dispatch so the caller can sample GPU telemetry
/// mid-run — that per-tick sampling is what produces the thermal/clock
/// time-series the report is actually judged on, not just a pass/fail.
pub fn run(
    ctx: &VulkanContext,
    duration: Duration,
    mut on_tick: impl FnMut(Duration),
) -> anyhow::Result<u32> {
    let buffer_size = (ELEMENT_COUNT as u64) * 4;
    let data_buffer = GpuBuffer::new(
        ctx,
        buffer_size,
        vk::BufferUsageFlags::STORAGE_BUFFER,
        ctx.device_local_memory_type,
    )?;

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

    let result = (|| -> anyhow::Result<()> {
        while started.elapsed() < duration {
            kernel.dispatch(ctx, &[&data_buffer], push_bytes, workgroups)?;
            dispatch_count += 1;
            on_tick(started.elapsed());
        }
        Ok(())
    })();

    kernel.destroy(ctx);
    data_buffer.destroy(ctx);
    result?;

    Ok(dispatch_count)
}
