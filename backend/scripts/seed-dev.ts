// Fills a local file:local.db with one account and a few reports so the site
// pages can be opened and looked at. Dev-only; never run against a real DB.
import { db, ensureSchema, createUser, getUserByEmail } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";

const EMAIL = "seller@example.com";
const PASSWORD = "devpassword";

async function main() {
  await ensureSchema();

  let user = await getUserByEmail(EMAIL);
  if (!user) user = await createUser(EMAIL, hashPassword(PASSWORD));

  await db().execute({ sql: `DELETE FROM reports WHERE user_id = ? OR user_id IS NULL`, args: [user.id] });

  const cards: Array<[string, string, number, string, number, number]> = [
    // name, verdict, vram bytes, vbios, peak temp, vram errors
    ["NVIDIA GeForce RTX 3080", "Pass", 10 * 1024 ** 3, "94.02.42.00.9B", 74, 0],
    ["NVIDIA GeForce RTX 2070 SUPER", "Fail", 8 * 1024 ** 3, "90.04.4B.00.31", 91, 1417],
    ["AMD Radeon RX 6800 XT", "Pass", 16 * 1024 ** 3, "017-D0000M-102", 71, 0],
  ];

  let i = 0;
  for (const [name, verdict, vram, vbios, peak, vramErrors] of cards) {
    i += 1;
    const id = crypto.randomUUID();
    const reasons =
      verdict === "Fail"
        ? JSON.stringify([
            `VRAM pattern test found ${vramErrors.toLocaleString("en-US")} errors. Any error indicates degraded memory.`,
            `Peak temperature reached ${peak} °C without thermally stabilizing.`,
          ])
        : "[]";

    await db().execute({
      sql: `INSERT INTO reports (
        id, user_id, client_version, device_name,
        fingerprint_uuid, fingerprint_pci_device_id, fingerprint_vram_total_bytes,
        fingerprint_vbios_version, fingerprint_hash,
        pcie_link_width_current, pcie_link_width_max,
        verdict, verdict_reasons,
        stress_dispatch_count, stress_duration_ms, stress_telemetry_series,
        stress_peak_temp_c, stress_thermally_stable, stress_clock_stability_pct, stress_aborted_for_safety,
        vram_passes_run, vram_total_errors, vram_bytes_tested, vram_duration_ms, vram_aborted_for_safety,
        fur_frames_rendered, fur_duration_ms, fur_mismatches, fur_pixels_checked, fur_aborted_for_safety,
        signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        user.id,
        "0.1.0",
        name,
        `GPU-${id.slice(0, 8)}-${id.slice(9, 13)}-${id.slice(14, 18)}-mock`,
        0x2206,
        vram,
        vbios,
        `sha256:${id.replace(/-/g, "")}${id.replace(/-/g, "").slice(0, 32)}`.slice(0, 71),
        16,
        16,
        verdict,
        reasons,
        482_000,
        300_000,
        JSON.stringify([{ t: 0, temp_c: 42, clock_mhz: 1905 }, { t: 150, temp_c: peak - 2, clock_mhz: 1860 }]),
        peak,
        verdict === "Pass" ? 1 : 0,
        verdict === "Pass" ? 99.1 : 71.4,
        0,
        4,
        vramErrors,
        Math.round(vram * 0.85),
        600_000,
        0,
        2700,
        45_000,
        verdict === "Pass" ? 0 : 0,
        172_800,
        0,
        "3045ad8f19c27be4f0a1" + "b7e35c92d4f8a6e1c0b39d7f4e28a05c6b1d3f970e8a24c5b6d1f83e07a9c4b2d",
        new Date(Date.now() - i * 86_400_000 * 3).toISOString(),
      ],
    });
    console.log(`seeded ${verdict.padEnd(4)} ${name}  ->  /r/${id}`);
  }

  const fresh = await getUserByEmail(EMAIL);
  console.log(`\naccount: ${EMAIL} / ${PASSWORD}`);
  console.log(`upload key: ${fresh?.upload_key}`);
}

main();
