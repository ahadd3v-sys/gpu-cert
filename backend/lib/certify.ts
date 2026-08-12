import { z } from "zod";
import { assessStressTest } from "./stress-analysis.js";

// Field names match the Rust client's `serde`-serialized struct names
// exactly (client/src/report.rs) — snake_case, no renaming on either side.
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
    passes_run: z.number().int().nonnegative(),
    total_errors: z.number().nonnegative(),
    bytes_tested: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    aborted_for_safety: z.boolean(),
  }),
  // Graphics-pipeline correctness/display-output check — see
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
  // Human-readable, one per failing check, empty on Pass — this is what
  // the certificate page shows under "why this failed" so a Fail isn't
  // just an unexplained red badge.
  reasons: string[];
  stressPeakTempC: number;
  stressThermallyStable: boolean;
  stressClockStabilityPct: number;
}

// Real corruption produces many wrong pixels, not one borderline sample near
// a legitimate floating-point/quantization edge (see fur_test.rs's own
// epsilon for the per-pixel tolerance) — 1% gives room for that noise while
// still catching anything systematic.
const FUR_MISMATCH_FAIL_FRACTION = 0.01;

// Any VRAM pattern-test error is a fail, full stop, since that directly
// indicates damaged/degraded memory cells (the whole reason this test
// exists per the research doc). Stress-test telemetry (thermal throttling,
// clock stability) used to be captured and stored but never scored — see
// stress-analysis.ts for what changed and why those thresholds are
// conservative pending real hardware data.
export function computeVerdict(req: CertifyRequest): VerdictResult {
  const reasons: string[] = [];

  if (req.vram_test.total_errors > 0) {
    const errCount = req.vram_test.total_errors;
    reasons.push(
      `${errCount} VRAM pattern-test error${errCount === 1 ? "" : "s"} detected — indicates damaged or degraded memory cells.`
    );
  }

  const stress = assessStressTest(req.stress_test.telemetry_series, req.stress_test.duration_ms);
  reasons.push(...stress.reasons);

  // A safety-triggered abort stops a test early (see client/src/safety.rs)
  // before hardware damage, but it's also itself a certifiable finding —
  // a card that can't finish a standard test run without overheating is a
  // real defect, not a report that should just be discarded.
  if (req.stress_test.aborted_for_safety) {
    reasons.push("Stress test stopped early because the GPU reached an unsafe temperature — indicates inadequate cooling.");
  }
  if (req.vram_test.aborted_for_safety) {
    reasons.push("VRAM test stopped early because the GPU reached an unsafe temperature — indicates inadequate cooling.");
  }
  if (req.fur_test.aborted_for_safety) {
    reasons.push("Render integrity test stopped early because the GPU reached an unsafe temperature — indicates inadequate cooling.");
  }

  if (req.pcie_link_width_current < req.pcie_link_width_max) {
    reasons.push(
      `PCIe link running at x${req.pcie_link_width_current} instead of its x${req.pcie_link_width_max} maximum — indicates a connector, slot, or riser cable issue.`
    );
  }

  if (req.fur_test.pixels_checked > 0) {
    const mismatchFraction = req.fur_test.mismatches / req.fur_test.pixels_checked;
    if (mismatchFraction > FUR_MISMATCH_FAIL_FRACTION) {
      reasons.push(
        `Render integrity test found ${req.fur_test.mismatches} of ${req.fur_test.pixels_checked} sample pixels computed incorrectly under load — indicates a GPU compute or rendering defect.`
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

// Deterministic, fixed-key-order string for the signature to cover —
// intentionally not JSON.stringify(req) directly, since object key order
// in JSON isn't guaranteed stable across serializers/re-parses, and the
// signature must verify the same way every time this payload is checked.
export function canonicalReportString(id: string, req: CertifyRequest, result: VerdictResult, createdAt: string): string {
  return JSON.stringify({
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
