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
  username TEXT UNIQUE,
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
  vram_diagnostics TEXT,
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
  consumed_at TEXT,
  -- What machine this ran on, captured before any testing so a run that later
  -- hangs or crashes has still said where it was.
  environment TEXT,
  -- The run's own log, appended as it goes. A run that never finishes still
  -- leaves the phase it reached, which is the whole point.
  run_log TEXT,
  failed_at TEXT,
  failure TEXT
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

-- One row per view of a certificate or its badge image. The point of
-- separating the two: a badge is embedded in a listing, so a badge request
-- means the listing was seen, while a page view means someone actually
-- clicked through to read the certificate. Impressions versus clickthroughs
-- is the whole question of whether this product works.
--
-- No cookies and no third-party script. The viewer hash is salted and rotates
-- daily, so it can count distinct people within a day and cannot follow
-- anyone across days.
CREATE TABLE IF NOT EXISTS report_views (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  referrer_host TEXT,
  viewer_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

`;

let initialized = false;

// CREATE TABLE IF NOT EXISTS won't add a column to a table that already
// exists, so anything added to SCHEMA after a DB has been created needs a
// matching ALTER here. Each runs inside its own try: "duplicate column name"
// is the expected outcome on an already-migrated DB, not a failure.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_reports_fingerprint_hash ON reports (fingerprint_hash);

CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports (user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_ip ON test_sessions (ip_hash, started_at);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);

CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);

CREATE INDEX IF NOT EXISTS idx_report_views_report ON report_views (report_id, created_at);

-- Enforces upload_key uniqueness on DBs where the column arrived via ALTER
-- (SQLite can't add a UNIQUE column in place). A unique index permits
-- multiple NULLs, which is what pre-backfill users hold.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_upload_key ON users (upload_key);

-- Same reasoning as the upload_key index: the column arrived via ALTER on
-- existing databases, where SQLite cannot add a UNIQUE column in place.
-- Usernames are stored already-lowercased, so a plain unique index is
-- sufficient to make them case-insensitively unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
`;

const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN upload_key TEXT`,
  // Existing accounts predate verification. They are marked verified rather
  // than locked out of their own certificates by a feature added after they
  // signed up.
  `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN username TEXT`,
  `ALTER TABLE reports ADD COLUMN vram_diagnostics TEXT`,
  `ALTER TABLE test_sessions ADD COLUMN environment TEXT`,
  `ALTER TABLE test_sessions ADD COLUMN run_log TEXT`,
  `ALTER TABLE test_sessions ADD COLUMN failed_at TEXT`,
  `ALTER TABLE test_sessions ADD COLUMN failure TEXT`,
  // Why a submission was refused, kept server-side only.
  //
  // The refusal itself is deliberately vague to the client, because handing a
  // forger the list of checks they failed is handing them the instructions.
  // But that left the reasons in an ephemeral platform log, so when an RTX
  // 3060 Ti's finished run was rejected there was no way to find out which
  // check had fired: exactly the situation diag.rs exists to prevent on the
  // client, reproduced on the server.
  `ALTER TABLE test_sessions ADD COLUMN rejected_at TEXT`,
  `ALTER TABLE test_sessions ADD COLUMN rejection TEXT`,
  // The serial printed on the card's own label, typed in by whoever owns the
  // certificate. Deliberately not part of the signed record: everything the
  // signature covers was measured by the client, and this was not.
  `ALTER TABLE reports ADD COLUMN serial_number TEXT`,
  `ALTER TABLE reports ADD COLUMN serial_added_at TEXT`,
];

// Order matters, and getting it wrong takes the whole site down rather than
// failing quietly. Tables, then column migrations, then indexes.
//
// The reason is that CREATE TABLE IF NOT EXISTS is a no-op against a database
// that already has the table, so a newly added column only arrives via its
// ALTER. An index over that column therefore cannot be created until the ALTER
// has run. Creating indexes in the same pass as the tables meant that on any
// existing database the index referenced a column that did not exist yet,
// which threw, which failed ensureSchema, which 500'd every route that touches
// the database. Exactly that shipped with the username column.
function statementsIn(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function ensureSchema() {
  if (initialized) return;

  for (const stmt of statementsIn(SCHEMA)) {
    await db().execute(stmt);
  }
  for (const stmt of MIGRATIONS) {
    try {
      await db().execute(stmt);
    } catch {
      // "duplicate column name" is the expected outcome on an already-migrated
      // database, not a failure.
    }
  }
  for (const stmt of statementsIn(INDEXES)) {
    await db().execute(stmt);
  }

  initialized = true;
}

export interface ReportRow {
  id: string;
  user_id: string | null;
  serial_number: string | null;
  serial_added_at: string | null;
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
  vram_diagnostics: string | null;
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
                 vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms, vram_aborted_for_safety, vram_diagnostics,
                 fur_frames_rendered, fur_duration_ms, fur_mismatches, fur_pixels_checked, fur_aborted_for_safety,
                 signature, created_at, serial_number, serial_added_at`;

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
  username: string | null;
  password_hash: string;
  upload_key: string | null;
  email_verified: number;
  created_at: string;
}

const USER_COLUMNS = `id, email, username, password_hash, upload_key, email_verified, created_at`;

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
export async function createUser(
  email: string,
  username: string,
  passwordHash: string,
  verified: boolean
): Promise<UserRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const uploadKey = generateUploadKey();
  await db().execute({
    sql: `INSERT INTO users (id, email, username, password_hash, upload_key, email_verified) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, email, username, passwordHash, uploadKey, verified ? 1 : 0],
  });
  return {
    id,
    email,
    username,
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
  /// The version that opened the session, which is what the version floor was
  /// checked against. Carried through so a submission can be judged by the
  /// rules in force when the run started rather than when it ended.
  client_version: string;
}

export async function createTestSession(opts: {
  fingerprintHash: string;
  deviceName: string;
  clientVersion: string;
  ipHash: string;
  environment?: string | null;
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
    sql: `INSERT INTO test_sessions (id, nonce, fingerprint_hash, device_name, client_version, ip_hash, started_at, environment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, nonce, opts.fingerprintHash, opts.deviceName, opts.clientVersion, opts.ipHash, new Date().toISOString(), opts.environment ?? null],
  });
  return { id, nonce };
}

export async function getTestSession(id: string, nonce: string): Promise<TestSessionRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, nonce, fingerprint_hash, started_at, progress_count, consumed_at, client_version
          FROM test_sessions WHERE id = ? AND nonce = ?`,
    args: [id, nonce],
  });
  const row = res.rows[0] as unknown as TestSessionRow | undefined;
  if (!row) return null;
  return { ...row, progress_count: Number(row.progress_count) };
}

/// Returns false if the session doesn't exist, the nonce is wrong, or it has
/// already been consumed, so a client can't keep a finished session alive.
export async function recordSessionProgress(
  id: string,
  nonce: string,
  logLines: string[] = []
): Promise<boolean> {
  await ensureSchema();
  // Appended rather than replaced, so each heartbeat only carries what is new
  // and a long run does not re-upload its history every minute. Capped so a
  // misbehaving client cannot grow one row without bound.
  const appended = logLines.length ? logLines.join("\n") + "\n" : "";
  const res = await db().execute({
    sql: `UPDATE test_sessions
          SET progress_count = progress_count + 1,
              last_progress_at = ?,
              run_log = substr(COALESCE(run_log, '') || ?, 1, 200000)
          WHERE id = ? AND nonce = ? AND consumed_at IS NULL`,
    args: [new Date().toISOString(), appended, id, nonce],
  });
  return res.rowsAffected > 0;
}

/// Records why a run died. The one thing a crashed run can still do, and the
/// difference between a bug that gets fixed and one that is only ever
/// described second-hand as "it got stuck".
/// Records why a submission was refused, against the session it was refused
/// for. Never returned to the client; see the migration for why.
/// Sets the card's printed serial, once, for the account that owns the
/// certificate.
///
/// Write-once on purpose. If it could be changed, a seller could certify a good
/// card, sell a different one, and edit the serial to match, which is precisely
/// the swap the field exists to make harder. The `serial_number IS NULL` clause
/// is what enforces it, in the statement rather than in a prior read, so two
/// racing requests cannot both win.
///
/// Returns false if the report does not exist, is not owned by this user, or
/// already has one.
export async function setReportSerial(
  reportId: string,
  userId: string,
  serial: string
): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `UPDATE reports SET serial_number = ?, serial_added_at = ?
          WHERE id = ? AND user_id = ? AND serial_number IS NULL`,
    args: [serial, new Date().toISOString(), reportId, userId],
  });
  return res.rowsAffected > 0;
}

/// Everything the admin page shows, in one round trip each.
///
/// These are the queries that have been run by hand against production all day
/// to answer "what actually happened", which is the argument for the page
/// existing: the answers were always in the database and always needed someone
/// with a shell to get them out.
export async function adminOverview(): Promise<Record<string, number>> {
  await ensureSchema();
  const res = await db().execute(`SELECT
    (SELECT COUNT(*) FROM reports) reports,
    (SELECT COUNT(DISTINCT fingerprint_hash) FROM reports) cards,
    (SELECT COUNT(*) FROM reports WHERE verdict = 'Fail') failed_cards,
    (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM reports WHERE user_id IS NOT NULL) claimed,
    (SELECT COUNT(*) FROM test_sessions) sessions,
    (SELECT COUNT(*) FROM test_sessions WHERE consumed_at IS NOT NULL) completed,
    (SELECT COUNT(*) FROM test_sessions WHERE failed_at IS NOT NULL) failed_runs,
    (SELECT COUNT(*) FROM report_views WHERE kind = 'page') page_views,
    (SELECT COUNT(*) FROM report_views WHERE kind = 'badge') badge_views,
    (SELECT COUNT(*) FROM feedback) feedback`);
  const row = res.rows[0] as unknown as Record<string, number>;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

export async function adminRecentReports(limit = 40): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, created_at, client_version, device_name, verdict,
                 vram_bytes_tested, fingerprint_vram_total_bytes, vram_total_errors,
                 fur_mismatches, stress_peak_temp_c, user_id, serial_number
          FROM reports ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows as unknown as Record<string, unknown>[];
}

/// Sessions matter more than reports here: a report only exists when a run
/// succeeded, so every interesting failure is invisible if you only look at
/// reports.
export async function adminRecentSessions(limit = 40): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, started_at, client_version, device_name, progress_count,
                 consumed_at, failed_at, failure, rejection,
                 length(COALESCE(run_log, '')) log_bytes,
                 length(COALESCE(environment, '')) env_bytes
          FROM test_sessions ORDER BY started_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function adminFeedback(limit = 50): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, created_at, message, contact, report_reference, console_output
          FROM feedback ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows as unknown as Record<string, unknown>[];
}

export async function adminSessionDetail(id: string): Promise<Record<string, unknown> | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT id, started_at, device_name, client_version, failure, rejection, run_log, environment
          FROM test_sessions WHERE id = ?`,
    args: [id],
  });
  return (res.rows[0] as unknown as Record<string, unknown>) ?? null;
}

export async function recordSessionRejection(
  id: string,
  problems: string[]
): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE test_sessions SET rejected_at = ?, rejection = substr(?, 1, 4000) WHERE id = ?`,
    args: [new Date().toISOString(), problems.join(" | "), id],
  });
}

export async function recordSessionFailure(
  id: string,
  nonce: string,
  failure: string,
  logLines: string[]
): Promise<boolean> {
  await ensureSchema();
  const res = await db().execute({
    sql: `UPDATE test_sessions
          SET failed_at = ?, failure = ?, run_log = substr(?, 1, 200000)
          WHERE id = ? AND nonce = ?`,
    args: [new Date().toISOString(), failure.slice(0, 8000), logLines.join("\n"), id, nonce],
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

// -------------------------------------------------------- view tracking

export type ViewKind = "page" | "badge";

export interface ViewStats {
  pageViews: number;
  badgeViews: number;
  uniqueViewers: number;
  lastViewedAt: string | null;
}

export async function recordReportView(opts: {
  reportId: string;
  kind: ViewKind;
  referrerHost: string | null;
  viewerHash: string;
}): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO report_views (id, report_id, kind, referrer_host, viewer_hash)
          VALUES (?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), opts.reportId, opts.kind, opts.referrerHost, opts.viewerHash],
  });
}

/// Stats for a set of reports in one query rather than one per row, since the
/// dashboard renders a whole register at once.
export async function getViewStats(reportIds: string[]): Promise<Map<string, ViewStats>> {
  const out = new Map<string, ViewStats>();
  if (reportIds.length === 0) return out;
  await ensureSchema();

  const placeholders = reportIds.map(() => "?").join(",");
  const res = await db().execute({
    sql: `SELECT report_id,
                 SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS page_views,
                 SUM(CASE WHEN kind = 'badge' THEN 1 ELSE 0 END) AS badge_views,
                 COUNT(DISTINCT viewer_hash) AS unique_viewers,
                 MAX(created_at) AS last_viewed_at
          FROM report_views WHERE report_id IN (${placeholders})
          GROUP BY report_id`,
    args: reportIds,
  });

  for (const row of res.rows as unknown as Array<{
    report_id: string;
    page_views: number;
    badge_views: number;
    unique_viewers: number;
    last_viewed_at: string | null;
  }>) {
    out.set(row.report_id, {
      pageViews: Number(row.page_views),
      badgeViews: Number(row.badge_views),
      uniqueViewers: Number(row.unique_viewers),
      lastViewedAt: row.last_viewed_at,
    });
  }
  return out;
}

/// Where a user's certificate traffic came from. This is the number that says
/// whether buyers are actually following these links out of listings.
export async function getReferrerBreakdown(
  userId: string,
  limit = 8
): Promise<Array<{ host: string; views: number }>> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT COALESCE(v.referrer_host, 'direct') AS host, COUNT(*) AS views
          FROM report_views v
          JOIN reports r ON r.id = v.report_id
          WHERE r.user_id = ? AND v.kind = 'page'
          GROUP BY host ORDER BY views DESC LIMIT ?`,
    args: [userId, limit],
  });
  return (res.rows as unknown as Array<{ host: string; views: number }>).map((r) => ({
    host: r.host,
    views: Number(r.views),
  }));
}

// ---------------------------------------------------------------- usernames

/// Deliberately narrow. A username may end up in a URL path (a public page for
/// a shop, say), in an email, and next to a verdict on a certificate, so the
/// character set is restricted to what is unambiguous in all three. No dots,
/// which read as file extensions in a path; no leading or trailing separators.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,18}[a-z0-9])$/;

/// Paths the site already uses, plus ones it plausibly will. Handing a user
/// "verify" or "admin" would mean either breaking their name later or living
/// with a routing conflict, and both are worse than refusing it now.
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "api", "app", "auth", "badge", "billing", "blog",
  "cert", "certificate", "certificates", "dashboard", "docs", "feedback",
  "gpucert", "gpu-cert", "help", "login", "logout", "me", "new", "null",
  "owner", "pricing", "r", "report", "reports", "root", "s", "settings",
  "shop", "shops", "signup", "static", "status", "support", "system", "team",
  "terms", "privacy", "test", "undefined", "user", "users", "verify",
  "well-known", "www",
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function usernameProblem(username: string): string | null {
  if (username.length < 3 || username.length > 20) {
    return "Username must be between 3 and 20 characters";
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "Usernames can use letters, numbers, hyphens and underscores, and must start and end with a letter or number";
  }
  if (RESERVED_USERNAMES.has(username)) {
    return "That username is reserved";
  }
  return null;
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT ${USER_COLUMNS} FROM users WHERE username = ?`,
    args: [normalizeUsername(username)],
  });
  return (res.rows[0] as unknown as UserRow) ?? null;
}

/// Login accepts either, because people remember one or the other and there is
/// no ambiguity: an email always contains "@", which a username never can.
export async function getUserByEmailOrUsername(identifier: string): Promise<UserRow | null> {
  const value = identifier.trim().toLowerCase();
  return value.includes("@") ? getUserByEmail(value) : getUserByUsername(value);
}

/// Accounts created before usernames existed have none. Rather than force an
/// interruption at login, one is derived from the email's local part on first
/// dashboard view, the same approach ensureUploadKey already takes.
export async function ensureUsername(user: UserRow): Promise<string> {
  if (user.username) return user.username;

  const base = normalizeUsername(user.email.split("@")[0] ?? "")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 16);
  const seed = usernameProblem(base) === null ? base : "user";

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}${attempt + 1}`;
    if (usernameProblem(candidate) !== null) continue;
    try {
      const res = await db().execute({
        sql: `UPDATE users SET username = ? WHERE id = ? AND username IS NULL`,
        args: [candidate, user.id],
      });
      if (res.rowsAffected > 0) return candidate;
      // Someone else set one first; re-read rather than overwrite.
      const fresh = await getUserById(user.id);
      if (fresh?.username) return fresh.username;
    } catch {
      // Unique violation: that name is taken, try the next suffix.
    }
  }
  return user.id.slice(0, 8);
}
