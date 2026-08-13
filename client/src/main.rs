mod account;
mod adl;
mod fingerprint;
mod nvml;
mod report;
mod safety;
mod vulkan;

use std::io::Write;
use std::time::{Duration, Instant};

use fingerprint::Fingerprint;
use nvml::GpuTelemetry;
use report::{sample_from_telemetry, CertifyRequest, FurTestReport, StressTestReport, VramTestReport};
use vulkan::VulkanContext;

/// Unifies the NVML and ADL backends behind one `read_primary_gpu` so the
/// rest of `run()` — three test loops that each re-sample telemetry every
/// tick — doesn't need to know which vendor's card it's running against.
enum GpuBackend {
    Nvml(nvml::Nvml),
    #[cfg(target_os = "windows")]
    Adl(adl::Adl),
}

impl GpuBackend {
    fn read_primary_gpu(&self) -> anyhow::Result<GpuTelemetry> {
        match self {
            GpuBackend::Nvml(n) => n.read_primary_gpu(),
            #[cfg(target_os = "windows")]
            GpuBackend::Adl(a) => a.read_primary_gpu(),
        }
    }
}

/// Tries NVIDIA first, then AMD — not a preference ranking, just an order.
/// A machine only has one or the other in practice, so whichever loads
/// first is used and the other is never touched.
fn load_gpu_backend() -> anyhow::Result<GpuBackend> {
    let nvml_err = match nvml::Nvml::load() {
        Ok(n) => return Ok(GpuBackend::Nvml(n)),
        Err(e) => e,
    };

    #[cfg(target_os = "windows")]
    {
        match adl::Adl::load() {
            Ok(a) => return Ok(GpuBackend::Adl(a)),
            Err(adl_err) => {
                return Err(anyhow::anyhow!(
                    "no supported GPU found.\n  NVIDIA (NVML): {nvml_err}\n  AMD (ADL): {adl_err}"
                ));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow::anyhow!("no supported GPU found (NVML load failed: {nvml_err}). AMD support is Windows-only."))
    }
}

// Phase 1 durations. Not tunable via CLI for end users (vs. keeping the
// test fixed-length for report comparability) — that's a product decision,
// not a stack one, deferred until Ahad weighs in. `--fast` below is a
// developer-only escape hatch for iterating on the client itself, not a
// public option; the website's download always runs the real durations.
const STRESS_TEST_DURATION: Duration = Duration::from_secs(5 * 60);
const VRAM_TEST_DURATION: Duration = Duration::from_secs(10 * 60);
const VRAM_TEST_FRACTION: f64 = 0.85;
// Short relative to the other two: this is a correctness/display-output
// check exercised under load, not a thermal soak — that's already covered
// by the 5-minute compute stress test above.
const FUR_TEST_DURATION: Duration = Duration::from_secs(45);

// Undocumented, developer-only: `gpu-cert.exe --fast` runs all three tests
// at durations short enough for a tight edit-rebuild-rerun loop while
// debugging the client itself — long enough to still exercise multiple VRAM
// passes and a real stress-telemetry series, short enough not to burn 16
// minutes per iteration. Never advertised, never what the website's
// download runs — a certificate produced this way isn't a real one.
const FAST_STRESS_TEST_DURATION: Duration = Duration::from_secs(20);
const FAST_VRAM_TEST_DURATION: Duration = Duration::from_secs(20);
const FAST_FUR_TEST_DURATION: Duration = Duration::from_secs(10);

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

    if std::env::args().any(|a| a == "--forget-account") {
        account::forget()?;
        println!("Account disconnected. Future runs will file anonymously.");
        return Ok(());
    }

    // Files a report from a previous run whose submission couldn't get
    // through. The results are already on disk, so this takes seconds
    // rather than re-running ~16 minutes of load against the card.
    if std::env::args().any(|a| a == "--resubmit") {
        match report::resubmit(account::load().as_deref())? {
            Some(response) => {
                println!("Filed. Report: {}", response.report_url);
                open_browser(&response.report_url);
            }
            None => println!("Nothing to resubmit."),
        }
        return Ok(());
    }

    let fast = std::env::args().any(|a| a == "--fast");
    let (stress_duration, vram_duration, fur_duration) = if fast {
        println!("(--fast: running short debug-length tests, not a real certificate)");
        (FAST_STRESS_TEST_DURATION, FAST_VRAM_TEST_DURATION, FAST_FUR_TEST_DURATION)
    } else {
        (STRESS_TEST_DURATION, VRAM_TEST_DURATION, FUR_TEST_DURATION)
    };

    let gpu = load_gpu_backend()?;
    let telemetry = gpu.read_primary_gpu()?;
    println!("Detected GPU: {} (VRAM: {} MB)", telemetry.name, telemetry.vram_total_bytes / 1_048_576);

    let fingerprint = Fingerprint::from_telemetry(&telemetry);
    println!("Fingerprint: {}", fingerprint.hash);

    let ctx = VulkanContext::new()?;
    println!("Vulkan device: {}", ctx.device_name);

    // Asked here, after we know there's a working GPU to test but before the
    // ~16 minutes of load start. Asking afterwards would mean an unattended run
    // finishes, waits on a prompt nobody is sitting at, and files anonymously
    // by default — the opposite of what the user chose.
    let upload_key = account::prompt_for_key();

    println!("Running stress test ({}s)...", stress_duration.as_secs());
    let mut telemetry_series = Vec::new();
    let stress_started = Instant::now();
    let stress_run = vulkan::stress::run(&ctx, stress_duration, |elapsed| {
        // Re-sampling telemetry every tick is deliberately cheap (a few
        // NVML calls) relative to the dispatch itself, so it doesn't skew
        // the load being measured.
        match gpu.read_primary_gpu() {
            Ok(sample_telemetry) => {
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
                let unsafe_temp = safety::is_temp_unsafe(sample.temperature_c);
                telemetry_series.push(sample);
                if unsafe_temp {
                    print_abort_warning(sample_telemetry.temperature_c);
                }
                !unsafe_temp
            }
            // A transient telemetry read failure shouldn't itself abort a
            // real test — keep going rather than false-trip the watchdog.
            Err(_) => true,
        }
    })?;
    println!();
    let stress_report: StressTestReport =
        report::build_stress_report(telemetry_series, &stress_run, stress_started.elapsed());
    println!("Stress test complete: {} dispatches", stress_report.dispatch_count);

    println!("Running VRAM pattern test ({}s)...", vram_duration.as_secs());
    let vram_result = vulkan::vram_test::run(
        &ctx,
        telemetry.vram_total_bytes,
        VRAM_TEST_FRACTION,
        vram_duration,
        |passes_run, total_errors, elapsed| {
            print_progress(&format!(
                "  pass {:>3}   errors {:>3}   {:>3}s",
                passes_run,
                total_errors,
                elapsed.as_secs()
            ));
            match gpu.read_primary_gpu() {
                Ok(t) => {
                    let unsafe_temp = safety::is_temp_unsafe(t.temperature_c);
                    if unsafe_temp {
                        print_abort_warning(t.temperature_c);
                    }
                    !unsafe_temp
                }
                Err(_) => true,
            }
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

    println!("Running render integrity test ({}s)...", fur_duration.as_secs());
    let fur_result = vulkan::fur_test::run(&ctx, fur_duration, |elapsed| {
        print_progress(&format!("  {:>3}s", elapsed.as_secs()));
        match gpu.read_primary_gpu() {
            Ok(t) => {
                let unsafe_temp = safety::is_temp_unsafe(t.temperature_c);
                if unsafe_temp {
                    print_abort_warning(t.temperature_c);
                }
                !unsafe_temp
            }
            Err(_) => true,
        }
    })?;
    println!();
    let fur_report = FurTestReport::from_result(&fur_result);
    println!(
        "Render integrity test complete: {} frames, {} of {} pixels mismatched",
        fur_report.frames_rendered, fur_report.mismatches, fur_report.pixels_checked
    );

    let request = CertifyRequest {
        client_version: env!("CARGO_PKG_VERSION"),
        fingerprint,
        device_name: telemetry.name.clone(),
        pcie_link_width_current: telemetry.pcie_link_width_current,
        pcie_link_width_max: telemetry.pcie_link_width_max,
        stress_test: stress_report,
        vram_test: vram_report,
        fur_test: fur_report,
    };

    println!("Submitting report...");
    let response = report::submit(&request, upload_key.as_deref())?;
    println!("Done. Report: {}", response.report_url);
    println!("Badge: {}", response.badge_url);

    match (&response.filed_to, response.upload_key_recognized) {
        (Some(email), _) => println!("Filed to {email}."),
        // A key was sent and rejected. The report is still valid and public, so
        // this is a note about attribution, not a failed run.
        (None, Some(false)) => {
            println!(
                "The upload key wasn't recognized, so this certificate isn't attached to an account."
            );
            println!("Check the key on your dashboard, then add this certificate from its page.");
        }
        (None, _) => println!("Not attached to an account. You can add it from the report page."),
    }

    open_browser(&response.report_url);

    Ok(())
}

fn print_progress(line: &str) {
    print!("\r{line}                    ");
    let _ = std::io::stdout().flush();
}

/// Printed once, right before a test loop aborts because the watchdog
/// tripped — see safety.rs. Aborting is still followed by a normal report
/// submission: an early stop for an unsafe temperature is itself a
/// meaningful, certifiable finding, not a run to just discard.
fn print_abort_warning(temp_c: u32) {
    println!(
        "\nStopping this test: GPU reached {temp_c}\u{b0}C, at or above the {}\u{b0}C safety limit. \
         Continuing to load the card at this temperature isn't safe.",
        safety::SAFETY_ABORT_TEMP_C
    );
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
