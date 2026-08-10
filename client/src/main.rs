mod adl;
mod fingerprint;
mod nvml;
mod report;
mod vulkan;

use std::io::Write;
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

// Console, not a GUI: the trust problem a GUI was meant to solve is now
// handled upstream — you only get this exe by clicking "Test your GPU" on
// the (logged-in) website, so the download itself is the trust signal, not
// this window's appearance. That let the client go back to being a plain
// pipe of println!s instead of carrying eframe/egui.
//
// Because it's a plain console app, double-clicking gpu-cert.exe from
// Explorer runs it attached to a console window that Windows destroys the
// instant the process exits — success or failure. Without an explicit pause,
// any output (including error messages) flashes and vanishes before it can
// be read. `main` stays a thin wrapper around `run` so every exit path
// (early `?` returns, the happy path, and even a panic) goes through
// `pause_before_exit` before the process actually terminates.
fn main() {
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_panic_hook(info);
        pause_before_exit();
    }));

    let result = run();
    if let Err(ref e) = result {
        eprintln!("Error: {e:?}");
    }
    pause_before_exit();

    if result.is_err() {
        std::process::exit(1);
    }
}

fn pause_before_exit() {
    println!("\nPress Enter to close this window...");
    let mut discard = String::new();
    let _ = std::io::stdin().read_line(&mut discard);
}

fn run() -> anyhow::Result<()> {
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
            let sample = sample_from_telemetry(elapsed, &sample_telemetry);
            print_progress(&format!(
                "  {:>3}s  {:>3}\u{b0}C  {:>3}% load  {:>4}W  {:>4}MHz core  {:>4}MHz mem",
                elapsed.as_secs(),
                sample.temperature_c,
                sample.utilization_pct,
                sample.power_draw_mw / 1000,
                sample.graphics_clock_mhz,
                sample.memory_clock_mhz,
            ));
            telemetry_series.push(sample);
        }
    })?;
    println!();
    let stress_report: StressTestReport =
        report::build_stress_report(telemetry_series, dispatch_count, stress_started.elapsed());
    println!("Stress test complete: {} dispatches", stress_report.dispatch_count);

    println!("Running VRAM pattern test ({} min)...", VRAM_TEST_DURATION.as_secs() / 60);
    let vram_result = vulkan::vram_test::run(
        &ctx,
        telemetry.vram_total_bytes,
        VRAM_TEST_FRACTION,
        VRAM_TEST_DURATION,
        |passes_run, total_errors, elapsed| {
            print_progress(&format!(
                "  pass {:>3}   errors {:>3}   {:>3}s",
                passes_run,
                total_errors,
                elapsed.as_secs()
            ));
        },
    )?;
    println!();
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

    open_browser(&response.report_url);

    Ok(())
}

fn print_progress(line: &str) {
    print!("\r{line}                    ");
    let _ = std::io::stdout().flush();
}

/// Opens the report page so the seller lands back on the site to see (and,
/// if logged in, claim) their result — the second half of the
/// site → download → run → back-to-site loop this client is built around.
#[cfg(target_os = "windows")]
fn open_browser(url: &str) {
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
}

#[cfg(not(target_os = "windows"))]
fn open_browser(url: &str) {
    println!("Open {url} in your browser to see the results.");
}
