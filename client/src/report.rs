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
    /// Junction temperature where the card throttles, and the memory junction.
    /// Skipped in the payload when absent so a backend that has not shipped
    /// support for them still parses a report unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotspot_temperature_c: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_temperature_c: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan_rpm: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fan_percent: Option<u32>,
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
    /// How the tested region was chosen and why it stopped there. Sent with
    /// the report so a coverage shortfall can be diagnosed from the stored
    /// data instead of by asking whoever ran it to copy their console.
    pub diagnostics: String,
    pub passes_run: u32,
    pub total_errors: u64,
    pub bytes_tested: u64,
    pub duration_ms: u64,
    pub aborted_for_safety: bool,
}

impl VramTestReport {
    pub fn from_result(r: &VramTestResult) -> Self {
        VramTestReport {
            diagnostics: r.diagnostics.clone(),
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
    /// "Pass" or "Fail", decided by the backend. Taken from the response
    /// rather than recomputed here, because two implementations of "did this
    /// card pass" will eventually disagree, and a console reading PASS over a
    /// certificate reading FAIL is the worst possible version of that.
    ///
    /// `None` when the backend did not say, which an older deployment will
    /// not. Deliberately not defaulted to a pass: assuming the good outcome
    /// when told nothing recreates exactly the disagreement this field exists
    /// to prevent, and it would do it on the failing card, where it matters.
    pub verdict: Option<String>,
    /// Why it failed, in the certificate's own words. Empty on a pass.
    pub verdict_reasons: Vec<String>,
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
/// Releases before v0.4.1 point at gpu-cert.vercel.app instead. That alias has
/// since been removed from the project, and those releases are refused by the
/// backend's version floor regardless, because they misreport VRAM coverage.
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
            // Defaulted rather than required, so a client stays compatible
            // with a backend that has not shipped this field yet.
            #[serde(default)]
            verdict: Option<String>,
            #[serde(default)]
            verdict_reasons: Vec<String>,
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
            verdict: raw.verdict,
            verdict_reasons: raw.verdict_reasons,
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
        hotspot_temperature_c: t.hotspot_temperature_c,
        memory_temperature_c: t.memory_temperature_c,
        fan_rpm: t.fan_rpm,
        fan_percent: t.fan_percent,
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
    /// How much of the log the backend already has. Only the new lines go up
    /// with each heartbeat, so a long run doesn't re-send its whole history
    /// every minute.
    lines_sent: std::cell::Cell<usize>,
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
        self.flush_log();
    }

    /// Sends everything logged since the last send, regardless of when the last
    /// heartbeat was.
    ///
    /// Called once more just before submitting, because otherwise a successful
    /// run uploads no log at all: heartbeats fire on an interval, so a run
    /// shorter than one interval never sends anything, and even a long run
    /// leaves its last interval's worth of lines on the machine. A failed run
    /// posts its log with the failure, so success was the only path that lost
    /// it, which is precisely backwards from useful.
    pub fn flush_log(&self) {
        self.last_heartbeat.set(std::time::Instant::now());

        let all = crate::diag::snapshot();
        let already = self.lines_sent.get().min(all.len());
        let fresh: Vec<String> = all[already..].to_vec();

        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let sent = client
            .post(format!("{BACKEND_BASE_URL}/api/session/progress"))
            .json(&serde_json::json!({
                "session_id": self.session_id,
                "nonce": self.nonce,
                "log": fresh,
            }))
            .send()
            .is_ok();
        // Only advance on success, so a dropped heartbeat re-sends its lines
        // next time rather than losing them.
        if sent {
            self.lines_sent.set(all.len());
        }
    }
}

/// Opens the session. Failing here stops the run before any load is applied,
/// which is deliberate: 16 minutes of testing that provably cannot be filed at
/// the end is worse than a clear refusal up front.
pub fn start_session(
    client_version: &str,
    device_name: &str,
    fingerprint_hash: &str,
    environment: serde_json::Value,
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
            // Sent before any testing, so a run that later hangs or crashes
            // has still told the backend what machine it was on.
            "environment": environment,
        }))
        .send()
        .map_err(|e| anyhow::anyhow!("couldn't reach the backend to start a test session: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        // The backend's own words when it has them. A version floor returns
        // 426 with an explanation of what to download, and printing only the
        // status code would turn that into an unactionable number.
        let detail = resp
            .json::<serde_json::Value>()
            .ok()
            .and_then(|body| body.get("error")?.as_str().map(str::to_owned));
        match detail {
            Some(message) => anyhow::bail!("{message}"),
            None => anyhow::bail!(
                "backend refused to start a test session: HTTP {status}. \
                 Check your connection and try again."
            ),
        }
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
        lines_sent: std::cell::Cell::new(0),
    })
}

/// Posts a failure against the open session. Called from the error path and
/// from the panic hook, which is why it takes ids rather than a borrowed
/// session and never returns an error: it runs while the process is already
/// on its way out.
///
/// Without this a crashed run leaves nothing at all, which is how two failures
/// have already gone undiagnosed.
pub fn report_failure(session_id: &str, nonce: &str, error: &str) {
    report_failure_within(session_id, nonce, error, Duration::from_secs(15));
}

/// `timeout` is a parameter because the cancellation path has a hard deadline
/// the error path does not: Windows terminates a console control handler after
/// a few seconds whatever it is doing, so a fifteen second attempt there would
/// simply be killed halfway and record nothing.
pub fn report_failure_within(session_id: &str, nonce: &str, error: &str, timeout: Duration) {
    let Ok(client) = reqwest::blocking::Client::builder().timeout(timeout).build() else {
        return;
    };
    let _ = client
        .post(format!("{BACKEND_BASE_URL}/api/session/failed"))
        .json(&serde_json::json!({
            "session_id": session_id,
            "nonce": nonce,
            "error": error,
            "log": crate::diag::snapshot(),
        }))
        .send();
}
