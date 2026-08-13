// scrypt via Node's built-in crypto, same reasoning as lib/signing.ts using
// built-in Ed25519 instead of a dependency: this only ever runs server-side,
// no bcrypt/argon2 package needed for a single hash+verify pair.
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// Burns the same scrypt work a real verification would, for the login path
// where no account matched. Without it, "no such email" returns in
// microseconds while a wrong password takes as long as scrypt does, and that
// difference is measurable over the network. It lets anyone enumerate which
// email addresses have accounts here.
const DUMMY_HASH = hashPassword("gpu-cert-timing-equalizer");

export function burnPasswordVerification(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}
