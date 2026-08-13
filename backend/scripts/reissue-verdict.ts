// Re-evaluates a stored certificate under the current rules and re-signs it.
//
// Needed because a verdict is computed once, at ingest, and signed. When a
// scoring rule turns out to have been wrong, every certificate already issued
// keeps the wrong answer, and the wrong answer is public at a URL the seller
// has been handing to buyers.
//
// This is deliberately a script and not a route. Re-signing rewrites a document
// that other people may already have read, so it should be a considered act
// with a printed before-and-after, not something the server does quietly. It
// requires --confirm, and it refuses to touch a report whose verdict does not
// actually change.
import { createClient } from "@libsql/client";
import { computeVerdict, canonicalReportStringFromRow } from "../lib/certify.js";
import { signReport } from "../lib/signing.js";

const id = process.argv[2];
const confirm = process.argv.includes("--confirm");
if (!id) {
  console.error("usage: reissue-verdict <report-id> [--confirm]");
  process.exit(1);
}

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const res = await db.execute({ sql: `SELECT * FROM reports WHERE id = ?`, args: [id] });
const row = res.rows[0] as Record<string, unknown> | undefined;
if (!row) {
  console.error(`no report ${id}`);
  process.exit(1);
}

// Rebuilt from the stored columns rather than from the original payload, which
// was never kept. Only the fields computeVerdict reads are needed.
const request = {
  client_version: String(row.client_version),
  device_name: String(row.device_name),
  pcie_link_width_current: Number(row.pcie_link_width_current),
  pcie_link_width_max: Number(row.pcie_link_width_max),
  fingerprint: {
    uuid: String(row.fingerprint_uuid),
    pci_device_id: Number(row.fingerprint_pci_device_id),
    vram_total_bytes: Number(row.fingerprint_vram_total_bytes),
    vbios_version: String(row.fingerprint_vbios_version),
    hash: String(row.fingerprint_hash),
  },
  stress_test: {
    dispatch_count: Number(row.stress_dispatch_count),
    duration_ms: Number(row.stress_duration_ms),
    telemetry_series: JSON.parse(String(row.stress_telemetry_series)),
    aborted_for_safety: Number(row.stress_aborted_for_safety) === 1,
  },
  vram_test: {
    diagnostics: String(row.vram_diagnostics ?? ""),
    passes_run: Number(row.vram_passes_run),
    total_errors: Number(row.vram_total_errors),
    bytes_tested: Number(row.vram_bytes_tested),
    duration_ms: Number(row.vram_duration_ms),
    aborted_for_safety: Number(row.vram_aborted_for_safety) === 1,
  },
  fur_test: {
    frames_rendered: Number(row.fur_frames_rendered),
    duration_ms: Number(row.fur_duration_ms),
    mismatches: Number(row.fur_mismatches),
    pixels_checked: Number(row.fur_pixels_checked),
    aborted_for_safety: Number(row.fur_aborted_for_safety) === 1,
  },
} as Parameters<typeof computeVerdict>[0];

const next = computeVerdict(request);
const wasVerdict = String(row.verdict);
const wasReasons = JSON.parse(String(row.verdict_reasons ?? "[]")) as string[];

console.log(`report   ${id}`);
console.log(`card     ${row.device_name}`);
console.log(`\nbefore   ${wasVerdict}`);
for (const r of wasReasons) console.log(`         - ${r}`);
console.log(`\nafter    ${next.verdict}`);
for (const r of next.reasons) console.log(`         - ${r}`);

if (wasVerdict === next.verdict && JSON.stringify(wasReasons) === JSON.stringify(next.reasons)) {
  console.log("\nunchanged, nothing to do");
  process.exit(0);
}
if (!confirm) {
  console.log("\nre-run with --confirm to re-sign and store this");
  process.exit(0);
}

// Signed from the stored row, through the same function verification uses, so
// the reissued certificate verifies by exactly the path a reader would take.
const updated = { ...row, verdict: next.verdict, verdict_reasons: JSON.stringify(next.reasons) };
const signature = signReport(canonicalReportStringFromRow(updated as never));
await db.execute({
  sql: `UPDATE reports SET verdict = ?, verdict_reasons = ?, signature = ? WHERE id = ?`,
  args: [next.verdict, JSON.stringify(next.reasons), signature, id],
});
console.log("\nreissued and re-signed");
