// Home, login, signup and dashboard. The certificate page (report-page.ts)
// owns the identity; these extend it as the same issuing body's stationery
// via the shared tokens and masthead in theme.ts.
//
// An account is optional everywhere in here, deliberately. The exe runs
// without one and its report is public the moment it lands, so nothing on
// this site may imply signing up is a prerequisite to testing a card, the
// account only buys you a place where your certificates are collected.
import { esc } from "./html.js";
import { sitePage } from "./theme.js";
import type { ReportRow } from "../lib/db.js";

const REPO_URL = "https://github.com/ahadd3v-sys/gpu-cert";
const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/gpu-cert.exe`;

function certificateNumber(id: string): string {
  return `GPUC-${id.slice(0, 8).toUpperCase()}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// "Verify" sits in front of the account links on every page, including for
// signed-out visitors, because the person most likely to need it is a buyer
// who was handed a certificate link by a stranger, someone with no account
// and no reason to make one.
//
// "Feedback" sits beside it, in the masthead rather than only in the footer,
// because the tool is new enough that the bugs still outnumber the users. Every
// hardware fault found so far came from someone running it on a real card and
// saying what happened, and a report that never gets sent is a bug that stays
// shipped. Worth demoting to the footer once that stops being true.
function loggedInNav(): string {
  return `<a href="/verify">Verify</a>
    <a href="/feedback">Feedback</a>
    <a href="/dashboard">My certificates</a>
    <form method="post" action="/logout"><button type="submit" class="btn btn-quiet">Log out</button></form>`;
}

function loggedOutNav(next?: string): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return `<a href="/verify">Verify</a>
    <a href="/feedback">Feedback</a>
    <a href="/login${q}">Log in</a>
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

  /* Steps ARE ordered here: you cannot share a link before running the
     exe, so the ordinals carry real information. */
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

  /* Three tests as three columns once there's room, matching the certificate.
     The render test spanned full width only because two-up orphaned it on a
     row of its own. */
  @media (min-width: 1000px) {
    .protocol-grid { grid-template-columns: repeat(3, 1fr); gap: 30px; }
    .protocol-block-wide { grid-column: auto; }
  }

  /* The closing section used to be one paragraph capped at 54ch, which left
     the right half of the sheet empty once the page widened. The answer isn't
     a longer line. Past about 75 characters prose gets hard to track, so it's
     giving the row something to hold. The four fields were already named in
     that paragraph, so they move out of the prose and into a panel shaped like
     the certificate's own specification rows, which is what they actually are. */
  .closing { display: grid; gap: 26px; align-items: start; }
  .closing .statement { max-width: none; }
  @media (min-width: 1000px) {
    .closing { grid-template-columns: minmax(0, 1fr) 320px; gap: 56px; }
  }

  .bound-card { border: 1px solid var(--paper-deep); padding: 18px 20px 16px; }
  .bound-title { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); margin: 0 0 4px; }
  ul.bound-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12.5px;
  }
  ul.bound-list li { padding: 8px 0; border-top: 1px solid var(--paper-deep); }
  .bound-note { font-size: 12px; color: var(--ink-muted); line-height: 1.55; margin: 12px 0 0; }

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
          <p class="protocol-method">Renders a deterministic shader and checks every pixel of every frame against the expected output, exactly, with no tolerance.</p>
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
      <div class="closing">
        <div>
          <p class="statement">The certificate is signed with GPU Cert's key when it is issued, not generated in the browser showing it to you. Anyone can re-check that signature against the <a href="/.well-known/gpu-cert-key.pem">published key</a>, or on the <a href="/verify">verification page</a>.</p>
          <p class="statement" style="margin-bottom: 0;">There are plenty of good diagnostic tools already. None of them produce something a stranger can check.</p>
        </div>
        <aside class="bound-card">
          <p class="bound-title">Bound to one card</p>
          <ul class="bound-list">
            <li>GPU UUID</li>
            <li>PCI device ID</li>
            <li>VBIOS version</li>
            <li>VRAM size</li>
          </ul>
          <p class="bound-note">Hashed together into the fingerprint printed on the certificate. Show it against a different card and it stops matching.</p>
        </aside>
      </div>
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
     number overflows its cell rather than wrapping (it's nowrap by design:
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

// -------------------------------------------------------------- verify

// The page that makes the certificate's central claim checkable. Everything
// else on this site is GPU Cert telling you something; this is the one place
// a stranger can confirm it without taking our word for it, so it states
// plainly what was checked and what that does and does not prove.
const VERIFY_CSS = `
  .verify-head { margin-bottom: 22px; }
  .verify-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .verify-form .field { flex: 1 1 260px; margin-bottom: 0; }
  .verify-form .btn { flex-shrink: 0; }

  .result {
    border-left: 3px solid var(--pass);
    background: rgba(63, 108, 79, 0.07);
    padding: 16px 18px;
    margin: 26px 0 0;
  }
  .result.invalid { border-left-color: var(--fail); background: rgba(150, 67, 47, 0.07); }
  .result-verdict { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 18px; margin: 0 0 6px; color: var(--pass); }
  .result.invalid .result-verdict { color: var(--fail); }
  .result-detail { font-size: 13.5px; color: var(--ink-muted); margin: 0; line-height: 1.6; }

  dl.verify-facts { display: grid; grid-template-columns: 1fr auto; row-gap: 0; margin: 22px 0 0; }
  .verify-facts > div { display: contents; }
  .verify-facts dt, .verify-facts dd { padding: 9px 0; border-top: 1px solid var(--paper-deep); margin: 0; font-size: 13.5px; }
  .verify-facts dt { color: var(--ink-muted); }
  .verify-facts dd { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; word-break: break-all; padding-left: 20px; }

  .verify-how { font-size: 12.5px; color: var(--ink-muted); line-height: 1.65; margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--paper-deep); }
  .verify-how code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
`;

export interface VerifyResult {
  reference: string;
  signatureValid: boolean;
  reportId: string;
  certificateNumber: string;
  deviceName: string;
  fingerprintHash: string;
  verdict: string;
  issuedAt: string;
}

export function renderVerify(opts: {
  loggedIn: boolean;
  reference?: string;
  error?: string;
  result?: VerifyResult;
}): string {
  const r = opts.result;

  const resultBlock = r
    ? `<div class="result${r.signatureValid ? "" : " invalid"}">
         <p class="result-verdict">${r.signatureValid ? "Signature valid" : "Signature does not match"}</p>
         <p class="result-detail">${
           r.signatureValid
             ? `This certificate was issued by GPU Cert and has not been altered since. It records a verdict of <strong>${esc(r.verdict)}</strong> for the card identified below.`
             : "The stored signature does not match this certificate's contents. Do not rely on it."
         }</p>
       </div>
       <dl class="verify-facts">
         <div><dt>Certificate No.</dt><dd>${esc(r.certificateNumber)}</dd></div>
         <div><dt>Device</dt><dd>${esc(r.deviceName)}</dd></div>
         <div><dt>Verdict</dt><dd>${esc(r.verdict)}</dd></div>
         <div><dt>Issued</dt><dd>${esc(formatDate(r.issuedAt))}</dd></div>
         <div><dt>Hardware fingerprint</dt><dd>${esc(r.fingerprintHash)}</dd></div>
       </dl>
       <p class="verify-how"><a href="/r/${esc(r.reportId)}">View the full certificate</a></p>`
    : "";

  return sitePage({
    title: "Verify a certificate",
    nav: opts.loggedIn ? loggedInNav() : loggedOutNav("/verify"),
    // Narrower than the content pages, since this is one short task, but wide
    // enough that the masthead nav stays on one line and the result labels
    // ("Certificate No.", "Hardware fingerprint") don't wrap.
    width: 800,
    css: VERIFY_CSS,
    body: `
    <div class="verify-head">
      <p class="eyebrow">Verification</p>
      <h1 class="display" style="font-size: 30px;">Check a certificate yourself.</h1>
      <p class="statement" style="margin-bottom: 0;">Every certificate is signed with GPU Cert's Ed25519 key when it is issued. Enter its number to re-check that signature against what is stored. If a single character of the result was changed after issue, the signature stops matching.</p>
    </div>
    ${opts.error ? `<p class="notice-fail">${esc(opts.error)}</p>` : ""}
    <form method="get" action="/verify" class="verify-form">
      <div class="field">
        <label for="reference">Certificate number or report ID</label>
        <input id="reference" name="reference" value="${esc(opts.reference ?? "")}" placeholder="GPUC-1A2B3C4D" autocomplete="off" required>
      </div>
      <button type="submit" class="btn">Verify</button>
    </form>
    ${resultBlock}
    <p class="verify-how">
      A valid signature proves the certificate came from GPU Cert and has not been edited. It does not prove the person showing it to you owns that card, so check that the hardware fingerprint matches the card you are actually being sold.
      <br><br>
      To check it without trusting this page, the public key is published at <code><a href="/.well-known/gpu-cert-key.pem">/.well-known/gpu-cert-key.pem</a></code>.
    </p>`,
  });
}

// ------------------------------------------------------------- feedback

// Text only, no file uploads, and that is a considered choice rather than a
// missing feature. What actually diagnoses a problem with this product is the
// exe's console output, which is text: it already prints the device, the
// Vulkan limits, the segment layout, per-pass error counts and the first
// mismatch. A screenshot of that same console is a lossy, unsearchable,
// several-hundred-kilobyte version of something that pastes in as a few
// kilobytes and can be grepped later.
//
// Uploads would also mean object storage, a size and MIME allowlist, and
// somebody moderating whatever strangers upload to an unauthenticated form.
// None of that earns its place before the first real user.
const FEEDBACK_CSS = `
  .feedback-head { margin-bottom: 22px; }
  .field textarea {
    width: 100%;
    font-family: "Inter", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink);
    background: var(--paper-bright, #f4f2ec);
    border: 1px solid var(--paper-deep);
    border-radius: 4px;
    padding: 10px 12px;
    resize: vertical;
  }
  .field textarea.console {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12.5px;
  }
  .field-optional { font-weight: normal; color: var(--ink-muted); letter-spacing: 0; text-transform: none; font-size: 10.5px; }
  /* Bots fill every field they find. People never see this one. */
  .trap { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
  .notice-pass {
    border-left: 3px solid var(--pass);
    background: rgba(63, 108, 79, 0.07);
    color: var(--pass);
    font-size: 13.5px;
    padding: 9px 14px;
    margin: 0 0 20px;
  }
  .feedback-alt { font-size: 12.5px; color: var(--ink-muted); margin: 18px 0 0; padding-top: 16px; border-top: 1px solid var(--paper-deep); line-height: 1.6; }
`;

export function renderFeedback(opts: {
  loggedIn: boolean;
  error?: string;
  sent?: boolean;
}): string {
  return sitePage({
    title: "Feedback",
    nav: opts.loggedIn ? loggedInNav() : loggedOutNav("/feedback"),
    width: 720,
    css: FEEDBACK_CSS,
    body: `
    <div class="feedback-head">
      <p class="eyebrow">Feedback</p>
      <h1 class="display" style="font-size: 30px;">Tell us what went wrong.</h1>
      <p class="statement" style="margin-bottom: 0;">Especially if the tool refused to run, failed a card you believe is healthy, or passed one you know is not. Every one of those is a bug worth chasing, and the ones found so far all came from someone running it on real hardware.</p>
    </div>
    ${opts.sent ? `<p class="notice-pass">Sent. Thank you, this genuinely helps.</p>` : ""}
    ${opts.error ? `<p class="notice-fail">${esc(opts.error)}</p>` : ""}
    <form method="post" action="/feedback">
      <div class="field">
        <label for="message">What happened</label>
        <textarea id="message" name="message" rows="6" required maxlength="4000"></textarea>
      </div>
      <div class="field">
        <label for="console_output">Console output <span class="field-optional">optional, paste it straight from the window</span></label>
        <textarea id="console_output" name="console_output" class="console" rows="6" maxlength="20000"></textarea>
      </div>
      <div class="field">
        <label for="report_reference">Certificate number <span class="field-optional">optional</span></label>
        <input id="report_reference" name="report_reference" placeholder="GPUC-1A2B3C4D" maxlength="64" autocomplete="off">
      </div>
      <div class="field">
        <label for="contact">Email <span class="field-optional">optional, only if you want a reply</span></label>
        <input id="contact" type="email" name="contact" maxlength="254" autocomplete="email">
      </div>
      <div class="trap" aria-hidden="true">
        <label for="website">Leave this empty</label>
        <input id="website" name="website" tabindex="-1" autocomplete="off">
      </div>
      <button type="submit" class="btn">Send feedback</button>
    </form>
    <p class="feedback-alt">
      The whole client and server are open source. If you would rather file a bug where you can watch it get fixed, or you want to read exactly what the tool does to your card before running it, that is all at <a href="${esc(REPO_URL)}">${esc(REPO_URL.replace("https://", ""))}</a>.
    </p>`,
  });
}
