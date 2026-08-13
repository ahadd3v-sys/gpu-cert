// Test-harness helpers for the shell scripts. Everything here talks to the
// throwaway database the calling script created, never to production.
//
// `backdate` exists because attestation is deliberately time-based: a report
// claiming 16 minutes of testing is refused unless its session was open that
// long. Tests can't wait 16 minutes, so they move the session's start time
// instead. That keeps the scripts exercising the real ingest path, including
// every attestation check, rather than a weakened version of it.
import { createClient } from "@libsql/client";
import { createEmailToken } from "../lib/db.js";

const [command, ...args] = process.argv.slice(2);
const db_url = process.env.DATABASE_URL as string;
const db = createClient({ url: db_url });

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3111";

async function startSession(fingerprintHash: string) {
  const res = await fetch(`${BASE}/api/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_version: "test",
      device_name: "AMD Radeon RX 6600",
      fingerprint_hash: fingerprintHash,
    }),
  });
  if (!res.ok) throw new Error(`session start failed: ${res.status}`);
  return (await res.json()) as { session_id: string; nonce: string };
}

switch (command) {
  case "start": {
    const session = await startSession(args[0]);
    process.stdout.write(`${session.session_id} ${session.nonce}`);
    break;
  }
  case "backdate": {
    // args: sessionId, secondsAgo, progressCount
    const [id, secondsAgo, progress] = args;
    const started = new Date(Date.now() - Number(secondsAgo) * 1000).toISOString();
    await db.execute({
      sql: `UPDATE test_sessions SET started_at = ?, progress_count = ? WHERE id = ?`,
      args: [started, Number(progress), id],
    });
    process.stdout.write("ok");
    break;
  }
  case "count": {
    const res = await db.execute(`SELECT COUNT(*) AS n FROM ${args[0]}`);
    process.stdout.write(String(res.rows[0].n));
    break;
  }
  case "tamper": {
    // args: reportId, column, value
    const [id, column, value] = args;
    if (!/^[a-z_]+$/.test(column)) throw new Error("bad column");
    await db.execute({ sql: `UPDATE reports SET ${column} = ? WHERE id = ?`, args: [value, id] });
    process.stdout.write("ok");
    break;
  }
  case "user-id": {
    const res = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [args[0]] });
    process.stdout.write(String(res.rows[0]?.id ?? ""));
    break;
  }
  case "set-verified": {
    await db.execute({ sql: "UPDATE users SET email_verified = ? WHERE email = ?", args: [Number(args[1]), args[0]] });
    process.stdout.write("ok");
    break;
  }
  case "verified": {
    const res = await db.execute({ sql: "SELECT email_verified FROM users WHERE email = ?", args: [args[0]] });
    process.stdout.write(String(res.rows[0]?.email_verified ?? ""));
    break;
  }
  // Mints a real token through the same code path the app uses. The raw token
  // only ever exists in the email, so a test that needs to click a link has to
  // issue its own.
  case "token": {
    process.stdout.write(await createEmailToken(args[0], args[1] as "verify" | "reset", 60));
    break;
  }
  case "owner-of": {
    const res = await db.execute({ sql: "SELECT COALESCE(user_id,'none') AS o FROM reports WHERE id = ?", args: [args[0]] });
    process.stdout.write(String(res.rows[0]?.o ?? "missing"));
    break;
  }
  case "username-of": {
    const res = await db.execute({ sql: "SELECT COALESCE(username,'none') AS u FROM users WHERE email = ?", args: [args[0]] });
    process.stdout.write(String(res.rows[0]?.u ?? "missing"));
    break;
  }
  case "views": {
    // args: reportId, kind
    const res = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM report_views WHERE report_id = ? AND kind = ?",
      args: [args[0], args[1]],
    });
    process.stdout.write(String(res.rows[0]!.n));
    break;
  }
  case "referrers": {
    const res = await db.execute({
      sql: "SELECT COALESCE(referrer_host,'direct') AS h FROM report_views WHERE report_id = ?",
      args: [args[0]],
    });
    process.stdout.write(res.rows.map((r) => r.h).join(","));
    break;
  }
  default:
    throw new Error(`unknown command: ${command}`);
}
