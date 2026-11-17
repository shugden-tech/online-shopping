// Webhook signature: X-Signature = lowercase hex HMAC-SHA256(DELIVERY_WEBHOOK_SECRET, raw body bytes).
import { safeEqual } from "../auth";

export const WEBHOOK_SECRET_MIN = 16;
const enc = new TextEncoder();

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let out = "";
  for (const b of sig) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time check (safeEqual hashes both sides first). */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const given = (header ?? "").trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(given)) {
    await safeEqual("x", "y"); // keep the timing similar for malformed headers
    return false;
  }
  return safeEqual(given, await hmacHex(secret, body));
}
