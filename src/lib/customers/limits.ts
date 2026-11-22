// Read-only check of a hitRateLimit() counter (src/lib/server.ts, same table and fixed window), for limits that
// count failures only: check first with overRateLimit(), call hitRateLimit() after a failure.
type D1 = import("@cloudflare/workers-types").D1Database;

export async function overRateLimit(db: D1, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSec);
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2")
    .bind(key.slice(0, 200), start)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= limit;
}
