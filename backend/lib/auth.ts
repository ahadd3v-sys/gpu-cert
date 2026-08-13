// Mirrors anurfi-board/lib/auth.ts's JWT-in-cookie pattern (same jose
// SignJWT/jwtVerify shape). The payload just carries a real user id
// instead of a fixed owner enum, since this app has open signup instead of
// two hardcoded passwords.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";

export const COOKIE_NAME = "gpucert_session";
const ALG = "HS256";

function secretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: string) {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey());
}

export async function verifySessionToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.userId === "string" ? payload.userId : null;
  } catch {
    return null;
  }
}

// Reads and verifies the session cookie for the current request. The exe
// never sends this cookie (it has no browser session), so this is only
// ever populated for requests made from a logged-in browser.
export async function getSessionUserId(c: Context): Promise<string | null> {
  return verifySessionToken(getCookie(c, COOKIE_NAME));
}
