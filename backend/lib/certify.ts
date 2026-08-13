import { z } from "zod";
import { assessStressTest } from "./stress-analysis.js";
import type { ReportRow } from "./db.js";

// Field names match the Rust client's `serde`-serialized struct names
// exactly (client/src/report.rs), snake_case, no renaming on either side.
export const TelemetrySampleSchema = z.object({
  elapsed_ms: z.number().int().nonnegative(),
  temperature_c: z.number().int(),
  power_draw_mw: z.number().int().nonnegative(),
  graphics_clock_mhz: z.number().int().nonnegative(),
  memory_clock_mhz: z.number().int().nonnegative(),
  // Clamped, not hard-validated: NVML on the client already clamps this to
  // 0-100, but a `.max(100)` here would fail the *entire* telemetry_series
  // array (safeParse validates atomically) over a single transient
  // out-of-range reading from any client, discarding an otherwise-valid
  // multi-minute test run. Coerce out-of-range values into range instead of
  // rejecting the sample (or report) outright.
  utilization_pct: z
    .number()
    .int()
    .transform((v) => Math.min(100, Math.max(0, v))),
});

export const CertifyRequestSchema = z.object({
  // Optional in the schema, required by the route. Clients released before
  // attestation existed don't send it, and rejecting those with a generic
  // "invalid report payload" would tell someone who just spent 16 minutes
  // nothing useful. Kept optional here so the route can answer with a real
  // explanation instead.
  attestation: z
    .object({
      session_id: z.string().min(1),
      nonce: z.string().min(1),
    })
    .optional(),
  client_version: z.string(),
  device_name: z.string(),
  pcie_link_width_current: z.number().int().nonnegative(),
  pcie_link_width_max: z.number().int().nonnegative(),
  fingerprint: z.object({
    uuid: z.string(),
    pci_device_id: z.number().int().nonnegative(),
    vram_total_bytes: z.number().nonnegative(),
    vbios_version: z.string(),
    hash: z.string(),
  }),
  stress_test: z.object({
    dispatch_count: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    telemetry_series: z.array(TelemetrySampleSchema),
    aborted_for_safety: z.boolean(),
  }),
  vram_test: z.object({
    // Optional so a client released before this field existed still validates.
    diagnostics: z.string().max(600).optional(),
    passes_run: z.number().int().nonnegative(),
    total_errors: z.number().nonnegative(),
    bytes_tested: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    aborted_for_safety: z.boolean(),
  }),
  // Graphics-pipeline correctness/display-output check, see
  // client/src/vulkan/fur_test.rs. The compute stress kernel never checks
  // its own output and never touches the rasterizer/ROP path; this does
  // both, by rendering a shader whose output is a deterministic function
  // the backend could in principle re-derive, so mismatches indicate real
  // compute/rendering defects, not just "ran without crashing."
  fur_test: z.object({
    frames_rendered: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    mismatches: z.number().int().nonnegative(),
    pixels_checked: z.number().int().nonnegative(),
    aborted_for_safety: z.boolean(),
  }),
});

export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;
export type CertifyRequest = z.infer<typeof CertifyRequestSchema>;

export type Verdict = "Pass" | "Fail";

export interface VerdictResult {
  verdict: Verdict;
  // Human-readable, one per failing check, empty on Pass. This is what
  // the certificate page shows under "why this failed" so a Fail isn't
  // just an unexplained red badge.
  reasons: string[];
  stressPeakTempC: number;
  stressThermallyStable: boolean;
  stressClockStabilityPct: number;
}

// Zero tolerance, exactly like the VRAM test, and for the same reason: a
// mismatch is now unambiguous.
//
// This used to allow 1%, which was the right call when the render test
// compared floating-point output against a CPU-recomputed reference, GPU and
// CPU float results legitimately differ, so some noise floor was unavoidable
// and any threshold was really a guess about how much. That test has been
// replaced by an exact integer comparison (see client/src/vulkan/fur_test.rs),
// where the GPU and the CPU must produce identical bits on every conformant
// implementation. There is no noise left to absorb, so a tolerance would only
// be hiding real defects.
const FUR_MISMATCH_FAIL_FRACTION = 0;

// Any VRAM pattern-test error is a fail, full stop, since that directly
// indicates damaged/degraded memory cells (the whole reason this test
// exists per the research doc). Stress-test telemetry (thermal throttling,
// clock stability) used to be captured and stored but never scored, see
// stress-analysis.ts for what changed and why those thresholds are
// conservative pending real hardware data.
export function computeVerdict(req: CertifyRequest): VerdictResult {
  const reasons: string[] = [];

  if (req.vram_test.total_errors > 0) {
    const errCount = req.vram_test.total_errors;
    reasons.push(
      `${errCount.toLocaleString("en-US")} VRAM pattern-test error${errCount === 1 ? "" : "s"} detected. This indicates damaged or degraded memory cells.`
    );
  }

  const stress = assessStressTest(req.stress_test.telemetry_series, req.stress_test.duration_ms);
  reasons.push(...stress.reasons);

  // A safety-triggered abort stops a test early (see client/src/safety.rs)
  // before hardware damage, but it's also itself a certifiable finding:
  // a card that can't finish a standard test run without overheating is a
  // real defect, not a report that should just be discarded.
  if (req.stress_test.aborted_for_safety) {
    reasons.push("Stress test stopped early because the GPU reached an unsafe temperature. This indicates inadequate cooling.");
  }
  if (req.vram_test.aborted_for_safety) {
    reasons.push("VRAM test stopped early because the GPU reached an unsafe temperature. This indicates inadequate cooling.");
  }
  if (req.fur_test.aborted_for_safety) {
    reasons.push("Render integrity test stopped early because the GPU reached an unsafe temperature. This indicates inadequate cooling.");
  }

  if (req.pcie_link_width_current < req.pcie_link_width_max) {
    reasons.push(
      `PCIe link running at x${req.pcie_link_width_current} instead of its x${req.pcie_link_width_max} maximum. This indicates a connector, slot, or riser cable issue.`
    );
  }

  if (req.fur_test.pixels_checked > 0) {
    const mismatchFraction = req.fur_test.mismatches / req.fur_test.pixels_checked;
    if (mismatchFraction > FUR_MISMATCH_FAIL_FRACTION) {
      reasons.push(
        `Render integrity test found ${req.fur_test.mismatches.toLocaleString("en-US")} of ${req.fur_test.pixels_checked.toLocaleString("en-US")} pixels computed incorrectly under load. This indicates a GPU compute or rendering defect.`
      );
    }
  }

  return {
    verdict: reasons.length > 0 ? "Fail" : "Pass",
    reasons,
    stressPeakTempC: stress.peakTempC,
    stressThermallyStable: stress.thermallyStable,
    stressClockStabilityPct: stress.clockStabilityPct,
  };
}

// Every field the signature commits to. Written out as an explicit shape,
// with exactly one place that serializes it, because signing and verifying
// have to agree byte for byte forever: a certificate signed today must still
// verify years from now, and the two code paths that build this string are in
// different files and run at different times (ingest vs. someone checking a
// stranger's certificate). If they were assembled independently, any
// divergence would silently turn every existing certificate invalid.
export interface CanonicalReport {
  id: string;
  client_version: string;
  device_name: string;
  fingerprint_hash: string;
  verdict: string;
  vram_total_errors: number;
  vram_bytes_tested: number;
  stress_peak_temp_c: number;
  stress_thermally_stable: boolean;
  stress_aborted_for_safety: boolean;
  vram_aborted_for_safety: boolean;
  pcie_link_width_current: number;
  pcie_link_width_max: number;
  fur_mismatches: number;
  fur_pixels_checked: number;
  fur_aborted_for_safety: boolean;
  created_at: string;
}

// Deterministic, fixed-key-order string for the signature to cover:
// intentionally not JSON.stringify(req) directly, since object key order
// in JSON isn't guaranteed stable across serializers/re-parses, and the
// signature must verify the same way every time this payload is checked.
//
// The key order here IS the wire format. Reordering, adding, or removing a
// field invalidates every certificate ever issued.
export function canonicalString(r: CanonicalReport): string {
  return JSON.stringify({
    id: r.id,
    client_version: r.client_version,
    device_name: r.device_name,
    fingerprint_hash: r.fingerprint_hash,
    verdict: r.verdict,
    vram_total_errors: r.vram_total_errors,
    vram_bytes_tested: r.vram_bytes_tested,
    stress_peak_temp_c: r.stress_peak_temp_c,
    stress_thermally_stable: r.stress_thermally_stable,
    stress_aborted_for_safety: r.stress_aborted_for_safety,
    vram_aborted_for_safety: r.vram_aborted_for_safety,
    pcie_link_width_current: r.pcie_link_width_current,
    pcie_link_width_max: r.pcie_link_width_max,
    fur_mismatches: r.fur_mismatches,
    fur_pixels_checked: r.fur_pixels_checked,
    fur_aborted_for_safety: r.fur_aborted_for_safety,
    created_at: r.created_at,
  });
}

// The ingest side: what gets signed when a report first arrives.
export function canonicalReportString(id: string, req: CertifyRequest, result: VerdictResult, createdAt: string): string {
  return canonicalString({
    id,
    client_version: req.client_version,
    device_name: req.device_name,
    fingerprint_hash: req.fingerprint.hash,
    verdict: result.verdict,
    vram_total_errors: req.vram_test.total_errors,
    vram_bytes_tested: req.vram_test.bytes_tested,
    stress_peak_temp_c: result.stressPeakTempC,
    stress_thermally_stable: result.stressThermallyStable,
    stress_aborted_for_safety: req.stress_test.aborted_for_safety,
    vram_aborted_for_safety: req.vram_test.aborted_for_safety,
    pcie_link_width_current: req.pcie_link_width_current,
    pcie_link_width_max: req.pcie_link_width_max,
    fur_mismatches: req.fur_test.mismatches,
    fur_pixels_checked: req.fur_test.pixels_checked,
    fur_aborted_for_safety: req.fur_test.aborted_for_safety,
    created_at: createdAt,
  });
}

// The verification side: rebuilds the exact same payload from what was
// stored, so a third party can re-derive it and check the signature.
//
// SQLite has no boolean type, so the flags come back as 0/1 and have to be
// converted rather than passed through, `0` would serialize as `0`, not
// `false`, and the signature would never match. Numbers go through
// `Number()` for the same class of reason: the driver may hand back a
// BigInt for a large integer column, and `JSON.stringify` throws on those.
export function canonicalReportStringFromRow(row: ReportRow): string {
  return canonicalString({
    id: row.id,
    client_version: row.client_version,
    device_name: row.device_name,
    fingerprint_hash: row.fingerprint_hash,
    verdict: row.verdict,
    vram_total_errors: Number(row.vram_total_errors),
    vram_bytes_tested: Number(row.vram_bytes_tested),
    stress_peak_temp_c: Number(row.stress_peak_temp_c),
    stress_thermally_stable: Number(row.stress_thermally_stable) === 1,
    stress_aborted_for_safety: Number(row.stress_aborted_for_safety) === 1,
    vram_aborted_for_safety: Number(row.vram_aborted_for_safety) === 1,
    pcie_link_width_current: Number(row.pcie_link_width_current),
    pcie_link_width_max: Number(row.pcie_link_width_max),
    fur_mismatches: Number(row.fur_mismatches),
    fur_pixels_checked: Number(row.fur_pixels_checked),
    fur_aborted_for_safety: Number(row.fur_aborted_for_safety) === 1,
    created_at: row.created_at,
  });
}
