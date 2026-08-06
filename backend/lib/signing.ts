// Ed25519 signing for certified reports. Uses Node's built-in `crypto`
// (native Ed25519 support since Node 12) rather than a JS crypto library —
// one less dependency, and this only ever runs server-side.
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "crypto";

function loadPrivateKey(): KeyObject {
  const pem = process.env.CERT_SIGNING_PRIVATE_KEY;
  if (!pem) throw new Error("CERT_SIGNING_PRIVATE_KEY is not set");
  return createPrivateKey({ key: pem.replace(/\\n/g, "\n"), format: "pem" });
}

function loadPublicKey(): KeyObject {
  const pem = process.env.CERT_SIGNING_PUBLIC_KEY;
  if (!pem) throw new Error("CERT_SIGNING_PUBLIC_KEY is not set");
  return createPublicKey({ key: pem.replace(/\\n/g, "\n"), format: "pem" });
}

// Ed25519 signs raw bytes directly (no separate digest step), so the caller
// just needs to hand in a stable byte representation of the report — see
// canonicalReportString() in lib/certify.ts for how that's built.
export function signReport(canonicalPayload: string): string {
  const signature = edSign(null, Buffer.from(canonicalPayload, "utf8"), loadPrivateKey());
  return signature.toString("base64");
}

export function verifyReportSignature(canonicalPayload: string, signatureBase64: string): boolean {
  return edVerify(
    null,
    Buffer.from(canonicalPayload, "utf8"),
    loadPublicKey(),
    Buffer.from(signatureBase64, "base64")
  );
}
