import { ImageResponse } from "@vercel/og";
import type { ReportRow } from "../lib/db";

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
      background: "#0b0d10",
      color: "#e8eaed",
      fontFamily: "sans-serif",
    },
    children: [
      el("div", {
        style: { display: "flex", alignItems: "center", gap: 12 },
        children: [
          el("div", {
            style: {
              display: "flex",
              padding: "6px 16px",
              borderRadius: 999,
              fontSize: 20,
              fontWeight: 700,
              color: "#fff",
              background: passed ? "#2fbf71" : "#e5484d",
            },
            children: passed ? "PASS" : "FAIL",
          }),
          el("div", { style: { fontSize: 20, color: "#9aa1a9" }, children: "GPU Cert" }),
        ],
      }),
      el("div", { style: { display: "flex", fontSize: 40, fontWeight: 700, marginTop: 20 }, children: report.device_name }),
      el("div", {
        style: { display: "flex", fontSize: 18, color: "#9aa1a9", marginTop: 8 },
        children: `${report.vram_total_errors} VRAM error${report.vram_total_errors === 1 ? "" : "s"} · ${report.vram_passes_run} passes tested`,
      }),
    ],
  });

  return new ImageResponse(tree, { width: 600, height: 315 });
}
