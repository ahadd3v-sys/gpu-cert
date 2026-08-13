import { createHash } from "crypto";
import { z } from "zod";
import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  db,
  ensureSchema,
  getReportById,
  findReportByReference,
  getReportsForUser,
  claimReport,
  createUser,
  getUserByEmail,
  getUserByUsername,
  getUserByEmailOrUsername,
  normalizeUsername,
  usernameProblem,
  ensureUsername,
  getUserById,
  getUserByUploadKey,
  createTestSession,
  getTestSession,
  recordSessionProgress,
  consumeTestSession,
  countRecentSessions,
  createFeedback,
  countRecentFeedback,
  recordReportView,
  getViewStats,
  getReferrerBreakdown,
  type ViewKind,
  createEmailToken,
  consumeEmailToken,
  markEmailVerified,
  setPassword,
  ensureUploadKey,
  generateUploadKey,
  setUploadKey,
} from "../lib/db.js";
import {
  CertifyRequestSchema,
  computeVerdict,
  canonicalReportString,
  canonicalReportStringFromRow,
} from "../lib/certify.js";
import { checkSubmission } from "../lib/attestation.js";
import { isEmailConfigured, sendEmail, verificationEmail, passwordResetEmail } from "../lib/email.js";
import { signReport, verifyReportSignature } from "../lib/signing.js";
import { hashPassword, verifyPassword, burnPasswordVerification } from "../lib/password.js";
import { COOKIE_NAME, createSessionToken, getSessionUserId } from "../lib/auth.js";
import { renderReportPage } from "./report-page.js";
import { renderBadge } from "./badge.js";
import { renderHome, renderLogin, renderSignup, renderDashboard, renderVerify, renderFeedback, renderNotice, renderForgotPassword, renderResetPassword } from "./pages.js";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://gpucert.com";
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export const app = new Hono();

// Client IPs are only ever needed to spot one source hammering an endpoint,
// never to identify anyone, so they are salted and hashed on the way in and
// the raw address is never stored. AUTH_SECRET doubles as the salt: it already
// exists, is already secret, and rotating it only costs a reset of the rate
// windows.
function hashIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || c.req.header("x-real-ip") || "unknown";
  return createHash("sha256").update(`${process.env.AUTH_SECRET ?? ""}:${ip}`).digest("hex");
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// `next` comes straight off the query string and is fed to a redirect after
// login, so it has to be constrained to this site. Left open, a link like
// /login?next=https://evil.example would send someone who just typed their
// password into gpucert.com onward to an attacker's page, which is a
// credible phishing setup precisely because the login itself was genuine.
//
// A single leading slash is required and a second one rejected: "//evil.example"
// is a protocol-relative URL, not a local path, and browsers follow it
// off-site. Backslashes are rejected for the same reason, since some browsers
// normalize them to forward slashes.
function safeNext(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next.includes("\\")) return null;
  return next;
}

// The exe submits here directly. It has no browser session, so ownership
// works one of two ways:
//
//   - With `Authorization: Bearer <upload key>`, the report is attributed to
//     that account at ingest. This is the "connect the app to your account"
//     path, the exe holds the key, so the run files itself.
//   - Without one, the report is stored unowned (user_id NULL) and stays
//     anonymous until someone claims it from the report page below.
//
// A bad key is deliberately not an error: the run took 16 minutes of real GPU
// load and the report itself is still valid, so it gets stored anonymously and
// the response says it wasn't attributed. Rejecting the submission would throw
// away good test data over a typo.
// Opened by the exe before any testing begins, and consumed by the submission
// at the end. The gap between the two is measured by this server rather than
// reported by the client, which is what stops a certificate from being
// something you can fabricate with one request. See lib/attestation.ts.
const SessionStartSchema = z.object({
  client_version: z.string().max(32),
  device_name: z.string().max(200),
  fingerprint_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

// A real run opens one session per ~16 minutes. This is far above that and
// only bites automated abuse.
const MAX_SESSIONS_PER_IP_PER_HOUR = 20;

app.post("/api/session/start", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SessionStartSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid session request" }, 400);
  }

  const ipHash = hashIp(c);
  if ((await countRecentSessions(ipHash, isoMinutesAgo(60))) >= MAX_SESSIONS_PER_IP_PER_HOUR) {
    return c.json({ error: "too many test sessions started recently" }, 429);
  }

  const session = await createTestSession({
    fingerprintHash: parsed.data.fingerprint_hash,
    deviceName: parsed.data.device_name,
    clientVersion: parsed.data.client_version,
    ipHash,
  });
  return c.json({
    session_id: session.id,
    nonce: session.nonce,
    // Told rather than assumed, so the cadence can be changed server-side
    // without every old client becoming non-compliant.
    heartbeat_interval_ms: 60_000,
  });
});

app.post("/api/session/progress", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({ session_id: z.string().min(1), nonce: z.string().min(1) })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid progress request" }, 400);
  }
  const ok = await recordSessionProgress(parsed.data.session_id, parsed.data.nonce);
  // Deliberately not an error the client should act on. A heartbeat that fails
  // must never interrupt a test that is otherwise running fine.
  return c.json({ ok });
});

app.post("/api/certify", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = CertifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid report payload", issues: parsed.error.issues }, 400);
  }
  const req = parsed.data;

  await ensureSchema();

  if (!req.attestation) {
    return c.json(
      {
        error:
          "this version of gpu-cert can no longer file certificates. Download the current release and run the test again.",
      },
      426
    );
  }

  const session = await getTestSession(req.attestation.session_id, req.attestation.nonce);

  // Answered specifically rather than folded into the generic refusal below.
  // The honest way to reach this is `--resubmit` after a submission that
  // actually landed but whose response was lost, and telling that user their
  // report "could not be attested" would be both alarming and wrong.
  if (session?.consumed_at) {
    return c.json(
      { error: "this test session has already been used, so its certificate already exists" },
      409
    );
  }

  const attestation = checkSubmission(req, session, new Date().toISOString());
  if (!attestation.ok) {
    // Logged in full, answered in one line. Handing back the list of failed
    // checks would just be instructions for producing a payload that passes.
    console.warn("rejected report", { problems: attestation.problems });
    return c.json({ error: "this report could not be attested to a real test run" }, 403);
  }

  // Consumed before the report is written, so two submissions racing on one
  // session can't both produce a certificate.
  if (!(await consumeTestSession(req.attestation.session_id))) {
    return c.json({ error: "this test session has already been used" }, 409);
  }

  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const keyHolder = bearer ? await getUserByUploadKey(bearer) : null;
  // Gating the claim button but not the upload key would leave the gate wide
  // open: an unverified account could simply attribute at ingest instead. An
  // unverified holder is treated exactly like an unrecognized key, so the run
  // is still stored and still public, just unattached.
  const keyOwner = keyHolder && keyHolder.email_verified === 1 ? keyHolder : null;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const result = computeVerdict(req);
  const signature = signReport(canonicalReportString(id, req, result, createdAt));

  await db().execute({
    sql: `INSERT INTO reports (
      id, user_id, client_version, device_name,
      fingerprint_uuid, fingerprint_pci_device_id, fingerprint_vram_total_bytes,
      fingerprint_vbios_version, fingerprint_hash,
      pcie_link_width_current, pcie_link_width_max,
      verdict, verdict_reasons,
      stress_dispatch_count, stress_duration_ms, stress_telemetry_series,
      stress_peak_temp_c, stress_thermally_stable, stress_clock_stability_pct, stress_aborted_for_safety,
      vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms, vram_aborted_for_safety,
      fur_frames_rendered, fur_duration_ms, fur_mismatches, fur_pixels_checked, fur_aborted_for_safety,
      signature, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      keyOwner?.id ?? null,
      req.client_version,
      req.device_name,
      req.fingerprint.uuid,
      req.fingerprint.pci_device_id,
      req.fingerprint.vram_total_bytes,
      req.fingerprint.vbios_version,
      req.fingerprint.hash,
      req.pcie_link_width_current,
      req.pcie_link_width_max,
      result.verdict,
      JSON.stringify(result.reasons),
      req.stress_test.dispatch_count,
      req.stress_test.duration_ms,
      JSON.stringify(req.stress_test.telemetry_series),
      result.stressPeakTempC,
      result.stressThermallyStable ? 1 : 0,
      result.stressClockStabilityPct,
      req.stress_test.aborted_for_safety ? 1 : 0,
      req.vram_test.passes_run,
      req.vram_test.total_errors,
      req.vram_test.bytes_tested,
      req.vram_test.duration_ms,
      req.vram_test.aborted_for_safety ? 1 : 0,
      req.fur_test.frames_rendered,
      req.fur_test.duration_ms,
      req.fur_test.mismatches,
      req.fur_test.pixels_checked,
      req.fur_test.aborted_for_safety ? 1 : 0,
      signature,
      createdAt,
    ],
  });

  return c.json({
    report_url: `${BASE_URL}/r/${id}`,
    badge_url: `${BASE_URL}/r/${id}/badge`,
    // Lets the exe print "filed to <account>" vs. "not attached to an
    // account" instead of guessing which happened.
    filed_to: keyOwner?.email ?? null,
    upload_key_recognized: bearer ? keyHolder !== null : null,
    // Distinguishes "we do not know this key" from "confirm your email first",
    // which are very different things to be told after a 16-minute run.
    upload_key_unverified: bearer ? keyHolder !== null && keyOwner === null : false,
  });
});

// Link unfurls from Discord, Slack and Reddit hit these URLs too, and search
// crawlers hit them constantly. Counting those as "a buyer looked at the
// certificate" would make the one number this exists to measure meaningless.
const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|curl|wget|headless|monitor|scrape|facebookexternalhit|embedly|discord|slack|telegram|whatsapp|twitter/i;

function isProbablyBot(c: Context): boolean {
  const ua = c.req.header("user-agent") ?? "";
  return ua === "" || BOT_UA.test(ua);
}

/// Just the host, never the full URL. A Referer can carry a search query or a
/// private listing path, none of which is needed to answer "did this come
/// from Reddit".
function referrerHost(c: Context): string | null {
  const raw = c.req.header("referer") ?? c.req.header("referrer");
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.replace(/^www\./, "");
    // Self-referrals are navigation inside the site, not an arrival.
    if (host && !BASE_URL.includes(host)) return host;
    return null;
  } catch {
    return null;
  }
}

/// Salted, and rotated daily by folding the date in. Enough to count distinct
/// people within a day, useless for following anyone across days.
function viewerHash(c: Context): string {
  const day = new Date().toISOString().slice(0, 10);
  const ua = c.req.header("user-agent") ?? "";
  return createHash("sha256")
    .update(`${process.env.AUTH_SECRET ?? ""}:${hashIp(c)}:${ua}:${day}`)
    .digest("hex");
}

/// Never allowed to break or slow the thing it is measuring. A certificate
/// that fails to load because analytics threw would be a strictly worse
/// product than one with no analytics.
async function trackView(c: Context, reportId: string, kind: ViewKind, ownerId: string | null) {
  try {
    if (isProbablyBot(c)) return;
    // The seller refreshing their own certificate is not a buyer looking at
    // it, and counting it would flatter the number that has to stay honest.
    const viewerId = await getSessionUserId(c);
    if (ownerId && viewerId === ownerId) return;
    await recordReportView({
      reportId,
      kind,
      referrerHost: referrerHost(c),
      viewerHash: viewerHash(c),
    });
  } catch (err) {
    console.error("view tracking failed", err);
  }
}

app.get("/r/:reportId", async (c) => {
  const report = await getReportById(c.req.param("reportId"));
  if (!report) return c.notFound();
  const viewerUserId = await getSessionUserId(c);
  await trackView(c, report.id, "page", report.user_id);
  const viewer = viewerUserId ? await getUserById(viewerUserId) : null;
  return c.html(
    renderReportPage(report, {
      loggedIn: viewer !== null,
      emailVerified: viewer?.email_verified === 1,
      // Set when a claim was just refused for want of a confirmed address.
      justBlocked: c.req.query("verify") === "1",
    })
  );
});

app.get("/r/:reportId/badge", async (c) => {
  const report = await getReportById(c.req.param("reportId"));
  if (!report) return c.notFound();
  // Counted even for unfurl bots would be wrong, but a badge embedded in a
  // listing is fetched by the *viewer's* browser, so this is a real
  // impression: the listing was on someone's screen.
  await trackView(c, report.id, "badge", report.user_id);
  return renderBadge(report);
});

app.post("/r/:reportId/claim", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect(`/login?next=/r/${c.req.param("reportId")}`);

  // Attaching a certificate to an account is the one action that makes a
  // public document say something about a person, so it needs the address
  // behind that account to be real. Without this, verification is decorative:
  // anyone could sign up as anyone and start collecting certificates under it.
  const user = await getUserById(userId);
  if (!user || user.email_verified !== 1) {
    return c.redirect(`/r/${c.req.param("reportId")}?verify=1`);
  }

  await claimReport(c.req.param("reportId"), userId);
  return c.redirect(`/r/${c.req.param("reportId")}`);
});

// The certificate's whole value to a buyer is that they don't have to take
// the seller's word for it, which requires somewhere to actually check. Both
// the query form (/verify?reference=) and the path form (/verify/GPUC-1A2B3C4D)
// land here, so a certificate number can be linked directly as well as typed.
async function handleVerify(c: Context, reference: string | null) {
  const loggedIn = (await getSessionUserId(c)) !== null;
  if (!reference) {
    return c.html(renderVerify({ loggedIn }));
  }

  const report = await findReportByReference(reference);
  if (!report) {
    return c.html(
      renderVerify({
        loggedIn,
        reference,
        error: "No certificate found with that number. Check it against the certificate itself.",
      }),
      404
    );
  }

  // Recomputed from what is stored rather than read from any field, which is
  // the point: if a stored value were tampered with, the string rebuilt here
  // differs from the one signed at issue and the check fails.
  let signatureValid = false;
  try {
    signatureValid = verifyReportSignature(canonicalReportStringFromRow(report), report.signature);
  } catch {
    // A malformed signature or an unreadable key is not a valid signature.
    // Reporting it as anything other than "does not match" would be worse
    // than useless on the one page whose job is to be trustworthy.
    signatureValid = false;
  }

  return c.html(
    renderVerify({
      loggedIn,
      reference,
      result: {
        reference,
        signatureValid,
        reportId: report.id,
        certificateNumber: `GPUC-${report.id.slice(0, 8).toUpperCase()}`,
        deviceName: report.device_name,
        fingerprintHash: report.fingerprint_hash,
        verdict: report.verdict,
        issuedAt: report.created_at,
      },
    })
  );
}

app.get("/verify", (c) => handleVerify(c, c.req.query("reference")?.trim() || null));
app.get("/verify/:reference", (c) => handleVerify(c, c.req.param("reference")));

// Published so the signature can be checked with any Ed25519 tool instead of
// only by this server, which is what makes "independently verifiable" mean
// something. Served as text/plain so a browser shows it rather than
// downloading it.
app.get("/.well-known/gpu-cert-key.pem", (c) => {
  const pem = process.env.CERT_SIGNING_PUBLIC_KEY;
  if (!pem) return c.text("signing key not configured", 500);
  return c.text(`${pem.replace(/\\n/g, "\n").trim()}\n`, 200, {
    "content-type": "application/x-pem-file; charset=utf-8",
    "cache-control": "public, max-age=3600",
  });
});

const MAX_FEEDBACK_PER_IP_PER_HOUR = 5;

app.get("/feedback", async (c) => {
  const userId = await getSessionUserId(c);
  return c.html(renderFeedback({ loggedIn: userId !== null, sent: c.req.query("sent") === "1" }));
});

app.post("/feedback", async (c) => {
  const userId = await getSessionUserId(c);
  const loggedIn = userId !== null;
  const form = await c.req.parseBody();

  // Honeypot. A hidden field that a person never sees and a form-filling bot
  // almost always completes. Answered with the same success page rather than
  // an error, so whatever filled it has no signal that it was caught.
  if (String(form.website ?? "").trim() !== "") {
    return c.redirect("/feedback?sent=1");
  }

  const message = String(form.message ?? "").trim();
  if (message.length < 10) {
    return c.html(
      renderFeedback({ loggedIn, error: "Tell us a little more about what happened." }),
      400
    );
  }

  const ipHash = hashIp(c);
  if ((await countRecentFeedback(ipHash, isoMinutesAgo(60))) >= MAX_FEEDBACK_PER_IP_PER_HOUR) {
    return c.html(
      renderFeedback({ loggedIn, error: "That's a lot of feedback at once. Try again in an hour." }),
      429
    );
  }

  // Truncated rather than rejected: someone who pasted a very long log should
  // still get their report filed, minus the tail.
  const trim = (value: unknown, max: number): string | null => {
    const text = String(value ?? "").trim();
    return text === "" ? null : text.slice(0, max);
  };

  await createFeedback({
    message: message.slice(0, 4000),
    contact: trim(form.contact, 254),
    reportReference: trim(form.report_reference, 64),
    consoleOutput: trim(form.console_output, 20000),
    ipHash,
  });

  return c.redirect("/feedback?sent=1");
});

app.get("/", async (c) => {
  const userId = await getSessionUserId(c);
  return c.html(renderHome(userId !== null));
});

app.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  return c.html(renderLogin(next, null));
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const identifier = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const next = safeNext(form.next);

  const user = await getUserByEmailOrUsername(identifier);
  if (!user) {
    burnPasswordVerification(password);
    return c.html(renderLogin(next, "Wrong username or password"), 401);
  }
  if (!verifyPassword(password, user.password_hash)) {
    return c.html(renderLogin(next, "Wrong username or password"), 401);
  }

  const token = await createSessionToken(user.id);
  setCookie(c, COOKIE_NAME, token, SESSION_COOKIE_OPTS);
  return c.redirect(next || "/dashboard");
});

app.get("/signup", (c) => {
  const next = safeNext(c.req.query("next"));
  return c.html(renderSignup(next, null));
});

app.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const username = normalizeUsername(String(form.username ?? ""));
  const password = String(form.password ?? "");
  const next = safeNext(form.next);

  const usernameIssue = usernameProblem(username);
  if (usernameIssue) {
    return c.html(renderSignup(next, usernameIssue), 400);
  }
  if (await getUserByUsername(username)) {
    return c.html(renderSignup(next, "That username is taken"), 409);
  }

  // The form carries type="email" and required, but a POST doesn't have to
  // come from the form, without this, an empty string is a valid email as
  // far as the database is concerned, and it takes the UNIQUE slot for every
  // subsequent malformed signup.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return c.html(renderSignup(next, "Enter a valid email address"), 400);
  }
  if (password.length < 8) {
    return c.html(renderSignup(next, "Password must be at least 8 characters"), 400);
  }
  if (await getUserByEmail(email)) {
    return c.html(renderSignup(next, "An account with that email already exists"), 409);
  }

  // The check above is a courtesy, not the guarantee, two simultaneous
  // signups for the same address both pass it. The UNIQUE index is what
  // actually enforces it, so its rejection is handled as the same user-facing
  // outcome rather than surfacing as a 500.
  // Created already-verified when there is no provider to send through, since
  // an unverified state nobody can ever leave is just a permanent banner.
  let user;
  try {
    user = await createUser(email, username, hashPassword(password), !isEmailConfigured());
  } catch {
    // The UNIQUE indexes on email and username are what actually enforce
    // uniqueness; the checks above only exist to give a better message.
    return c.html(renderSignup(next, "That email or username is already taken"), 409);
  }

  if (isEmailConfigured()) {
    const verifyToken = await createEmailToken(user.id, "verify", 24 * 60);
    await sendEmail({ to: user.email, ...verificationEmail(BASE_URL, verifyToken) });
  }

  const token = await createSessionToken(user.id);
  setCookie(c, COOKIE_NAME, token, SESSION_COOKIE_OPTS);
  return c.redirect(next || "/dashboard");
});

app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.redirect("/");
});

// Confirming an address, and recovering one. Both hang off the same
// single-use token table; see lib/db.ts.
app.get("/verify-email", async (c) => {
  const token = c.req.query("token") ?? "";
  const userId = token ? await consumeEmailToken(token, "verify") : null;
  if (!userId) {
    return c.html(
      renderNotice({
        loggedIn: (await getSessionUserId(c)) !== null,
        title: "That link has expired",
        body: "Verification links last 24 hours and work once. Sign in and request a new one from your dashboard.",
        ok: false,
      }),
      400
    );
  }
  await markEmailVerified(userId);
  return c.html(
    renderNotice({
      loggedIn: (await getSessionUserId(c)) !== null,
      title: "Email confirmed",
      body: "Your address is verified. You can reset your password with it if you ever need to.",
      ok: true,
    })
  );
});

app.post("/resend-verification", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect("/login?next=/dashboard");
  const user = await getUserById(userId);
  if (user && user.email_verified !== 1 && isEmailConfigured()) {
    const token = await createEmailToken(user.id, "verify", 24 * 60);
    await sendEmail({ to: user.email, ...verificationEmail(BASE_URL, token) });
  }
  return c.redirect("/dashboard?sent=1");
});

app.get("/forgot-password", (c) => c.html(renderForgotPassword({})));

app.post("/forgot-password", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const user = await getUserByEmail(email);

  // Always the same answer, whether or not that address has an account.
  // Anything else turns this form into a way to test which emails are
  // registered here.
  if (user && isEmailConfigured()) {
    const token = await createEmailToken(user.id, "reset", 60);
    await sendEmail({ to: user.email, ...passwordResetEmail(BASE_URL, token) });
  }
  return c.html(renderForgotPassword({ sent: true, emailConfigured: isEmailConfigured() }));
});

app.get("/reset-password", (c) => c.html(renderResetPassword({ token: c.req.query("token") ?? "" })));

app.post("/reset-password", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  const password = String(form.password ?? "");
  if (password.length < 8) {
    return c.html(
      renderResetPassword({ token, error: "Password must be at least 8 characters" }),
      400
    );
  }

  const userId = await consumeEmailToken(token, "reset");
  if (!userId) {
    return c.html(
      renderResetPassword({ token: "", error: "That reset link has expired or was already used." }),
      400
    );
  }
  await setPassword(userId, hashPassword(password));
  // Reaching a reset link proves control of the address, so this doubles as
  // verification and saves the user a second round trip.
  await markEmailVerified(userId);

  const session = await createSessionToken(userId);
  setCookie(c, COOKIE_NAME, session, SESSION_COOKIE_OPTS);
  return c.redirect("/dashboard");
});

app.get("/dashboard", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect("/login?next=/dashboard");

  const user = await getUserById(userId);
  // A valid session for a deleted account: clear it rather than 500 on the
  // missing row.
  if (!user) {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.redirect("/login?next=/dashboard");
  }

  const [reports, uploadKey, username] = await Promise.all([
    getReportsForUser(userId),
    ensureUploadKey(user),
    ensureUsername(user),
  ]);
  const [viewStats, referrers] = await Promise.all([
    getViewStats(reports.map((r) => r.id)),
    getReferrerBreakdown(userId),
  ]);
  return c.html(
    renderDashboard(reports, { email: user.email, username }, uploadKey, viewStats, referrers, {
      emailVerified: user.email_verified === 1,
      verificationSent: c.req.query("sent") === "1",
      canResend: isEmailConfigured(),
    })
  );
});

app.post("/dashboard/key/rotate", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect("/login?next=/dashboard");
  await setUploadKey(userId, generateUploadKey());
  return c.redirect("/dashboard");
});
