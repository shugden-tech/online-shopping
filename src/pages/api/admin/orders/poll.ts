// GET /api/admin/orders/poll  [orders.read]  (lead, 0004) -> { ok, latestId, newCount }
// Cheap check for the admin's new-order badge: the newest order id and how many orders wait in `new`.
import { adminRoute } from "../../../../lib/catalog/route";
import { json } from "../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/orders/poll", "orders.read", async (_ctx, env) => {
  const r = await env.DB.prepare(
    "SELECT (SELECT COALESCE(MAX(id), 0) FROM orders) AS latestId, (SELECT COUNT(*) FROM orders WHERE status = 'new') AS newCount",
  ).first<{ latestId: number; newCount: number }>();
  return json(200, { ok: true, latestId: r?.latestId ?? 0, newCount: r?.newCount ?? 0 });
});
