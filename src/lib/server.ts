// Server-only helpers shared by the API routes: JSON responses, client IP, the atomic D1 rate limiter,
// admin bearer auth, inventory overrides and order status rules. Never import this from an island.
import type { Product } from "./products";

type D1 = import("@cloudflare/workers-types").D1Database;

export const NO_STORE = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex",
} as const;

export const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extra } });

export const fail = (status: number, errors: Record<string, string>, extra?: Record<string, string>) =>
  json(status, { ok: false, errors }, extra);

export function clientIp(request: Request, getAddress: () => string): string {
  const h = request.headers.get("CF-Connecting-IP");
  if (h) return h.slice(0, 64);
  try {
    return getAddress() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Reads a JSON body with a size cap. Returns a Response on failure. */
export async function readJson(request: Request, maxBytes: number): Promise<{ value: unknown } | Response> {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) return fail(415, { form: "server" });
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return fail(413, { form: "server" });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return fail(413, { form: "server" });
  try {
    return { value: JSON.parse(text) };
  } catch {
    return fail(400, { form: "server" });
  }
}

/* ---------------- rate limiting ---------------- */

/**
 * Atomic fixed-window counter: one upsert ... RETURNING per call, so concurrent requests can never both
 * read "4" and both insert. Returns true when the call is allowed (count after increment <= limit).
 */
export async function hitRateLimit(db: D1, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSec);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key.slice(0, 200), start)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** Deletes counters from old windows. Cheap; call occasionally via waitUntil. */
export function pruneRateLimits(db: D1, olderThanSec = 86_400): Promise<unknown> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  return db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(cutoff).run().catch(() => {});
}

/* ---------------- admin auth ---------------- */

const enc = new TextEncoder();

/** Constant-time comparison: both sides are hashed first, so length and content leak nothing. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export const ADMIN_MIN_TOKEN = 24;

/**
 * `Authorization: Bearer <ADMIN_TOKEN>`. Returns null when authorised, otherwise the 401/429/503 Response.
 * Failed attempts are rate limited per IP (20 per 10 minutes).
 */
export async function requireAdmin(request: Request, env: Env, ip: string): Promise<Response | null> {
  const secret = env.ADMIN_TOKEN ?? "";
  if (secret.length < ADMIN_MIN_TOKEN) {
    console.error(`[admin] ADMIN_TOKEN is not set or shorter than ${ADMIN_MIN_TOKEN} characters`);
    return fail(503, { form: "admin-disabled" });
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  if (m && (await safeEqual(m[1]!, secret))) return null;
  const allowed = await hitRateLimit(env.DB, `admin-fail:${ip}`, 20, 600);
  if (!allowed) return fail(429, { form: "rate" });
  return fail(401, { form: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="genzst-admin"' });
}

/* ---------------- inventory ---------------- */

export interface InventoryRow { product_id: string; ml: number; price: number | null; stock: number | null; updated_at: string }

export interface EffectiveSize {
  price: number;
  inStock: boolean;
  /** Units available, or undefined when not tracked. */
  stock: number | undefined;
  /** true when D1 holds a non-null stock that must be decremented on order. */
  tracked: boolean;
}

/**
 * Inventory rule: when a D1 inventory row exists, its non-null price / stock override the build-time
 * product JSON; a NULL column (or no row) falls back to the JSON value, which is the old behaviour.
 */
export function effectiveSize(size: Product["sizes"][number], row: InventoryRow | undefined): EffectiveSize {
  const price = row?.price ?? size.price;
  if (row && row.stock !== null) {
    return { price, inStock: price > 0 && row.stock > 0, stock: row.stock, tracked: true };
  }
  return { price, inStock: price > 0 && size.inStock, stock: size.stock, tracked: false };
}

export async function loadInventory(db: D1, keys: { slug: string; ml: number }[]): Promise<Map<string, InventoryRow>> {
  const out = new Map<string, InventoryRow>();
  if (!keys.length) return out;
  const slugs = [...new Set(keys.map((k) => k.slug))];
  const res = await db
    .prepare(`SELECT product_id, ml, price, stock, updated_at FROM inventory WHERE product_id IN (${slugs.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...slugs)
    .all<InventoryRow>();
  for (const r of res.results ?? []) out.set(`${r.product_id}:${r.ml}`, r);
  return out;
}

/* ---------------- order status ---------------- */

export const STATUSES = ["new", "confirmed", "paid", "shipped", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
const FLOW: Status[] = ["new", "confirmed", "paid", "shipped", "done"];

/** new → confirmed → paid → shipped → done, one step at a time; any non-cancelled status → cancelled. */
export function canTransition(from: string, to: string): boolean {
  if (from === to || from === "cancelled") return false;
  if (to === "cancelled") return (STATUSES as readonly string[]).includes(from);
  const i = FLOW.indexOf(from as Status);
  return i >= 0 && FLOW[i + 1] === to;
}

/** A stored order line. `tracked` = its stock was decremented in D1 (and is restored on cancel). */
export interface OrderLine { slug: string; brand: string; name: string; ml: number; qty: number; price: number; tracked?: boolean }

export const ORDER_NO_RE = /^GZ-\d{6}-[A-Z2-9]{4}$/;
