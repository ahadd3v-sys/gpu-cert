// Shared visual language for every page on the site.
//
// Palette and type are anurfi.net's own tokens, reused directly rather than
// reinvented: --paper/--paper-deep/--ink/--ink-muted below are anurfi's
// --bg-2/--line/--ink/--muted-2, and --mark is anurfi's --bg (#14120f),
// which anurfi itself repurposes as its link/accent color rather than a
// literal "background", the same repurposing carries over here as GPU
// Cert's accent, replacing what used to be a one-off navy. Space Grotesk
// and Inter are anurfi's own display/body pairing. --pass and --fail are
// GPU Cert's own addition (anurfi has no verdict semantics), kept
// desaturated so they read as part of the same warm-neutral family
// instead of a bolted-on traffic-light red/green.
//
// The certificate page (report-page.ts) still commits to one fixed paper
// look rather than following the viewer's light/dark preference, a
// certificate authority whose letterhead changes color depending on who's
// looking at it reads as less credible, not more, and the certificate is
// the thing the whole site exists to make believable. The rest of the site
// follows suit for the same reason: it's the same issuing body's
// stationery, not a separate product with its own preferences to honor.
import { esc } from "./html.js";
import { SPACE_GROTESK_WOFF2_BASE64, INTER_WOFF2_BASE64 } from "./fonts.js";

export const TOKENS_CSS = `:root {
    --paper: #ece9e2;
    --paper-deep: #ddd8cc;
    --paper-edge: #ddd8cc;
    --ink: #1a1814;
    --ink-muted: #6b6658;
    --mark: #14120f;
    --pass: #3f6c4f;
    --fail: #96432f;
  }`;

export const FONT_FACE_CSS = `@font-face {
    font-family: "Space Grotesk";
    font-style: normal;
    font-weight: 500 700;
    font-display: swap;
    src: url(data:font/woff2;base64,${SPACE_GROTESK_WOFF2_BASE64}) format("woff2");
  }
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 400 600;
    font-display: swap;
    src: url(data:font/woff2;base64,${INTER_WOFF2_BASE64}) format("woff2");
  }`;

// The emblem again, redrawn for a browser tab rather than reused from
// renderEmblem(). Two things stop that one working here: it is stroked in
// `currentColor`, which resolves to nothing in a favicon context, and its
// hairlines vanish at 16px.
//
// So this inverts to solid shapes, a dark tile with a paper hexagon and a dark
// centre, which still reads as the same mark when it is sixteen pixels wide in
// a row of twenty tabs. Inline as a data URI rather than a served file so it
// needs no route, no build step, and no extra request.
//
// Single quotes inside the SVG on purpose: it sits in a double-quoted HTML
// attribute, and `#` has to be percent-encoded or the browser reads it as a
// fragment and drops the rest of the image.
const FAVICON_SVG = [
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>",
  "<rect width='32' height='32' rx='6' fill='%2314120f'/>",
  "<polygon points='16,4 26,10 26,22 16,28 6,22 6,10' fill='%23ece9e2'/>",
  "<rect x='12' y='12' width='8' height='8' fill='%2314120f'/>",
  "</svg>",
].join("");

export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml,${FAVICON_SVG}">`;

// Hexagonal die mark, the letterhead emblem, geometric rather than a literal
// GPU illustration so it stays legible at 32px and in a favicon. Its straight
// edges and right angles already read as the same "geometric grotesk"
// character as Space Grotesk, so it carried over unchanged in the move away
// from Fraunces.
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
// sheet, it's a fixed-shape document with layout rules that would only be
// dead weight here.
const SITE_CSS = `
  ${FONT_FACE_CSS}

  ${TOKENS_CSS}

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--paper-edge);
    color: var(--ink);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  a { color: var(--mark); }
  a:focus-visible, button:focus-visible, input:focus-visible {
    outline: 2px solid var(--mark);
    outline-offset: 2px;
  }

  /* One paper sheet per page, ticked at the corners like the certificate:
     the "controlled document" motif carries across the whole site, not
     just the certificate itself. */
  .sheet {
    position: relative;
    background: var(--paper);
    border: 1px solid var(--paper-deep);
    box-shadow: 0 18px 40px -24px rgba(26, 24, 20, 0.45), 0 2px 6px rgba(26, 24, 20, 0.06);
    padding: 36px 40px 32px;
  }
  .tick { position: absolute; width: 14px; height: 14px; }
  .tick-tl { top: 9px; left: 9px; border-top: 1.5px solid var(--mark); border-left: 1.5px solid var(--mark); }
  .tick-tr { top: 9px; right: 9px; border-top: 1.5px solid var(--mark); border-right: 1.5px solid var(--mark); }
  .tick-bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--mark); border-left: 1.5px solid var(--mark); }
  .tick-br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--mark); border-right: 1.5px solid var(--mark); }

  .rule { border: none; border-top: 1px solid var(--paper-deep); margin: 28px 0; }
  .rule-double { border: none; height: 4px; border-top: 1px solid var(--mark); border-bottom: 1px solid var(--mark); opacity: 0.5; margin: 20px 0; }

  /* Masthead, identical treatment to the certificate's letterhead. */
  .masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .mark-group { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
  .emblem { width: 32px; height: 32px; color: var(--mark); flex-shrink: 0; }
  .wordmark { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 19px; letter-spacing: 0.02em; color: var(--mark); }
  .tagline { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin-top: 2px; }
  .masthead-nav { display: flex; align-items: center; gap: 18px; font-size: 13px; }
  .masthead-nav form { margin: 0; }

  .section-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mark); margin: 0 0 14px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mark); margin: 0 0 14px; }

  h1.display { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: clamp(28px, 5vw, 40px); line-height: 1.1; margin: 0 0 18px; text-wrap: balance; }
  h2.display { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 21px; line-height: 1.25; margin: 0 0 10px; }
  .statement { color: var(--ink-muted); font-size: 15px; line-height: 1.7; margin: 0 0 22px; max-width: 54ch; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }

  /* Actions. The filled button is the certificate's claim button, restyled
     to the same mark/paper pairing. Small radius here (anurfi's own
     convention), but not on the certificate sheet or its ticks, where a
     rounded corner would break the crop-mark reading of "a printed
     document," which is the one place sharp corners still carry meaning. */
  .btn {
    display: inline-block;
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 14px;
    padding: 10px 22px;
    background: var(--mark);
    color: var(--paper);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-decoration: none;
  }
  .btn:hover { opacity: 0.9; }
  .btn-quiet {
    background: none;
    color: var(--mark);
    border: 1px solid var(--mark);
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
  }

  /* Forms */
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mark); margin-bottom: 6px; }
  .field input {
    width: 100%;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    padding: 9px 11px;
    background: #f6f5f0;
    border: 1px solid var(--paper-deep);
    border-radius: 4px;
    border-bottom: 1.5px solid var(--ink-muted);
    color: var(--ink);
  }
  .field-hint { font-size: 12px; color: var(--ink-muted); margin: 6px 0 0; }

  /* Errors are stated, not apologized for, same register as the
     certificate's "Why This Failed" list. */
  .notice-fail {
    border-left: 3px solid var(--fail);
    background: rgba(150, 67, 47, 0.07);
    color: var(--fail);
    font-size: 13.5px;
    padding: 9px 14px;
    margin: 0 0 20px;
  }

  .footer-note { font-size: 11.5px; color: var(--ink-muted); }
  .page-footer { max-width: 760px; margin: 0 auto; padding: 18px 20px 40px; text-align: center; }
  /* "Open source" belongs where a stranger deciding whether to run an
     unsigned exe will look for it, which is every page rather than a
     paragraph on the home page they may never scroll to. */
  .footer-links { margin-top: 8px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }

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

// 1100, not 760. A certificate should read as a document rather than fill the
// glass, but at 760 on a desktop monitor the sheet floated in more empty
// background than content, which reads as unfinished rather than as restraint.
// Prose is kept readable independently by `.statement`'s own max-width in ch,
// so the extra width goes to the tabular and multi-column sections that can
// actually use it instead of stretching line lengths.
export function sitePage({ title, nav = "", css = "", width = 1100, body }: PageOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}, GPU Cert</title>
${FAVICON_LINK}
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
  <p class="footer-note footer-links">
    <a href="https://github.com/ahadd3v-sys/gpu-cert">Read the source</a>
    <span aria-hidden="true">&middot;</span>
    <a href="/verify">Verify a certificate</a>
    <span aria-hidden="true">&middot;</span>
    <a href="/feedback">Feedback</a>
  </p>
</footer>
</body>
</html>`;
}
