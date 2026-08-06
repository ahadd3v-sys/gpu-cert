mod adl;
mod fingerprint;
mod nvml;
mod report;
mod vulkan;

use std::time::{Duration, Instant};

use fingerprint::Fingerprint;
use report::{sample_from_telemetry, CertifyRequest, StressTestReport, VramTestReport};
use vulkan::VulkanContext;

// Phase 1 durations. Not tunable via CLI yet — exposing knobs like this to
// end users (vs. keeping the test fixed-length for report comparability) is
// a product decision, not a stack one; deferred until Ahad weighs in.
const STRESS_TEST_DURATION: Duration = Duration::from_secs(5 * 60);
const VRAM_TEST_DURATION: Duration = Duration::from_secs(10 * 60);
const VRAM_TEST_FRACTION: f64 = 0.85;

fn main() -> anyhow::Result<()> {
    println!("gpu-cert v{} — hardware verification client", env!("CARGO_PKG_VERSION"));

    let nvml = nvml::Nvml::load().map_err(|e| {
        anyhow::anyhow!(
            "no supported GPU found (NVML load failed: {e}). AMD support via ADL is scaffolded \
             but not wired in yet — see src/adl.rs."
        )
    })?;
    let telemetry = nvml.read_primary_gpu()?;
    println!("Detected GPU: {} (VRAM: {} MB)", telemetry.name, telemetry.vram_total_bytes / 1_048_576);

    let fingerprint = Fingerprint::from_telemetry(&telemetry);
    println!("Fingerprint: {}", fingerprint.hash);

    let ctx = VulkanContext::new()?;
    println!("Vulkan device: {}", ctx.device_name);

    println!("Running stress test ({} min)...", STRESS_TEST_DURATION.as_secs() / 60);
    let mut telemetry_series = Vec::new();
    let stress_started = Instant::now();
    let dispatch_count = vulkan::stress::run(&ctx, STRESS_TEST_DURATION, |elapsed| {
        // Re-sampling telemetry every tick is deliberately cheap (a few
        // NVML calls) relative to the dispatch itself, so it doesn't skew
        // the load being measured.
        if let Ok(sample_telemetry) = nvml.read_primary_gpu() {
            telemetry_series.push(sample_from_telemetry(elapsed, &sample_telemetry));
        }
    })?;
    let stress_report: StressTestReport =
        report::build_stress_report(telemetry_series, dispatch_count, stress_started.elapsed());
    println!("Stress test complete: {} dispatches", stress_report.dispatch_count);

    println!("Running VRAM pattern test ({} min)...", VRAM_TEST_DURATION.as_secs() / 60);
    let vram_result = vulkan::vram_test::run(
        &ctx,
        telemetry.vram_total_bytes,
        VRAM_TEST_FRACTION,
        VRAM_TEST_DURATION,
    )?;
    let vram_report = VramTestReport::from_result(&vram_result);
    println!(
        "VRAM test complete: {} passes, {} errors across {} MB tested",
        vram_report.passes_run,
        vram_report.total_errors,
        vram_report.bytes_tested / 1_048_576
    );

    let request = CertifyRequest {
        client_version: env!("CARGO_PKG_VERSION"),
        fingerprint,
        device_name: telemetry.name.clone(),
        stress_test: stress_report,
        vram_test: vram_report,
    };

    println!("Submitting report...");
    let response = report::submit(&request)?;
    println!("Done. Report: {}", response.report_url);
    println!("Badge: {}", response.badge_url);

    Ok(())
}
