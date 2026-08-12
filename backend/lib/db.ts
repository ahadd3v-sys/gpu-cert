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
//
// reports.user_id is nullable: the exe submits anonymously (it never holds
// a browser session cookie), so a report starts unowned and is "claimed"
// by whoever opens its report page while logged in — see claimReport().
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  upload_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  client_version TEXT NOT NULL,
  device_name TEXT NOT NULL,
  fingerprint_uuid TEXT NOT NULL,
  fingerprint_pci_device_id INTEGER NOT NULL,
  fingerprint_vram_total_bytes INTEGER NOT NULL,
  fingerprint_vbios_version TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  pcie_link_width_current INTEGER NOT NULL DEFAULT 0,
  pcie_link_width_max INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL,
  verdict_reasons TEXT NOT NULL DEFAULT '[]',
  stress_dispatch_count INTEGER NOT NULL,
  stress_duration_ms INTEGER NOT NULL,
  stress_telemetry_series TEXT NOT NULL,
  stress_peak_temp_c INTEGER NOT NULL DEFAULT 0,
  stress_thermally_stable INTEGER NOT NULL DEFAULT 1,
  stress_clock_stability_pct REAL NOT NULL DEFAULT 0,
  stress_aborted_for_safety INTEGER NOT NULL DEFAULT 0,
  vram_passes_run INTEGER NOT NULL,
  vram_total_errors INTEGER NOT NULL,
  vram_bytes_tested INTEGER NOT NULL,
  vram_duration_ms INTEGER NOT NULL,
  vram_aborted_for_safety INTEGER NOT NULL DEFAULT 0,
  fur_frames_rendered INTEGER NOT NULL DEFAULT 0,
  fur_duration_ms INTEGER NOT NULL DEFAULT 0,
  fur_mismatches INTEGER NOT NULL DEFAULT 0,
  fur_pixels_checked INTEGER NOT NULL DEFAULT 0,
  fur_aborted_for_safety INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_fingerprint_hash ON reports (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports (user_id);

-- Enforces upload_key uniqueness on DBs where the column arrived via ALTER
-- (SQLite can't add a UNIQUE column in place). A unique index permits
-- multiple NULLs, which is what pre-backfill users hold.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_upload_key ON users (upload_key);
`;

let initialized = false;

// CREATE TABLE IF NOT EXISTS won't add a column to a table that already
// exists, so anything added to SCHEMA after a DB has been created needs a
// matching ALTER here. Each runs inside its own try: "duplicate column name"
// is the expected outcome on an already-migrated DB, not a failure.
const MIGRATIONS = [`ALTER TABLE users ADD COLUMN upload_key TEXT`];

export async function ensureSchema() {
  if (initialized) return;
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await db().execute(stmt);
  }
  for (const stmt of MIGRATIONS) {
    try {
      await db().execute(stmt);
    } catch {
      // column already exists
    }
  }
  initialized = true;
}

export interface ReportRow {
  id: string;
  user_id: string | null;
  client_version: string;
  device_name: string;
  fingerprint_uuid: string;
  fingerprint_pci_device_id: number;
  fingerprint_vram_total_bytes: number;
  fingerprint_vbios_version: string;
  fingerprint_hash: string;
  pcie_link_width_current: number;
  pcie_link_width_max: number;
  verdict: string;
  verdict_reasons: string;
  stress_dispatch_count: number;
  stress_duration_ms: number;
  stress_peak_temp_c: number;
  stress_thermally_stable: number;
  stress_clock_stability_pct: number;
  stress_aborted_for_safety: number;
  vram_passes_run: number;
  vram_total_errors: number;
  vram_bytes_tested: number;
  vram_duration_ms: number;
  vram_aborted_for_safety: number;
  fur_frames_rendered: number;
  fur_duration_ms: number;
  fur_mismatches: number;
  fur_pixels_checked: number;
  fur_aborted_for_safety: number;
  signature: string;
  created_at: string;
}

const REPORT_COLUMNS = `id, user_id, client_version, device_name, fingerprint_uuid, fingerprint_pci_device_id,
                 fingerprint_vram_total_bytes, fingerprint_vbios_version, fingerprint_hash,
                 pcie_link_width_current, pcie_link_width_max,
                 verdict, verdict_reasons, stress_dispatch_count, stress_duration_ms,
                 stress_peak_temp_c, stress_thermally_stable, stress_clock_stability_pct, stress_aborted_for_safety,
                 vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms, vram_aborted_for_safety,
                 fur_frames_rendered, fur_duration_ms, fur_mismatches, fur_pixels_checked, fur_aborted_for_safety,
                 signature, created_at`;

export async function getReportById(id: string): Promise<ReportRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  return row as unknown as ReportRow;
}

export async function getReportsForUser(userId: string): Promise<ReportRow[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${REPORT_COLUMNS} FROM reports WHERE user_id = ? ORDER BY created_at DESC`,
    args: [userId],
  });
  return res.rows as unknown as ReportRow[];
}

// First claim wins: a report can only ever belong to one account. Returns
// false (not an error) if it was already claimed by someone else, so the
// caller can show "already saved to an account" instead of silently
// reassigning ownership.
export async function claimReport(reportId: string, userId: string): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `UPDATE reports SET user_id = ? WHERE id = ? AND user_id IS NULL`,
    args: [userId, reportId],
  });
  return res.rowsAffected > 0;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  upload_key: string | null;
  created_at: string;
}

const USER_COLUMNS = `id, email, password_hash, upload_key, created_at`;

// Read aloud off a dashboard and typed into a console prompt, so the alphabet
// drops the four glyph pairs that get mistyped that way (I/1, O/0) and the
// key is grouped in fours. 16 chars from a 32-symbol alphabet is 80 bits.
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateUploadKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 4) groups.push(chars.slice(i, i + 4).join(""));
  return `GPUC-${groups.join("-")}`;
}

export async function createUser(email: string, passwordHash: string): Promise<UserRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const uploadKey = generateUploadKey();
  await db().execute({
    sql: `INSERT INTO users (id, email, password_hash, upload_key) VALUES (?, ?, ?, ?)`,
    args: [id, email, passwordHash, uploadKey],
  });
  return {
    id,
    email,
    password_hash: passwordHash,
    upload_key: uploadKey,
    created_at: new Date().toISOString(),
  };
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`,
    args: [email],
  });
  return (res.rows[0] as unknown as UserRow) ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    args: [id],
  });
  return (res.rows[0] as unknown as UserRow) ?? null;
}

// The exe authenticates with this and nothing else, so the lookup is the
// whole authorization check for attributing a report at ingest.
export async function getUserByUploadKey(uploadKey: string): Promise<UserRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${USER_COLUMNS} FROM users WHERE upload_key = ?`,
    args: [uploadKey],
  });
  return (res.rows[0] as unknown as UserRow) ?? null;
}

export async function setUploadKey(userId: string, uploadKey: string): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE users SET upload_key = ? WHERE id = ?`,
    args: [uploadKey, userId],
  });
}

// Accounts created before upload keys existed have upload_key NULL; the
// dashboard mints one on first view rather than needing a data backfill.
export async function ensureUploadKey(user: UserRow): Promise<string> {
  if (user.upload_key) return user.upload_key;
  const uploadKey = generateUploadKey();
  await setUploadKey(user.id, uploadKey);
  return uploadKey;
}
