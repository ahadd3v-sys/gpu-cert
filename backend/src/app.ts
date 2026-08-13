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
  getUserById,
  getUserByUploadKey,
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
import { signReport, verifyReportSignature } from "../lib/signing.js";
import { hashPassword, verifyPassword, burnPasswordVerification } from "../lib/password.js";
import { COOKIE_NAME, createSessionToken, getSessionUserId } from "../lib/auth.js";
import { renderReportPage } from "./report-page.js";
import { renderBadge } from "./badge.js";
import { renderHome, renderLogin, renderSignup, renderDashboard, renderVerify } from "./pages.js";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://gpu-cert.vercel.app";
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export const app = new Hono();

// `next` comes straight off the query string and is fed to a redirect after
// login, so it has to be constrained to this site. Left open, a link like
// /login?next=https://evil.example would send someone who just typed their
// password into gpu-cert.vercel.app onward to an attacker's page, which is a
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
//     path — the exe holds the key, so the run files itself.
//   - Without one, the report is stored unowned (user_id NULL) and stays
//     anonymous until someone claims it from the report page below.
//
// A bad key is deliberately not an error: the run took 16 minutes of real GPU
// load and the report itself is still valid, so it gets stored anonymously and
// the response says it wasn't attributed. Rejecting the submission would throw
// away good test data over a typo.
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

  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const keyOwner = bearer ? await getUserByUploadKey(bearer) : null;

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
    upload_key_recognized: bearer ? keyOwner !== null : null,
  });
});

app.get("/r/:reportId", async (c) => {
  const report = await getReportById(c.req.param("reportId"));
  if (!report) return c.notFound();
  const viewerUserId = await getSessionUserId(c);
  return c.html(renderReportPage(report, viewerUserId !== null));
});

app.get("/r/:reportId/badge", async (c) => {
  const report = await getReportById(c.req.param("reportId"));
  if (!report) return c.notFound();
  return renderBadge(report);
});

app.post("/r/:reportId/claim", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect(`/login?next=/r/${c.req.param("reportId")}`);
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
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const next = safeNext(form.next);

  const user = await getUserByEmail(email);
  if (!user) {
    burnPasswordVerification(password);
    return c.html(renderLogin(next, "Wrong email or password"), 401);
  }
  if (!verifyPassword(password, user.password_hash)) {
    return c.html(renderLogin(next, "Wrong email or password"), 401);
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
  const password = String(form.password ?? "");
  const next = safeNext(form.next);

  // The form carries type="email" and required, but a POST doesn't have to
  // come from the form — without this, an empty string is a valid email as
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

  // The check above is a courtesy, not the guarantee — two simultaneous
  // signups for the same address both pass it. The UNIQUE index is what
  // actually enforces it, so its rejection is handled as the same user-facing
  // outcome rather than surfacing as a 500.
  let user;
  try {
    user = await createUser(email, hashPassword(password));
  } catch {
    return c.html(renderSignup(next, "An account with that email already exists"), 409);
  }
  const token = await createSessionToken(user.id);
  setCookie(c, COOKIE_NAME, token, SESSION_COOKIE_OPTS);
  return c.redirect(next || "/dashboard");
});

app.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.redirect("/");
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

  const [reports, uploadKey] = await Promise.all([getReportsForUser(userId), ensureUploadKey(user)]);
  return c.html(renderDashboard(reports, user.email, uploadKey));
});

app.post("/dashboard/key/rotate", async (c) => {
  const userId = await getSessionUserId(c);
  if (!userId) return c.redirect("/login?next=/dashboard");
  await setUploadKey(userId, generateUploadKey());
  return c.redirect("/dashboard");
});
