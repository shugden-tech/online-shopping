// Background retry of provider calls (A3). Signature frozen in docs/CONTRACTS.md §4.
// Called by POST /api/admin/jobs/run (lead) and POST /api/admin/shipments/run-retries (A3).
//
// Picks shipments whose next_retry_at is due:
//   * failed  -> pending (event source 'system') -> provider call
//   * pending -> provider call (a create whose worker died after claiming the lease)
// A shipment that has failed MAX_ATTEMPTS times has next_retry_at NULL and is never picked again
// (an admin can still POST /api/admin/shipments/{id}/retry).
import { getAdapter } from "./registry";
import { dispatch, transition, type ShipmentRow } from "./service";

export async function retryShipments(env: Env, limit = 20): Promise<{ retried: number; failed: number }> {
  const db = env.DB;
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const due = await db
    .prepare(
      `SELECT s.id, s.order_id, s.provider, s.status, o.status AS order_status FROM shipments s JOIN orders o ON o.id = s.order_id
        WHERE s.status IN ('pending', 'failed') AND s.next_retry_at IS NOT NULL AND s.next_retry_at <= datetime('now')
        ORDER BY s.next_retry_at, s.id LIMIT ?`,
    )
    .bind(n)
    .all<Pick<ShipmentRow, "id" | "order_id" | "provider" | "status" | "order_status">>();

  let retried = 0;
  let failed = 0;
  for (const s of due.results ?? []) {
    try {
      if (!getAdapter(s.provider)?.automatic) continue;
      if (s.status === "failed") {
        if (s.order_status === "cancelled") {
          await transition(db, s, { to: "cancelled", source: "system", actor: "system", note: "order cancelled", set: { retryInMinutes: null } });
          continue;
        }
        const r = await transition(db, s, { to: "pending", source: "system", actor: "system", note: "automatic retry", set: { retryInMinutes: null } });
        if (!r.ok) continue;
      }
      const out = await dispatch(env, s.id, "system");
      if (out === "created") retried++;
      else if (out === "failed") failed++;
    } catch (err) {
      failed++;
      console.error(`[delivery] retry of shipment ${s.id} crashed`, (err as Error)?.name ?? "Error");
    }
  }
  return { retried, failed };
}
