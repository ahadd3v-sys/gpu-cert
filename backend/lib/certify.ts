import { z } from "zod";

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
  }),
  vram_test: z.object({
    passes_run: z.number().int().nonnegative(),
    total_errors: z.number().nonnegative(),
    bytes_tested: z.number().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  }),
});

export type CertifyRequest = z.infer<typeof CertifyRequestSchema>;

export type Verdict = "Pass" | "Fail";

// v1 threshold, deliberately simple: any VRAM pattern-test error is a fail,
// full stop, since that directly indicates damaged/degraded memory cells
// (the whole reason this test exists per the research doc). Stress-test
// telemetry (thermal throttling, clock stability) is captured and stored
// but not yet scored — that needs real hardware runs to calibrate sane
// thresholds against, which this dev environment can't produce. Revisit
// once Ahad has data from an actual Windows/GPU test run.
export function computeVerdict(req: CertifyRequest): Verdict {
  if (req.vram_test.total_errors > 0) return "Fail";
  return "Pass";
}

// Deterministic, fixed-key-order string for the signature to cover —
// intentionally not JSON.stringify(req) directly, since object key order
// in JSON isn't guaranteed stable across serializers/re-parses, and the
// signature must verify the same way every time this payload is checked.
export function canonicalReportString(id: string, req: CertifyRequest, verdict: Verdict, createdAt: string): string {
  return JSON.stringify({
    id,
    client_version: req.client_version,
    device_name: req.device_name,
    fingerprint_hash: req.fingerprint.hash,
    verdict,
    vram_total_errors: req.vram_test.total_errors,
    vram_bytes_tested: req.vram_test.bytes_tested,
    created_at: createdAt,
  });
}
