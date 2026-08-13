// Fails if a colour is written down anywhere except the two token blocks.
//
// Dark mode shipped broken because of exactly this. The tokens all inverted
// correctly, and four call sites had a cream hex typed directly into them, so
// the upload-key panel and every input well stayed light on a dark page with
// pale text on top of them. The tokens were right; the audit was missing.
//
// Scoped to theme.ts and pages.ts, the files that participate in theming.
// report-page.ts is deliberately light-only, so a literal there is a style
// preference rather than a bug waiting for someone to switch themes.
import { readFileSync } from "node:fs";

const FILES = ["src/theme.ts", "src/pages.ts"];

// Anything that names a colour rather than referring to one.
// `white` needs the trailing guard or it matches `white-space`, which is a
// layout property and has never been a colour.
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b(?!-)/g;

/// Removes the regions where writing a colour down is the whole point: the two
/// token definitions, and the favicon, which is an SVG data URI whose colours
/// cannot be variables because it is not a stylesheet.
function stripAllowedRegions(source: string): string {
  const cut = (text: string, start: string) => {
    const from = text.indexOf(start);
    if (from === -1) return text;
    // Token blocks are template literals terminated by a backtick and a
    // semicolon, which is unambiguous here and avoids parsing TypeScript.
    const to = text.indexOf("`;", from);
    if (to === -1) return text;
    // Blanked, not spliced. Removing the region shifts every line number after
    // it, and a checker that reports the wrong line is worse than no checker:
    // it sends you to read code that is fine.
    const region = text.slice(from, to).replace(/[^\n]/g, " ");
    return text.slice(0, from) + region + text.slice(to);
  };
  let out = source;
  out = cut(out, "export const TOKENS_CSS");
  out = cut(out, "const DARK_VALUES");
  out = cut(out, "export const DARK_TOKENS_CSS");
  out = cut(out, "const FAVICON_SVG");
  // Comments discuss colours constantly, in both TypeScript and CSS syntax,
  // and a comment cannot make a panel the wrong shade. Replaced with newlines
  // rather than removed so the reported line numbers still point somewhere
  // useful.
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  out = out.replace(/\/\/[^\n]*/g, blank);
  return out;
}

let failures = 0;
for (const file of FILES) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const stripped = stripAllowedRegions(source);
  const found = [...stripped.matchAll(COLOUR)];
  if (found.length === 0) {
    console.log(`ok   ${file} refers to colours only through tokens`);
    continue;
  }
  failures += found.length;
  for (const m of found) {
    const line = stripped.slice(0, m.index).split("\n").length;
    console.log(`FAIL ${file}: hardcoded colour ${m[0]} near line ${line}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} hardcoded colour(s). Add a token in TOKENS_CSS and DARK_TOKENS_CSS instead: ` +
      `anything written down here is a surface that will not follow the theme.`
  );
  process.exit(1);
}
// A checker that has never failed proves nothing, so it is shown a copy of the
// exact bug it exists to catch before it is believed.
const canary = stripAllowedRegions(`
  export const TOKENS_CSS = \`:root { --paper: #ece9e2; }\`;
  const styles = ".key-panel { background: #f6f5f0; }";
`);
if (![...canary.matchAll(COLOUR)].length) {
  console.error("the colour check does not detect a hardcoded colour, so it is not checking anything");
  process.exit(1);
}
console.log("ok   the check itself detects the bug it was written for");

console.log("\ntheme ok");
