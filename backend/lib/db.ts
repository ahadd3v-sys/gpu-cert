import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function db(): Client {
  if (!client) {
    client = createClient({
      url: process.env.DATABASE_URL || "file:local.db",
      authToken: process.env.DATABASE_AUTH_TOKEN,
    });
  }
  return client;
}

// Fingerprint fields are stored flat (not as a JSON blob) so a future
// "has this card been certified before" lookup can index on
// fingerprint_hash directly instead of parsing JSON per row.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  client_version TEXT NOT NULL,
  device_name TEXT NOT NULL,
  fingerprint_uuid TEXT NOT NULL,
  fingerprint_pci_device_id INTEGER NOT NULL,
  fingerprint_vram_total_bytes INTEGER NOT NULL,
  fingerprint_vbios_version TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  stress_dispatch_count INTEGER NOT NULL,
  stress_duration_ms INTEGER NOT NULL,
  stress_telemetry_series TEXT NOT NULL,
  vram_passes_run INTEGER NOT NULL,
  vram_total_errors INTEGER NOT NULL,
  vram_bytes_tested INTEGER NOT NULL,
  vram_duration_ms INTEGER NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_fingerprint_hash ON reports (fingerprint_hash);
`;

let initialized = false;

export async function ensureSchema() {
  if (initialized) return;
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await db().execute(stmt);
  }
  initialized = true;
}

export interface ReportRow {
  id: string;
  client_version: string;
  device_name: string;
  fingerprint_uuid: string;
  fingerprint_pci_device_id: number;
  fingerprint_vram_total_bytes: number;
  fingerprint_vbios_version: string;
  fingerprint_hash: string;
  verdict: string;
  stress_dispatch_count: number;
  stress_duration_ms: number;
  vram_passes_run: number;
  vram_total_errors: number;
  vram_bytes_tested: number;
  vram_duration_ms: number;
  signature: string;
  created_at: string;
}

export async function getReportById(id: string): Promise<ReportRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, client_version, device_name, fingerprint_uuid, fingerprint_pci_device_id,
                 fingerprint_vram_total_bytes, fingerprint_vbios_version, fingerprint_hash,
                 verdict, stress_dispatch_count, stress_duration_ms,
                 vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms,
                 signature, created_at
          FROM reports WHERE id = ?`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  return row as unknown as ReportRow;
}
