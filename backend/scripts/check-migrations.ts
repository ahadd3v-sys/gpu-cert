// Runs ensureSchema() against databases shaped like older deployments.
//
// This exists because of a real outage. The username column was added with a
// UNIQUE index over it, both declared in the same block, so on a database that
// already had a users table the index was created before the ALTER that added
// the column. It threw, ensureSchema() failed, and every route touching the
// database returned 500. Nothing caught it because a fresh database, which is
// all the tests had ever used, creates the column and the index together and
// works fine.
//
// So the thing to test is not "does the schema apply", it is "does the schema
// apply to a database that predates it". Each case below is a snapshot of a
// real past shape.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClient } from "@libsql/client";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
    failures++;
  }
}

/// Every historical shape of the users table, oldest first. A new entry goes on
/// the end whenever a migration lands.
const LEGACY_SHAPES: Array<{ name: string; sql: string[] }> = [
  {
    name: "the original schema, before upload keys",
    sql: [
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    ],
  },
  {
    name: "after upload keys, before email verification",
    sql: [
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         upload_key TEXT UNIQUE,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    ],
  },
  {
    name: "production as it stood when usernames shipped",
    sql: [
      `CREATE TABLE users (
         id TEXT PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         upload_key TEXT UNIQUE,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         email_verified INTEGER NOT NULL DEFAULT 1
       )`,
      `INSERT INTO users (id, email, password_hash, upload_key)
         VALUES ('u1', 'existing@example.com', 'x:y', 'GPUC-AAAA-BBBB-CCCC-DDDD')`,
    ],
  },
];

const dir = mkdtempSync(join(tmpdir(), "gpucert-migrations-"));

console.log("migrations against older databases:");

for (const [i, shape] of LEGACY_SHAPES.entries()) {
  const path = join(dir, `legacy-${i}.db`);
  process.env.DATABASE_URL = `file:${path}`;

  const seed = createClient({ url: process.env.DATABASE_URL });
  for (const stmt of shape.sql) await seed.execute(stmt);

  // Imported fresh each time: ensureSchema() memoizes with a module-level
  // flag, so a single import would only ever migrate the first database.
  const db = await import(`../lib/db.js?case=${i}`);
  let applied = true;
  try {
    await db.ensureSchema();
  } catch (err) {
    applied = false;
    check(shape.name, false, String(err));
  }
  if (!applied) continue;

  const cols = await seed.execute("PRAGMA table_info(users)");
  const names = cols.rows.map((r) => String(r.name));
  const indexes = await seed.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'"
  );
  const indexNames = indexes.rows.map((r) => String(r.name));

  const hasAll =
    names.includes("upload_key") && names.includes("email_verified") && names.includes("username");
  check(shape.name, hasAll, `columns: ${names.join(", ")}`);
  check(
    `  ${shape.name}: the username index exists`,
    indexNames.includes("idx_users_username"),
    `indexes: ${indexNames.join(", ")}`
  );

  // The whole point of the index: it has to actually enforce uniqueness on a
  // migrated database, not merely exist.
  await seed.execute("UPDATE users SET username = 'taken' WHERE id = 'u1'").catch(() => {});
  if (shape.sql.length > 1) {
    let rejected = false;
    try {
      await seed.execute(
        `INSERT INTO users (id, email, username, password_hash) VALUES ('u2','other@example.com','taken','x:y')`
      );
    } catch {
      rejected = true;
    }
    check(`  ${shape.name}: duplicate usernames are rejected`, rejected);
  }
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall migration checks passed");
