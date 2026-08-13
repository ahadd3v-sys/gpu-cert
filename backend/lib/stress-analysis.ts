import type { TelemetrySample } from "./certify.js";

// Turns the raw per-tick telemetry series from the stress test into a
// pass/fail-relevant assessment. Previously this telemetry was captured and
// stored but never scored, a card that throttled hard or had an unstable
// power delivery system still passed outright as long as VRAM came back
// clean. These thresholds are deliberately conservative (biased toward not
// failing a healthy card) since they're picked from general GPU thermal/
// power-limit behavior, not from real hardware runs. This dev environment
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
/// Raised from 20, and no longer sufficient on its own. See the check below.
const CLOCK_DROP_FAIL_PCT = 35;

/// A clock drop only counts against a card if the card was also hot.
///
/// 20% with no temperature condition was calibrated against a stress kernel
/// that turned out not to stress anything: it drew 149 W on a 220 W RTX 3070
/// and its working set fit in cache. Against the real load that replaced it, a
/// perfectly healthy card drops much further, because that is what a power
/// limit is for.
///
/// This project's own AMD test card is BIOS-locked to 100 W. Its telemetry
/// under the old kernel read 100 W average and 100 W peak, flat, which is the
/// signature of a card pegged at its cap rather than one being worked lightly.
/// Under a heavier load it will boost high while cold and settle well down, and
/// the old rule would have called that a power delivery fault on a card that is
/// behaving exactly as designed.
///
/// The distinction that actually carries information: a large clock drop at a
/// moderate temperature is power-limit behaviour and normal. The same drop with
/// the card hot is thermal throttling and worth reporting. Requiring both means
/// a power-capped card can never fail this check on its cap alone.
const CLOCK_DROP_NEEDS_TEMP_C = 80;
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
  // test, or a client that failed to sample telemetry), don't fail a card
  // over a data-collection gap, just skip the trend-based checks.
  if (series.length < MIN_SAMPLES_FOR_ANALYSIS || durationMs <= 0) {
    return { peakTempC, thermallyStable: true, clockStabilityPct: 0, reasons: [] };
  }

  const reasons: string[] = [];

  if (peakTempC >= OVER_TEMP_C) {
    reasons.push(
      `GPU reached ${peakTempC}°C during the stress test, at or above the safe operating ceiling for consumer GPUs. This indicates inadequate cooling.`
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
    reasons.push("GPU temperature was still climbing at the end of the stress test instead of stabilizing. This indicates inadequate cooling.");
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
    if (clockDropPct > CLOCK_DROP_FAIL_PCT && peakTempC >= CLOCK_DROP_NEEDS_TEMP_C) {
      reasons.push(
        `GPU core clock dropped ${clockDropPct.toFixed(0)}% under sustained load while reaching ${peakTempC}\u00b0C. A drop that large together with that temperature is thermal throttling rather than normal power-limit behaviour, and points at cooling or power delivery.`
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

    // Sample-to-sample movement, not spread about the mean.
    //
    // Standard deviation cannot tell a smoothly declining clock from a jittery
    // one: a card sliding steadily from 2650 to 1400 under its power cap has a
    // large deviation about its mean and no instability at all, and the old
    // metric called that a power delivery fault. Since the comment above always
    // said "jumping around, rather than smoothly declining", the metric was
    // simply not measuring what it claimed to.
    //
    // Averaging the absolute step between consecutive samples separates them.
    // A monotonic decline moves a fraction of a percent per sample however
    // steep it is overall; a clock oscillating between two states moves the
    // full gap every time.
    const steps: number[] = [];
    for (let i = 1; i < clocks.length; i++) {
      steps.push(Math.abs(clocks[i] - clocks[i - 1]));
    }
    clockStabilityPct = mean > 0 ? (average(steps) / mean) * 100 : 0;
    if (clockStabilityPct > CLOCK_INSTABILITY_FAIL_PCT) {
      reasons.push(
        `GPU clock speed was unstable during the test (±${clockStabilityPct.toFixed(1)}% variation), consistent with a power delivery issue.`
      );
    }
  }

  return { peakTempC, thermallyStable, clockStabilityPct, reasons };
}
