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
  hotspot_temperature_c?: number;
  memory_temperature_c?: number;
  fan_rpm?: number;
  fan_percent?: number;
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
  /// How far the hotspot sits above the edge. 30 is a healthy RDNA card.
  hotspotDelta?: number;
  memTemp?: number;
  fanRpm?: number;
  fanPercent?: number;
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
      ...(opts.hotspotDelta != null
        ? {
            hotspot_temperature_c:
              Math.round(opts.startTemp + (opts.steadyTemp - opts.startTemp) * settle) + opts.hotspotDelta,
          }
        : {}),
      ...(opts.memTemp != null ? { memory_temperature_c: opts.memTemp } : {}),
      ...(opts.fanRpm != null ? { fan_rpm: opts.fanRpm } : {}),
      ...(opts.fanPercent != null ? { fan_percent: opts.fanPercent } : {}),
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

// ------------------------------------------------- sensors only some cards have

// A healthy RDNA delta. 30 C above edge is normal and must never be a finding.
const normalDelta = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 68, hotspotDelta: 30 }),
  D
);
check("a normal 30C hotspot delta is not a finding", normalDelta.reasons.length === 0, normalDelta.reasons.join("; "));

// The signature that identified defective RDNA 4 cards in the field: an
// unremarkable edge with the junction far above it.
// Edge deliberately low: when heat is not reaching the cooler it is not
// reaching the edge sensor either, which is exactly why the edge alone looks
// reassuring on these cards. 50 C edge with a 100 C junction, still under the
// limit, so this tests the delta rule and not the junction one.
const badContact = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 35, steadyTemp: 50, hotspotDelta: 50 }),
  D
);
check(
  "an abnormal hotspot delta is reported even when the edge looks fine",
  badContact.reasons.some((r) => r.includes("not reaching the cooler")),
  badContact.reasons.join("; ")
);

// Past the junction limit, which is the card failing to move its own heat.
const cooking = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 60, steadyTemp: 72, hotspotDelta: 38 }),
  D
);
check("a hotspot past the junction limit fails", cooking.reasons.some((r) => r.includes("junction limit")), cooking.reasons.join("; "));

// Memory hot enough to be throttling, on a card whose core looks fine. This is
// the pad wear a mined card has, and memory is what this product certifies.
const hotMemory = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 62, memTemp: 102 }),
  D
);
check("hot memory is reported even with a cool core", hotMemory.reasons.some((r) => r.includes("thermal pads")), hotMemory.reasons.join("; "));

// A fan being asked for 60% that is not turning.
const deadFan = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 78, fanRpm: 0, fanPercent: 60 }),
  D
);
check("a stalled fan is reported", deadFan.reasons.some((r) => r.includes("did not turn")), deadFan.reasons.join("; "));

// A working fan must not be.
const goodFan = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 68, fanRpm: 1650, fanPercent: 60 }),
  D
);
check("a spinning fan is not", goodFan.reasons.length === 0, goodFan.reasons.join("; "));

// The rule that matters most: a card that cannot report these sensors is not
// accused of anything. NVIDIA reports none of them.
const noSensors = assessStressTest(
  series({ durationMs: D, startClock: 1900, endClock: 1820, startTemp: 45, steadyTemp: 68 }),
  D
);
check("a card that reports no extra sensors is not accused", noSensors.reasons.length === 0, noSensors.reasons.join("; "));
check("and its unknown readings stay null rather than defaulting", noSensors.peakHotspotC == null && noSensors.peakMemoryC == null);

if (failures > 0) {
  console.error(`\n${failures} stress-analysis check(s) failed`);
  process.exit(1);
}
console.log("\nstress analysis ok");
