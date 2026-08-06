//! Anti-tamper hardware fingerprint: binds a report to UUID + PCI device ID
//! + VRAM size + VBIOS version as a tuple rather than any single field.
//! Per the research doc, UUID alone is driver-reported and spoofable, and
//! serial number support is weak-to-absent on consumer cards — a 4-field
//! tuple is harder to spoof consistently while still being cheap to compute
//! client-side. This does not claim to be tamper-proof, only harder to fake
//! than a single field (see the scope doc's honest framing on this).

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::nvml::GpuTelemetry;

#[derive(Debug, Serialize)]
pub struct Fingerprint {
    pub uuid: String,
    pub pci_device_id: u32,
    pub vram_total_bytes: u64,
    pub vbios_version: String,
    /// sha256(uuid | pci_device_id | vram_total_bytes | vbios_version),
    /// included so the backend can cheaply dedupe/compare fingerprints
    /// without re-deriving the hash from the raw tuple every time.
    pub hash: String,
}

impl Fingerprint {
    pub fn from_telemetry(t: &GpuTelemetry) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(t.uuid.as_bytes());
        hasher.update(b"|");
        hasher.update(t.pci_device_id.to_le_bytes());
        hasher.update(b"|");
        hasher.update(t.vram_total_bytes.to_le_bytes());
        hasher.update(b"|");
        hasher.update(t.vbios_version.as_bytes());
        let hash = format!("{:x}", hasher.finalize());

        Fingerprint {
            uuid: t.uuid.clone(),
            pci_device_id: t.pci_device_id,
            vram_total_bytes: t.vram_total_bytes,
            vbios_version: t.vbios_version.clone(),
            hash,
        }
    }
}
