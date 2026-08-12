//! Builds the report payload and POSTs it to the backend's `/api/certify`
//! ingest endpoint. The backend (not the client) holds the Ed25519 signing
//! key and is the source of truth for the signed report — this module's
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

#[derive(Serialize)]
pub struct CertifyRequest {
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
    /// recognize it — worth telling the user, since they typed it in. `None`
    /// means no key was sent at all.
    pub upload_key_recognized: Option<bool>,
}

/// Backend base URL — hardcoded to production for now since there's no
/// staging environment yet. Revisit if/when the backend gets a staging
/// deploy worth pointing the client at during development.
const BACKEND_BASE_URL: &str = "https://gpu-cert.vercel.app";

/// `upload_key` is the "connect the app to your account" credential the user
/// copies off their dashboard. It's optional on purpose: the tool is fully
/// usable without an account, and a report submitted without a key is stored
/// public-but-unattached, claimable from its page later.
pub fn submit(req: &CertifyRequest, upload_key: Option<&str>) -> anyhow::Result<CertifyResponse> {
    let client = reqwest::blocking::Client::new();
    let mut builder = client.post(format!("{BACKEND_BASE_URL}/api/certify")).json(req);
    if let Some(key) = upload_key {
        builder = builder.bearer_auth(key);
    }

    let resp = builder
        .send()
        .map_err(|e| anyhow::anyhow!("failed to reach backend: {e}"))?;

    if !resp.status().is_success() {
        anyhow::bail!("backend rejected report: HTTP {}", resp.status());
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
    let raw: RawResponse = resp
        .json()
        .map_err(|e| anyhow::anyhow!("malformed backend response: {e}"))?;

    Ok(CertifyResponse {
        report_url: raw.report_url,
        badge_url: raw.badge_url,
        filed_to: raw.filed_to,
        upload_key_recognized: raw.upload_key_recognized,
    })
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
