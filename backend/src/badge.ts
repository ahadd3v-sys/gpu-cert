import { ImageResponse } from "@vercel/og";
import type { ReportRow } from "../lib/db.js";
import {
  SPACE_GROTESK_WOFF_BADGE_BASE64,
  INTER_400_WOFF_BADGE_BASE64,
  INTER_600_WOFF_BADGE_BASE64,
} from "./fonts.js";

// Plain object literals shaped like React elements ({type, props}), not
// JSX. `@vercel/og`/satori only need the shape — they don't call any real
// React API — but writing `<div>` JSX syntax would compile to a call into
// "react/jsx-runtime", pulling the actual React package back in as a
// runtime dependency for the sake of one image. This stays JSX-shaped
// without needing JSX or React installed. Typed `any` deliberately: the
// real type (satori's ReactElement) lives in the optional `react` package
// we're not installing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function el(type: string, props: Record<string, any>): any {
  return { type, key: null, props };
}

// Same paper/ink/mark palette as the rest of the site — this is the image
// that represents a certificate off-site (embedded in a listing, shared to
// Discord), so it can't contradict the identity the certificate itself sets.
const PAPER = "#ece9e2";
const INK = "#1a1814";
const INK_MUTED = "#6b6658";
const MARK = "#14120f";
const PASS = "#3f6c4f";
const FAIL = "#96432f";

export function renderBadge(report: ReportRow): ImageResponse {
  const passed = report.verdict === "Pass";

  const tree = el("div", {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      padding: 40,
      background: PAPER,
      color: INK,
      fontFamily: "Inter",
    },
    children: [
      el("div", {
        style: { display: "flex", alignItems: "center", gap: 12 },
        children: [
          el("div", {
            style: {
              display: "flex",
              padding: "6px 16px",
              borderRadius: 6,
              fontSize: 20,
              fontWeight: 600,
              color: PAPER,
              background: passed ? PASS : FAIL,
            },
            children: passed ? "PASS" : "FAIL",
          }),
          el("div", { style: { fontSize: 20, color: MARK, fontFamily: "Space Grotesk", fontWeight: 600 }, children: "GPU Cert" }),
        ],
      }),
      el("div", { style: { display: "flex", fontSize: 40, fontWeight: 600, fontFamily: "Space Grotesk", marginTop: 20 }, children: report.device_name }),
      el("div", {
        style: { display: "flex", fontSize: 18, color: INK_MUTED, marginTop: 8 },
        children: `${report.vram_total_errors} VRAM error${report.vram_total_errors === 1 ? "" : "s"} · ${report.vram_passes_run} passes tested`,
      }),
    ],
  });

  return new ImageResponse(tree, {
    width: 600,
    height: 315,
    fonts: [
      { name: "Inter", data: Buffer.from(INTER_400_WOFF_BADGE_BASE64, "base64"), weight: 400, style: "normal" },
      { name: "Inter", data: Buffer.from(INTER_600_WOFF_BADGE_BASE64, "base64"), weight: 600, style: "normal" },
      { name: "Space Grotesk", data: Buffer.from(SPACE_GROTESK_WOFF_BADGE_BASE64, "base64"), weight: 600, style: "normal" },
    ],
  });
}
