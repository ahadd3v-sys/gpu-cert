// The 1200x630 image that unfurls when a certificate URL is pasted somewhere.
//
// This is not decoration. The product travels by a seller dropping their
// certificate link into a listing or a trade channel, which means this image,
// not the site, is what nearly every buyer sees first. It has to answer the
// only three questions a buyer has at that moment (which card, did it pass,
// how recently) before they decide whether the link is worth a click.
//
// Distinct from `badge.ts`, which is the small mark a seller embeds *inside* a
// listing body and which therefore stays deliberately plain at 600x315. This
// one is the wide crop every unfurler asks for and can afford to be a document.
import { ImageResponse } from "@vercel/og";
import type { ReportRow } from "../lib/db.js";
import {
  SPACE_GROTESK_WOFF_BADGE_BASE64,
  INTER_400_WOFF_BADGE_BASE64,
  INTER_600_WOFF_BADGE_BASE64,
} from "./fonts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function el(type: string, props: Record<string, any>): any {
  return { type, key: null, props };
}

// The light palette only. An unfurled card sits on someone else's background
// in someone else's client, so it cannot follow the reader's theme the way the
// site does; it has to be one fixed thing that looks deliberate everywhere.
const PAPER = "#ece9e2";
const PAPER_EDGE = "#e3dfd6";
const INK = "#1a1814";
const INK_MUTED = "#6b6658";
const RULE = "#c9c3b6";
const PASS = "#3f6c4f";
const FAIL = "#96432f";

const WIDTH = 1200;
const HEIGHT = 630;

function fonts() {
  return [
    { name: "Inter", data: Buffer.from(INTER_400_WOFF_BADGE_BASE64, "base64"), weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: Buffer.from(INTER_600_WOFF_BADGE_BASE64, "base64"), weight: 600 as const, style: "normal" as const },
    { name: "Space Grotesk", data: Buffer.from(SPACE_GROTESK_WOFF_BADGE_BASE64, "base64"), weight: 600 as const, style: "normal" as const },
  ];
}

/// The masthead, repeated on both cards so a certificate preview and the site
/// preview are recognisably the same issuer.
function masthead(right: string) {
  return el("div", {
    style: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" },
    children: [
      el("div", {
        style: { display: "flex", flexDirection: "column" },
        children: [
          el("div", {
            style: { display: "flex", fontFamily: "Space Grotesk", fontWeight: 600, fontSize: 30, letterSpacing: 2, color: INK },
            children: "GPU CERT",
          }),
          el("div", {
            style: { display: "flex", fontSize: 15, color: INK_MUTED, letterSpacing: 1.5, marginTop: 4 },
            children: "INDEPENDENT VERIFICATION PROTOCOL",
          }),
        ],
      }),
      el("div", { style: { display: "flex", fontSize: 17, color: INK_MUTED, fontVariantNumeric: "tabular-nums" }, children: right }),
    ],
  });
}

function rule(weight = 1) {
  return el("div", { style: { display: "flex", width: "100%", height: weight, background: RULE } });
}

/// A cell of the specification strip along the bottom.
///
/// `size` exists because the two cards put different things here: the
/// certificate's cells are short measured figures that want to be big, and the
/// site card's are phrases that collide at the same size.
function stat(label: string, value: string, size = 27) {
  return el("div", {
    style: { display: "flex", flexDirection: "column", flex: 1, paddingRight: 24 },
    children: [
      el("div", { style: { display: "flex", fontSize: 14, color: INK_MUTED, letterSpacing: 1.2 }, children: label.toUpperCase() }),
      el("div", {
        style: { display: "flex", fontSize: size, fontFamily: "Space Grotesk", fontWeight: 600, color: INK, marginTop: 6, fontVariantNumeric: "tabular-nums" },
        children: value,
      }),
    ],
  });
}

function sheet(children: unknown[]) {
  return el("div", {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      background: PAPER_EDGE,
      padding: 28,
      fontFamily: "Inter",
    },
    children: [
      el("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: PAPER,
          border: `1px solid ${RULE}`,
          padding: "44px 52px",
          justifyContent: "space-between",
        },
        children,
      }),
    ],
  });
}

export function renderCertificateCard(report: ReportRow, certificateNumber: string): ImageResponse {
  const passed = report.verdict === "Pass";
  const vramPct =
    report.fingerprint_vram_total_bytes > 0
      ? Math.round((report.vram_bytes_tested / report.fingerprint_vram_total_bytes) * 100)
      : 0;
  const tested = new Date(report.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const tree = sheet([
    masthead(certificateNumber),
    rule(1),
    el("div", {
      style: { display: "flex", flexDirection: "column" },
      children: [
        // The verdict leads, because it is the only thing a buyer scanning a
        // listing actually needs from the preview.
        el("div", {
          style: {
            display: "flex",
            alignSelf: "flex-start",
            padding: "8px 22px",
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: 3,
            color: PAPER,
            background: passed ? PASS : FAIL,
          },
          children: passed ? "PASS" : "FAIL",
        }),
        el("div", {
          style: {
            display: "flex",
            fontSize: report.device_name.length > 28 ? 58 : 70,
            fontFamily: "Space Grotesk",
            fontWeight: 600,
            color: INK,
            marginTop: 22,
            lineHeight: 1.05,
          },
          children: report.device_name,
        }),
        el("div", {
          style: { display: "flex", fontSize: 20, color: INK_MUTED, marginTop: 14 },
          children: `Tested ${tested}. Verify this certificate yourself at gpucert.com.`,
        }),
      ],
    }),
    el("div", {
      style: { display: "flex", flexDirection: "column", width: "100%" },
      children: [
        rule(3),
        el("div", {
          style: { display: "flex", width: "100%", paddingTop: 22 },
          children: [
            stat("Memory tested", `${vramPct}%`),
            stat("Memory errors", String(report.vram_total_errors)),
            stat("Peak temp", `${report.stress_peak_temp_c} °C`),
            stat("Pixel faults", String(report.fur_mismatches)),
          ],
        }),
      ],
    }),
  ]);

  return new ImageResponse(tree, { width: WIDTH, height: HEIGHT, fonts: fonts() });
}

/// The card for every page that is not a certificate.
export function renderSiteCard(): ImageResponse {
  const tree = sheet([
    masthead("gpucert.com"),
    rule(1),
    el("div", {
      style: { display: "flex", flexDirection: "column" },
      children: [
        el("div", {
          style: { display: "flex", fontSize: 62, fontFamily: "Space Grotesk", fontWeight: 600, color: INK, lineHeight: 1.1 },
          children: "Prove the card works before you ask a stranger to trust you.",
        }),
        el("div", {
          style: { display: "flex", fontSize: 22, color: INK_MUTED, marginTop: 20 },
          children: "A signed certificate for a used GPU, at a URL the buyer can check.",
        }),
      ],
    }),
    el("div", {
      style: { display: "flex", flexDirection: "column", width: "100%" },
      children: [
        rule(3),
        el("div", {
          style: { display: "flex", width: "100%", paddingTop: 22 },
          children: [
            stat("Memory", "Every byte", 24),
            stat("Load", "At rated power", 24),
            stat("Render", "Against a reference", 24),
          ],
        }),
      ],
    }),
  ]);

  return new ImageResponse(tree, { width: WIDTH, height: HEIGHT, fonts: fonts() });
}
