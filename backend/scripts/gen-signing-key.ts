// Run once (`npm run gen-signing-key`) to provision the real signing key.
// Prints two PEM values, paste them into Vercel env vars as
// CERT_SIGNING_PRIVATE_KEY and CERT_SIGNING_PUBLIC_KEY. There is no
// recovery if the private key is lost: every previously issued report's
// signature becomes unverifiable against a newly generated key, so back
// this up somewhere durable (password manager, not just Vercel).
import { generateKeyPairSync } from "crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

console.log("CERT_SIGNING_PRIVATE_KEY:\n");
console.log(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
console.log("CERT_SIGNING_PUBLIC_KEY:\n");
console.log(publicKey.export({ type: "spki", format: "pem" }).toString());
