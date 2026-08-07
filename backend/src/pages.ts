// Deliberately undressed — no <style> blocks, no layout decisions. This is
// functional scaffolding only; visual design for these pages is being done
// separately (Claude Design), not here, so there's nothing here to fight
// or redo once that lands.
import { esc } from "./html";
import type { ReportRow } from "../lib/db";

const DOWNLOAD_URL = "https://github.com/ahadd3v-sys/gpu-cert/releases/latest/download/gpu-cert.exe";

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — GPU Cert</title>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderHome(loggedIn: boolean): string {
  const body = loggedIn
    ? `<p><a href="${DOWNLOAD_URL}">Test your GPU</a> — downloads gpu-cert.exe. Run it, then come back here.</p>
       <p><a href="/dashboard">My reports</a></p>
       <form method="post" action="/logout"><button type="submit">Log out</button></form>`
    : `<p>GPU Cert — hardware verification for GPUs sold peer-to-peer.</p>
       <p><a href="/login">Log in</a> or <a href="/signup">sign up</a> to test your GPU and get a certificate.</p>`;
  return shell("GPU Cert", body);
}

export function renderLogin(next: string | null, error: string | null): string {
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  const errorLine = error ? `<p>${esc(error)}</p>` : "";
  return shell(
    "Log in",
    `<h1>Log in</h1>
     ${errorLine}
     <form method="post" action="/login">
       ${nextField}
       <div><label>Email <input type="email" name="email" required></label></div>
       <div><label>Password <input type="password" name="password" required></label></div>
       <button type="submit">Log in</button>
     </form>
     <p><a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Sign up</a> instead</p>`
  );
}

export function renderSignup(next: string | null, error: string | null): string {
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";
  const errorLine = error ? `<p>${esc(error)}</p>` : "";
  return shell(
    "Sign up",
    `<h1>Sign up</h1>
     ${errorLine}
     <form method="post" action="/signup">
       ${nextField}
       <div><label>Email <input type="email" name="email" required></label></div>
       <div><label>Password <input type="password" name="password" minlength="8" required></label></div>
       <button type="submit">Sign up</button>
     </form>
     <p><a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Log in</a> instead</p>`
  );
}

export function renderDashboard(reports: ReportRow[]): string {
  const rows = reports.length
    ? `<ul>${reports
        .map(
          (r) =>
            `<li><a href="/r/${esc(r.id)}">${esc(r.device_name)}</a> — ${esc(r.verdict)} — ${esc(new Date(r.created_at).toLocaleDateString())}</li>`
        )
        .join("")}</ul>`
    : `<p>No reports yet. <a href="${DOWNLOAD_URL}">Test your GPU</a> to get started.</p>`;
  return shell(
    "My reports",
    `<h1>My reports</h1>
     ${rows}
     <p><a href="/">Home</a></p>`
  );
}
