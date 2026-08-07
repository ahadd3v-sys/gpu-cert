//! Builds the report payload and POSTs it to the backend's `/api/certify`
//! ingest endpoint. The backend (not the client) holds the Ed25519 signing
//! key and is the source of truth for the signed report — this module's
//! job is just to package raw results faithfully, not to make any
//! certification judgment itself.

use serde::Serialize;
use std::time::Duration;

use crate::fingerprint::Fingerprint;
use crate::nvml::GpuTelemetry;
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
    pub stress_test: StressTestReport,
    pub vram_test: VramTestReport,
}

#[derive(Serialize)]
pub struct StressTestReport {
    pub dispatch_count: u32,
    pub duration_ms: u64,
    pub telemetry_series: Vec<TelemetrySample>,
}

#[derive(Serialize)]
pub struct VramTestReport {
    pub passes_run: u32,
    pub total_errors: u64,
    pub bytes_tested: u64,
    pub duration_ms: u64,
}

impl VramTestReport {
    pub fn from_result(r: &VramTestResult) -> Self {
        VramTestReport {
            passes_run: r.passes_run,
            total_errors: r.total_errors,
            bytes_tested: r.bytes_tested,
            duration_ms: r.duration.as_millis() as u64,
        }
    }
}

pub struct CertifyResponse {
    pub report_url: String,
    pub badge_url: String,
}

/// Backend base URL — hardcoded to production for now since there's no
/// staging environment yet. Revisit if/when the backend gets a staging
/// deploy worth pointing the client at during development.
const BACKEND_BASE_URL: &str = "https://gpu-cert.vercel.app";

pub fn submit(req: &CertifyRequest) -> anyhow::Result<CertifyResponse> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{BACKEND_BASE_URL}/api/certify"))
        .json(req)
        .send()
        .map_err(|e| anyhow::anyhow!("failed to reach backend: {e}"))?;

    if !resp.status().is_success() {
        anyhow::bail!("backend rejected report: HTTP {}", resp.status());
    }

    #[derive(serde::Deserialize)]
    struct RawResponse {
        report_url: String,
        badge_url: String,
    }
    let raw: RawResponse = resp
        .json()
        .map_err(|e| anyhow::anyhow!("malformed backend response: {e}"))?;

    Ok(CertifyResponse {
        report_url: raw.report_url,
        badge_url: raw.badge_url,
    })
}

pub fn build_stress_report(
    telemetry_series: Vec<TelemetrySample>,
    dispatch_count: u32,
    duration: Duration,
) -> StressTestReport {
    StressTestReport {
        dispatch_count,
        duration_ms: duration.as_millis() as u64,
        telemetry_series,
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
        utilization_pct: t.utilization_pct,
    }
}
