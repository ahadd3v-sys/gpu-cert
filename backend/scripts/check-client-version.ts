// Guards the version floor. The interesting cases are the released client
// versions themselves, because getting this comparison wrong either strands
// working clients or lets the 4032 MiB builds keep writing rows.
import { readFileSync } from "node:fs";
import { compareVersions, isSupportedClient, MIN_CLIENT_VERSION } from "../lib/client-version.js";

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label} (got ${actual}, want ${expected})`);
};

check("0.5.1 vs 0.5.1", compareVersions("0.5.1", "0.5.1"), 0);
check("0.5 vs 0.5.0", compareVersions("0.5", "0.5.0"), 0);
check("0.10.0 > 0.9.0", compareVersions("0.10.0", "0.9.0") > 0, true);
check("0.4.2 < 0.5.1", compareVersions("0.4.2", "0.5.1") < 0, true);
check("v-prefix tolerated", compareVersions("v0.5.1", "0.5.1"), 0);
check("prerelease stripped", compareVersions("0.5.1-rc1", "0.5.1"), 0);
check("garbage sorts low", compareVersions("nonsense", "0.5.1") < 0, true);

// Every version that has ever submitted a report or opened a session, plus
// every superseded release. Each entry here was current once.
for (const old of [
  "0.1.0", "0.1.7", "0.1.8", "0.2.0", "0.3.0", "0.3.1",
  "0.4.0", "0.4.1", "0.4.2", "0.5.1", "0.5.2", "0.5.3",
]) {
  check(`${old} refused`, isSupportedClient(old), false);
}

// The floor must never sit above the client actually being shipped, or every
// honest run is turned away the moment it starts. Read from Cargo.toml rather
// than restated here, because a second copy of a version number is a second
// thing to forget.
//
// Equality is not required. A release that changes nothing about what a run
// means, console output for instance, should not expire everyone's results.
const cargo = readFileSync(new URL("../../client/Cargo.toml", import.meta.url), "utf8");
const shipped = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
check("the floor never exceeds the shipped client", compareVersions(MIN_CLIENT_VERSION, shipped) <= 0, true);
check("the shipped client is accepted by the floor", isSupportedClient(shipped), true);
check(`${MIN_CLIENT_VERSION} accepted`, isSupportedClient(MIN_CLIENT_VERSION), true);
check("1.0.0 accepted", isSupportedClient("1.0.0"), true);

if (failures > 0) {
  console.error(`\n${failures} version check(s) failed`);
  process.exit(1);
}
console.log("\nclient version floor ok");
