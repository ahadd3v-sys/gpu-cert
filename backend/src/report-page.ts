import type { ReportRow } from "../lib/db";
import { esc } from "./html";

// Hand-written HTML string, not JSX — this is a single static-shaped page
// with no interactivity, and skipping JSX means skipping React as a
// runtime dependency entirely (see badge.ts for the same reasoning on the
// image route).
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

export function renderReportPage(report: ReportRow, viewerLoggedIn: boolean): string {
  const passed = report.verdict === "Pass";
  const badgeColor = passed ? "#2fbf71" : "#e5484d";
  const claimSection =
    report.user_id === null
      ? viewerLoggedIn
        ? `<form method="post" action="/r/${esc(report.id)}/claim" style="margin-top:24px;">
             <button type="submit">Save to my account</button>
           </form>`
        : `<p class="meta" style="margin-top:24px;"><a href="/login?next=/r/${esc(report.id)}">Log in</a> to save this report to your account.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.device_name)} — GPU Cert</title>
<style>
  :root { color-scheme: light dark; --bg: #0b0d10; --fg: #e8eaed; --muted: #9aa1a9; --border: #2a2e33; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --fg: #17181a; --muted: #5b6169; --border: #e3e5e8; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 24px; }
  .verdict { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 14px; font-weight: 600; color: #fff; background: ${badgeColor}; }
  h1 { margin-top: 16px; margin-bottom: 4px; }
  .meta { color: var(--muted); margin-top: 0; }
  section { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 24px; }
  section:first-of-type { margin-top: 32px; }
  h2 { font-size: 16px; color: var(--muted); }
  .hash { font-family: monospace; font-size: 13px; color: var(--muted); word-break: break-all; }
  .report-id { margin-top: 40px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="verdict">${passed ? "PASS" : "FAIL"}</div>
  <h1>${esc(report.device_name)}</h1>
  <p class="meta">Certified ${esc(new Date(report.created_at).toLocaleString())}</p>

  <section>
    <h2>VRAM pattern test</h2>
    <ul>
      <li>${report.vram_passes_run} passes run</li>
      <li>${formatBytes(report.vram_bytes_tested)} tested</li>
      <li>${report.vram_total_errors} error${report.vram_total_errors === 1 ? "" : "s"} detected</li>
    </ul>
  </section>

  <section>
    <h2>Stress test</h2>
    <ul>
      <li>${report.stress_dispatch_count} dispatches</li>
      <li>${(report.stress_duration_ms / 1000).toFixed(0)}s duration</li>
    </ul>
  </section>

  <section>
    <h2>Fingerprint</h2>
    <p class="hash">${esc(report.fingerprint_hash)}</p>
  </section>

  ${claimSection}

  <p class="report-id">Report ID: ${esc(report.id)}</p>
</main>
</body>
</html>`;
}
