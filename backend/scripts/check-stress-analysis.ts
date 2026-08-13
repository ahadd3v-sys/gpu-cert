// Guards the stress scoring against false failures.
//
// A false FAIL is the worst outcome this product can produce. A card that
// passes when it should fail costs one buyer one bad purchase; a card that
// fails when it is healthy destroys a seller's listing and their trust in the
// certificate, and they have no way to argue with it.
//
// The case that motivated this file: an RX 6600 BIOS-locked to 100 W. Under a
// stress kernel heavy enough to hold it at that cap, it boosts high while cold
// and settles far down, which the old rule scored as a power delivery fault.
import { assessStressTest } from "../lib/stress-analysis.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? "  (" + detail + ")" : ""}`);
};

type Sample = {
  elapsed_ms: number;
  temperature_c: number;
  power_draw_mw: number;
  graphics_clock_mhz: number;
  memory_clock_mhz: number;
  utilization_pct: number;
};

/// Temperature approaches its steady state rather than climbing linearly,
/// because that is what a real card does and because a linear ramp trips the
/// "still climbing at the end" check on its own, which would mask whatever the
/// fixture was actually meant to test.
function series(opts: {
  durationMs: number;
  startClock: number;
  endClock: number;
  startTemp: number;
  steadyTemp: number;
  jitter?: number;
}): Sample[] {
  const n = 300;
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const settle = 1 - Math.exp(-5 * f);
    const jitter = opts.jitter ? (i % 2 === 0 ? opts.jitter : -opts.jitter) : 0;
    out.push({
      elapsed_ms: Math.round(f * opts.durationMs),
      temperature_c: Math.round(opts.startTemp + (opts.steadyTemp - opts.startTemp) * settle),
      power_draw_mw: 100_000,
      // Linear, not settling: the drop is measured between an early window and
      // a late one, and a curve that settles inside the early window hides most
      // of it. Declining steadily across the run is also what a throttling card
      // actually does, since the clock tracks the temperature building.
      graphics_clock_mhz: Math.round(
        opts.startClock + (opts.endClock - opts.startClock) * f + jitter
      ),
      memory_clock_mhz: 1750,
      utilization_pct: 99,
    });
  }
  return out;
}

const D = 300_000;

// The RX 6600 at its 100 W cap: boosts to 2650 cold, settles at 1900 (28%
// down), never gets hot. Normal, and must pass.
const powerCapped = assessStressTest(series({ durationMs: D, startClock: 2650, endClock: 1400, startTemp: 45, steadyTemp: 62 }), D);
check("a power-limited card that drops 39% while staying cool passes", powerCapped.reasons.length === 0, powerCapped.reasons.join("; "));

// Identical clock behaviour, hot card. Only the temperature differs, which is
// exactly the distinction the change introduced.
const throttling = assessStressTest(series({ durationMs: D, startClock: 2650, endClock: 1400, startTemp: 60, steadyTemp: 88 }), D);
check("the same drop while hot is reported", throttling.reasons.some((r) => r.includes("thermal throttling")), throttling.reasons.join("; "));

// Over-temperature is independent of clocks.
const hot = assessStressTest(series({ durationMs: D, startClock: 2000, endClock: 2000, startTemp: 80, steadyTemp: 97 }), D);
check("a card crossing 95C fails regardless of clocks", hot.reasons.length > 0, hot.reasons.join("; "));

// Jittering clocks are a VRM signal and stay a failure at any temperature.
const jittery = assessStressTest(series({ durationMs: D, startClock: 2000, endClock: 2000, startTemp: 50, steadyTemp: 58, jitter: 400 }), D);
check("unstable clocks still fail while cool", jittery.reasons.some((r) => r.includes("unstable")), jittery.reasons.join("; "));

// A healthy card that barely moves must be clean.
const healthy = assessStressTest(series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 68 }), D);
check("a healthy card passes cleanly", healthy.reasons.length === 0, healthy.reasons.join("; "));

if (failures > 0) {
  console.error(`\n${failures} stress-analysis check(s) failed`);
  process.exit(1);
}
console.log("\nstress analysis ok");
