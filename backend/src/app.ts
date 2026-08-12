import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  db,
  ensureSchema,
  getReportById,
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
import { CertifyRequestSchema, computeVerdict, canonicalReportString } from "../lib/certify.js";
import { signReport } from "../lib/signing.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { COOKIE_NAME, createSessionToken, getSessionUserId } from "../lib/auth.js";
import { renderReportPage } from "./report-page.js";
import { renderBadge } from "./badge.js";
import { renderHome, renderLogin, renderSignup, renderDashboard } from "./pages.js";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://gpu-cert.vercel.app";
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export const app = new Hono();

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

app.get("/", async (c) => {
  const userId = await getSessionUserId(c);
  return c.html(renderHome(userId !== null));
});

app.get("/login", (c) => {
  const next = c.req.query("next") ?? null;
  return c.html(renderLogin(next, null));
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const next = typeof form.next === "string" ? form.next : null;

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.html(renderLogin(next, "Wrong email or password"), 401);
  }

  const token = await createSessionToken(user.id);
  setCookie(c, COOKIE_NAME, token, SESSION_COOKIE_OPTS);
  return c.redirect(next || "/dashboard");
});

app.get("/signup", (c) => {
  const next = c.req.query("next") ?? null;
  return c.html(renderSignup(next, null));
});

app.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");
  const next = typeof form.next === "string" ? form.next : null;

  if (password.length < 8) {
    return c.html(renderSignup(next, "Password must be at least 8 characters"), 400);
  }
  if (await getUserByEmail(email)) {
    return c.html(renderSignup(next, "An account with that email already exists"), 409);
  }

  const user = await createUser(email, hashPassword(password));
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
