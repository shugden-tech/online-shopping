// Customer accounts: password hashing (PBKDF2-SHA256 via WebCrypto), random tokens, SHA-256, base64url.
// Server-only. Passwords are never logged or returned.
import { COMMON_PASSWORDS } from "./common-passwords";

/** Workers' WebCrypto refuses PBKDF2 above 100,000 iterations. */
export const PBKDF2_ITER = 100_000;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomToken = (n = 32) => b64url(randomBytes(n));

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iter: number;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return { hash: b64url(hash), salt: b64url(salt), iter: PBKDF2_ITER };
}

/** Constant-time compare of two byte arrays of the same length. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const DUMMY_SALT = b64url(new Uint8Array(16));

/**
 * Checks a password against a stored hash. With `stored` null it still runs one PBKDF2 (on a dummy salt) so an
 * unknown phone takes as long as a wrong password.
 */
export async function verifyPassword(password: string, stored: PasswordHash | null): Promise<boolean> {
  const iter = stored && stored.iter > 0 && stored.iter <= PBKDF2_ITER ? stored.iter : PBKDF2_ITER;
  const got = await pbkdf2(password, fromB64url(stored?.salt ?? DUMMY_SALT), iter);
  if (!stored) return false;
  return sameBytes(got, fromB64url(stored.hash));
}

/** null when acceptable, else an error code: `short`, `long`, `common`. */
export function passwordProblem(password: string, phone?: string | null): string | null {
  if (password.length < PASSWORD_MIN) return "short";
  if (password.length > PASSWORD_MAX) return "long";
  const low = password.toLowerCase();
  if (COMMON_PASSWORDS.has(low) || (phone && low.includes(phone)) || /^(.)\1+$/.test(low) || /^\d+$/.test(low) && isSequence(low)) return "common";
  return null;
}

function isSequence(d: string): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < d.length; i++) {
    const step = (d.charCodeAt(i) - d.charCodeAt(i - 1) + 10) % 10;
    if (step !== 1) up = false;
    if (step !== 9) down = false;
  }
  return up || down;
}

/** Temporary password for an admin reset: 12 characters from an alphabet without look-alikes. */
export function tempPassword(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += abc[b % abc.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
