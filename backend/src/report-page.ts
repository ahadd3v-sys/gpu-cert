import type { ReportRow } from "../lib/db.js";
import { esc } from "./html.js";
import { FONT_FACE_CSS, TOKENS_CSS, renderEmblem } from "./theme.js";

// Hand-written HTML string, not JSX — this is a single static-shaped page
// with no interactivity beyond the claim form, and skipping JSX means
// skipping React as a runtime dependency entirely (see badge.ts for the
// same reasoning on the image route).
//
// Styled as an actual certificate (lab-report/calibration-certificate
// register, not diploma-ornate) rather than a generic results screen,
// since this page's whole job is to read as a credible, hard-to-fake
// document to a stranger deciding whether to trust a GPU listing. It
// commits to a single fixed "paper" look rather than following the
// viewer's OS light/dark preference — a certificate isn't supposed to
// look different depending on who's viewing it.
function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatPciId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function certificateNumber(id: string): string {
  return `GPUC-${id.slice(0, 8).toUpperCase()}`;
}

// Circular stamp seal: an arc of ring text spanning 300° (leaving a 60° gap
// at the bottom for a center mark, same convention real embossed stamps
// use), two roughened rings behind it, and the verdict as the centerpiece.
// The ink-roughness filter is applied only to the ring strokes, not the
// text, so the text stays legible while the rings read as physically
// stamped rather than vector-perfect.
function renderSeal(verdict: "Pass" | "Fail"): string {
  const passed = verdict === "Pass";
  const color = passed ? "#3f6c4f" : "#96432f";
  const word = passed ? "PASS" : "FAIL";
  const subword = passed ? "CERTIFIED" : "NOT CERTIFIED";
  const ringText = "GPU CERT  •  INDEPENDENT VERIFICATION PROTOCOL  • ";

  return `<svg class="seal" viewBox="0 0 200 200" aria-hidden="true">
    <defs>
      <filter id="sealInk" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.6"/>
      </filter>
      <path id="sealRingPath" d="M 62.5,164.95 A 75,75 0 1,1 137.5,164.95" fill="none"/>
    </defs>
    <circle cx="100" cy="100" r="90" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.9" filter="url(#sealInk)"/>
    <circle cx="100" cy="100" r="80" fill="none" stroke="${color}" stroke-width="1" opacity="0.75" filter="url(#sealInk)"/>
    <text class="seal-ring-text" fill="${color}">
      <textPath href="#sealRingPath" startOffset="1%">${esc(ringText)}</textPath>
    </text>
    <text x="100" y="172" text-anchor="middle" class="seal-mark" fill="${color}">&#10022;</text>
    <text x="100" y="98" text-anchor="middle" class="seal-word" fill="${color}">${word}</text>
    <text x="100" y="120" text-anchor="middle" class="seal-subword" fill="${color}">${subword}</text>
  </svg>`;
}

export function renderReportPage(report: ReportRow, viewerLoggedIn: boolean): string {
  const passed = report.verdict === "Pass";
  const vramPct = Math.round((report.vram_bytes_tested / report.fingerprint_vram_total_bytes) * 100);
  const sigTruncated = `${report.signature.slice(0, 20)}…${report.signature.slice(-16)}`;
  const reasons: string[] = passed ? [] : JSON.parse(report.verdict_reasons);

  const reasonsSection =
    reasons.length > 0
      ? `<hr class="rule">
         <section>
           <p class="section-label">Why This Failed</p>
           <ul class="reasons-list">
             ${reasons.map((r) => `<li>${esc(r)}</li>`).join("\n")}
           </ul>
         </section>`
      : "";

  const claimAction =
    report.user_id === null
      ? viewerLoggedIn
        ? `<form method="post" action="/r/${esc(report.id)}/claim" class="claim-form">
             <button type="submit" class="claim-button">Save to my account</button>
           </form>`
        : `<p class="claim-prompt"><a href="/login?next=/r/${esc(report.id)}">Log in</a> to save this report to your account.</p>`
      : `<p class="claim-prompt">Saved to an account.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.device_name)} — GPU Cert</title>
<style>
  ${FONT_FACE_CSS}

  ${TOKENS_CSS}

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--paper-edge);
    color: var(--ink);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  main.page {
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 20px 64px;
  }

  .certificate {
    position: relative;
    background: var(--paper);
    border: 1px solid var(--paper-deep);
    padding: 40px 44px 36px;
    box-shadow: 0 18px 40px -24px rgba(27, 33, 29, 0.45), 0 2px 6px rgba(27, 33, 29, 0.06);
  }

  .verdict-edge {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 5px;
  }
  .verdict-edge.pass { background: var(--pass); }
  .verdict-edge.fail { background: var(--fail); }

  .tick { position: absolute; width: 16px; height: 16px; }
  .tick-tl { top: 10px; left: 10px; border-top: 1.5px solid var(--mark); border-left: 1.5px solid var(--mark); }
  .tick-tr { top: 10px; right: 10px; border-top: 1.5px solid var(--mark); border-right: 1.5px solid var(--mark); }
  .tick-bl { bottom: 10px; left: 10px; border-bottom: 1.5px solid var(--mark); border-left: 1.5px solid var(--mark); }
  .tick-br { bottom: 10px; right: 10px; border-bottom: 1.5px solid var(--mark); border-right: 1.5px solid var(--mark); }

  .rule { border: none; border-top: 1px solid var(--paper-deep); margin: 28px 0; }
  .rule-double { border: none; height: 4px; border-top: 1px solid var(--mark); border-bottom: 1px solid var(--mark); opacity: 0.5; margin: 22px 0; }

  .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }

  .mark-group { display: flex; align-items: center; gap: 12px; }
  .emblem { width: 32px; height: 32px; color: var(--mark); flex-shrink: 0; }
  .wordmark { font-family: "Space Grotesk", sans-serif; font-weight: 650; font-size: 19px; letter-spacing: 0.04em; color: var(--mark); }
  .tagline { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-top: 2px; }

  .serial-block { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: var(--ink-muted); }
  .serial-row { white-space: nowrap; }
  .serial-label { text-transform: uppercase; letter-spacing: 0.06em; font-size: 9.5px; margin-right: 6px; }
  .serial-value { color: var(--ink); font-variant-numeric: tabular-nums; }

  .hero { position: relative; text-align: center; padding: 8px 0 4px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mark); margin: 0 0 14px; }
  .device-name { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: clamp(28px, 5vw, 38px); line-height: 1.12; margin: 0 0 18px; text-wrap: balance; }
  .statement { max-width: 46ch; margin: 0 auto; color: var(--ink-muted); font-size: 14.5px; line-height: 1.65; }

  .seal { position: absolute; width: 152px; height: 152px; right: -6px; bottom: -46px; transform: rotate(-8deg); filter: drop-shadow(0 3px 4px rgba(27, 33, 29, 0.18)); }
  .seal-ring-text { font-family: "Space Grotesk", sans-serif; font-size: 8.6px; letter-spacing: 1.6px; }
  .seal-mark { font-size: 11px; }
  .seal-word { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 30px; letter-spacing: 0.02em; }
  .seal-subword { font-size: 9px; letter-spacing: 0.14em; }

  .section-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mark); margin: 0 0 14px; }

  dl.spec-grid { display: grid; grid-template-columns: 1fr auto; row-gap: 0; margin: 0; }
  .spec-row { display: contents; }
  .spec-row dt, .spec-row dd { padding: 9px 0; border-top: 1px solid var(--paper-deep); margin: 0; font-size: 13.5px; }
  .spec-row:first-child dt, .spec-row:first-child dd { border-top: none; }
  .spec-row dt { color: var(--ink-muted); font-weight: normal; }
  .spec-row dd { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; word-break: break-all; padding-left: 20px; }

  .protocol-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
  .protocol-block { min-width: 0; }
  .protocol-block-wide { grid-column: 1 / -1; }
  .protocol-name { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 16px; margin: 0 0 4px; }
  .protocol-method { font-size: 12.5px; color: var(--ink-muted); margin: 0 0 14px; line-height: 1.5; }
  dl.protocol-results { display: grid; grid-template-columns: 1fr auto; row-gap: 6px; margin: 0; font-size: 13px; }
  .protocol-results > div { display: contents; }
  .protocol-results dt { color: var(--ink-muted); margin: 0; }
  .protocol-results dd { margin: 0; text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }

  .reasons-list { margin: 0; padding-left: 20px; color: var(--fail); font-size: 13.5px; line-height: 1.6; }
  .reasons-list li { margin-bottom: 6px; }
  .reasons-list li::marker { color: var(--fail); }

  .auth-footer { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
  .auth-footer .sig { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; margin: 0 0 4px; word-break: break-all; }
  .footer-note { font-size: 11px; color: var(--ink-muted); margin: 0; }
  .verify-block { text-align: right; }
  .verify-url { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; margin: 2px 0 0; }

  .page-actions { margin-top: 28px; text-align: center; }
  .claim-button {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 13.5px;
    padding: 9px 20px;
    background: var(--mark);
    color: var(--paper);
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .claim-button:hover { opacity: 0.9; }
  .claim-button:focus-visible, a:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }
  .claim-prompt { font-size: 13px; color: var(--ink-muted); margin: 0; }
  .claim-prompt a { color: var(--mark); }

  .report-id-footer { text-align: center; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; color: var(--ink-muted); margin-top: 14px; }

  @media (max-width: 560px) {
    .certificate { padding: 32px 22px 28px; }
    .masthead { flex-direction: column; }
    .serial-block { text-align: left; }
    .seal { position: static; margin: 24px auto 0; transform: rotate(-4deg); }
    .protocol-grid { grid-template-columns: 1fr; gap: 24px; }
    .auth-footer { flex-direction: column; }
    .verify-block { text-align: left; }
  }
</style>
</head>
<body>
<main class="page">
  <article class="certificate">
    <div class="verdict-edge ${passed ? "pass" : "fail"}"></div>
    <span class="tick tick-tl"></span>
    <span class="tick tick-tr"></span>
    <span class="tick tick-bl"></span>
    <span class="tick tick-br"></span>

    <header class="masthead">
      <div class="mark-group">
        ${renderEmblem()}
        <div>
          <div class="wordmark">GPU CERT</div>
          <div class="tagline">Independent Verification Protocol</div>
        </div>
      </div>
      <div class="serial-block">
        <div class="serial-row"><span class="serial-label">Certificate No.</span><span class="serial-value">${esc(certificateNumber(report.id))}</span></div>
        <div class="serial-row"><span class="serial-label">Issued</span><span class="serial-value">${formatDate(report.created_at)}</span></div>
      </div>
    </header>

    <div class="rule-double"></div>

    <section class="hero">
      <p class="eyebrow">Certificate of Hardware Verification</p>
      <h1 class="device-name">${esc(report.device_name)}</h1>
      <p class="statement">This certifies that the graphics processing unit described herein has completed GPU Cert's independent hardware verification protocol and is issued the result below.</p>
      ${renderSeal(passed ? "Pass" : "Fail")}
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">GPU Specification</p>
      <dl class="spec-grid">
        <div class="spec-row"><dt>Device</dt><dd>${esc(report.device_name)}</dd></div>
        <div class="spec-row"><dt>Total VRAM</dt><dd>${formatBytes(report.fingerprint_vram_total_bytes)}</dd></div>
        <div class="spec-row"><dt>GPU UUID</dt><dd>${esc(report.fingerprint_uuid)}</dd></div>
        <div class="spec-row"><dt>PCI Device ID</dt><dd>${formatPciId(report.fingerprint_pci_device_id)}</dd></div>
        <div class="spec-row"><dt>VBIOS Version</dt><dd>${esc(report.fingerprint_vbios_version)}</dd></div>
        <div class="spec-row"><dt>Hardware Fingerprint</dt><dd>${esc(report.fingerprint_hash)}</dd></div>
        <div class="spec-row"><dt>PCIe Link Width</dt><dd>x${report.pcie_link_width_current} of x${report.pcie_link_width_max} max</dd></div>
        <div class="spec-row"><dt>Client Version</dt><dd>${esc(report.client_version)}</dd></div>
      </dl>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">Verification Protocol</p>
      <div class="protocol-grid">
        <div class="protocol-block">
          <p class="protocol-name">Stress Test</p>
          <p class="protocol-method">Sustained GPU load via a hand-written Vulkan compute kernel</p>
          <dl class="protocol-results">
            <div><dt>Duration</dt><dd>${formatDuration(report.stress_duration_ms)}</dd></div>
            <div><dt>Dispatches</dt><dd>${formatCount(report.stress_dispatch_count)}</dd></div>
            <div><dt>Peak temperature</dt><dd>${report.stress_peak_temp_c}°C</dd></div>
            <div><dt>Thermal stability</dt><dd>${report.stress_thermally_stable === 1 ? "Stable" : "Throttled"}</dd></div>
          </dl>
        </div>
        <div class="protocol-block">
          <p class="protocol-name">VRAM Pattern Test</p>
          <p class="protocol-method">Bit-pattern write/verify sweep across active memory</p>
          <dl class="protocol-results">
            <div><dt>Duration</dt><dd>${formatDuration(report.vram_duration_ms)}</dd></div>
            <div><dt>Coverage</dt><dd>${formatBytes(report.vram_bytes_tested)} (${vramPct}%)</dd></div>
            <div><dt>Passes run</dt><dd>${formatCount(report.vram_passes_run)}</dd></div>
            <div><dt>Errors</dt><dd>${formatCount(report.vram_total_errors)}</dd></div>
          </dl>
        </div>
        <div class="protocol-block protocol-block-wide">
          <p class="protocol-name">Render Integrity Test</p>
          <p class="protocol-method">Deterministic graphics-pipeline render, checked pixel-for-pixel against the expected output — catches rasterizer/shader-core defects the compute and VRAM tests can't see</p>
          <dl class="protocol-results">
            <div><dt>Duration</dt><dd>${formatDuration(report.fur_duration_ms)}</dd></div>
            <div><dt>Frames rendered</dt><dd>${formatCount(report.fur_frames_rendered)}</dd></div>
            <div><dt>Sample pixels checked</dt><dd>${formatCount(report.fur_pixels_checked)}</dd></div>
            <div><dt>Mismatches</dt><dd>${formatCount(report.fur_mismatches)}</dd></div>
          </dl>
        </div>
      </div>
    </section>
    ${reasonsSection}
    <div class="rule-double"></div>

    <footer class="auth-footer">
      <div>
        <p class="section-label">Cryptographic Signature</p>
        <p class="sig">${esc(sigTruncated)}</p>
        <p class="footer-note">Ed25519 — verifiable against GPU Cert's published signing key</p>
      </div>
      <div class="verify-block">
        <p class="footer-note">Verified ${formatTimestamp(report.created_at)}</p>
        <p class="verify-url">/r/${esc(report.id)}</p>
      </div>
    </footer>
  </article>

  <div class="page-actions">${claimAction}</div>
  <p class="report-id-footer">Report ID: ${esc(report.id)}</p>
</main>
</body>
</html>`;
}
