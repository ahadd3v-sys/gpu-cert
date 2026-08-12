// Shared visual language for every page on the site.
//
// The certificate page (report-page.ts) established this identity first —
// paper stock, ink, a navy issuing-body accent, Fraunces for display and
// Georgia for running text. The rest of the site is the same issuing body's
// stationery, so the tokens and the masthead live here and both sides import
// them rather than each page carrying its own copy of the palette.
//
// Like the certificate, these pages commit to one fixed paper look instead of
// following the viewer's light/dark preference. A certificate authority whose
// letterhead changes color depending on who's looking at it reads as less
// credible, not more, and the certificate is the thing the whole site exists
// to make believable.
import { esc } from "./html";
import { FRAUNCES_WOFF2_BASE64 } from "./fonts";

export const TOKENS_CSS = `:root {
    --paper: #eef0e9;
    --paper-deep: #e3e6db;
    --paper-edge: #dde1d5;
    --ink: #1b211d;
    --ink-muted: #5c655c;
    --navy: #23395d;
    --pass: #1f6b45;
    --fail: #8a2a2a;
  }`;

export const FONT_FACE_CSS = `@font-face {
    font-family: "Fraunces";
    font-style: normal;
    font-weight: 300 900;
    font-display: swap;
    src: url(data:font/woff2;base64,${FRAUNCES_WOFF2_BASE64}) format("woff2");
  }`;

// Hexagonal die mark — the letterhead emblem, geometric rather than a literal
// GPU illustration so it stays legible at 32px and in a favicon.
export function renderEmblem(): string {
  return `<svg class="emblem" viewBox="0 0 32 32" aria-hidden="true">
    <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <rect x="11" y="11" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <line x1="16" y1="2" x2="16" y2="11" stroke="currentColor" stroke-width="1.2"/>
    <line x1="16" y1="21" x2="16" y2="30" stroke="currentColor" stroke-width="1.2"/>
    <line x1="4" y1="16" x2="11" y2="16" stroke="currentColor" stroke-width="1.2"/>
    <line x1="21" y1="16" x2="28" y2="16" stroke="currentColor" stroke-width="1.2"/>
  </svg>`;
}

// Base stylesheet for the non-certificate pages. The certificate keeps its own
// sheet — it's a fixed-shape document with layout rules that would only be
// dead weight here.
const SITE_CSS = `
  ${FONT_FACE_CSS}

  ${TOKENS_CSS}

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--paper-edge);
    color: var(--ink);
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    font-size: 15px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  a { color: var(--navy); }
  a:focus-visible, button:focus-visible, input:focus-visible {
    outline: 2px solid var(--navy);
    outline-offset: 2px;
  }

  /* One paper sheet per page, ticked at the corners like the certificate. */
  .sheet {
    position: relative;
    background: var(--paper);
    border: 1px solid var(--paper-deep);
    box-shadow: 0 18px 40px -24px rgba(27, 33, 29, 0.45), 0 2px 6px rgba(27, 33, 29, 0.06);
    padding: 36px 40px 32px;
  }
  .tick { position: absolute; width: 14px; height: 14px; }
  .tick-tl { top: 9px; left: 9px; border-top: 1.5px solid var(--navy); border-left: 1.5px solid var(--navy); }
  .tick-tr { top: 9px; right: 9px; border-top: 1.5px solid var(--navy); border-right: 1.5px solid var(--navy); }
  .tick-bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--navy); border-left: 1.5px solid var(--navy); }
  .tick-br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--navy); border-right: 1.5px solid var(--navy); }

  .rule { border: none; border-top: 1px solid var(--paper-deep); margin: 28px 0; }
  .rule-double { border: none; height: 4px; border-top: 1px solid var(--navy); border-bottom: 1px solid var(--navy); opacity: 0.5; margin: 20px 0; }

  /* Masthead — identical treatment to the certificate's letterhead. */
  .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .mark-group { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
  .emblem { width: 32px; height: 32px; color: var(--navy); flex-shrink: 0; }
  .wordmark { font-family: "Fraunces", serif; font-weight: 650; font-size: 19px; letter-spacing: 0.04em; color: var(--navy); }
  .tagline { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-top: 2px; }
  .masthead-nav { display: flex; align-items: center; gap: 18px; font-size: 13px; }
  .masthead-nav form { margin: 0; }

  .section-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--navy); margin: 0 0 14px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--navy); margin: 0 0 14px; }

  h1.display { font-family: "Fraunces", serif; font-weight: 600; font-size: clamp(28px, 5vw, 40px); line-height: 1.1; margin: 0 0 18px; text-wrap: balance; }
  h2.display { font-family: "Fraunces", serif; font-weight: 600; font-size: 21px; line-height: 1.25; margin: 0 0 10px; }
  .statement { color: var(--ink-muted); font-size: 15px; line-height: 1.7; margin: 0 0 22px; max-width: 54ch; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }

  /* Actions. The filled navy button is the certificate's claim button. */
  .btn {
    display: inline-block;
    font-family: Georgia, serif;
    font-size: 14px;
    padding: 10px 22px;
    background: var(--navy);
    color: var(--paper);
    border: none;
    cursor: pointer;
    text-decoration: none;
  }
  .btn:hover { opacity: 0.9; }
  .btn-quiet {
    background: none;
    color: var(--navy);
    border: 1px solid var(--navy);
    padding: 7px 14px;
    font-size: 13px;
  }

  /* Forms */
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--navy); margin-bottom: 6px; }
  .field input {
    width: 100%;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    padding: 9px 11px;
    background: #f6f7f2;
    border: 1px solid var(--paper-deep);
    border-bottom: 1.5px solid var(--ink-muted);
    color: var(--ink);
  }
  .field-hint { font-size: 12px; color: var(--ink-muted); margin: 6px 0 0; }

  /* Errors are stated, not apologized for — same register as the
     certificate's "Why This Failed" list. */
  .notice-fail {
    border-left: 3px solid var(--fail);
    background: rgba(138, 42, 42, 0.05);
    color: var(--fail);
    font-size: 13.5px;
    padding: 9px 14px;
    margin: 0 0 20px;
  }

  .footer-note { font-size: 11.5px; color: var(--ink-muted); }
  .page-footer { max-width: 760px; margin: 0 auto; padding: 18px 20px 40px; text-align: center; }

  @media (max-width: 560px) {
    .sheet { padding: 28px 20px 24px; }
    .masthead { flex-direction: column; }
  }
`;

interface PageOpts {
  title: string;
  /** Rendered into the masthead's right side. */
  nav?: string;
  /** Extra page-specific CSS, appended after the base sheet. */
  css?: string;
  /** Sheet max-width. Narrow for the credential forms. */
  width?: number;
  body: string;
}

export function sitePage({ title, nav = "", css = "", width = 760, body }: PageOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — GPU Cert</title>
<style>${SITE_CSS}
  main.page { max-width: ${width}px; margin: 0 auto; padding: 48px 20px 24px; }
${css}
</style>
</head>
<body>
<main class="page">
  <div class="sheet">
    <span class="tick tick-tl"></span>
    <span class="tick tick-tr"></span>
    <span class="tick tick-bl"></span>
    <span class="tick tick-br"></span>

    <header class="masthead">
      <a class="mark-group" href="/">
        ${renderEmblem()}
        <div>
          <div class="wordmark">GPU CERT</div>
          <div class="tagline">Independent Verification Protocol</div>
        </div>
      </a>
      <nav class="masthead-nav">${nav}</nav>
    </header>

    <div class="rule-double"></div>

    ${body}
  </div>
</main>
<footer class="page-footer">
  <p class="footer-note">GPU Cert issues signed hardware verification certificates. Every certificate is public and independently verifiable.</p>
</footer>
</body>
</html>`;
}
