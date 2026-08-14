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
import type { ReportRow, ViewStats } from "../lib/db.js";

const REPO_URL = "https://github.com/ahadd3v-sys/gpu-cert";
const DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/gpu-cert.exe`;

function certificateNumber(id: string): string {
  return `GPUC-${id.slice(0, 8).toUpperCase()}`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/// "3 hours ago" rather than a date.
///
/// On this section the age is the point: a certificate from an hour ago says
/// the service is alive in a way "14 Aug 2026" does not, and a visitor deciding
/// whether to trust a stranger's link wants to know how fresh the test was.
/// Falls back to a date past a week, where relative time stops being useful and
/// starts being coy.
function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(iso);
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
  /* Sits directly under the hero: the freshest evidence the service is real,
     and the thing a visitor should meet before any explanation of it. */
  .certified { margin-top: 30px; padding-top: 22px; border-top: 1px solid var(--paper-deep); }
  .certified-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .certified-all { font-size: 12px; color: var(--ink-muted); }
  .certified-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 10px; margin-top: 12px; }
  /* A tile, not a photograph. See renderHome for why there are no images. */
  .certified-card { display: block; padding: 12px 14px; border: 1px solid var(--paper-deep);
                    text-decoration: none; color: var(--ink); background: var(--paper); }
  .certified-card:hover { border-color: var(--ink-muted); }
  .certified-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .certified-verdict { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .certified-verdict.is-pass { color: var(--pass); }
  .certified-verdict.is-fail { color: var(--fail); }
  .certified-when { font-size: 11px; color: var(--ink-muted); }
  .certified-name { display: block; margin-top: 6px; font-family: "Space Grotesk", sans-serif;
                    font-weight: 600; font-size: 14px; line-height: 1.3; }
  .certified-meta { display: block; margin-top: 3px; font-size: 11.5px; color: var(--ink-muted); }

  .hero { padding: 6px 0 4px; }
  .hero-actions { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .hero-aside { font-size: 12.5px; color: var(--ink-muted); }
  .beta-note {
    font-size: 12.5px;
    line-height: 1.65;
    color: var(--ink-muted);
    border-left: 2px solid var(--paper-deep);
    padding-left: 14px;
    margin: 22px 0 0;
    max-width: 62ch;
  }
  .beta-note b { color: var(--ink); font-weight: 500; }

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

export function renderHome(loggedIn: boolean, certified: ReportRow[] = []): string {
  // Deliberately no product photography.
  //
  // Fetching a picture per GPU does not survive contact with the problem: there
  // is no reliable source keyed by model name, new cards appear constantly so
  // any lookup table rots, board partners' versions of the same chip look
  // nothing alike, and hotlinking someone else's product shots is a licensing
  // question nobody wants. It would also make the front page depend on a
  // third-party request that can be slow or gone.
  //
  // The model name set in the certificate's own type does not have any of those
  // problems and works for every card ever released, including ones that do not
  // exist yet.
  const certifiedSection =
    certified.length === 0
      ? ""
      : `<section class="certified">
          <div class="certified-head">
            <h2 class="section-label">Recently tested</h2>
            <a class="certified-all" href="/verify">Check a certificate</a>
          </div>
          <div class="certified-grid">
            ${certified
              .map((r) => {
                const passed = r.verdict === "Pass";
                const coverage =
                  r.fingerprint_vram_total_bytes > 0
                    ? Math.round((r.vram_bytes_tested / r.fingerprint_vram_total_bytes) * 100)
                    : 0;
                return `<a class="certified-card" href="/r/${esc(r.id)}">
                  <span class="certified-top">
                    <span class="certified-verdict ${passed ? "is-pass" : "is-fail"}">${passed ? "Passed" : "Failed"}</span>
                    <span class="certified-when">${esc(timeAgo(r.created_at))}</span>
                  </span>
                  <span class="certified-name">${esc(r.device_name)}</span>
                  <span class="certified-meta">${coverage}% of memory tested${
                    r.vram_total_errors > 0 ? `, ${r.vram_total_errors} errors` : ", no errors"
                  }</span>
                </a>`;
              })
              .join("")}
          </div>
        </section>`;

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
        <span class="hero-aside">Windows, 4&nbsp;MB. Runs about 11&nbsp;minutes.</span>
      </div>
      <p class="beta-note"><b>Early access.</b> The tool is new and free to use. Windows only, NVIDIA or AMD. It is unsigned, so Windows will warn you on first run: choose More info, then Run anyway. If anything breaks or a result looks wrong, <a href="/feedback">tell me</a>, that is what this stage is for.</p>
    </section>

    ${certifiedSection}

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
          <p class="protocol-method">A bit-pattern write and verify sweep across the card's active memory, five minutes, derived from memtest_vulkan.</p>
          <p class="protocol-catch"><b>Catches</b> the memory damage heavy mining leaves behind. Telemetry alone cannot see it. One error fails the card.</p>
        </div>
        <div class="protocol-block-wide">
          <p class="protocol-name">Render integrity test</p>
          <p class="protocol-method">Renders a deterministic shader and checks every pixel of every frame against the expected output, exactly, with no tolerance.</p>
          <p class="protocol-catch"><b>Catches</b> rasterizer and shader-core defects that produce wrong pixels rather than no pixels, which neither test above reads back far enough to notice.</p>
        </div>
      </div>
      <hr class="rule">
      <p class="footer-note">Alongside the three tests, the run records what the card will tell it about its own condition: junction and memory temperature where available, fan speed against the speed the driver asked for, and PCIe link width. A junction far above the edge sensor means heat is not reaching the cooler, memory at its throttling point means worn thermal pads, and a fan being asked to spin that is not turning is a fan that has failed. Link width is reported rather than failed, because it describes the slot the card is sitting in, not the card.</p>
      <p class="footer-note">Any test aborts on its own if the GPU crosses 105&nbsp;°C at the junction, or 100&nbsp;°C where no junction sensor exists, and an aborted run is reported as a finding rather than thrown away.</p>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">How it works</p>
      <ol class="steps">
        <li><div><div class="step-title">Download and run gpu-cert.exe</div><div class="step-note">A console app. It reads the card's identity, runs the three tests, and submits the result.</div></div></li>
        <li><div><div class="step-title">Your browser opens the finished certificate</div><div class="step-note">Signed server-side and bound to that specific card's fingerprint, at a public URL.</div></div></li>
        <li><div><div class="step-title">Put the link in your listing</div><div class="step-note">Anyone can open it and check the result without installing anything or taking your word for it.</div></div></li>
        <li class="step-optional"><div><div class="step-title">Optional: put your name on it</div><div class="step-note">The certificate is public and verifiable without an account. To attach one to your name, so it appears in your register and you can build a track record, you need <a href="/signup">an account with a confirmed email</a>. Connect it to the app once and every later run files itself; certificates already made can be attached afterwards.</div></div></li>
      </ol>
    </section>

    <hr class="rule">

    <section>
      <p class="section-label">Why a buyer should believe it</p>
      <div class="closing">
        <div>
          <p class="statement">The certificate is signed with GPU Cert's key when it is issued, not generated in the browser showing it to you. Anyone can re-check that signature on the <a href="/verify">verification page</a>, or against GPU Cert's published signing key without trusting this site at all.</p>
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
          <p class="bound-note">Hashed together into the fingerprint printed on the certificate. On NVIDIA that identifier is burned into the card and follows it anywhere, so a buyer can run the tool and confirm they were sent the card that was tested. AMD publishes no per-card identifier, so there the fingerprint identifies the model, memory size and BIOS rather than the individual card, and each certificate says which of the two it is.</p>
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
  withUsername?: boolean;
  /// Login only. The reset flow existed and worked for a while with nothing
  /// linking to it, which from a user's side is the same as not having one.
  showForgotLink?: boolean;
  /// Login takes either, so the field cannot be typed as an email.
  identifierLabel?: string;
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
        <label for="email">${esc(opts.identifierLabel ?? "Email")}</label>
        <input id="email" type="${opts.identifierLabel ? "text" : "email"}" name="email" autocomplete="${opts.identifierLabel ? "username" : "email"}" required>
      </div>
      ${
        opts.withUsername
          ? `<div class="field">
               <label for="username">Username</label>
               <input id="username" name="username" minlength="3" maxlength="20" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{1,18}[a-zA-Z0-9]" autocomplete="username" required>
               <p class="field-hint">3 to 20 characters. Letters, numbers, hyphens and underscores.</p>
             </div>`
          : ""
      }
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" name="password"${minAttr} autocomplete="current-password" required>
        ${opts.minLength ? `<p class="field-hint">At least ${opts.minLength} characters.</p>` : ""}
      </div>
      <button type="submit" class="btn">${esc(opts.submitLabel)}</button>
    </form>
    ${opts.showForgotLink ? `<p class="auth-alt"><a href="/forgot-password">Forgot your password?</a></p>` : ""}
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
    identifierLabel: "Email or username",
    showForgotLink: true,
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
    withUsername: true,
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
  .key-panel { background: var(--paper-raised); border: 1px solid var(--paper-deep); border-radius: 6px; padding: 20px 22px; }
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

export interface DashboardEmailState {
  emailVerified: boolean;
  verificationSent: boolean;
  /// False when no provider is configured, in which case there is nothing to
  /// resend and saying so beats a button that silently does nothing.
  canResend: boolean;
}

export interface AccountIdentity {
  email: string;
  username: string;
}

export function renderDashboard(
  reports: ReportRow[],
  account: AccountIdentity,
  uploadKey: string,
  viewStats: Map<string, ViewStats>,
  referrers: Array<{ host: string; views: number }>,
  emailState: DashboardEmailState
): string {
  const register = reports.length
    ? `<table class="register">
         <thead>
           <tr>
             <th class="hide-sm">Certificate</th>
             <th>Card</th>
             <th class="hide-sm">Result</th>
             <th class="num">Views</th>
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
             <td class="num views" title="${viewStats.get(r.id)?.badgeViews ?? 0} badge impression(s) in listings">${viewStats.get(r.id)?.pageViews ?? 0}</td>
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

  // Shown rather than enforced. An account is optional here and its
  // certificates are public either way, so locking the dashboard behind a
  // click in an inbox would cost a real user more than it costs an abusive
  // one. What verification actually buys is a working password reset, which
  // is what this says.
  const verifyBanner = emailState.emailVerified
    ? ""
    : emailState.verificationSent
      ? `<p class="notice-info">Confirmation sent to ${esc(account.email)}. Check your inbox, and your spam folder.</p>`
      : emailState.canResend
        ? `<div class="notice-info">
             <span>Your email is not confirmed yet, so you cannot save certificates to this account and could not reset your password.</span>
             <form method="post" action="/resend-verification"><button type="submit" class="btn btn-quiet">Send the link again</button></form>
           </div>`
        : "";

  // The number that decides whether any of this is worth charging for. A
  // certificate nobody opens is worth nothing at any price, so this is shown
  // plainly rather than buried, including when it is zero.
  const totalPageViews = [...viewStats.values()].reduce((n, v) => n + v.pageViews, 0);
  const totalBadgeViews = [...viewStats.values()].reduce((n, v) => n + v.badgeViews, 0);
  const traffic = reports.length
    ? `<section>
         <p class="section-label">Who is looking</p>
         <div class="traffic">
           <div class="traffic-figures">
             <div class="figure"><span class="figure-n">${formatCount(totalPageViews)}</span><span class="figure-label">certificate opens</span></div>
             <div class="figure"><span class="figure-n">${formatCount(totalBadgeViews)}</span><span class="figure-label">badge impressions</span></div>
           </div>
           ${
             referrers.length
               ? `<dl class="referrers">${referrers
                   .map(
                     (r) =>
                       `<div><dt>${r.host === "direct" ? "Opened directly" : esc(r.host)}</dt><dd>${formatCount(r.views)}</dd></div>`
                   )
                   .join("")}</dl>`
               : `<p class="footer-note" style="margin:0">Nobody has opened one yet. Put the link in a listing and this fills in.</p>`
           }
         </div>
         <p class="footer-note" style="margin-top:14px">Your own visits are not counted, and neither are link previews or crawlers. Some sites strip the referrer, so those arrive as "opened directly".</p>
       </section>

       <hr class="rule">`
    : "";

  return sitePage({
    title: "My certificates",
    nav: loggedInNav(),
    css: `${DASHBOARD_CSS}
      .traffic { display: grid; gap: 24px; align-items: start; }
      @media (min-width: 780px) { .traffic { grid-template-columns: 260px minmax(0, 1fr); gap: 48px; } }
      .traffic-figures { display: flex; gap: 32px; }
      .figure { display: flex; flex-direction: column; }
      .figure-n { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 30px; line-height: 1.1; }
      .figure-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); margin-top: 2px; }
      dl.referrers { display: grid; grid-template-columns: 1fr auto; margin: 0; font-size: 13.5px; }
      .referrers > div { display: contents; }
      .referrers dt, .referrers dd { margin: 0; padding: 7px 0; border-top: 1px solid var(--paper-deep); }
      .referrers dt { color: var(--ink-muted); }
      .referrers dd { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
      .referrers > div:first-child dt, .referrers > div:first-child dd { border-top: none; }
      td.views { color: var(--ink-muted); }
      .notice-info {
        display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
        border-left: 3px solid var(--mark); background: var(--tint-mark);
        font-size: 13.5px; padding: 10px 14px; margin: 0 0 20px;
      }
      .notice-info form { margin: 0; }`,
    body: `
    ${verifyBanner}
    <div class="dash-head">
      <div>
        <p class="eyebrow">Register of issued certificates</p>
        <h1 class="display" style="font-size: 27px; margin-bottom: 2px;">${esc(account.username)}</h1>
        <p class="footer-note">${esc(account.email)} &middot; ${reports.length} ${reports.length === 1 ? "certificate" : "certificates"} filed to this account.</p>
      </div>
      ${reports.length ? `<a class="btn" href="${DOWNLOAD_URL}">Test another card</a>` : ""}
    </div>

    <hr class="rule">

    ${register}

    <hr class="rule">

    ${traffic}

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
    background: var(--tint-pass);
    padding: 16px 18px;
    margin: 26px 0 0;
  }
  .result.invalid { border-left-color: var(--fail); background: var(--tint-fail); }
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
  /* Shown rather than linked. Serving the key as a file made browsers download
     something the OS could not open, and the point of publishing it is that a
     person can read it. */
  pre.pubkey {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px;
    line-height: 1.7;
    color: var(--ink-muted);
    background: var(--paper-raised);
    border: 1px solid var(--paper-deep);
    border-radius: 4px;
    padding: 12px 14px;
    margin: 14px 0 0;
    overflow-x: auto;
    white-space: pre;
    user-select: all;
  }
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
  publicKey?: string;
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
      To check a signature without trusting this page at all, this is GPU Cert's public key. Verify with any Ed25519 tool.
    </p>
    ${
      opts.publicKey
        ? `<pre class="pubkey" aria-label="GPU Cert Ed25519 public key">${esc(opts.publicKey)}</pre>
           <p class="verify-how" style="border: none; padding-top: 0; margin-top: 10px;">Also served as plain text at <code>/.well-known/gpu-cert-key.pem</code>.</p>`
        : ""
    }`,
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
    background: var(--paper-raised);
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
    background: var(--tint-pass);
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
      All of the source is public, client and server. If you would rather file a bug where you can watch it get fixed, or you want to read exactly what the tool does to your card before running it, that is all at <a href="${esc(REPO_URL)}">${esc(REPO_URL.replace("https://", ""))}</a>.
    </p>`,
  });
}

// ------------------------------------------------- notices and recovery

const NOTICE_CSS = `
  .notice-head { margin-bottom: 18px; }
  .notice-body { color: var(--ink-muted); font-size: 15px; line-height: 1.7; margin: 0 0 22px; max-width: 54ch; }
`;

export function renderNotice(opts: {
  loggedIn: boolean;
  title: string;
  body: string;
  ok: boolean;
}): string {
  return sitePage({
    title: opts.title,
    nav: opts.loggedIn ? loggedInNav() : loggedOutNav(),
    width: 620,
    css: NOTICE_CSS,
    body: `
    <div class="notice-head">
      <p class="eyebrow">${opts.ok ? "Confirmed" : "Link expired"}</p>
      <h1 class="display" style="font-size: 30px;">${esc(opts.title)}</h1>
    </div>
    <p class="notice-body">${esc(opts.body)}</p>
    <a class="btn" href="${opts.loggedIn ? "/dashboard" : "/login"}">${opts.loggedIn ? "Go to my certificates" : "Log in"}</a>`,
  });
}

export function renderForgotPassword(opts: {
  sent?: boolean;
  error?: string;
  emailConfigured?: boolean;
}): string {
  // The confirmation is identical whether or not that address has an account,
  // so this form can't be used to find out who has one.
  const confirmation = opts.sent
    ? `<p class="notice-pass">If there is an account for that address, a reset link is on its way. It works once and lasts an hour.</p>
       ${opts.emailConfigured === false ? `<p class="field-hint">Email delivery is not configured on this deployment yet, so no message was actually sent.</p>` : ""}`
    : "";
  return sitePage({
    title: "Reset password",
    nav: loggedOutNav(),
    width: 470,
    css: `${AUTH_CSS}
      .notice-pass { border-left: 3px solid var(--pass); background: var(--tint-pass); color: var(--pass); font-size: 13.5px; padding: 9px 14px; margin: 0 0 20px; }`,
    body: `
    <div class="auth-head">
      <p class="eyebrow">Reset password</p>
      <h1 class="display" style="font-size: 27px; margin-bottom: 10px;">Get back into your account.</h1>
      <p class="statement" style="margin-bottom: 0; font-size: 14px;">Enter the address you signed up with and we will send a link to set a new password.</p>
    </div>
    ${confirmation}
    ${opts.error ? `<p class="notice-fail">${esc(opts.error)}</p>` : ""}
    <form method="post" action="/forgot-password">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" autocomplete="email" required>
      </div>
      <button type="submit" class="btn">Send reset link</button>
    </form>
    <p class="auth-alt">Remembered it? <a href="/login">Log in</a>.</p>
    <p class="auth-skip">Your certificates stay public and verifiable either way. An account only collects them in one place.</p>`,
  });
}

export function renderResetPassword(opts: { token: string; error?: string }): string {
  return sitePage({
    title: "Choose a new password",
    nav: loggedOutNav(),
    width: 470,
    css: AUTH_CSS,
    body: `
    <div class="auth-head">
      <p class="eyebrow">Reset password</p>
      <h1 class="display" style="font-size: 27px; margin-bottom: 10px;">Choose a new password.</h1>
    </div>
    ${opts.error ? `<p class="notice-fail">${esc(opts.error)}</p>` : ""}
    ${
      opts.token
        ? `<form method="post" action="/reset-password">
             <input type="hidden" name="token" value="${esc(opts.token)}">
             <div class="field">
               <label for="password">New password</label>
               <input id="password" type="password" name="password" minlength="8" autocomplete="new-password" required>
               <p class="field-hint">At least 8 characters.</p>
             </div>
             <button type="submit" class="btn">Set password</button>
           </form>`
        : `<p class="auth-alt"><a href="/forgot-password">Request a new reset link</a>.</p>`
    }`,
  });
}


/// The page that replaces running SQL against production by hand.
///
/// Reports are the successes, and the successes are the least interesting rows
/// in the database. Every bug found today came from a session that never
/// produced a report: a crash, a cancelled window, a rejected submission. So
/// sessions get equal billing and their failure and rejection text is shown in
/// full rather than truncated to fit a column.
export function renderAdmin(opts: {
  overview: Record<string, number>;
  reports: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  detail: Record<string, unknown> | null;
  feedback: Record<string, unknown>[];
  storage: Record<string, number>;
}): string {
  const n = (v: unknown) => Number(v ?? 0);
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  const o = opts.overview;

  const stat = (label: string, value: string | number, note = "") =>
    `<div class="stat"><div class="stat-value">${esc(String(value))}</div>
       <div class="stat-label">${esc(label)}</div>
       ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}</div>`;

  // Free tier limits, stated here so the headroom below is a number rather
  // than a feeling. Turso: 5 GB storage, 10 million row writes and 500 million
  // row reads a month.
  const TURSO_FREE_BYTES = 5 * 1024 ** 3;
  const TURSO_FREE_WRITES_MONTHLY = 10_000_000;

  // Vercel Hobby: 100 GB of bandwidth a month.
  const VERCEL_FREE_BANDWIDTH = 100 * 1024 ** 3;
  // Measured against production rather than guessed: a certificate page, a
  // badge, and the share of each that is inlined font data.
  const PAGE_BYTES = 111_254;
  const BADGE_BYTES = 14_162;
  const FONT_BYTES = 96_000;
  // One session open, roughly eleven heartbeats over an eleven minute run, one
  // submission, and the browser opening the finished certificate.
  const REQUESTS_PER_RUN = 1 + 11 + 1 + 2;

  const st = opts.storage;
  const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1);
  const usedPct = (st.bytes / TURSO_FREE_BYTES) * 100;

  // A run writes one session row, a heartbeat update roughly every minute for
  // eleven minutes, one report, and a view or two. Writes are not the binding
  // constraint at any plausible volume, but stating the arithmetic is what
  // makes that claim checkable rather than reassuring.
  const WRITES_PER_RUN = 1 + 11 + 1 + 2;
  const runsPerMonthBeforeWriteLimit = Math.floor(TURSO_FREE_WRITES_MONTHLY / WRITES_PER_RUN);

  // Sized on recent certificates, not the all-time average: telemetry per
  // report fell by roughly fifty times when sampling moved to once a second,
  // so the historical figure describes a client nobody runs.
  const perCert = Math.max(st.bytesPerRecentCertificate, 1);
  const certificatesUntilFull = Math.floor((TURSO_FREE_BYTES - st.bytes) / perCert);

  // Bandwidth is dominated by people reading certificates, which is the point
  // of the product, so it is the number that will move first.
  const bandwidthBytes = opts.overview.page_views * PAGE_BYTES + opts.overview.badge_views * BADGE_BYTES;
  const viewsUntilBandwidthLimit = Math.floor((VERCEL_FREE_BANDWIDTH - bandwidthBytes) / PAGE_BYTES);

  const infra = `<section class="sheet-section">
    <h2>Infrastructure</h2>
    <p class="section-note">Measured from the database itself. No provider tokens are stored here: a Vercel or Turso platform token can create and destroy infrastructure, and keeping one in a web process to render a number would turn this page into a deployment credential.</p>
    <div class="stats">
      ${stat("Database", `${mb(st.bytes)} MB`, `${usedPct.toFixed(3)}% of the 5 GB free tier`)}
      ${stat("Per certificate", `${(perCert / 1024).toFixed(0)} KB`, `telemetry, across ${st.certificatesMeasured} current-format runs`)}
      ${stat("Room left", certificatesUntilFull.toLocaleString("en-GB"), "more certificates before 5 GB")}
      ${stat("Runs / month", runsPerMonthBeforeWriteLimit.toLocaleString("en-GB"), `before the ${(TURSO_FREE_WRITES_MONTHLY / 1e6).toFixed(0)}M write limit`)}
    </div>
    <table class="admin">
      <thead><tr><th>What is using the space</th><th>Size</th><th>Share</th></tr></thead>
      <tbody>
        <tr><td>Stress telemetry on certificates</td><td class="mono">${mb(st.telemetryBytes)} MB</td><td class="mono">${((st.telemetryBytes / Math.max(st.bytes, 1)) * 100).toFixed(0)}%</td></tr>
        <tr><td>Run logs on sessions</td><td class="mono">${mb(st.logBytes)} MB</td><td class="mono">${((st.logBytes / Math.max(st.bytes, 1)) * 100).toFixed(0)}%</td></tr>
        <tr><td>Machine environments on sessions</td><td class="mono">${mb(st.environmentBytes)} MB</td><td class="mono">${((st.environmentBytes / Math.max(st.bytes, 1)) * 100).toFixed(0)}%</td></tr>
        <tr><td>Everything else</td><td class="mono">${mb(Math.max(st.bytes - st.telemetryBytes - st.logBytes - st.environmentBytes, 0))} MB</td><td class="mono">rest</td></tr>
      </tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Hosting</h2>
    <p class="section-note">Derived from what this site actually serves, not from Vercel's API. Vercel issues no read-only token: one scoped to read usage can also destroy the project, so keeping one in a web process to render a number is a worse idea than doing the arithmetic. The dashboard at vercel.com remains authoritative.</p>
    <div class="stats">
      ${stat("Requests / run", String(REQUESTS_PER_RUN), "session, heartbeats, submission")}
      ${stat("Page weight", `${Math.round(PAGE_BYTES / 1024)} KB`, "a certificate, fonts included")}
      ${stat("Bandwidth used", `${(bandwidthBytes / 1024 ** 3).toFixed(3)} GB`, `${((bandwidthBytes / VERCEL_FREE_BANDWIDTH) * 100).toFixed(2)}% of the 100 GB free tier`)}
      ${stat("Room left", viewsUntilBandwidthLimit.toLocaleString("en-GB"), "more certificate opens this month")}
    </div>
    <p class="section-note">Most of that page weight is the two fonts, embedded in every response because they are inlined rather than served as files a browser can cache. Serving them separately would cut a repeat visit by roughly ${Math.round((1 - (PAGE_BYTES - FONT_BYTES) / PAGE_BYTES) * 100)}% and multiply the headroom above by about ${Math.round(PAGE_BYTES / Math.max(PAGE_BYTES - FONT_BYTES, 1))}. Not worth doing at this traffic; worth doing before it matters.</p>
  </section>`;

  const reportRows = opts.reports
    .map((r) => {
      const cov = pct(n(r.vram_bytes_tested), n(r.fingerprint_vram_total_bytes));
      const bad = n(r.vram_total_errors) > 0 || n(r.fur_mismatches) > 0;
      return `<tr>
        <td class="mono">${esc(String(r.created_at).slice(5, 16))}</td>
        <td>${esc(String(r.device_name))}</td>
        <td class="mono">${esc(String(r.client_version))}</td>
        <td class="${r.verdict === "Pass" ? "ok" : "bad"}">${esc(String(r.verdict))}</td>
        <td class="mono">${cov}%</td>
        <td class="mono ${bad ? "bad" : ""}">${n(r.vram_total_errors)} / ${n(r.fur_mismatches)}</td>
        <td class="mono">${n(r.stress_peak_temp_c)}C</td>
        <td>${r.user_id ? "claimed" : ""}${r.serial_number ? " serial" : ""}</td>
        <td><a href="/r/${esc(String(r.id))}">open</a></td>
      </tr>`;
    })
    .join("");

  const sessionRows = opts.sessions
    .map((sn) => {
      const state = sn.consumed_at ? "submitted" : sn.failed_at ? "failed" : "no report";
      const why = String(sn.failure || "") || String(sn.rejection || "");
      return `<tr>
        <td class="mono">${esc(String(sn.started_at).slice(5, 16))}</td>
        <td>${esc(String(sn.device_name))}</td>
        <td class="mono">${esc(String(sn.client_version))}</td>
        <td class="${state === "submitted" ? "ok" : state === "failed" ? "bad" : "warn"}">${state}</td>
        <td class="mono">${n(sn.progress_count)}</td>
        <td class="why">${esc(why)}</td>
        <td>${n(sn.log_bytes) > 0 ? `<a href="/admin?session=${esc(String(sn.id))}">log</a>` : ""}</td>
      </tr>`;
    })
    .join("");

  const detail = opts.detail
    ? `<section class="sheet-section">
         <h2>${esc(String(opts.detail.device_name))}, ${esc(String(opts.detail.started_at).slice(0, 16))}</h2>
         ${opts.detail.failure ? `<p class="bad">${esc(String(opts.detail.failure))}</p>` : ""}
         ${opts.detail.rejection ? `<p class="bad">Refused: ${esc(String(opts.detail.rejection))}</p>` : ""}
         <h3>Run log</h3>
         <pre class="dump">${esc(String(opts.detail.run_log || "(none)"))}</pre>
         <h3>Environment</h3>
         <pre class="dump">${esc(String(opts.detail.environment || "(none)"))}</pre>
         <p><a href="/admin">back to all sessions</a></p>
       </section>`
    : "";

  return sitePage({
    title: "Admin",
    nav: `<a href="/dashboard">Dashboard</a>`,
    width: 1240,
    css: `
      .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1px;
               background: var(--paper-deep); border: 1px solid var(--paper-deep); margin-bottom: 28px; }
      .stat { background: var(--paper); padding: 12px 14px; }
      .stat-value { font-size: 22px; font-weight: 600; font-family: "Space Grotesk", sans-serif; }
      .stat-label { font-size: 11.5px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.04em; }
      .stat-note { font-size: 11px; color: var(--ink-muted); margin-top: 2px; }
      table.admin { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 8px; }
      table.admin th { text-align: left; font-weight: 600; font-size: 11.5px; text-transform: uppercase;
                       letter-spacing: 0.04em; color: var(--ink-muted); padding: 6px 8px;
                       border-bottom: 1px solid var(--paper-deep); }
      table.admin td { padding: 6px 8px; border-bottom: 1px solid var(--paper-deep); vertical-align: top; }
      .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
      .ok { color: var(--pass); } .bad { color: var(--fail); } .warn { color: var(--ink-muted); }
      /* Failure text is the reason this page exists, so it is never truncated. */
      .why { font-size: 12px; color: var(--ink-muted); max-width: 420px; }
      .dump { background: var(--paper-deep); padding: 12px; overflow-x: auto; font-size: 11.5px;
              line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 460px; }
      /* Wide tables scroll rather than pushing the page sideways. */
      .scroller { overflow-x: auto; }
      .feedback-item { border: 1px solid var(--paper-deep); padding: 12px 14px; margin-bottom: 10px; }
      .feedback-meta { font-size: 11.5px; color: var(--ink-muted); margin: 0 0 6px; }
      .feedback-message { margin: 0; white-space: pre-wrap; }
    `,
    body: `
      <h1>Admin</h1>
      <p class="section-note">Five numbers, because the rest were noise. Everything else is in the tables below.</p>
      <div class="stats">
        ${stat(
          "Clickthrough",
          o.badge_views > 0 ? `${pct(o.page_views, o.badge_views)}%` : "no data",
          `${o.page_views} opens from ${o.badge_views} badge views`
        )}
        ${stat(
          "Runs finished",
          o.sessions > 0 ? `${pct(o.completed, o.sessions)}%` : "no data",
          `${o.completed} of ${o.sessions} produced a certificate`
        )}
        ${stat("Cards found faulty", o.failed_cards, `of ${o.reports} certificates`)}
        ${stat("This week", o.reports_week, `certificates, ${o.page_views_week} opens`)}
        ${stat("Runs that broke", o.failed_week, "in the last 7 days, see below")}
      </div>

      ${infra}

      ${detail}

      <section class="sheet-section">
        <h2>Feedback</h2>
        <p class="section-note">Submissions from the feedback form. Nothing else surfaces these, so this is the only place they are read.</p>
        ${
          opts.feedback.length === 0
            ? `<p class="section-note">Nothing submitted yet.</p>`
            : opts.feedback
                .map(
                  (f) => `<article class="feedback-item">
                    <p class="feedback-meta">${esc(String(f.created_at).slice(0, 16))}${
                      f.contact ? ` &middot; ${esc(String(f.contact))}` : " &middot; no contact given"
                    }${f.report_reference ? ` &middot; ${esc(String(f.report_reference))}` : ""}</p>
                    <p class="feedback-message">${esc(String(f.message))}</p>
                    ${f.console_output ? `<pre class="dump">${esc(String(f.console_output))}</pre>` : ""}
                  </article>`
                )
                .join("")
        }
      </section>

      <section class="sheet-section">
        <h2>Runs</h2>
        <p class="section-note">Every run, including the ones that never produced a certificate. Those are the interesting ones.</p>
        <div class="scroller">
          <table class="admin">
            <thead><tr><th>Started</th><th>Card</th><th>Ver</th><th>Outcome</th><th>Beats</th><th>Why it stopped</th><th></th></tr></thead>
            <tbody>${sessionRows || `<tr><td colspan="7">No runs yet.</td></tr>`}</tbody>
          </table>
        </div>
      </section>

      <section class="sheet-section">
        <h2>Certificates</h2>
        <div class="scroller">
          <table class="admin">
            <thead><tr><th>Issued</th><th>Card</th><th>Ver</th><th>Verdict</th><th>Coverage</th><th>Errors / mismatches</th><th>Peak</th><th></th><th></th></tr></thead>
            <tbody>${reportRows || `<tr><td colspan="9">No certificates yet.</td></tr>`}</tbody>
          </table>
        </div>
      </section>
    `,
  });
}

/// One line per release, written for someone deciding whether to re-download
/// rather than for someone reading the diff.
///
/// Hand-written rather than generated from git. A generated log is a list of
/// commits, and a commit list is the wrong thing to show a seller: they do not
/// care that a struct moved, they care whether their last certificate is still
/// worth anything. Only releases that change what a run means get an entry with
/// any weight to it, and the ones that were purely internal say so in a line.
interface ReleaseNote {
  version: string;
  date: string;
  /// The headline in plain language. Absent for a maintenance release.
  summary: string;
  /// Set when a release changed what a number on a certificate means, which is
  /// the only reason anyone reading this needs to care about an old one.
  changesResults?: boolean;
}

const RELEASE_NOTES: ReleaseNote[] = [
  { version: "0.7.1", date: "14 Aug 2026", summary: "Memory temperature and fan speed are now read on NVIDIA as well as AMD." },
  {
    version: "0.7.0",
    date: "14 Aug 2026",
    summary:
      "Reads the junction temperature the card actually throttles on, not just the edge sensor, and the safety cutoff moves with it. Memory temperature and fan speed are recorded for the first time: memory at its throttling point means worn thermal pads, and a fan being asked to spin that is not turning has failed.",
    changesResults: true,
  },
  { version: "0.6.2", date: "13 Aug 2026", summary: "A run that stalls while preparing the render test now says so instead of going quiet." },
  {
    version: "0.6.0 to 0.6.1",
    date: "13 Aug 2026",
    summary:
      "The stress test now works memory as well as compute. Its working set was small enough to sit entirely in cache, so it never touched VRAM at all. A whole run is about eleven minutes instead of sixteen.",
    changesResults: true,
  },
  {
    version: "0.5.7 to 0.5.8",
    date: "13 Aug 2026",
    summary:
      "The stress test was not stressing. It drew 149 W on a 220 W card while reporting the GPU as 98% busy, because the load left most of the card idle. It now holds cards at their rated power.",
    changesResults: true,
  },
  { version: "0.5.3 to 0.5.6", date: "13 Aug 2026", summary: "New console: one screen that updates in place rather than pages of scrolling output. Cancelled runs now record that they were cancelled." },
  {
    version: "0.5.2",
    date: "13 Aug 2026",
    summary:
      "Fixed a crash on some AMD cards. The client was allocating from memory types the Vulkan specification forbids it to use without an extension it does not enable.",
    changesResults: true,
  },
  {
    version: "0.5.1",
    date: "13 Aug 2026",
    summary:
      "Fixed the bug that capped every run at 4032 MB of memory tested regardless of card size. Coverage went from 25% to 85% on a 16 GB card. Allocations now ask each buffer which memory it accepts instead of choosing once for the whole device.",
    changesResults: true,
  },
  { version: "0.4.0 to 0.4.2", date: "13 Aug 2026", summary: "A certificate now requires a test session opened before the run and timed by the server, so one cannot be produced without spending the time. Runs upload what machine they were on, so a failure can be diagnosed without asking anyone for their console." },
  {
    version: "0.2.0 to 0.3.1",
    date: "13 Aug 2026",
    summary:
      "The memory test is split across several buffers. A single descriptor can only address 4 GB, and exceeding that silently wrapped, which is why earlier runs reported billions of errors on healthy cards.",
    changesResults: true,
  },
  { version: "0.1.0 to 0.1.9", date: "12 to 13 Aug 2026", summary: "First working client: three tests, hardware fingerprint, signed certificate." },
];

export function renderChangelog(): string {
  const rows = RELEASE_NOTES.map(
    (r) => `<section class="release">
      <div class="release-head">
        <h2>${esc(r.version)}</h2>
        <span class="release-date">${esc(r.date)}</span>
        ${r.changesResults ? `<span class="release-flag">changes what results mean</span>` : ""}
      </div>
      <p class="release-summary">${esc(r.summary)}</p>
    </section>`
  ).join("");

  return sitePage({
    title: "Changes",
    nav: `<a href="/verify">Verify</a><a href="/feedback">Feedback</a>`,
    width: 900,
    css: `
      .release { padding: 18px 0; border-top: 1px solid var(--paper-deep); }
      .release:first-of-type { border-top: none; }
      .release-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
      .release-head h2 { margin: 0; font-size: 17px; font-family: ui-monospace, Menlo, Consolas, monospace; }
      .release-date { font-size: 12.5px; color: var(--ink-muted); }
      /* The only distinction a reader actually needs: whether an older
         certificate of theirs still means what it says. */
      .release-flag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
                      color: var(--fail); border: 1px solid var(--fail); border-radius: 2px; padding: 1px 6px; }
      .release-summary { margin: 6px 0 0; color: var(--ink-muted); line-height: 1.6; max-width: 68ch; }
    `,
    body: `
      <h1>Changes</h1>
      <p class="statement">Every release of the client, most recent first. Certificates record the version that produced them, so an older one can be read against what the tool did at the time.</p>
      <p class="statement">Runs from superseded versions are refused rather than accepted quietly. A certificate is a claim about a card, and one produced by a build known to measure the wrong thing is worse than no certificate at all. That is why the tool sometimes asks you to download it again.</p>
      ${rows}
      <p class="footer-note" style="margin-top: 28px;">Full commit history and source: <a href="https://github.com/ahadd3v-sys/gpu-cert">github.com/ahadd3v-sys/gpu-cert</a></p>
    `,
  });
}
