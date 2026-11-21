// A2: hold expiry. `new` orders whose hold_expires_at has passed are cancelled (reason `expired`), their held
// stock is released and their pending payments are marked `expired`. A QPay order is re-checked with QPay
// first (a Wire order: its PaymentIntent is read back), so a payment whose callback / webhook got lost is applied
// instead of expired.
// Called from POST /api/orders via waitUntil and from the lead's POST /api/admin/jobs/run.
import { qpayConfigured, refreshQpay, refreshWire, wireConfigured } from "../payments";
import { transitionOrder } from "./state";
import { loadOrder, type OrderRow } from "./types";

/** If QPay cannot be reached, an expired QPay order is left alone for this long before it expires anyway. */
const QPAY_GRACE_HOURS = 6;

export async function sweepExpiredHolds(env: Env, limit = 50): Promise<{ expired: number }> {
  const db = env.DB;
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const due = await db
    .prepare(
      `SELECT *, (hold_expires_at < datetime('now', ?2)) AS past_grace FROM orders
        WHERE status = 'new' AND hold_expires_at IS NOT NULL AND hold_expires_at < datetime('now')
        ORDER BY hold_expires_at LIMIT ?1`,
    )
    .bind(n, `-${QPAY_GRACE_HOURS} hours`)
    .all<OrderRow & { past_grace: number }>();
  let expired = 0;
  for (const candidate of due.results ?? []) {
    try {
      let order: OrderRow | null = candidate;
      const qpay = order.payment === "qpay" && qpayConfigured(env);
      const wire = order.payment === "wire" && wireConfigured(env);
      if (qpay || wire) {
        try {
          if (qpay) await refreshQpay(env, order);
          else await refreshWire(env, order);
        } catch (err) {
          console.error(`[holds] ${order.payment} check for ${order.order_no} failed:`, String((err as Error)?.message ?? err));
          if (!candidate.past_grace) continue; // try again on the next sweep
        }
        order = await loadOrder(db, candidate.order_no);
        if (!order || order.status !== "new") continue; // it was paid (or changed) meanwhile
      }
      const r = await transitionOrder(db, order, "cancelled", "system", { reason: "expired", note: "hold expired" });
      if (r.ok) expired++;
    } catch (err) {
      console.error(`[holds] expiring ${candidate.order_no} failed`, err);
    }
  }
  return { expired };
}
