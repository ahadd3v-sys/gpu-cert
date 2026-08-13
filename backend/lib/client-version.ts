//! Which client releases the backend still accepts.
//!
//! Until now "is this client too old" was answered by a side effect: the
//! certify route rejected anything that didn't send an attestation, and only
//! releases from v0.4.0 send one. That drew the line wherever a field happened
//! to be introduced rather than where it belongs, and it let v0.4.0 keep
//! filing certificates even though every v0.4.0 run reports exactly 4032 MiB
//! of VRAM tested regardless of card size. Five of the first seven reports in
//! the database are that bug.
//!
//! A version floor makes the line explicit and moves it to the start of a run
//! instead of the end, so someone on an old build is told to upgrade before
//! spending sixteen minutes on a test whose result will be thrown away.
//!
//! See MIN_CLIENT_VERSION below for how aggressively it is raised, and why
//! that answer is different during early access than it will be later.

/// Releases at or above this may open sessions and file certificates.
///
/// Policy during early access: **raise this with every release that fixes a
/// client bug**, and accept that it invalidates older results.
///
/// The gentler rule, keep old clients working while their results are still
/// true, is the right one for a tool with real users. It is the wrong one
/// here. There are single-digit reports in the database, every release so far
/// has fixed something that changed what a run means or whether it finishes at
/// all, and a stale result costs more than a stranded client: a certificate is
/// a claim about a card, and one produced by a build known to be broken is a
/// claim nobody should be relying on. Ahad's call, and correct while the
/// sample is this small.
///
/// Revisit when there are enough certificates in circulation that expiring
/// them is a cost rather than housekeeping.
export const MIN_CLIENT_VERSION = "0.5.4";

export const UPGRADE_MESSAGE =
  "This version of gpu-cert is no longer supported: it has a bug that affects what its results mean. " +
  "Download the current release from https://gpucert.com and run the test again.";

/// Compares dotted numeric versions. Returns <0, 0, or >0 like a C comparator.
///
/// Missing components count as zero, so "0.5" and "0.5.0" are equal, and any
/// component that isn't a number sorts as zero rather than throwing: a client
/// sending a garbage version string should be refused by the floor, not crash
/// the route.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      // Drops any prerelease or build suffix, so "0.5.1-rc1" compares as 0.5.1.
      .split(/[-+]/)[0]
      .split(".")
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });

  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isSupportedClient(version: string): boolean {
  return compareVersions(version, MIN_CLIENT_VERSION) >= 0;
}
