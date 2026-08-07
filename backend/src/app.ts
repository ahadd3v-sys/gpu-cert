import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { db, ensureSchema, getReportById, getReportsForUser, claimReport, createUser, getUserByEmail } from "../lib/db";
import { CertifyRequestSchema, computeVerdict, canonicalReportString } from "../lib/certify";
import { signReport } from "../lib/signing";
import { hashPassword, verifyPassword } from "../lib/password";
import { COOKIE_NAME, createSessionToken, getSessionUserId } from "../lib/auth";
import { renderReportPage } from "./report-page";
import { renderBadge } from "./badge";
import { renderHome, renderLogin, renderSignup, renderDashboard } from "./pages";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://gpu-cert.vercel.app";
const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export const app = new Hono();

// The exe submits here directly — no session cookie, so every report
// starts unowned (user_id NULL) and gets attached to an account later via
// the claim flow below, once a logged-in browser opens the report page.
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

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const verdict = computeVerdict(req);
  const signature = signReport(canonicalReportString(id, req, verdict, createdAt));

  await db().execute({
    sql: `INSERT INTO reports (
      id, client_version, device_name,
      fingerprint_uuid, fingerprint_pci_device_id, fingerprint_vram_total_bytes,
      fingerprint_vbios_version, fingerprint_hash,
      verdict,
      stress_dispatch_count, stress_duration_ms, stress_telemetry_series,
      vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms,
      signature, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      req.client_version,
      req.device_name,
      req.fingerprint.uuid,
      req.fingerprint.pci_device_id,
      req.fingerprint.vram_total_bytes,
      req.fingerprint.vbios_version,
      req.fingerprint.hash,
      verdict,
      req.stress_test.dispatch_count,
      req.stress_test.duration_ms,
      JSON.stringify(req.stress_test.telemetry_series),
      req.vram_test.passes_run,
      req.vram_test.total_errors,
      req.vram_test.bytes_tested,
      req.vram_test.duration_ms,
      signature,
      createdAt,
    ],
  });

  return c.json({
    report_url: `${BASE_URL}/r/${id}`,
    badge_url: `${BASE_URL}/r/${id}/badge`,
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
  const reports = await getReportsForUser(userId);
  return c.html(renderDashboard(reports));
});
