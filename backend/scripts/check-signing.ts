// Guards the one property that makes /verify meaningful: the canonical string
// built at ingest (from a CertifyRequest) and the one rebuilt at verification
// (from the stored row) have to be byte-identical.
//
// They are produced by different functions, from different shapes, in
// different files, at different times. If they ever diverge, nothing fails
// loudly — certificates just start reporting as forged, including genuine
// ones, on the single page whose entire job is to be trustworthy. So this
// runs as part of the build rather than living as a comment saying "keep
// these in sync".
//
// Uses a throwaway key pair generated here, so it needs no production
// secrets and can run anywhere.
import { generateKeyPairSync } from "crypto";
import {
  CertifyRequestSchema,
  computeVerdict,
  canonicalReportString,
  canonicalReportStringFromRow,
} from "../lib/certify.js";
import type { ReportRow } from "../lib/db.js";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
    failures++;
  }
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.CERT_SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.CERT_SIGNING_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const { signReport, verifyReportSignature } = await import("../lib/signing.js");

// A failing report, since that exercises every boolean and the large error
// counts a real degraded card produces.
const request = CertifyRequestSchema.parse({
  client_version: "0.2.0",
  device_name: "AMD Radeon RX 6600",
  pcie_link_width_current: 8,
  pcie_link_width_max: 16,
  fingerprint: {
    uuid: "PCI_VEN_1002&DEV_73FF",
    pci_device_id: 29695,
    vram_total_bytes: 8573157376,
    vbios_version: "unknown",
    hash: "a".repeat(64),
  },
  stress_test: {
    dispatch_count: 513,
    duration_ms: 20012,
    telemetry_series: Array.from({ length: 12 }, (_, i) => ({
      elapsed_ms: i * 1000,
      temperature_c: 60 + i,
      power_draw_mw: 100000,
      graphics_clock_mhz: 2000,
      memory_clock_mhz: 1750,
      utilization_pct: 99,
    })),
    aborted_for_safety: true,
  },
  vram_test: {
    passes_run: 332,
    total_errors: 356482285544,
    bytes_tested: 7287183768,
    duration_ms: 20051,
    aborted_for_safety: false,
  },
  fur_test: {
    frames_rendered: 210,
    duration_ms: 10013,
    mismatches: 361,
    pixels_checked: 13762560,
    aborted_for_safety: true,
  },
});

const id = "d94f925e-8cd3-4f6a-b54a-460fe2158f5d";
const createdAt = "2026-08-13T00:24:11.243Z";
const result = computeVerdict(request);
const atIngest = canonicalReportString(id, request, result, createdAt);
const signature = signReport(atIngest);

// SQLite gives back integers for booleans and has no boolean type, so this
// mirrors exactly what the driver hands over on a read.
const row = {
  id,
  user_id: null,
  client_version: request.client_version,
  device_name: request.device_name,
  fingerprint_uuid: request.fingerprint.uuid,
  fingerprint_pci_device_id: request.fingerprint.pci_device_id,
  fingerprint_vram_total_bytes: request.fingerprint.vram_total_bytes,
  fingerprint_vbios_version: request.fingerprint.vbios_version,
  fingerprint_hash: request.fingerprint.hash,
  pcie_link_width_current: request.pcie_link_width_current,
  pcie_link_width_max: request.pcie_link_width_max,
  verdict: result.verdict,
  verdict_reasons: JSON.stringify(result.reasons),
  stress_dispatch_count: request.stress_test.dispatch_count,
  stress_duration_ms: request.stress_test.duration_ms,
  stress_peak_temp_c: result.stressPeakTempC,
  stress_thermally_stable: result.stressThermallyStable ? 1 : 0,
  stress_clock_stability_pct: result.stressClockStabilityPct,
  stress_aborted_for_safety: request.stress_test.aborted_for_safety ? 1 : 0,
  vram_passes_run: request.vram_test.passes_run,
  vram_total_errors: request.vram_test.total_errors,
  vram_bytes_tested: request.vram_test.bytes_tested,
  vram_duration_ms: request.vram_test.duration_ms,
  vram_aborted_for_safety: request.vram_test.aborted_for_safety ? 1 : 0,
  fur_frames_rendered: request.fur_test.frames_rendered,
  fur_duration_ms: request.fur_test.duration_ms,
  fur_mismatches: request.fur_test.mismatches,
  fur_pixels_checked: request.fur_test.pixels_checked,
  fur_aborted_for_safety: request.fur_test.aborted_for_safety ? 1 : 0,
  signature,
  created_at: createdAt,
} as unknown as ReportRow;

const atVerify = canonicalReportStringFromRow(row);

console.log("signing round-trip:");
check("canonical string is identical at ingest and at verification", atIngest === atVerify, `ingest: ${atIngest}\n        stored: ${atVerify}`);
check("a genuine certificate verifies", verifyReportSignature(atVerify, signature));

// Tampering must be detectable in every field the signature covers, which is
// the actual promise the certificate page makes to a buyer.
const tampered: Array<[string, Partial<ReportRow>]> = [
  ["verdict flipped to Pass", { verdict: "Pass" }],
  ["VRAM errors zeroed", { vram_total_errors: 0 }],
  ["render mismatches zeroed", { fur_mismatches: 0 }],
  ["device name swapped", { device_name: "NVIDIA GeForce RTX 4090" }],
  ["fingerprint swapped", { fingerprint_hash: "b".repeat(64) }],
  ["PCIe width faked", { pcie_link_width_current: 16 }],
  ["safety abort hidden", { stress_aborted_for_safety: 0 }],
  ["issue date moved", { created_at: "2020-01-01T00:00:00.000Z" }],
];
for (const [name, patch] of tampered) {
  const altered = { ...row, ...patch } as ReportRow;
  const valid = verifyReportSignature(canonicalReportStringFromRow(altered), signature);
  check(`tampering detected: ${name}`, !valid);
}

// Zero tolerance on render mismatches, per the verdict rules.
const clean = computeVerdict({
  ...request,
  pcie_link_width_current: 16,
  stress_test: { ...request.stress_test, aborted_for_safety: false },
  vram_test: { ...request.vram_test, total_errors: 0 },
  fur_test: { ...request.fur_test, mismatches: 0, aborted_for_safety: false },
});
check("a clean run passes", clean.verdict === "Pass", clean.reasons.join(" | "));

const oneBadPixel = computeVerdict({
  ...request,
  pcie_link_width_current: 16,
  stress_test: { ...request.stress_test, aborted_for_safety: false },
  vram_test: { ...request.vram_test, total_errors: 0 },
  fur_test: { ...request.fur_test, mismatches: 1, aborted_for_safety: false },
});
check("a single wrong pixel fails", oneBadPixel.verdict === "Fail");

const oneBadCell = computeVerdict({
  ...request,
  pcie_link_width_current: 16,
  stress_test: { ...request.stress_test, aborted_for_safety: false },
  vram_test: { ...request.vram_test, total_errors: 1 },
  fur_test: { ...request.fur_test, mismatches: 0, aborted_for_safety: false },
});
check("a single VRAM error fails", oneBadCell.verdict === "Fail");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
