// Home, login, signup and dashboard. The certificate page (report-page.ts)
// owns the identity; these extend it as the same issuing body's stationery
// via the shared tokens and masthead in theme.ts.
//
// An account is optional everywhere in here, deliberately. The exe runs
// without one and its report is public the moment it lands, so nothing on
// this site may imply signing up is a prerequisite to testing a card — the
// account only buys you a place where your certificates are collected.
import { esc } from "./html";
import { sitePage } from "./theme";
import type { ReportRow } from "../lib/db";

const DOWNLOAD_URL = "https://github.com/ahadd3v-sys/gpu-cert/releases/latest/download/gpu-cert.exe";

function certificateNumber(id: string): string {
  return `GPUC-${id.slice(0, 8).toUpperCase()}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function loggedInNav(): string {
  return `<a href="/dashboard">My certificates</a>
    <form method="post" action="/logout"><button type="submit" class="btn btn-quiet">Log out</button></form>`;
}

function loggedOutNav(next?: string): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return `<a href="/login${q}">Log in</a>
    <a class="btn btn-quiet" href="/signup${q}">Create account</a>`;
}

// ---------------------------------------------------------------- home

const HOME_CSS = `
  .hero { padding: 6px 0 4px; }
  .hero-actions { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .hero-aside { font-size: 12.5px; color: var(--ink-muted); }

  /* The three tests, in the certificate's own protocol register. Not
     numbered: they run as a set, and no order is meaningful to a reader. */
  .protocol-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
  .protocol-block-wide { grid-column: 1 / -1; }
  .protocol-name { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 16px; margin: 0 0 4px; }
  .protocol-method { font-size: 12.5px; color: var(--ink-muted); margin: 0; line-height: 1.55; }
  .protocol-catch { font-size: 12.5px; margin: 8px 0 0; }
  /* Label, not a link: mark-colored body text next to real links elsewhere
     on the page reads as clickable, so this carries the eyebrow treatment
     instead. */
  .protocol-catch b {
    font-weight: normal;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin-right: 3px;
  }

  /* Steps ARE ordered here — you cannot share a link before running the
     exe — so the ordinals carry real information. */
  ol.steps { list-style: none; counter-reset: step; margin: 0; padding: 0; }
  ol.steps li { counter-increment: step; display: grid; grid-template-columns: 34px 1fr; gap: 14px; padding: 13px 0; border-top: 1px solid var(--paper-deep); }
  ol.steps li:first-child { border-top: none; }
  ol.steps li::before {
    content: counter(step, decimal-leading-zero);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--mark);
    padding-top: 3px;
  }
  .step-title { font-weight: normal; }
  .step-note { font-size: 12.5px; color: var(--ink-muted); }
  .step-optional .step-title { color: var(--ink-muted); }

  @media (max-width: 560px) {
    .protocol-grid { grid-template-columns: 1fr; gap: 22px; }
  }
`;

export function renderHome(loggedIn: boolean): string {
  return sitePage({
    title: "GPU Cert",
    nav: loggedIn ? loggedInNav() : loggedOutNav(),
    css: HOME_CSS,
    body: `
    <section class="hero">
      <p class="eyebrow">Hardware verification for the used GPU market</p>
      <h1 class="display">Prove the card works before you ask a stranger to trust you.</h1>
      <p class="statement">A used GPU listing is a claim with nothing behind it. GPU Cert runs a fixed test protocol against the card in your machine, then issues a signed certificate at a public URL. The buyer checks it themselves. No account needed to run it.</p>
      <div class="hero-actions">
        <a class="btn" href="${DOWNLOAD_URL}">Test your GPU</a>
        <span class="hero-aside">Windows, 3.8&nbsp;MB. Runs about 16 minutes.</span>
      </div>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">What gets tested</p>
      <div class="protocol-grid">
        <div>
          <p class="protocol-name">Stress test</p>
          <p class="protocol-method">Five minutes of sustained compute load through a hand-written Vulkan kernel, logging temperature and clocks throughout.</p>
          <p class="protocol-catch"><b>Catches</b> cards that overheat, never thermally settle, or throttle hard under load.</p>
        </div>
        <div>
          <p class="protocol-name">VRAM pattern test</p>
          <p class="protocol-method">A bit-pattern write and verify sweep across the card's active memory, ten minutes, derived from memtest_vulkan.</p>
          <p class="protocol-catch"><b>Catches</b> the memory damage heavy mining leaves behind. Telemetry alone cannot see it. One error fails the card.</p>
        </div>
        <div class="protocol-block-wide">
          <p class="protocol-name">Render integrity test</p>
          <p class="protocol-method">Renders a deterministic shader and checks a grid of sampled pixels against the CPU-recomputed expected output, every frame.</p>
          <p class="protocol-catch"><b>Catches</b> rasterizer and shader-core defects that produce wrong pixels rather than no pixels, which neither test above reads back far enough to notice.</p>
        </div>
      </div>
      <hr class="rule">
      <p class="footer-note">PCIe link width is checked too: a card sitting in a degraded slot, riser or connector fails with that stated as the reason. Any test aborts on its own if the GPU crosses 100&nbsp;°C, and an aborted run is reported as a finding rather than thrown away.</p>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">How it works</p>
      <ol class="steps">
        <li><div><div class="step-title">Download and run gpu-cert.exe</div><div class="step-note">A console app. It reads the card's identity, runs the three tests, and submits the result.</div></div></li>
        <li><div><div class="step-title">Your browser opens the finished certificate</div><div class="step-note">Signed server-side and bound to that specific card's fingerprint, at a public URL.</div></div></li>
        <li><div><div class="step-title">Put the link in your listing</div><div class="step-note">Anyone can open it and check the result without installing anything or taking your word for it.</div></div></li>
        <li class="step-optional"><div><div class="step-title">Optional: keep it in an account</div><div class="step-note">Create an account to collect your certificates in one place, or <a href="/signup">connect the app</a> so future runs file themselves. Certificates you have already made can be added afterwards.</div></div></li>
      </ol>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">Why a buyer should believe it</p>
      <p class="statement" style="margin-bottom: 0;">The certificate is signed with GPU Cert's key, not generated in your browser, and it names the card it was issued to: GPU UUID, PCI device ID, VBIOS version, VRAM size. Move the certificate to a different card and the fingerprint stops matching. There are plenty of good diagnostic tools already, and none of them produce something a stranger can verify.</p>
    </section>`,
  });
}

// ------------------------------------------------------- login / signup

const AUTH_CSS = `
  .auth-head { margin-bottom: 22px; }
  .auth-alt { font-size: 13px; color: var(--ink-muted); margin: 18px 0 0; }
  .auth-skip { font-size: 12.5px; color: var(--ink-muted); margin: 14px 0 0; padding-top: 14px; border-top: 1px solid var(--paper-deep); }
`;

function authPage(opts: {
  title: string;
  heading: string;
  intro: string;
  action: string;
  submitLabel: string;
  next: string | null;
  error: string | null;
  minLength?: number;
  altLine: string;
}): string {
  const nextField = opts.next ? `<input type="hidden" name="next" value="${esc(opts.next)}">` : "";
  const minAttr = opts.minLength ? ` minlength="${opts.minLength}"` : "";
  return sitePage({
    title: opts.title,
    width: 470,
    css: AUTH_CSS,
    body: `
    <div class="auth-head">
      <p class="eyebrow">${esc(opts.title)}</p>
      <h1 class="display" style="font-size: 27px; margin-bottom: 10px;">${esc(opts.heading)}</h1>
      <p class="statement" style="margin-bottom: 0; font-size: 14px;">${opts.intro}</p>
    </div>
    ${opts.error ? `<p class="notice-fail">${esc(opts.error)}</p>` : ""}
    <form method="post" action="${esc(opts.action)}">
      ${nextField}
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" autocomplete="email" required>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" name="password"${minAttr} autocomplete="current-password" required>
        ${opts.minLength ? `<p class="field-hint">At least ${opts.minLength} characters.</p>` : ""}
      </div>
      <button type="submit" class="btn">${esc(opts.submitLabel)}</button>
    </form>
    <p class="auth-alt">${opts.altLine}</p>
    <p class="auth-skip">You do not need an account to test a card. <a href="/">Skip this</a> and run the tool.</p>`,
  });
}

export function renderLogin(next: string | null, error: string | null): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return authPage({
    title: "Log in",
    heading: "Your certificates, in one place.",
    intro: "Log in to see every certificate you have filed and to get the key that connects the app to this account.",
    action: "/login",
    submitLabel: "Log in",
    next,
    error,
    altLine: `No account yet? <a href="/signup${q}">Create one</a>.`,
  });
}

export function renderSignup(next: string | null, error: string | null): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return authPage({
    title: "Create account",
    heading: "Keep every certificate you issue.",
    intro: "An account collects your certificates, and gives you a key so the app files future runs under your name automatically.",
    action: "/signup",
    submitLabel: "Create account",
    next,
    error,
    minLength: 8,
    altLine: `Already have an account? <a href="/login${q}">Log in</a>.`,
  });
}

// ----------------------------------------------------------- dashboard

const DASHBOARD_CSS = `
  .dash-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 4px; }
  .dash-head .btn { flex-shrink: 0; }

  /* A register of issued certificates, not a card grid: this is a numbered
     ledger of documents, and the certificate number is how you refer to one. */
  table.register { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  table.register th {
    text-align: left;
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--mark);
    padding: 0 0 9px;
    border-bottom: 1px solid var(--mark);
  }
  table.register td { padding: 11px 0; border-bottom: 1px solid var(--paper-deep); vertical-align: baseline; }
  /* Cells are edge-to-edge columns with no border between them, so the gutter
     has to come from padding or the number runs into the card name once the
     table is narrow enough to wrap. */
  table.register th:not(:last-child), table.register td:not(:last-child) { padding-right: 16px; }
  table.register th.num, table.register td.num { text-align: right; }
  .cert-no { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; color: var(--ink-muted); white-space: nowrap; }
  .device-cell a { text-decoration: none; }
  .device-cell a:hover { text-decoration: underline; }
  .verdict { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap; }
  .verdict-pass { color: var(--pass); }
  .verdict-fail { color: var(--fail); }
  .issued { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; color: var(--ink-muted); white-space: nowrap; }

  .empty-register { border: 1px dashed var(--paper-deep); border-radius: 6px; padding: 26px; text-align: center; }
  .empty-register p { margin: 0 0 16px; color: var(--ink-muted); font-size: 14px; }

  /* Connect-the-app panel. The key is the only interactive secret on the
     site, so it gets the monospace/tabular treatment data gets elsewhere. */
  .key-panel { background: #f6f5f0; border: 1px solid var(--paper-deep); border-radius: 6px; padding: 20px 22px; }
  /* .statement caps at 54ch for running prose; inside this panel that leaves
     a short ragged column against a full-width box. */
  .key-panel .statement { max-width: none; }
  .key-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 14px 0 0; }
  .key-value {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 15px;
    letter-spacing: 0.06em;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--paper-deep);
    border-radius: 4px;
    padding: 9px 13px;
    user-select: all;
  }
  .key-panel form { margin: 0; }

  /* Three columns of fixed-width mono don't fit a phone: the certificate
     number overflows its cell rather than wrapping (it's nowrap by design —
     a broken certificate number is worse than a hidden one). So below 560px
     the number and result columns are dropped and both move under the card
     name, where they have the full row width to sit in. */
  .row-meta { display: none; gap: 10px; margin-top: 3px; }
  .row-meta .cert-no { font-size: 11.5px; }

  @media (max-width: 560px) {
    table.register th.hide-sm, table.register td.hide-sm { display: none; }
    .row-meta { display: flex; align-items: baseline; }
  }
`;

export function renderDashboard(reports: ReportRow[], email: string, uploadKey: string): string {
  const register = reports.length
    ? `<table class="register">
         <thead>
           <tr>
             <th class="hide-sm">Certificate</th>
             <th>Card</th>
             <th class="hide-sm">Result</th>
             <th class="num">Issued</th>
           </tr>
         </thead>
         <tbody>
           ${reports
             .map((r) => {
               const passed = r.verdict === "Pass";
               return `<tr>
             <td class="cert-no hide-sm">${esc(certificateNumber(r.id))}</td>
             <td class="device-cell"><a href="/r/${esc(r.id)}">${esc(r.device_name)}</a>
               <div class="row-meta">
                 <span class="cert-no">${esc(certificateNumber(r.id))}</span>
                 <span class="verdict ${passed ? "verdict-pass" : "verdict-fail"}">${esc(r.verdict)}</span>
               </div></td>
             <td class="hide-sm"><span class="verdict ${passed ? "verdict-pass" : "verdict-fail"}">${esc(r.verdict)}</span></td>
             <td class="num issued">${formatDate(r.created_at)}</td>
           </tr>`;
             })
             .join("\n")}
         </tbody>
       </table>`
    : `<div class="empty-register">
         <p>No certificates filed yet.</p>
         <a class="btn" href="${DOWNLOAD_URL}">Test your GPU</a>
       </div>`;

  return sitePage({
    title: "My certificates",
    nav: loggedInNav(),
    css: DASHBOARD_CSS,
    body: `
    <div class="dash-head">
      <div>
        <p class="eyebrow">Register of issued certificates</p>
        <h1 class="display" style="font-size: 27px; margin-bottom: 6px;">${esc(email)}</h1>
        <p class="footer-note">${reports.length} ${reports.length === 1 ? "certificate" : "certificates"} filed to this account.</p>
      </div>
      ${reports.length ? `<a class="btn" href="${DOWNLOAD_URL}">Test another card</a>` : ""}
    </div>

    <hr class="rule">

    ${register}

    <hr class="rule">

    <section>
      <p class="section-label">Connect the app to this account</p>
      <div class="key-panel">
        <p class="statement" style="margin: 0; font-size: 14px;">Paste this key into gpu-cert.exe once, when it asks. Every run after that files its certificate here automatically instead of arriving unattached.</p>
        <div class="key-row">
          <span class="key-value">${esc(uploadKey)}</span>
          <form method="post" action="/dashboard/key/rotate">
            <button type="submit" class="btn btn-quiet">Replace key</button>
          </form>
        </div>
        <p class="field-hint">Replacing the key stops any machine still using the old one from filing here. Certificates already filed are unaffected.</p>
      </div>
      <p class="field-hint" style="margin-top: 14px;">Ran the tool without the key? Open that certificate and add it to this account from the page itself. It stays public either way.</p>
    </section>`,
  });
}
