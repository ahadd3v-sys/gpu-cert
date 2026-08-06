import { Hono } from "hono";
import { db, ensureSchema, getReportById } from "../lib/db";
import { CertifyRequestSchema, computeVerdict, canonicalReportString } from "../lib/certify";
import { signReport } from "../lib/signing";
import { renderReportPage } from "./report-page";
import { renderBadge } from "./badge";

const BASE_URL = process.env.PUBLIC_BASE_URL || "https://gpu-cert.vercel.app";

export const app = new Hono();

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
  return c.html(renderReportPage(report));
});

app.get("/r/:reportId/badge", async (c) => {
  const report = await getReportById(c.req.param("reportId"));
  if (!report) return c.notFound();
  return renderBadge(report);
});
