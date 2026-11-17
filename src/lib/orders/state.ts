// A2 order state changes. Every change is ONE D1 batch:
//   1. a guard that aborts the whole batch unless the order still has the status we read (see guard()),
//   2. the stock / reservation / payment side effects (CONTRACTS §3 stock arithmetic),
//   3. the conditional order UPDATE (... WHERE id = ? AND status = ?from), the order_events row and the audit row.
// Because of the guard, a concurrent change (admin vs. QPay callback vs. hold sweep) makes the losing batch
// write nothing at all, so stock is committed / released / restored exactly once.
import { auditStatement } from "../audit";
import { canOrderTransition, type Actor, type OrderStatus } from "../contracts";
import type { D1, OrderRow, Stmt } from "./types";

/**
 * Batch guard: aborts the whole D1 batch unless `existsSql` matches a row. It inserts a row with an invalid
 * `reason` into stock_movements only when the condition is false, so the table's CHECK constraint fails and
 * D1 rolls the batch back. When the condition holds it inserts nothing.
 */
export function guard(db: D1, existsSql: string, ...args: (string | number | null)[]): Stmt {
  return db
    .prepare(
      `INSERT INTO stock_movements (sku_id, delta, reason, actor)
       SELECT '-', 0, 'guard-failed', 'system' WHERE NOT EXISTS (${existsSql})`,
    )
    .bind(...args);
}
export const guardOrderStatus = (db: D1, orderId: number, status: string) =>
  guard(db, "SELECT 1 FROM orders WHERE id = ?1 AND status = ?2", orderId, status);

/** True when a batch failed because a guard() fired (somebody else changed the row first). */
export function isGuardError(err: unknown): boolean {
  const msg = String((err as { cause?: unknown })?.cause ?? "") + String(err);
  return /CHECK constraint failed/i.test(msg) && /reason/i.test(msg);
}
export function isCheckError(err: unknown): boolean {
  const msg = String((err as { cause?: unknown })?.cause ?? "") + String(err);
  return /CHECK constraint failed/i.test(msg);
}
export const errText = (err: unknown) => String((err as { cause?: unknown })?.cause ?? "") + " " + String(err);

/** Held -> committed: stock -= qty, reserved -= qty, movement `sale` (tracked lines only). */
export function commitReservations(db: D1, orderId: number, actor: Actor): Stmt[] {
  return [
    db
      .prepare(
        `INSERT INTO stock_movements (sku_id, delta, reason, order_id, actor)
         SELECT r.sku_id, -r.qty, 'sale', r.order_id, ?2 FROM reservations r JOIN skus s ON s.id = r.sku_id
          WHERE r.order_id = ?1 AND r.status = 'held' AND r.tracked = 1 AND s.stock IS NOT NULL`,
      )
      .bind(orderId, actor),
    db
      .prepare(
        `UPDATE skus SET stock = skus.stock - r.qty, reserved = skus.reserved - r.qty, updated_at = datetime('now')
           FROM reservations r
          WHERE r.order_id = ?1 AND r.status = 'held' AND r.tracked = 1 AND r.sku_id = skus.id`,
      )
      .bind(orderId),
    db
      .prepare("UPDATE reservations SET status = 'committed', updated_at = datetime('now') WHERE order_id = ?1 AND status = 'held'")
      .bind(orderId),
  ];
}

/** Held -> released: reserved -= qty (cancel or hold expiry before payment). */
export function releaseReservations(db: D1, orderId: number): Stmt[] {
  return [
    db
      .prepare(
        `UPDATE skus SET reserved = skus.reserved - r.qty, updated_at = datetime('now')
           FROM reservations r
          WHERE r.order_id = ?1 AND r.status = 'held' AND r.tracked = 1 AND r.sku_id = skus.id`,
      )
      .bind(orderId),
    db
      .prepare("UPDATE reservations SET status = 'released', updated_at = datetime('now') WHERE order_id = ?1 AND status = 'held'")
      .bind(orderId),
  ];
}

/** Cancel after paid: stock += qty, movement `cancel_after_paid` (reservations stay committed). */
export function restoreCommitted(db: D1, orderId: number, actor: Actor): Stmt[] {
  return [
    db
      .prepare(
        `INSERT INTO stock_movements (sku_id, delta, reason, order_id, actor)
         SELECT r.sku_id, r.qty, 'cancel_after_paid', r.order_id, ?2 FROM reservations r JOIN skus s ON s.id = r.sku_id
          WHERE r.order_id = ?1 AND r.status = 'committed' AND r.tracked = 1 AND s.stock IS NOT NULL`,
      )
      .bind(orderId, actor),
    db
      .prepare(
        `UPDATE skus SET stock = skus.stock + r.qty, updated_at = datetime('now')
           FROM reservations r
          WHERE r.order_id = ?1 AND r.status = 'committed' AND r.tracked = 1 AND r.sku_id = skus.id AND skus.stock IS NOT NULL`,
      )
      .bind(orderId),
  ];
}

export function eventStatement(db: D1, orderId: number, from: string | null, to: string, actor: Actor, note: string | null): Stmt {
  return db
    .prepare("INSERT INTO order_events (order_id, from_status, to_status, actor, note) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(orderId, from, to, actor, note);
}

export type TransitionResult =
  | { ok: true; from: OrderStatus; to: OrderStatus }
  | { ok: false; code: "transition" | "conflict"; from: OrderStatus; to: string };

/**
 * Any transition except -> paid (payments/markPaid owns that, it needs a payment row).
 * cancelled: before paid releases held stock and closes pending payments; after paid restores stock.
 * confirmed: clears hold_expires_at (a confirmed order no longer expires).
 */
export async function transitionOrder(
  db: D1,
  order: OrderRow,
  to: OrderStatus,
  actor: Actor,
  opts: { note?: string | null; reason?: string | null } = {},
): Promise<TransitionResult> {
  const from = order.status;
  if (to === "paid" || !canOrderTransition(from, to)) return { ok: false, code: "transition", from, to };
  const note = opts.note ?? null;
  const stmts: Stmt[] = [guardOrderStatus(db, order.id, from)];
  let set = "status = ?1, updated_at = datetime('now')";
  const extra: (string | null)[] = [];
  if (to === "cancelled") {
    const reason = opts.reason ?? (actor === "customer" ? "customer" : actor === "system" ? "system" : "admin");
    if (from === "paid") {
      stmts.push(...restoreCommitted(db, order.id, actor));
    } else {
      stmts.push(...releaseReservations(db, order.id));
      stmts.push(
        db
          .prepare("UPDATE payments SET status = ?2, updated_at = datetime('now') WHERE order_id = ?1 AND status = 'pending'")
          .bind(order.id, reason === "expired" ? "expired" : "cancelled"),
      );
      set += ", payment_status = CASE WHEN payment_status = 'pending' THEN 'unpaid' ELSE payment_status END";
    }
    set += ", hold_expires_at = NULL, cancel_reason = ?4";
    extra.push(reason);
  } else if (to === "confirmed") {
    set += ", hold_expires_at = NULL";
  }
  stmts.push(
    db.prepare(`UPDATE orders SET ${set} WHERE id = ?2 AND status = ?3`).bind(to, order.id, from, ...extra),
    eventStatement(db, order.id, from, to, actor, note),
    auditStatement(db, actor, "order.status", "order", order.order_no, { from, to, ...(extra[0] ? { reason: extra[0] } : {}) }),
  );
  try {
    await db.batch(stmts);
    return { ok: true, from, to };
  } catch (err) {
    if (isGuardError(err)) return { ok: false, code: "conflict", from, to };
    throw err;
  }
}
