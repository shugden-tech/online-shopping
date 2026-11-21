// Optional "Google-ээр нэвтрэх" (server-only): OAuth 2.0 authorization-code flow with PKCE (S256), a random `state`
// and `nonce` kept in a signed, HttpOnly, 10-minute cookie, and the ID token verified here with WebCrypto against
// Google's JWKS (RS256; iss, aud, exp, iat, nonce). No libraries. Contract: docs/CONTRACTS.md §10.
//
// Enabled only when GOOGLE_CLIENT_ID (var) and GOOGLE_CLIENT_SECRET (secret) are both set; otherwise the routes
// answer 404 and /api/account/me says google:false, so the profile page hides the button.
// GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_JWKS_URL override the endpoints for tests and are honoured ONLY for
// requests to localhost.
import { isLocalRequest, safeEqual } from "../auth";
import { b64url, fromB64url, randomToken } from "./crypto";
import { readCookie } from "./session";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const STATE_COOKIE = "__Host-gz_goauth";
const STATE_TTL = 600;
const enc = new TextEncoder();

export const googleEnabled = (env: Env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;

export function endpoints(env: Env, request: Request) {
  const local = isLocalRequest(request);
  return {
    auth: (local && env.GOOGLE_AUTH_URL) || AUTH_URL,
    token: (local && env.GOOGLE_TOKEN_URL) || TOKEN_URL,
    jwks: (local && env.GOOGLE_JWKS_URL) || JWKS_URL,
  };
}

export const redirectUri = (request: Request) => `${new URL(request.url).origin}/api/account/google/callback`;

/** Where the flow may send the browser back to (no open redirect). */
export const RETURN_PATHS = ["/profile/", "/en/profile/", "/zahialga/", "/en/checkout/"] as const;
export const safeReturn = (p: string | null) => (RETURN_PATHS as readonly string[]).includes(p ?? "") ? p! : "/profile/";

/* ---------------- signed state cookie ---------------- */

export interface OAuthState {
  s: string; // state
  v: string; // PKCE code_verifier
  n: string; // nonce
  m: "login" | "link";
  c: number; // customer id for "link", else 0
  r: string; // return path
  e: number; // expiry (unix seconds)
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function stateCookie(env: Env, st: OAuthState): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(st)));
  const sig = await hmac(env.GOOGLE_CLIENT_SECRET!, `gz-oauth.${body}`);
  return `${STATE_COOKIE}=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL}`;
}
export const clearStateCookie = () => `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function readState(env: Env, request: Request): Promise<OAuthState | null> {
  const raw = readCookie(request, STATE_COOKIE);
  const m = raw ? /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(raw) : null;
  if (!m) return null;
  if (!(await safeEqual(await hmac(env.GOOGLE_CLIENT_SECRET!, `gz-oauth.${m[1]}`), m[2]!))) return null;
  try {
    const st = JSON.parse(new TextDecoder().decode(fromB64url(m[1]!))) as OAuthState;
    return st.e > Date.now() / 1000 ? st : null;
  } catch {
    return null;
  }
}

export async function newState(mode: "login" | "link", customerId: number, ret: string): Promise<{ st: OAuthState; challenge: string }> {
  const st: OAuthState = { s: randomToken(24), v: randomToken(48), n: randomToken(24), m: mode, c: customerId, r: ret, e: Math.floor(Date.now() / 1000) + STATE_TTL };
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(st.v))));
  return { st, challenge };
}

export function authorizeUrl(env: Env, request: Request, st: OAuthState, challenge: string): string {
  const u = new URL(endpoints(env, request).auth);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: "openid email profile",
    state: st.s,
    nonce: st.n,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return u.toString();
}

/* ---------------- token exchange + ID token ---------------- */

export interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export async function exchangeCode(env: Env, request: Request, code: string, verifier: string): Promise<string | null> {
  const res = await fetch(endpoints(env, request).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof data?.id_token === "string" ? data.id_token : null;
}

interface Jwk { kid?: string; kty?: string; alg?: string; n?: string; e?: string; use?: string }
let jwksCache: { url: string; keys: Jwk[]; until: number } | null = null;

async function jwks(url: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.url === url && jwksCache.until > Date.now()) return jwksCache.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { url, keys, until: Date.now() + 3600_000 };
  return keys;
}

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Verifies signature (RS256, key from the JWKS by kid), issuer, audience, expiry, issue time and nonce. */
export async function verifyIdToken(env: Env, request: Request, token: string, nonce: string): Promise<GoogleClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const url = endpoints(env, request).jwks;
  let jwk = (await jwks(url)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(url, true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const audOk = aud === env.GOOGLE_CLIENT_ID || (Array.isArray(aud) && aud.includes(env.GOOGLE_CLIENT_ID));
  if (!ISSUERS.has(String(claims.iss)) || !audOk) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
  if (typeof claims.iat === "number" && claims.iat > now + 300) return null;
  if (typeof claims.nonce !== "string" || !(await safeEqual(claims.nonce, nonce))) return null;
  if (typeof claims.sub !== "string" || !/^[\w-]{1,255}$/.test(claims.sub)) return null;
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email.slice(0, 200) : undefined,
    email_verified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}
