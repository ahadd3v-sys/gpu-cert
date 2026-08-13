//! Builds the report payload and POSTs it to the backend's `/api/certify`
//! ingest endpoint. The backend (not the client) holds the Ed25519 signing
//! key and is the source of truth for the signed report. This module's
//! job is just to package raw results faithfully, not to make any
//! certification judgment itself.

use serde::Serialize;
use std::time::Duration;

use crate::fingerprint::Fingerprint;
use crate::nvml::GpuTelemetry;
use crate::vulkan::fur_test::FurTestResult;
use crate::vulkan::stress::StressRunResult;
use crate::vulkan::vram_test::VramTestResult;

#[derive(Clone, Serialize)]
pub struct TelemetrySample {
    pub elapsed_ms: u64,
    pub temperature_c: u32,
    pub power_draw_mw: u32,
    pub graphics_clock_mhz: u32,
    pub memory_clock_mhz: u32,
    pub utilization_pct: u32,
}

/// Ties a submitted report to a session the backend opened before testing
/// started. Without it the backend has no way to tell a real 16-minute run
/// from a handcrafted JSON payload, and a certificate is only worth what that
/// distinction is worth.
#[derive(Serialize)]
pub struct Attestation {
    pub session_id: String,
    pub nonce: String,
}

#[derive(Serialize)]
pub struct CertifyRequest {
    pub attestation: Attestation,
    pub client_version: &'static str,
    pub fingerprint: Fingerprint,
    pub device_name: String,
    pub pcie_link_width_current: u32,
    pub pcie_link_width_max: u32,
    pub stress_test: StressTestReport,
    pub vram_test: VramTestReport,
    pub fur_test: FurTestReport,
}

#[derive(Serialize)]
pub struct StressTestReport {
    pub dispatch_count: u32,
    pub duration_ms: u64,
    pub telemetry_series: Vec<TelemetrySample>,
    pub aborted_for_safety: bool,
}

#[derive(Serialize)]
pub struct VramTestReport {
    pub passes_run: u32,
    pub total_errors: u64,
    pub bytes_tested: u64,
    pub duration_ms: u64,
    pub aborted_for_safety: bool,
}

impl VramTestReport {
    pub fn from_result(r: &VramTestResult) -> Self {
        VramTestReport {
            passes_run: r.passes_run,
            total_errors: r.total_errors,
            bytes_tested: r.bytes_tested,
            duration_ms: r.duration.as_millis() as u64,
            aborted_for_safety: r.aborted_for_safety,
        }
    }
}

#[derive(Serialize)]
pub struct FurTestReport {
    pub frames_rendered: u32,
    pub duration_ms: u64,
    pub mismatches: u32,
    pub pixels_checked: u32,
    pub aborted_for_safety: bool,
}

impl FurTestReport {
    pub fn from_result(r: &FurTestResult) -> Self {
        FurTestReport {
            frames_rendered: r.frames_rendered,
            duration_ms: r.duration.as_millis() as u64,
            mismatches: r.mismatches,
            pixels_checked: r.pixels_checked,
            aborted_for_safety: r.aborted_for_safety,
        }
    }
}

pub struct CertifyResponse {
    pub report_url: String,
    pub badge_url: String,
    /// Email of the account the report was filed under, if an upload key was
    /// sent and recognized. `None` means the report is public but unattached,
    /// which is a normal outcome, not an error.
    pub filed_to: Option<String>,
    /// `Some(false)` specifically means a key was sent and the backend did not
    /// recognize it, worth telling the user, since they typed it in. `None`
    /// means no key was sent at all.
    pub upload_key_recognized: Option<bool>,
}

/// Backend base URL, hardcoded to production for now since there's no
/// staging environment yet. Revisit if/when the backend gets a staging
/// deploy worth pointing the client at during development.
///
/// Releases before v0.4.1 point at gpu-cert.vercel.app instead. That alias
/// stays live and keeps working, so an exe already sitting on someone's
/// desktop is not broken by the move.
const BACKEND_BASE_URL: &str = "https://gpucert.com";

/// `upload_key` is the "connect the app to your account" credential the user
/// copies off their dashboard. It's optional on purpose: the tool is fully
/// usable without an account, and a report submitted without a key is stored
/// public-but-unattached, claimable from its page later.
/// A whole run is ~16 minutes of GPU load, so the submission at the end is
/// the most expensive thing in the program to lose. These exist because a
/// dropped Wi-Fi packet at minute 16 should not throw that away.
const SUBMIT_ATTEMPTS: u32 = 4;
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(45);

/// Where an unsent report is parked so `--resubmit` can pick it up.
fn pending_report_path() -> Option<std::path::PathBuf> {
    Some(crate::account::config_dir()?.join("pending-report.json"))
}

pub fn submit(req: &CertifyRequest, upload_key: Option<&str>) -> anyhow::Result<CertifyResponse> {
    let payload = serde_json::to_string(req)
        .map_err(|e| anyhow::anyhow!("failed to serialize report: {e}"))?;

    match post_payload(&payload, upload_key) {
        Ok(resp) => {
            // Only meaningful if a previous run left one behind.
            if let Some(path) = pending_report_path() {
                let _ = std::fs::remove_file(path);
            }
            Ok(resp)
        }
        Err(e) => {
            // The test results are still perfectly good; only the delivery
            // failed. Keeping them means the user can retry in a second
            // instead of re-running the card for another 16 minutes.
            match save_pending(&payload) {
                Some(path) => Err(anyhow::anyhow!(
                    "{e}\n\n  Your test results were saved to {}\n  \
                     Run `gpu-cert.exe --resubmit` once you're back online to file them. \
                     You do not need to run the tests again.",
                    path.display()
                )),
                None => Err(e),
            }
        }
    }
}

fn save_pending(payload: &str) -> Option<std::path::PathBuf> {
    let path = pending_report_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    std::fs::write(&path, payload).ok()?;
    Some(path)
}

/// Files a report left behind by an earlier run whose submission failed.
pub fn resubmit(upload_key: Option<&str>) -> anyhow::Result<Option<CertifyResponse>> {
    let Some(path) = pending_report_path() else {
        return Ok(None);
    };
    let Ok(payload) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };

    let response = post_payload(&payload, upload_key)?;
    let _ = std::fs::remove_file(&path);
    Ok(Some(response))
}

/// Retries on the failures that are worth retrying and stops on the ones
/// that aren't. A timeout, a refused connection or a 5xx are all plausibly
/// transient. A 4xx means the backend understood the request and rejected
/// it, so sending the identical bytes again would only fail identically.
fn post_payload(payload: &str, upload_key: Option<&str>) -> anyhow::Result<CertifyResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .map_err(|e| anyhow::anyhow!("failed to create HTTP client: {e}"))?;

    let mut last_error = None;
    for attempt in 1..=SUBMIT_ATTEMPTS {
        if attempt > 1 {
            // 2s, 4s, 8s. Long enough for a flaky link to come back, short
            // enough that nobody walks away from the console.
            let backoff = Duration::from_secs(1 << (attempt - 1));
            println!("  retrying in {}s (attempt {attempt} of {SUBMIT_ATTEMPTS})...", backoff.as_secs());
            std::thread::sleep(backoff);
        }

        let mut builder = client
            .post(format!("{BACKEND_BASE_URL}/api/certify"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload.to_string());
        if let Some(key) = upload_key {
            builder = builder.bearer_auth(key);
        }

        let resp = match builder.send() {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(anyhow::anyhow!("failed to reach backend: {e}"));
                continue;
            }
        };

        let status = resp.status();
        if status.is_client_error() {
            let detail = resp.text().unwrap_or_default();
            anyhow::bail!(
                "backend rejected report: HTTP {status}{}",
                if detail.is_empty() { String::new() } else { format!(", {detail}") }
            );
        }
        if !status.is_success() {
            last_error = Some(anyhow::anyhow!("backend error: HTTP {status}"));
            continue;
        }

        #[derive(serde::Deserialize)]
        struct RawResponse {
            report_url: String,
            badge_url: String,
            #[serde(default)]
            filed_to: Option<String>,
            #[serde(default)]
            upload_key_recognized: Option<bool>,
        }
        let raw: RawResponse = match resp.json() {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(anyhow::anyhow!("malformed backend response: {e}"));
                continue;
            }
        };

        return Ok(CertifyResponse {
            report_url: raw.report_url,
            badge_url: raw.badge_url,
            filed_to: raw.filed_to,
            upload_key_recognized: raw.upload_key_recognized,
        });
    }

    Err(last_error
        .unwrap_or_else(|| anyhow::anyhow!("could not submit the report"))
        .context(format!("gave up after {SUBMIT_ATTEMPTS} attempts")))
}

pub fn build_stress_report(
    telemetry_series: Vec<TelemetrySample>,
    run_result: &StressRunResult,
    duration: Duration,
) -> StressTestReport {
    StressTestReport {
        dispatch_count: run_result.dispatch_count,
        duration_ms: duration.as_millis() as u64,
        telemetry_series,
        aborted_for_safety: run_result.aborted_for_safety,
    }
}

/// Convenience used by main.rs's tick callback to turn a fresh telemetry
/// read into a timestamped sample. Kept here (not in nvml.rs) since it's
/// about report shape, not about talking to the driver.
pub fn sample_from_telemetry(elapsed: Duration, t: &GpuTelemetry) -> TelemetrySample {
    TelemetrySample {
        elapsed_ms: elapsed.as_millis() as u64,
        temperature_c: t.temperature_c,
        power_draw_mw: t.power_draw_mw,
        graphics_clock_mhz: t.graphics_clock_mhz,
        memory_clock_mhz: t.memory_clock_mhz,
        // Re-clamp here too (nvml.rs already clamps at the read site): a
        // percentage sample built into the report must never carry an
        // out-of-range value regardless of how `t` was constructed.
        utilization_pct: t.utilization_pct.min(100),
    }
}

/// A test run's server-side session. Opened before any load is applied, kept
/// alive by periodic check-ins, and spent by the submission at the end.
///
/// The check-ins are what make the timing meaningful. Without them the backend
/// could only see a session opened and a report arriving later, which anyone
/// could reproduce by opening a session and sleeping. With them, a forged run
/// has to keep talking to the server across the whole duration it claims.
pub struct TestSession {
    pub session_id: String,
    pub nonce: String,
    heartbeat_interval: Duration,
    last_heartbeat: std::cell::Cell<std::time::Instant>,
}

impl TestSession {
    pub fn attestation(&self) -> Attestation {
        Attestation { session_id: self.session_id.clone(), nonce: self.nonce.clone() }
    }

    /// Called from the per-tick callbacks of every test. Cheap and silent: it
    /// only sends when the interval has elapsed, and a failure is ignored
    /// entirely. A dropped heartbeat must never interrupt a run that is
    /// otherwise fine, since losing 16 minutes of GPU load to a blip on the
    /// wifi is a far worse outcome than a slightly thinner attestation.
    pub fn heartbeat(&self) {
        if self.last_heartbeat.get().elapsed() < self.heartbeat_interval {
            return;
        }
        self.last_heartbeat.set(std::time::Instant::now());

        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = client
            .post(format!("{BACKEND_BASE_URL}/api/session/progress"))
            .json(&serde_json::json!({
                "session_id": self.session_id,
                "nonce": self.nonce,
            }))
            .send();
    }
}

/// Opens the session. Failing here stops the run before any load is applied,
/// which is deliberate: 16 minutes of testing that provably cannot be filed at
/// the end is worse than a clear refusal up front.
pub fn start_session(
    client_version: &str,
    device_name: &str,
    fingerprint_hash: &str,
) -> anyhow::Result<TestSession> {
    #[derive(serde::Deserialize)]
    struct RawSession {
        session_id: String,
        nonce: String,
        #[serde(default)]
        heartbeat_interval_ms: Option<u64>,
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(SUBMIT_TIMEOUT)
        .build()
        .map_err(|e| anyhow::anyhow!("failed to create HTTP client: {e}"))?;

    let resp = client
        .post(format!("{BACKEND_BASE_URL}/api/session/start"))
        .json(&serde_json::json!({
            "client_version": client_version,
            "device_name": device_name,
            "fingerprint_hash": fingerprint_hash,
        }))
        .send()
        .map_err(|e| anyhow::anyhow!("couldn't reach the backend to start a test session: {e}"))?;

    if !resp.status().is_success() {
        anyhow::bail!(
            "backend refused to start a test session: HTTP {}. Check your connection and try again.",
            resp.status()
        );
    }

    let raw: RawSession = resp
        .json()
        .map_err(|e| anyhow::anyhow!("malformed session response: {e}"))?;

    Ok(TestSession {
        session_id: raw.session_id,
        nonce: raw.nonce,
        // Server-chosen, so the cadence can change without reissuing clients.
        heartbeat_interval: Duration::from_millis(raw.heartbeat_interval_ms.unwrap_or(60_000)),
        last_heartbeat: std::cell::Cell::new(std::time::Instant::now()),
    })
}
