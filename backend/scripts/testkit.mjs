// Test-harness helpers for the shell scripts. Everything here talks to the
// throwaway database the calling script created, never to production.
//
// `backdate` exists because attestation is deliberately time-based: a report
// claiming 16 minutes of testing is refused unless its session was open that
// long. Tests can't wait 16 minutes, so they move the session's start time
// instead. That keeps the scripts exercising the real ingest path, including
// every attestation check, rather than a weakened version of it.
import { createClient } from "@libsql/client";

const [command, ...args] = process.argv.slice(2);
const db = createClient({ url: process.env.DATABASE_URL });

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3111";

async function startSession(fingerprintHash) {
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
  return res.json();
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
  default:
    throw new Error(`unknown command: ${command}`);
}
