// Customer sessions (server-only).
//   cookie  __Host-gz_session = 32 random bytes (base64url), HttpOnly, Secure, SameSite=Lax, Path=/
//   D1      customer_sessions.id = hex SHA-256(token)  (the token itself is never stored)
//   expiry  30 days, sliding: pushed forward (and the cookie re-sent) at most once an hour while used
//   hint    gz_in=1 (not HttpOnly, no secret): tells the storefront JS to load the account code lazily
// Every mutating account route requires an Origin header equal to the site origin (CSRF), see accountRoute().
import type { APIContext, APIRoute } from "astro";
import { clientIp, fail } from "../server";
import { randomToken, sha256Hex } from "./crypto";

type D1 = import("@cloudflare/workers-types").D1Database;

export const SESSION_COOKIE = "__Host-gz_session";
export const HINT_COOKIE = "gz_in";
export const SESSION_DAYS = 30;
const MAX_AGE = SESSION_DAYS * 86_400;
const SLIDE_AFTER_SEC = 3600;

export interface CustomerRow {
  id: number;
  phone: string | null;
  name: string;
  display_name: string;
  password_hash: string | null;
  password_salt: string | null;
  password_iter: number | null;
  must_change_password: number;
  avatar_key: string | null;
  show_on_board: number;
  google_sub: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CustomerSession {
  id: string; // session id (token hash)
  customer: CustomerRow;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export const sessionCookies = (token: string): string[] => [
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
  `${HINT_COOKIE}=1; Path=/; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
];
export const clearCookies = (): string[] => [
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  `${HINT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`,
];

/** "Chrome · Android"-style label; never the full UA string. */
export function shortAgent(ua: string | null): string {
  if (!ua) return "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ua.split(/[\s/]/)[0] ?? "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ").slice(0, 120);
}

/** Creates a session row and returns the Set-Cookie values. */
export async function createSession(db: D1, customerId: number, request: Request): Promise<{ id: string; cookies: string[] }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  await db
    .prepare(
      `INSERT INTO customer_sessions (id, customer_id, expires_at, user_agent) VALUES (?1, ?2, datetime('now', '+${SESSION_DAYS} days'), ?3)`,
    )
    .bind(id, customerId, shortAgent(request.headers.get("User-Agent")))
    .run();
  return { id, cookies: sessionCookies(token) };
}

/**
 * The signed-in customer, or null. Slides the expiry (at most once an hour) and then returns `refresh` cookies so
 * the browser keeps the cookie as long as the server keeps the row.
 */
export async function getSession(db: D1, request: Request): Promise<(CustomerSession & { refresh?: string[] }) | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, CAST(strftime('%s', 'now') - strftime('%s', s.last_seen) AS INTEGER) AS idle, c.*
       FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?1 AND s.expires_at > datetime('now') AND c.deleted_at IS NULL`,
    )
    .bind(id)
    .first<CustomerRow & { session_id: string; idle: number }>();
  if (!row) return null;
  const { session_id, idle, ...customer } = row;
  let refresh: string[] | undefined;
  if (idle >= SLIDE_AFTER_SEC) {
    await db
      .prepare(`UPDATE customer_sessions SET last_seen = datetime('now'), expires_at = datetime('now', '+${SESSION_DAYS} days') WHERE id = ?1`)
      .bind(session_id)
      .run();
    refresh = sessionCookies(token);
  }
  return { id: session_id, customer: customer as CustomerRow, refresh };
}

/** CSRF: a mutating request must carry an Origin header equal to this site's origin. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export type AccountHandler<S> = (ctx: APIContext, env: Env, session: S, ip: string) => Promise<Response>;

function wrap(tag: string, needAuth: boolean, handler: AccountHandler<CustomerSession | null>): APIRoute {
  return async (ctx) => {
    try {
      const env = ctx.locals.runtime?.env;
      if (!env?.DB) throw new Error("D1 binding DB is missing");
      if (!SAFE.has(ctx.request.method) && !sameOrigin(ctx.request)) return fail(403, { form: "origin" });
      const ip = clientIp(ctx.request, () => ctx.clientAddress);
      const s = await getSession(env.DB, ctx.request);
      if (needAuth && !s) return withCookies(fail(401, { form: "unauthorized" }), [clearCookies()[1]!]);
      const res = await handler(ctx, env, s, ip);
      if (s?.refresh && !res.headers.has("Set-Cookie")) withCookies(res, s.refresh);
      return res;
    } catch (err) {
      console.error(`[account/${tag}]`, err instanceof Error ? err.message : "error");
      return fail(500, { form: "server" });
    }
  };
}

/**
 * Wrapper for signed-in /api/account/* routes: env check → same-origin check on mutating methods → session (401
 * without one) → handler → sliding-cookie refresh. Errors become 500 without details.
 */
export const accountRoute = (tag: string, handler: AccountHandler<CustomerSession>): APIRoute =>
  wrap(tag, true, handler as AccountHandler<CustomerSession | null>);

/** Same as accountRoute, but the session is optional (register, login, me). */
export const publicAccountRoute = (tag: string, handler: AccountHandler<CustomerSession | null>): APIRoute => wrap(tag, false, handler);

/** Response helper that sets several cookies. */
export function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}
