// GET /api/admin/customers?q=&cursor=&limit= [customers.read, owner only] -> { ok, items, nextCursor }
// Read-only list of customer accounts (newest first). q matches phone digits or name. Deleted accounts are listed
// with deleted:true and no personal data (it was removed). Contract: docs/CONTRACTS.md §10.
import { adminRoute } from "../../../lib/catalog/route";
import { json } from "../../../lib/server";

export const prerender = false;

interface Row {
  id: number; phone: string | null; name: string; display_name: string; email: string | null; google_sub: string | null;
  password_hash: string | null; must_change_password: number; created_at: string; deleted_at: string | null; orders: number; last_seen: string | null;
}

export const GET = adminRoute("admin/customers", "customers.read", async ({ url }, env) => {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const cursor = Number(url.searchParams.get("cursor") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const where: string[] = [];
  const args: unknown[] = [];
  if (cursor > 0) {
    args.push(cursor);
    where.push(`c.id < ?${args.length}`);
  }
  if (q) {
    const digits = q.replace(/\D/g, "");
    args.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    const nameArg = args.length;
    if (digits.length >= 3) {
      args.push(`%${digits}%`);
      where.push(`(c.name LIKE ?${nameArg} ESCAPE '\\' OR c.phone LIKE ?${args.length})`);
    } else where.push(`c.name LIKE ?${nameArg} ESCAPE '\\'`);
  }
  args.push(limit + 1);
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.phone, c.name, c.display_name, c.email, c.google_sub, c.password_hash, c.must_change_password, c.created_at, c.deleted_at,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders,
              (SELECT MAX(last_seen) FROM customer_sessions s WHERE s.customer_id = c.id) AS last_seen
       FROM customers c ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.id DESC LIMIT ?${args.length}`,
    )
    .bind(...args)
    .all<Row>();
  const more = results.length > limit;
  const rows = results.slice(0, limit);
  return json(200, {
    ok: true,
    items: rows.map((r) => ({
      id: r.id, phone: r.phone, name: r.name, displayName: r.display_name, email: r.email, google: r.google_sub !== null,
      hasPassword: r.password_hash !== null, mustChangePassword: r.must_change_password === 1, orders: r.orders,
      createdAt: r.created_at, lastSeen: r.last_seen, deleted: r.deleted_at !== null,
    })),
    nextCursor: more ? rows[rows.length - 1]!.id : null,
  });
});
