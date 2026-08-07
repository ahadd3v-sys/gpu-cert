// Shared by every hand-written HTML page (see report-page.ts for why these
// are strings, not JSX). esc() is the only thing standing between
// user-controlled fields (email, etc.) and the page.
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
