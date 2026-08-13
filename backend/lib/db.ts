import { createHash } from "crypto";
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
// by whoever opens its report page while logged in; see claimReport().
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  upload_key TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use links for confirming an address and for resetting a password.
-- Only a hash of each token is stored: the token itself lives in the email and
-- nowhere else, so a copy of this table grants nobody a password reset.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
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

-- Opened before a test run starts and consumed by the submission at the end.
-- Its whole purpose is to put a clock the client doesn't control between those
-- two moments: see lib/attestation.ts.
CREATE TABLE IF NOT EXISTS test_sessions (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  client_version TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_progress_at TEXT,
  progress_count INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

-- Text only, deliberately: see the note in app.ts's /feedback route on why
-- there are no file uploads.
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  contact TEXT,
  report_reference TEXT,
  console_output TEXT,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_fingerprint_hash ON reports (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_ip ON test_sessions (ip_hash, started_at);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);

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
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN upload_key TEXT`,
  // Existing accounts predate verification. They are marked verified rather
  // than locked out of their own certificates by a feature added after they
  // signed up.
  `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1`,
];

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

// Accepts whatever a person actually has in front of them. The certificate
// page shows a short "Certificate No." (GPUC- plus the first 8 characters of
// the id, uppercased) far more prominently than the full report id, so that
// short form is what someone checking a stranger's certificate will type,
// while a pasted URL yields the full id. Both resolve here.
//
// The prefix branch only ever runs on input already matched against
// /^[0-9a-f]{8}$/, so nothing user-controlled reaches the LIKE pattern.
export async function findReportByReference(reference: string): Promise<ReportRow | null> {
  await ensureSchema();

  const compact = reference.trim().replace(/[^0-9a-zA-Z-]/g, "");
  const full = compact.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(full)) {
    return getReportById(full);
  }

  const short = compact.replace(/^GPUC-?/i, "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(short)) return null;

  const res = await db().execute({
    sql: `SELECT ${REPORT_COLUMNS} FROM reports WHERE id LIKE ? LIMIT 2`,
    args: [`${short}%`],
  });
  // A truncated reference could in principle match more than one report.
  // Refusing to answer is the only correct response: picking one would tell
  // someone their certificate is valid while showing them a different card's.
  if (res.rows.length !== 1) return null;
  return res.rows[0] as unknown as ReportRow;
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
  email_verified: number;
  created_at: string;
}

const USER_COLUMNS = `id, email, password_hash, upload_key, email_verified, created_at`;

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

/// `verified` is true when there is no way to send a confirmation email, since
/// marking an account unverified that can never be verified would just be a
/// permanent banner nobody can dismiss.
export async function createUser(email: string, passwordHash: string, verified: boolean): Promise<UserRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const uploadKey = generateUploadKey();
  await db().execute({
    sql: `INSERT INTO users (id, email, password_hash, upload_key, email_verified) VALUES (?, ?, ?, ?, ?)`,
    args: [id, email, passwordHash, uploadKey, verified ? 1 : 0],
  });
  return {
    id,
    email,
    password_hash: passwordHash,
    upload_key: uploadKey,
    email_verified: verified ? 1 : 0,
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

// ------------------------------------------------------------ test sessions

export interface TestSessionRow {
  id: string;
  nonce: string;
  fingerprint_hash: string;
  started_at: string;
  progress_count: number;
  consumed_at: string | null;
}

export async function createTestSession(opts: {
  fingerprintHash: string;
  deviceName: string;
  clientVersion: string;
  ipHash: string;
}): Promise<{ id: string; nonce: string }> {
  await ensureSchema();
  const id = crypto.randomUUID();
  // 256 bits. The session id alone would do, but a separate secret means the
  // id can be logged or referenced without granting the ability to submit
  // against that session.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  await db().execute({
    sql: `INSERT INTO test_sessions (id, nonce, fingerprint_hash, device_name, client_version, ip_hash, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, nonce, opts.fingerprintHash, opts.deviceName, opts.clientVersion, opts.ipHash, new Date().toISOString()],
  });
  return { id, nonce };
}

export async function getTestSession(id: string, nonce: string): Promise<TestSessionRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, nonce, fingerprint_hash, started_at, progress_count, consumed_at
          FROM test_sessions WHERE id = ? AND nonce = ?`,
    args: [id, nonce],
  });
  const row = res.rows[0] as unknown as TestSessionRow | undefined;
  if (!row) return null;
  return { ...row, progress_count: Number(row.progress_count) };
}

/// Returns false if the session doesn't exist, the nonce is wrong, or it has
/// already been consumed, so a client can't keep a finished session alive.
export async function recordSessionProgress(id: string, nonce: string): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `UPDATE test_sessions
          SET progress_count = progress_count + 1, last_progress_at = ?
          WHERE id = ? AND nonce = ? AND consumed_at IS NULL`,
    args: [new Date().toISOString(), id, nonce],
  });
  return res.rowsAffected > 0;
}

/// Atomic, and the reason submission order matters: consuming before inserting
/// the report means two simultaneous submissions against one session can't both
/// win. A conditional UPDATE is the lock; SQLite gives us the atomicity free.
export async function consumeTestSession(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `UPDATE test_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
    args: [new Date().toISOString(), id],
  });
  return res.rowsAffected > 0;
}

export async function countRecentSessions(ipHash: string, sinceIso: string): Promise<number> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM test_sessions WHERE ip_hash = ? AND started_at > ?`,
    args: [ipHash, sinceIso],
  });
  return Number((res.rows[0] as unknown as { n: number }).n);
}

// ---------------------------------------------------------------- feedback

export async function createFeedback(opts: {
  message: string;
  contact: string | null;
  reportReference: string | null;
  consoleOutput: string | null;
  ipHash: string;
}): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO feedback (id, message, contact, report_reference, console_output, ip_hash)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      opts.message,
      opts.contact,
      opts.reportReference,
      opts.consoleOutput,
      opts.ipHash,
    ],
  });
}

export async function countRecentFeedback(ipHash: string, sinceIso: string): Promise<number> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM feedback WHERE ip_hash = ? AND created_at > ?`,
    args: [ipHash, sinceIso],
  });
  return Number((res.rows[0] as unknown as { n: number }).n);
}

// ------------------------------------------------------- email tokens

export type EmailTokenKind = "verify" | "reset";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/// Returns the raw token, which is the only copy. It goes in the email and is
/// never written down here.
export async function createEmailToken(
  userId: string,
  kind: EmailTokenKind,
  ttlMinutes: number
): Promise<string> {
  await ensureSchema();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  // Any older token of the same kind stops working the moment a new one is
  // issued, so "resend" cannot leave a trail of live links behind it.
  await db().execute({
    sql: `DELETE FROM email_tokens WHERE user_id = ? AND kind = ?`,
    args: [userId, kind],
  });
  await db().execute({
    sql: `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)`,
    args: [hashToken(token), userId, kind, new Date(Date.now() + ttlMinutes * 60_000).toISOString()],
  });
  return token;
}

/// Atomically spends a token, returning the user id it belonged to. The
/// single-use guarantee is the conditional UPDATE rather than a read followed
/// by a write, so two clicks on one reset link cannot both succeed.
export async function consumeEmailToken(
  token: string,
  kind: EmailTokenKind
): Promise<string | null> {
  await ensureSchema();
  const now = new Date().toISOString();
  const res = await db().execute({
    sql: `UPDATE email_tokens SET used_at = ?
          WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?
          RETURNING user_id`,
    args: [now, hashToken(token), kind, now],
  });
  const row = res.rows[0] as unknown as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export async function markEmailVerified(userId: string): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: `UPDATE users SET email_verified = 1 WHERE id = ?`, args: [userId] });
}

export async function setPassword(userId: string, passwordHash: string): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE users SET password_hash = ? WHERE id = ?`,
    args: [passwordHash, userId],
  });
}
