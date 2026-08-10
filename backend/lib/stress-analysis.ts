import type { TelemetrySample } from "./certify";

// Turns the raw per-tick telemetry series from the stress test into a
// pass/fail-relevant assessment. Previously this telemetry was captured and
// stored but never scored — a card that throttled hard or had an unstable
// power delivery system still passed outright as long as VRAM came back
// clean. These thresholds are deliberately conservative (biased toward not
// failing a healthy card) since they're picked from general GPU thermal/
// power-limit behavior, not from real hardware runs — this dev environment
// has no real GPU to calibrate against. Revisit once there's telemetry from
// an actual Windows/GPU test run.
export interface StressAssessment {
  peakTempC: number;
  thermallyStable: boolean;
  clockStabilityPct: number;
  reasons: string[];
}

const OVER_TEMP_C = 95;
const THERMAL_CLIMB_TOLERANCE_C = 2.5;
const CLOCK_DROP_FAIL_PCT = 20;
const CLOCK_INSTABILITY_FAIL_PCT = 8;
const MIN_SAMPLES_FOR_ANALYSIS = 10;

function average(nums: number[]): number {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function inWindow(series: TelemetrySample[], durationMs: number, fromFrac: number, toFrac: number): TelemetrySample[] {
  const from = durationMs * fromFrac;
  const to = durationMs * toFrac;
  return series.filter((s) => s.elapsed_ms >= from && s.elapsed_ms <= to);
}

export function assessStressTest(series: TelemetrySample[], durationMs: number): StressAssessment {
  const peakTempC = series.length > 0 ? Math.max(...series.map((s) => s.temperature_c)) : 0;

  // Too few samples to say anything meaningful about trends (a very short
  // test, or a client that failed to sample telemetry) — don't fail a card
  // over a data-collection gap, just skip the trend-based checks.
  if (series.length < MIN_SAMPLES_FOR_ANALYSIS || durationMs <= 0) {
    return { peakTempC, thermallyStable: true, clockStabilityPct: 0, reasons: [] };
  }

  const reasons: string[] = [];

  if (peakTempC >= OVER_TEMP_C) {
    reasons.push(
      `GPU reached ${peakTempC}°C during the stress test, at or above the safe operating ceiling for consumer GPUs — indicates inadequate cooling.`
    );
  }

  // Thermal stabilization: most cards should plateau well within a 5-minute
  // sustained load. Still climbing in the final stretch suggests the cooler
  // isn't keeping up (dried paste, degraded pads, failing fan).
  const priorWindow = inWindow(series, durationMs, 0.7, 0.85);
  const lastWindow = inWindow(series, durationMs, 0.85, 1.0);
  const thermallyStable =
    priorWindow.length === 0 || lastWindow.length === 0
      ? true
      : average(lastWindow.map((s) => s.temperature_c)) - average(priorWindow.map((s) => s.temperature_c)) <=
        THERMAL_CLIMB_TOLERANCE_C;
  if (!thermallyStable) {
    reasons.push("GPU temperature was still climbing at the end of the stress test instead of stabilizing — indicates inadequate cooling.");
  }

  // Clock throttle magnitude: some clock reduction under sustained full
  // load is normal (TDP/power-limit behavior by design), but a large drop
  // from the early-run clock goes beyond typical margins.
  const earlyClockWindow = inWindow(series, durationMs, 0.05, 0.2);
  const lateClockWindow = inWindow(series, durationMs, 0.8, 1.0);
  let clockDropPct = 0;
  if (earlyClockWindow.length > 0 && lateClockWindow.length > 0) {
    const earlyAvg = average(earlyClockWindow.map((s) => s.graphics_clock_mhz));
    const lateAvg = average(lateClockWindow.map((s) => s.graphics_clock_mhz));
    clockDropPct = earlyAvg > 0 ? ((earlyAvg - lateAvg) / earlyAvg) * 100 : 0;
    if (clockDropPct > CLOCK_DROP_FAIL_PCT) {
      reasons.push(
        `GPU core clock dropped ${clockDropPct.toFixed(0)}% under sustained load, beyond typical power-limit throttling — indicates thermal or power delivery issues.`
      );
    }
  }

  // Clock instability: steady-state (post-ramp-up) clock speed jumping
  // around, rather than smoothly declining, points at a power delivery
  // problem (VRM issues) rather than expected throttle behavior.
  const steadyState = inWindow(series, durationMs, 0.2, 1.0);
  let clockStabilityPct = 0;
  if (steadyState.length > 1) {
    const clocks = steadyState.map((s) => s.graphics_clock_mhz);
    const mean = average(clocks);
    const variance = average(clocks.map((c) => (c - mean) ** 2));
    const stdDev = Math.sqrt(variance);
    clockStabilityPct = mean > 0 ? (stdDev / mean) * 100 : 0;
    if (clockStabilityPct > CLOCK_INSTABILITY_FAIL_PCT) {
      reasons.push(
        `GPU clock speed was unstable during the test (±${clockStabilityPct.toFixed(1)}% variation) — consistent with a power delivery issue.`
      );
    }
  }

  return { peakTempC, thermallyStable, clockStabilityPct, reasons };
}
