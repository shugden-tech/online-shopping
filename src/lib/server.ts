// Server-only helpers shared by the API routes: JSON responses, client IP, JSON body reading and the
// atomic D1 rate limiter. Never import this from an island.

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

// Admin auth lives in ./auth.ts; catalog, order and payment logic in ./catalog, ./orders, ./payments.
