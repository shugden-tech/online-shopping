// GET /api/admin/stats?range=today|7d|30d  [orders.read]  (lead, 0004)
// Dashboard numbers, all aggregated in SQL. Days are Mongolia days (UTC+8).
//   { ok, range, kpi: { orders, cancelled, paidOrders, revenue, aov }, now: { pendingPayments, toShip, lowStock,
//     outOfStock, failedShipments, failedWebhooks, draftProducts, unpricedActive },
//     series: [{ day, orders, revenue }] (always the last 30 days), latest: [order rows (10)] }
// revenue = sum of totals of orders created in the range whose payment is confirmed (payment_status 'paid')
// and that were not cancelled. Snapshot numbers (`now`) ignore the range.
import { adminRoute } from "../../../lib/catalog/route";
import { fail, json } from "../../../lib/server";

export const prerender = false;

const TZ = "+8 hours";
const LOW = 3;
const RANGES: Record<string, number> = { today: 0, "7d": 6, "30d": 29 };

export const GET = adminRoute("admin/stats", "orders.read", async ({ url }, env) => {
  const range = url.searchParams.get("range") ?? "7d";
  if (!(range in RANGES)) return fail(400, { range: "invalid" });
  const since = `-${RANGES[range]} days`;
  const db = env.DB;
  const day = `date(created_at, '${TZ}')`;
  const [kpi, now, series, latest] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS orders,
                SUM(status = 'cancelled') AS cancelled,
                SUM(payment_status = 'paid' AND status <> 'cancelled') AS paidOrders,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' AND status <> 'cancelled' THEN total END), 0) AS revenue
           FROM orders WHERE ${day} >= date('now', '${TZ}', ?1)`,
      )
      .bind(since),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE status IN ('new','confirmed') AND payment_status <> 'paid') AS pendingPayments,
         (SELECT COUNT(*) FROM orders o WHERE o.status = 'paid'
             AND NOT EXISTS (SELECT 1 FROM shipments x WHERE x.order_id = o.id AND x.status NOT IN ('cancelled','failed'))) AS toShip,
         (SELECT COUNT(*) FROM skus k JOIN products p ON p.id = k.product_id
             WHERE p.status = 'active' AND k.active = 1 AND k.stock IS NOT NULL AND k.stock - k.reserved BETWEEN 1 AND ${LOW}) AS lowStock,
         (SELECT COUNT(*) FROM skus k JOIN products p ON p.id = k.product_id
             WHERE p.status = 'active' AND k.active = 1 AND k.stock IS NOT NULL AND k.stock - k.reserved <= 0) AS outOfStock,
         (SELECT COUNT(*) FROM shipments WHERE status = 'failed') AS failedShipments,
         (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'failed') AS failedWebhooks,
         (SELECT COUNT(*) FROM products WHERE status = 'draft') AS draftProducts,
         (SELECT COUNT(*) FROM products p WHERE p.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM skus k WHERE k.product_id = p.id AND k.price IS NOT NULL AND k.active = 1)) AS unpricedActive`,
    ),
    db.prepare(
      `SELECT ${day} AS day, COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN payment_status = 'paid' AND status <> 'cancelled' THEN total END), 0) AS revenue
         FROM orders WHERE ${day} >= date('now', '${TZ}', '-29 days') GROUP BY 1 ORDER BY 1`,
    ),
    db.prepare(
      `SELECT order_no AS orderNo, created_at AS createdAt, name, phone, total, payment, payment_status AS paymentStatus, status
         FROM orders ORDER BY id DESC LIMIT 10`,
    ),
  ]);
  const k = (kpi!.results?.[0] ?? {}) as Record<string, number | null>;
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const paidOrders = n(k.paidOrders);
  const revenue = n(k.revenue);

  // fill the 30 days (oldest first), so the chart never skips a day
  const byDay = new Map(((series!.results ?? []) as { day: string; orders: number; revenue: number }[]).map((r) => [r.day, r]));
  const today = new Date(Date.now() + 8 * 3600_000);
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (29 - i));
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    return { day: key, orders: n(r?.orders), revenue: n(r?.revenue) };
  });
  return json(200, {
    ok: true,
    range,
    kpi: { orders: n(k.orders), cancelled: n(k.cancelled), paidOrders, revenue, aov: paidOrders ? Math.round(revenue / paidOrders) : 0 },
    now: Object.fromEntries(Object.entries((now!.results?.[0] ?? {}) as Record<string, number>).map(([a, b]) => [a, n(b)])),
    lowStockThreshold: LOW,
    series: days,
    latest: latest!.results ?? [],
  });
});
