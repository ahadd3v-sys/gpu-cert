mod account;
mod adl;
mod diag;
mod fingerprint;
mod nvml;
mod report;
mod safety;
mod ui;
mod vulkan;

use std::time::{Duration, Instant};

use fingerprint::Fingerprint;
use nvml::GpuTelemetry;
use report::{sample_from_telemetry, CertifyRequest, FurTestReport, StressTestReport, VramTestReport};
use vulkan::VulkanContext;

/// Unifies the NVML and ADL backends behind one `read_primary_gpu` so the
/// rest of `run()`, three test loops that each re-sample telemetry every
/// tick, doesn't need to know which vendor's card it's running against.
enum GpuBackend {
    Nvml(nvml::Nvml),
    #[cfg(target_os = "windows")]
    Adl(adl::Adl),
}

impl GpuBackend {
    fn name(&self) -> &'static str {
        match self {
            GpuBackend::Nvml(_) => "nvml",
            #[cfg(target_os = "windows")]
            GpuBackend::Adl(_) => "adl",
        }
    }

    fn read_primary_gpu(&self) -> anyhow::Result<GpuTelemetry> {
        match self {
            GpuBackend::Nvml(n) => n.read_primary_gpu(),
            #[cfg(target_os = "windows")]
            GpuBackend::Adl(a) => a.read_primary_gpu(),
        }
    }
}

/// Tries NVIDIA first, then AMD, not a preference ranking, just an order.
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
            Ok(a) => Ok(GpuBackend::Adl(a)),
            Err(adl_err) => Err(anyhow::anyhow!(
                "no supported GPU found.\n  NVIDIA (NVML): {nvml_err}\n  AMD (ADL): {adl_err}"
            )),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow::anyhow!("no supported GPU found (NVML load failed: {nvml_err}). AMD support is Windows-only."))
    }
}

// Phase 1 durations. Not tunable via CLI for end users (vs. keeping the
// test fixed-length for report comparability), that's a product decision,
// not a stack one, deferred until Ahad weighs in. `--fast` below is a
// developer-only escape hatch for iterating on the client itself, not a
// public option; the website's download always runs the real durations.
const STRESS_TEST_DURATION: Duration = Duration::from_secs(5 * 60);
const VRAM_TEST_DURATION: Duration = Duration::from_secs(10 * 60);
const VRAM_TEST_FRACTION: f64 = 0.85;
// Short relative to the other two: this is a correctness/display-output
// check exercised under load, not a thermal soak, that's already covered
// by the 5-minute compute stress test above.
const FUR_TEST_DURATION: Duration = Duration::from_secs(45);

// Undocumented, developer-only: `gpu-cert.exe --fast` runs all three tests
// at durations short enough for a tight edit-rebuild-rerun loop while
// debugging the client itself, long enough to still exercise multiple VRAM
// passes and a real stress-telemetry series, short enough not to burn 16
// minutes per iteration. Never advertised, never what the website's
// download runs, a certificate produced this way isn't a real one.
const FAST_STRESS_TEST_DURATION: Duration = Duration::from_secs(20);
const FAST_VRAM_TEST_DURATION: Duration = Duration::from_secs(20);
const FAST_FUR_TEST_DURATION: Duration = Duration::from_secs(10);

// Console, not a GUI: the trust problem a GUI was meant to solve is now
// handled upstream: you only get this exe by clicking "Test your GPU" on
// the (logged-in) website, so the download itself is the trust signal, not
// this window's appearance. That let the client go back to being a plain
// pipe of println!s instead of carrying eframe/egui.
//
// Because it's a plain console app, double-clicking gpu-cert.exe from
// Explorer runs it attached to a console window that Windows destroys the
// instant the process exits, success or failure. Without an explicit pause,
// any output (including error messages) flashes and vanishes before it can
// be read. `main` stays a thin wrapper around `run` so every exit path
// (early `?` returns, the happy path, and even a panic) goes through
// `pause_before_exit` before the process actually terminates.
/// Set once a session exists, so the panic hook and the error path can both
/// file a failure against it. A crashed run that reports nothing is a run
/// nobody can fix.
static OPEN_SESSION: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

fn report_failure(error: &str) {
    diag::record(format!("FAILED: {error}"));
    let session = OPEN_SESSION.lock().ok().and_then(|s| s.clone());
    if let Some((id, nonce)) = session {
        report::report_failure(&id, &nonce, error);
    }
    if let Some(path) = diag::write_local_copy() {
        eprintln!("\nA log of this run was saved to {}", path.display());
        eprintln!("Paste it at https://gpucert.com/feedback and this gets fixed.");
    }
}

fn main() {
    diag::init();
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_panic_hook(info);
        report_failure(&format!("panic: {info}"));
        pause_before_exit();
    }));

    let result = run();
    if let Err(ref e) = result {
        eprintln!("Error: {e:?}");
        report_failure(&format!("{e:?}"));
    } else {
        diag::write_local_copy();
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
    ui::init();
    ui::banner(env!("CARGO_PKG_VERSION"));

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
        (FAST_STRESS_TEST_DURATION, FAST_VRAM_TEST_DURATION, FAST_FUR_TEST_DURATION)
    } else {
        (STRESS_TEST_DURATION, VRAM_TEST_DURATION, FUR_TEST_DURATION)
    };

    diag::phase("enumerating Vulkan devices");
    // Collected before anything can refuse to continue, so a machine where no
    // device matches still reports what it had. "It didn't detect my other
    // GPU" is unanswerable without this.
    let vulkan_devices = vulkan::describe_devices();
    diag::record(format!("vulkan: {vulkan_devices}"));

    diag::phase("loading vendor telemetry");
    let gpu = load_gpu_backend().inspect_err(|e| diag::record(format!("backend load failed: {e}")))?;
    let telemetry_backend = gpu.name();
    let telemetry = gpu.read_primary_gpu()?;
    diag::record(format!(
        "telemetry: {} vendor=0x{:04X} device=0x{:04X} vram={}MB vbios={}",
        telemetry.name,
        telemetry.pci_vendor_id,
        telemetry.pci_device_id,
        telemetry.vram_total_bytes / 1_048_576,
        telemetry.vbios_version
    ));
    let fingerprint = Fingerprint::from_telemetry(&telemetry);

    // Matched against the telemetry rather than taken as device 0, so the
    // card being tested is provably the card being certified. See
    // VulkanContext::new.
    diag::phase("selecting the Vulkan device");
    let ctx = VulkanContext::new(&vulkan::GpuSelector {
        vendor_id: telemetry.pci_vendor_id,
        device_id: telemetry.pci_device_id,
        name: telemetry.name.clone(),
    })?;
    let mut screen = ui::Screen::new(env!("CARGO_PKG_VERSION"), fast);
    screen.set_device(
        &telemetry.name,
        telemetry.vram_total_bytes / 1_048_576,
        &format!("Vulkan: {}", ctx.device_name),
    );
    diag::record(format!(
        "selected {}: heap {} of {}MB, device-local types {:?}, maxStorageBufferRange={}, maxMemoryAllocationSize={}MB, budget={}",
        ctx.device_name,
        ctx.device_local_heap_index,
        ctx.device_local_heap_size / 1_048_576,
        ctx.device_local_memory_types,
        ctx.max_storage_buffer_range,
        ctx.max_memory_allocation_size / 1_048_576,
        ctx.available_device_local_bytes().map(|b| b / 1_048_576).unwrap_or(0)
    ));

    // Asked here, after we know there's a working GPU to test but before the
    // ~16 minutes of load start. Asking afterwards would mean an unattended run
    // finishes, waits on a prompt nobody is sitting at, and files anonymously
    // by default, the opposite of what the user chose.
    let upload_key = account::prompt_for_key();

    // Opened before any load is applied. The backend times the gap between
    // this and the submission, which is what stops a certificate from being
    // something you can produce with a single request instead of a real run.
    diag::phase("opening the test session");
    let session = report::start_session(
        env!("CARGO_PKG_VERSION"),
        &telemetry.name,
        &fingerprint.hash,
        serde_json::json!({
            "client_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "args": std::env::args().skip(1).collect::<Vec<_>>(),
            "vulkan": vulkan_devices,
            "selected_device": ctx.device_name,
            "telemetry_backend": telemetry_backend,
            "log": diag::snapshot(),
        }),
    )?;
    if let Ok(mut open) = OPEN_SESSION.lock() {
        *open = Some((session.session_id.clone(), session.nonce.clone()));
    }

    diag::phase("stress test");
    screen.start(0, "starting");
    let mut telemetry_series = Vec::new();
    let stress_started = Instant::now();
    let stress_run = vulkan::stress::run(&ctx, stress_duration, |elapsed| {
        // Re-sampling telemetry every tick is deliberately cheap (a few
        // NVML calls) relative to the dispatch itself, so it doesn't skew
        // the load being measured.
        session.heartbeat();
        match gpu.read_primary_gpu() {
            Ok(sample_telemetry) => {
                let sample = sample_from_telemetry(elapsed, &sample_telemetry);
                screen.update(
                    0,
                    elapsed.as_secs_f32() / stress_duration.as_secs_f32(),
                    &format!(
                        "{}\u{b0}C   {}% load   {} W   {} MHz core   {} MHz mem",
                        sample.temperature_c,
                        sample.utilization_pct,
                        sample.power_draw_mw / 1000,
                        sample.graphics_clock_mhz,
                        sample.memory_clock_mhz,
                    ),
                );
                let unsafe_temp = safety::is_temp_unsafe(sample.temperature_c);
                telemetry_series.push(sample);
                if unsafe_temp {
                    screen.warn(&abort_warning(sample_telemetry.temperature_c));
                }
                !unsafe_temp
            }
            // A transient telemetry read failure shouldn't itself abort a
            // real test, keep going rather than false-trip the watchdog.
            Err(_) => true,
        }
    })
    .inspect_err(|e| screen.fail(0, &e.to_string()))?;
    let stress_report: StressTestReport =
        report::build_stress_report(telemetry_series, &stress_run, stress_started.elapsed());
    screen.finish(
        0,
        &format!(
            "{} dispatches, peak {}\u{b0}C",
            stress_report.dispatch_count,
            stress_report.telemetry_series.iter().map(|s| s.temperature_c).max().unwrap_or(0)
        ),
    );

    diag::phase("VRAM pattern test");
    screen.start(1, "allocating");
    let vram_result = vulkan::vram_test::run(
        &ctx,
        telemetry.vram_total_bytes,
        VRAM_TEST_FRACTION,
        vram_duration,
        |passes_run, total_errors, elapsed| {
            screen.update(
                1,
                elapsed.as_secs_f32() / vram_duration.as_secs_f32(),
                &format!("pass {passes_run}   {total_errors} errors"),
            );
            session.heartbeat();
            match gpu.read_primary_gpu() {
                Ok(t) => {
                    let unsafe_temp = safety::is_temp_unsafe(t.temperature_c);
                    if unsafe_temp {
                        screen.warn(&abort_warning(t.temperature_c));
                    }
                    !unsafe_temp
                }
                Err(_) => true,
            }
        },
    )
    .inspect_err(|e| screen.fail(1, &e.to_string()))?;
    let vram_report = VramTestReport::from_result(&vram_result);
    let coverage_pct = (vram_report.bytes_tested * 100)
        .checked_div(telemetry.vram_total_bytes)
        .unwrap_or(0);
    screen.finish(
        1,
        &format!(
            "{} passes over {} MB ({}% of the card), {} errors",
            vram_report.passes_run,
            vram_report.bytes_tested / 1_048_576,
            coverage_pct,
            vram_report.total_errors
        ),
    );

    diag::phase("render integrity test");
    screen.start(2, "building the reference image");
    let fur_result = vulkan::fur_test::run(&ctx, fur_duration, |elapsed| {
        screen.update(
            2,
            elapsed.as_secs_f32() / fur_duration.as_secs_f32(),
            "comparing every pixel of every frame",
        );
        session.heartbeat();
        match gpu.read_primary_gpu() {
            Ok(t) => {
                let unsafe_temp = safety::is_temp_unsafe(t.temperature_c);
                if unsafe_temp {
                    screen.warn(&abort_warning(t.temperature_c));
                }
                !unsafe_temp
            }
            Err(_) => true,
        }
    })
    .inspect_err(|e| screen.fail(2, &e.to_string()))?;
    let fur_report = FurTestReport::from_result(&fur_result);
    screen.finish(
        2,
        &format!(
            "{} frames, {} pixels checked, {} mismatched",
            fur_report.frames_rendered, fur_report.pixels_checked, fur_report.mismatches
        ),
    );

    let vram_report_errors = vram_report.total_errors;

    let request = CertifyRequest {
        attestation: session.attestation(),
        client_version: env!("CARGO_PKG_VERSION"),
        fingerprint,
        device_name: telemetry.name.clone(),
        pcie_link_width_current: telemetry.pcie_link_width_current,
        pcie_link_width_max: telemetry.pcie_link_width_max,
        stress_test: stress_report,
        vram_test: vram_report,
        fur_test: fur_report,
    };

    diag::phase("submitting");
    // Last chance to get the log off the machine while the session is still
    // open. Heartbeats only fire on an interval, so without this a short run
    // uploads nothing and a long one loses its final interval.
    session.flush_log();
    screen.start(2, "filing the certificate");
    let response = report::submit(&request, upload_key.as_deref())?;

    let passed = response.verdict.eq_ignore_ascii_case("pass");
    let headline = if passed {
        format!("{} passed every test", telemetry.name)
    } else {
        response
            .verdict_reasons
            .first()
            .cloned()
            .unwrap_or_else(|| format!("{} failed", telemetry.name))
    };

    let mut lines: Vec<(&str, String)> = vec![
        ("Coverage", format!("{coverage_pct}% of VRAM, {} errors", vram_report_errors)),
        ("Report", response.report_url.clone()),
        ("Badge", response.badge_url.clone()),
    ];
    lines.push(match (&response.filed_to, response.upload_key_recognized) {
        (Some(email), _) => ("Filed to", email.clone()),
        // A key was sent and rejected. The report is still valid and public,
        // so this is a note about attribution, not a failed run.
        (None, Some(false)) => (
            "Account",
            "the upload key was not recognised. Attach this from the report page.".to_string(),
        ),
        (None, _) => ("Account", "not attached. You can attach it from the report page.".to_string()),
    });

    ui::result(env!("CARGO_PKG_VERSION"), passed, &headline, &lines);

    open_browser(&response.report_url);

    Ok(())
}

/// Shown once, right before a test loop aborts because the watchdog tripped;
/// see safety.rs. Aborting is still followed by a normal report submission: an
/// early stop for an unsafe temperature is itself a meaningful, certifiable
/// finding, not a run to just discard.
fn abort_warning(temp_c: u32) -> String {
    format!(
        "Stopping this test: the GPU reached {temp_c}\u{b0}C, at or above the {}\u{b0}C safety \
         limit. Continuing to load the card at this temperature is not safe.",
        safety::SAFETY_ABORT_TEMP_C
    )
}

/// Opens the report page so the seller lands back on the site to see (and,
/// if logged in, claim) their result, the second half of the
/// site → download → run → back-to-site loop this client is built around.
#[cfg(target_os = "windows")]
fn open_browser(url: &str) {
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
}

#[cfg(not(target_os = "windows"))]
fn open_browser(url: &str) {
    println!("Open {url} in your browser to see the results.");
}
