// Makes a certificate mean "this card was tested" rather than "someone sent us
// these numbers".
//
// The problem this exists for: /api/certify used to sign whatever JSON it was
// handed. A seller with a mining-damaged card could publish a flawless,
// genuinely-signed, genuinely-verifying certificate with one curl. Every other
// guarantee in this product sits on top of that one, so it was worth very
// little.
//
// There is no way to make a user-controlled client provably honest. The client
// runs on their machine; they can patch it. So the goal here is not proof, it
// is cost. Forging a certificate should require sitting through a real test
// run rather than sending one request, and the numbers should have to hold
// together well enough that a casual forgery fails.
//
// Three layers, in increasing order of how hard they are to defeat:
//
//   1. Internal consistency. Some values in a report are arithmetically bound
//      to others, so a hand-written payload trips over itself.
//   2. Physical plausibility. No GPU has ever had 40 TB/s of memory bandwidth.
//   3. Server-measured wall-clock time. This is the layer that actually costs
//      an attacker something: the server, not the client, decides how long the
//      session was open, and a 16-minute claim needs 16 minutes of real time
//      and heartbeats spread across them.

import type { CertifyRequest } from "./certify.js";

/// The render test's framebuffer is 256x256, and it checks every pixel of
/// every frame (client/src/vulkan/fur_test.rs). So pixels_checked is not a
/// free variable: it is frames_rendered times this. Changing the resolution in
/// the client means changing it here too, which is why it is stated in one
/// place with a comment rather than inlined as a magic number.
export const RENDER_PIXELS_PER_FRAME = 256 * 256;

/// Well above any real hardware. HBM3E tops out around 8 TB/s and consumer
/// cards are an order of magnitude below that, so this only catches invented
/// numbers, never a fast card. Deliberately not tuned per-device: the point is
/// to be impossible to argue with, not to be tight.
const MAX_PLAUSIBLE_BANDWIDTH_BYTES_PER_SEC = 40e12;

/// How much shorter than its claimed test time a session may be. Some slack is
/// required and honest: the claimed durations are measured inside each test,
/// while the session spans setup, the CPU reference build, telemetry init and
/// the upload, so wall-clock is normally *longer*. This only catches a client
/// claiming substantially more testing than the session was even open for.
const MIN_WALLCLOCK_RATIO = 0.8;

/// Runs longer than this must have checked in at least once. Short debug runs
/// are exempt so that a `--fast` run doesn't need heartbeat plumbing to work.
const HEARTBEAT_REQUIRED_AFTER_MS = 120_000;

/// Roughly one per minute of testing, minus generous slack for a client that
/// was slow to start or lost a request. Heartbeats are best-effort on the
/// client, so this must not be tight enough to fail an honest run on a flaky
/// connection.
function expectedMinimumHeartbeats(claimedTotalMs: number): number {
  if (claimedTotalMs <= HEARTBEAT_REQUIRED_AFTER_MS) return 0;
  return Math.max(1, Math.floor(claimedTotalMs / 120_000));
}

export interface SessionRecord {
  id: string;
  fingerprint_hash: string;
  started_at: string;
  progress_count: number;
  consumed_at: string | null;
  client_version: string;
}

/// How long a session stays fileable. Generous, because a run whose upload
/// failed is saved to disk and filed later with --resubmit, and someone
/// offline overnight should not lose sixteen minutes of testing. Bounded at
/// all because an unconsumed session is a standing permission to file, and a
/// permission with no expiry is one an old client can sit on indefinitely.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface AttestationResult {
  ok: boolean;
  /// Phrased for a log, not for the person submitting: a forger shouldn't be
  /// handed a checklist of what to fix. The route returns a flat refusal.
  problems: string[];
}

export function claimedTotalDurationMs(req: CertifyRequest): number {
  return req.stress_test.duration_ms + req.vram_test.duration_ms + req.fur_test.duration_ms;
}

/// Checks that only involve the report itself. Split out from the session
/// checks so it can be unit tested without a database, and so a report can be
/// sanity-checked even in contexts where no session applies.
export function checkReportConsistency(req: CertifyRequest): string[] {
  const problems: string[] = [];

  // Every pixel of every frame is checked, so this is a fixed relationship.
  // A forger picking round numbers for "frames" and "pixels" independently
  // lands here first.
  const expectedPixels = req.fur_test.frames_rendered * RENDER_PIXELS_PER_FRAME;
  if (req.fur_test.pixels_checked !== expectedPixels) {
    problems.push(
      `render pixels_checked ${req.fur_test.pixels_checked} != frames_rendered ${req.fur_test.frames_rendered} * ${RENDER_PIXELS_PER_FRAME} (${expectedPixels})`
    );
  }

  // Can't have found more wrong pixels than were looked at.
  if (req.fur_test.mismatches > req.fur_test.pixels_checked) {
    problems.push(
      `render mismatches ${req.fur_test.mismatches} exceeds pixels_checked ${req.fur_test.pixels_checked}`
    );
  }

  // Same for memory: each pass compares every tested element once, so errors
  // are bounded by passes times elements.
  const elementsPerPass = Math.floor(req.vram_test.bytes_tested / 4);
  const maxVramErrors = elementsPerPass * req.vram_test.passes_run;
  if (req.vram_test.passes_run > 0 && req.vram_test.total_errors > maxVramErrors) {
    problems.push(
      `vram total_errors ${req.vram_test.total_errors} exceeds ${maxVramErrors} possible over ${req.vram_test.passes_run} pass(es)`
    );
  }

  // A pass writes and then reads back everything it tested.
  if (req.vram_test.duration_ms > 0) {
    const bytesMoved = req.vram_test.bytes_tested * 2 * req.vram_test.passes_run;
    const bytesPerSecond = bytesMoved / (req.vram_test.duration_ms / 1000);
    if (bytesPerSecond > MAX_PLAUSIBLE_BANDWIDTH_BYTES_PER_SEC) {
      problems.push(
        `vram test implies ${(bytesPerSecond / 1e9).toFixed(0)} GB/s, beyond any real hardware`
      );
    }
  }

  // Work claimed but no time taken, in either direction.
  if (req.vram_test.passes_run > 0 && req.vram_test.duration_ms === 0) {
    problems.push("vram passes ran in zero time");
  }
  if (req.fur_test.frames_rendered > 0 && req.fur_test.duration_ms === 0) {
    problems.push("render frames drawn in zero time");
  }
  if (req.stress_test.dispatch_count > 0 && req.stress_test.duration_ms === 0) {
    problems.push("stress dispatches ran in zero time");
  }

  // The stress test samples telemetry after every dispatch, so a multi-minute
  // run that produced no samples at all did not happen the way it claims.
  if (req.stress_test.duration_ms > 60_000 && req.stress_test.telemetry_series.length === 0) {
    problems.push(
      `stress test claims ${Math.round(req.stress_test.duration_ms / 1000)}s but reported no telemetry samples`
    );
  }

  // Telemetry timestamps are elapsed-within-the-test, so they cannot run past
  // the test itself.
  const lastSample = req.stress_test.telemetry_series.at(-1);
  if (lastSample && lastSample.elapsed_ms > req.stress_test.duration_ms + 5_000) {
    problems.push(
      `stress telemetry runs to ${lastSample.elapsed_ms}ms, past the ${req.stress_test.duration_ms}ms test`
    );
  }

  return problems;
}

/// The real test durations in the client (client/src/main.rs). A certificate is
/// a claim about how hard the card was worked, so a run substantially shorter
/// than these is not one, however honestly it was produced.
///
/// These must track the client's constants. If a release changes a duration,
/// change it here in the same commit or every honest run starts failing.
const REAL_TEST_DURATION_MS = {
  stress: 5 * 60_000,
  vram: 5 * 60_000,
  fur: 45_000,
} as const;

/// Slack for a test that overshoots or undershoots its target slightly. Wide,
/// because this is separating twenty seconds from ten minutes, not policing
/// precision.
const MIN_DURATION_RATIO = 0.5;

/// Whether this run is long enough to be worth a certificate at all.
///
/// `--fast` exists so the client can be iterated on without burning sixteen
/// minutes per rebuild, and it prints "not a real certificate" when it starts.
/// The server believed otherwise: a twenty second debug run produced a signed,
/// public, passing certificate that differed from a real one only in the
/// duration figures printed on it. A buyer reading a bold PASS is not going to
/// reason about "0m 20s".
///
/// Checked server side rather than by trusting a flag from the client, because
/// a client that wants to lie about this would simply not send the flag.
///
/// A test aborted by the safety watchdog is exempt: stopping early because the
/// card crossed 100C is a finding, and refusing to certify it would throw away
/// the most important result the tool can produce.
export function checkCertifiableRun(req: CertifyRequest): string[] {
  const problems: string[] = [];
  const tooShort = (
    label: string,
    actualMs: number,
    requiredMs: number,
    aborted: boolean
  ) => {
    if (aborted) return;
    if (actualMs < requiredMs * MIN_DURATION_RATIO) {
      problems.push(
        `the ${label} ran ${Math.round(actualMs / 1000)}s, short of the ${Math.round(requiredMs / 1000)}s a certificate represents`
      );
    }
  };

  tooShort(
    "stress test",
    req.stress_test.duration_ms,
    REAL_TEST_DURATION_MS.stress,
    req.stress_test.aborted_for_safety
  );
  tooShort(
    "VRAM test",
    req.vram_test.duration_ms,
    REAL_TEST_DURATION_MS.vram,
    req.vram_test.aborted_for_safety
  );
  tooShort(
    "render test",
    req.fur_test.duration_ms,
    REAL_TEST_DURATION_MS.fur,
    req.fur_test.aborted_for_safety
  );

  return problems;
}

/// The full check: report consistency plus everything the server itself
/// observed about the session.
export function checkSubmission(
  req: CertifyRequest,
  session: SessionRecord | null,
  nowIso: string
): AttestationResult {
  const problems = checkReportConsistency(req);

  if (!session) {
    return { ok: false, problems: [...problems, "no matching open test session"] };
  }
  if (session.consumed_at !== null) {
    // One session, one certificate. Otherwise a single honest run becomes an
    // unlimited supply of certificates for cards that were never tested.
    return { ok: false, problems: [...problems, "test session already used"] };
  }
  if (session.fingerprint_hash !== req.fingerprint.hash) {
    // The session is opened with the card's fingerprint before any testing
    // starts, so this catches a run being re-pointed at a different card
    // partway through.
    problems.push("report fingerprint does not match the card this session was opened for");
  }

  // Judged by the version that opened the session, not the one submitting.
  // Anything else means raising the version floor kills every run already in
  // flight, which is exactly what happened to a full sixteen minute run on an
  // RX 6600: it passed every test and was refused at the last step because the
  // floor moved while it was running. A session can only exist if the client
  // was supported when it started, so finishing one is always allowed.
  if (req.client_version !== session.client_version) {
    problems.push(
      `report claims version ${req.client_version} but the session was opened by ${session.client_version}`
    );
  }

  const claimedMs = claimedTotalDurationMs(req);
  const wallClockMs = Date.parse(nowIso) - Date.parse(session.started_at);
  if (!Number.isFinite(wallClockMs) || wallClockMs < 0) {
    problems.push("session timestamps are unusable");
  } else if (wallClockMs < claimedMs * MIN_WALLCLOCK_RATIO) {
    // The layer that costs an attacker real time. The server timed this, so
    // claiming 16 minutes of testing means the session had to be open for it.
    problems.push(
      `claims ${Math.round(claimedMs / 1000)}s of testing but the session was only open ${Math.round(wallClockMs / 1000)}s`
    );
  }

  if (Number.isFinite(wallClockMs) && wallClockMs > MAX_SESSION_AGE_MS) {
    problems.push("this test session is too old to file");
  }

  const minHeartbeats = expectedMinimumHeartbeats(claimedMs);
  if (session.progress_count < minHeartbeats) {
    problems.push(
      `only ${session.progress_count} progress report(s) across ${Math.round(claimedMs / 1000)}s of claimed testing, expected at least ${minHeartbeats}`
    );
  }

  return { ok: problems.length === 0, problems };
}
