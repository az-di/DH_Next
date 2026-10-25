import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

// Signed, expiring tokens for the "connect your calendar" link the bot texts
// each member. The token doubles as the OAuth `state`, so the callback knows
// which user is connecting without any login.

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", config.linkSecret).update(payload).digest("base64url");
}

export function createConnectToken(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id, or null if the token is forged or expired. */
export function verifyConnectToken(token: string, now = Date.now()): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof u === "string" && typeof e === "number" && e > now ? u : null;
  } catch {
    return null;
  }
}

export function connectUrl(userId: string): string {
  return `${config.publicBaseUrl}/connect?t=${encodeURIComponent(createConnectToken(userId))}`;
}
