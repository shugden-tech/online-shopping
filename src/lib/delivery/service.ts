// Shipment service (A3): create, status transitions, provider calls with retry/backoff, order side effects.
// Server-only. State machine = SHIPMENT_TRANSITIONS (contracts.ts); side effects = CONTRACTS.md §3.
//
// Every state change is ONE D1 batch:
//   1. UPDATE shipments ... WHERE id = ? AND status = ?from          (the conditional update)
//   2. guard: UPDATE shipments SET status = '!stale' WHERE id = ? AND status <> ?to
//      -> if (1) lost a race, (2) violates the status CHECK and the whole batch rolls back,
//         so no event / order change / audit row is written for a change that did not happen.
//   3. INSERT shipment_events (external_event_id de-duplicates webhooks via the unique index)
//   4. order side effects: order_events row + UPDATE orders ... WHERE status = 'paid' | 'shipped'
//   5. audit_log row (auditStatement)
// Logs and last_error carry ids and short error codes only — never names, phones or addresses.
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { auditStatement } from "../audit";
import { canShipmentTransition, type Actor, type ShipmentStatus } from "../contracts";
import { getAdapter } from "./registry";
import { DeliveryError, type DeliveryAdapter, type DeliveryOrder } from "./types";

type D1 = Env["DB"];

export const MAX_ATTEMPTS = 8;
/** Minutes a provider call holds a pending shipment before another worker may pick it up. */
export const LEASE_MINUTES = 5;
/** Backoff after the n-th failed attempt: min(2^n minutes, 6 hours). */
export const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 360);

export type EventSource = "admin" | "webhook" | "poll" | "system";

export interface ShipmentRow {
  id: number;
  order_id: number;
  provider: string;
  provider_ref: string | null;
  tracking_no: string | null;
  tracking_url: string | null;
  status: ShipmentStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  order_no: string;
  order_status: string;
}

const SELECT_SHIPMENT = `SELECT s.id, s.order_id, s.provider, s.provider_ref, s.tracking_no, s.tracking_url, s.status, s.attempts,
  s.last_error, s.next_retry_at, s.created_at, s.updated_at, o.order_no, o.status AS order_status
  FROM shipments s JOIN orders o ON o.id = s.order_id`;

export function shipmentView(r: ShipmentRow) {
  return {
    id: r.id,
    orderNo: r.order_no,
    orderStatus: r.order_status,
    provider: r.provider,
    providerRef: r.provider_ref,
    trackingNo: r.tracking_no,
    trackingUrl: r.tracking_url,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    nextRetryAt: r.next_retry_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type ShipmentView = ReturnType<typeof shipmentView>;

export function loadShipment(db: D1, id: number) {
  return db.prepare(`${SELECT_SHIPMENT} WHERE s.id = ?`).bind(id).first<ShipmentRow>();
}

export function loadShipmentByRef(db: D1, provider: string, providerRef: string) {
  return db.prepare(`${SELECT_SHIPMENT} WHERE s.provider = ? AND s.provider_ref = ?`).bind(provider, providerRef).first<ShipmentRow>();
}

export async function shipmentEvents(db: D1, id: number) {
  const res = await db
    .prepare("SELECT id, at, from_status AS fromStatus, to_status AS toStatus, source, external_event_id AS externalEventId, note FROM shipment_events WHERE shipment_id = ? ORDER BY id")
    .bind(id)
    .all();
  return res.results ?? [];
}

/* ---------------- errors from D1 ---------------- */

function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    parts.push(String((cur as { message?: unknown }).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}
const isGuardAbort = (t: string) => /CHECK constraint failed/i.test(t);
const isDuplicateEvent = (t: string) => /UNIQUE constraint failed: shipment_events/i.test(t);
const isDuplicateRef = (t: string) => /UNIQUE constraint failed: shipments\.provider/i.test(t);
const isDuplicateId = (t: string) => /UNIQUE constraint failed: shipments\.id/i.test(t);

/* ---------------- order side effects ---------------- */

function orderStep(db: D1, orderId: number, from: "paid" | "shipped", to: "shipped" | "done", actor: Actor, note: string): D1PreparedStatement[] {
  return [
    // the event first, while the status is still `from`; both are no-ops when the order moved on
    db
      .prepare("INSERT INTO order_events (order_id, from_status, to_status, actor, note) SELECT id, ?, ?, ?, ? FROM orders WHERE id = ? AND status = ?")
      .bind(from, to, actor, note, orderId, from),
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?").bind(to, orderId, from),
  ];
}

/** created / picked_up / in_transit => order paid -> shipped; delivered => (paid -> shipped ->) done. */
export function orderSideEffects(db: D1, orderId: number, shipmentId: number, to: ShipmentStatus, actor: Actor): D1PreparedStatement[] {
  const note = `shipment ${shipmentId} ${to}`;
  if (to === "created" || to === "picked_up" || to === "in_transit") return orderStep(db, orderId, "paid", "shipped", actor, note);
  if (to === "delivered") return [...orderStep(db, orderId, "paid", "shipped", actor, note), ...orderStep(db, orderId, "shipped", "done", actor, note)];
  return [];
}

/* ---------------- transitions ---------------- */

export interface TransitionInput {
  to: ShipmentStatus;
  source: EventSource;
  actor: Actor;
  note?: string | null;
  externalEventId?: string | null;
  set?: {
    providerRef?: string | null;
    trackingNo?: string | null;
    trackingUrl?: string | null;
    attempts?: number;
    lastError?: string | null;
    /** null clears next_retry_at; a number schedules it that many minutes from now. */
    retryInMinutes?: number | null;
  };
  auditData?: Record<string, unknown>;
}
export type TransitionResult = { ok: true } | { ok: false; reason: "transition" | "stale" | "duplicate" | "ref-conflict" };

export async function transition(db: D1, ship: Pick<ShipmentRow, "id" | "status" | "order_id">, t: TransitionInput): Promise<TransitionResult> {
  const from = ship.status;
  if (!canShipmentTransition(from, t.to)) return { ok: false, reason: "transition" };
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const args: (string | number | null)[] = [t.to];
  const set = t.set ?? {};
  const put = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (set.providerRef !== undefined) put("provider_ref", set.providerRef);
  if (set.trackingNo !== undefined) put("tracking_no", set.trackingNo);
  if (set.trackingUrl !== undefined) put("tracking_url", set.trackingUrl);
  if (set.attempts !== undefined) put("attempts", set.attempts);
  if (set.lastError !== undefined) put("last_error", set.lastError);
  if (set.retryInMinutes === null) sets.push("next_retry_at = NULL");
  else if (set.retryInMinutes !== undefined) {
    sets.push("next_retry_at = datetime('now', ?)");
    args.push(`+${Math.round(set.retryInMinutes)} minutes`);
  }
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE shipments SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...args, ship.id, from),
    db.prepare("UPDATE shipments SET status = '!stale' WHERE id = ? AND status <> ?").bind(ship.id, t.to),
    db
      .prepare("INSERT INTO shipment_events (shipment_id, from_status, to_status, source, external_event_id, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ship.id, from, t.to, t.source, t.externalEventId ?? null, t.note ?? null),
    ...orderSideEffects(db, ship.order_id, ship.id, t.to, t.actor),
    auditStatement(db, t.actor, "shipment.status", "shipment", ship.id, { from, to: t.to, source: t.source, ...t.auditData }),
  ];
  try {
    await db.batch(stmts);
    return { ok: true };
  } catch (e) {
    const m = errText(e);
    if (isDuplicateEvent(m)) return { ok: false, reason: "duplicate" };
    if (isDuplicateRef(m)) return { ok: false, reason: "ref-conflict" };
    if (isGuardAbort(m)) return { ok: false, reason: "stale" };
    throw e;
  }
}

/* ---------------- create ---------------- */

export type CreateOutcome =
  | { ok: true; shipment: ShipmentView }
  | { ok: false; status: number; errors: Record<string, string>; shipmentId?: number };

export async function createShipment(env: Env, orderNo: string, adapter: DeliveryAdapter, actor: Actor): Promise<CreateOutcome> {
  const db = env.DB;
  const order = await db.prepare("SELECT id, status FROM orders WHERE order_no = ?").bind(orderNo).first<{ id: number; status: string }>();
  if (!order) return { ok: false, status: 404, errors: { orderNo: "notFound" } };

  const conflict = async (): Promise<CreateOutcome | null> => {
    const active = await db.prepare("SELECT id FROM shipments WHERE order_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1").bind(order.id).first<{ id: number }>();
    if (active) return { ok: false, status: 409, errors: { orderNo: "has-shipment" }, shipmentId: active.id };
    const o = await db.prepare("SELECT status FROM orders WHERE id = ?").bind(order.id).first<{ status: string }>();
    if (o?.status !== "paid") return { ok: false, status: 409, errors: { orderNo: "not-paid" } };
    return null;
  };
  const pre = await conflict();
  if (pre) return pre;

  // The id is chosen up front so the event and audit rows can reference it inside the same batch.
  // The INSERT writes the invalid status '!conflict' (-> CHECK fails -> batch rolls back) when the order is
  // no longer paid or already has an active shipment, so two concurrent creates cannot both succeed.
  let id = 0;
  for (let attempt = 0; attempt < 4 && !id; attempt++) {
    const next = (await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM shipments").first<{ id: number }>())!.id;
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO shipments (id, order_id, provider, status)
             SELECT ?, o.id, ?, CASE WHEN o.status = 'paid'
                 AND NOT EXISTS (SELECT 1 FROM shipments x WHERE x.order_id = o.id AND x.status <> 'cancelled')
               THEN 'pending' ELSE '!conflict' END
             FROM orders o WHERE o.id = ?`,
          )
          .bind(next, adapter.id, order.id),
        db
          .prepare("INSERT INTO shipment_events (shipment_id, from_status, to_status, source, note) VALUES (?, NULL, 'pending', ?, ?)")
          .bind(next, actor === "system" ? "system" : "admin", `provider ${adapter.id}`),
        auditStatement(db, actor, "shipment.create", "shipment", next, { orderNo, provider: adapter.id }),
      ]);
      id = next;
    } catch (e) {
      const m = errText(e);
      if (isDuplicateId(m)) continue; // another shipment took that id; pick the next one
      if (isGuardAbort(m)) return (await conflict()) ?? { ok: false, status: 409, errors: { orderNo: "conflict" } };
      throw e;
    }
  }
  if (!id) return { ok: false, status: 503, errors: { form: "busy" } };

  if (adapter.automatic) await dispatch(env, id, actor);
  const row = await loadShipment(db, id);
  return { ok: true, shipment: shipmentView(row!) };
}

/* ---------------- provider call ---------------- */

interface DispatchRow extends ShipmentRow {
  name: string;
  phone: string;
  phone2: string | null;
  city: string;
  district: string | null;
  khoroo: string | null;
  address: string;
  items_json: string;
}

function itemsCount(itemsJson: string): number {
  try {
    const items = JSON.parse(itemsJson) as unknown;
    if (!Array.isArray(items)) return 0;
    return items.reduce((n: number, it) => {
      const q = (it as { qty?: unknown })?.qty;
      return n + (Number.isInteger(q) && (q as number) > 0 ? (q as number) : 0);
    }, 0);
  } catch {
    return 0;
  }
}

export type DispatchOutcome = "created" | "failed" | "skipped";

/**
 * Sends a `pending` shipment to its provider. Claims a short lease first (next_retry_at) so a concurrent
 * worker does not send it twice; the idempotency key makes a repeated send after a crash harmless.
 * Success: pending -> created (+ order paid -> shipped). Failure: pending -> failed, attempts + 1,
 * next_retry_at = now + backoff (no next retry after MAX_ATTEMPTS or for non-retryable errors).
 */
export async function dispatch(env: Env, shipmentId: number, actor: Actor): Promise<DispatchOutcome> {
  const db = env.DB;
  const s = await db
    .prepare(
      `${SELECT_SHIPMENT.replace("o.status AS order_status", "o.status AS order_status, o.name, o.phone, o.phone2, o.city, o.district, o.khoroo, o.address, o.items_json")} WHERE s.id = ?`,
    )
    .bind(shipmentId)
    .first<DispatchRow>();
  if (!s || s.status !== "pending") return "skipped";
  const adapter = getAdapter(s.provider);
  if (!adapter?.automatic) return "skipped";

  if (s.order_status === "cancelled") {
    await transition(db, s, { to: "cancelled", source: "system", actor, note: "order cancelled", set: { retryInMinutes: null } });
    return "skipped";
  }

  const claim = await db
    .prepare(
      `UPDATE shipments SET next_retry_at = datetime('now', ?), updated_at = datetime('now')
        WHERE id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))`,
    )
    .bind(`+${LEASE_MINUTES} minutes`, s.id)
    .run();
  if (!claim.meta.changes) return "skipped";

  const order: DeliveryOrder = {
    orderNo: s.order_no,
    // a re-send after a delivery failure (provider_ref already set) is a new parcel, so a new key
    idempotencyKey: s.provider_ref ? `shipment-${s.id}-after-${s.provider_ref}` : `shipment-${s.id}`,
    recipient: { name: s.name, phone: s.phone, phone2: s.phone2 || null },
    address: { city: s.city, district: s.district || null, khoroo: s.khoroo || null, line: s.address },
    itemsCount: itemsCount(s.items_json),
  };
  const attempts = s.attempts + 1;
  const lease = { ...s, status: "pending" as const };

  let failure: { code: string; retryable: boolean } | null = null;
  try {
    if (!adapter.configured(env)) throw new DeliveryError("not_configured", true);
    const r = await adapter.create(env, order);
    const to: ShipmentStatus = r.status === "picked_up" || r.status === "in_transit" ? r.status : "created";
    const res = await transition(db, lease, {
      to,
      source: "system",
      actor,
      note: "accepted by provider",
      set: { providerRef: r.providerRef, trackingNo: r.trackingNo ?? null, trackingUrl: r.trackingUrl ?? null, attempts, lastError: null, retryInMinutes: null },
      auditData: { attempts },
    });
    if (res.ok) return "created";
    if (res.reason === "stale") return "skipped";
    failure = { code: res.reason === "ref-conflict" ? "duplicate_ref" : res.reason, retryable: false };
  } catch (err) {
    failure = err instanceof DeliveryError ? { code: err.code, retryable: err.retryable } : { code: "internal", retryable: true };
    if (!(err instanceof DeliveryError)) console.error(`[delivery] shipment ${s.id}: adapter error`, (err as Error)?.name ?? "Error");
  }

  const retryIn = failure.retryable && attempts < MAX_ATTEMPTS ? backoffMinutes(attempts) : null;
  console.warn(`[delivery] shipment ${s.id} provider=${s.provider} create failed: ${failure.code} attempt=${attempts}${retryIn ? ` retry_in=${retryIn}m` : " no_retry"}`);
  await transition(db, lease, {
    to: "failed",
    source: "system",
    actor,
    note: `provider error ${failure.code}`,
    set: { attempts, lastError: failure.code, retryInMinutes: retryIn },
    auditData: { attempts, error: failure.code, retryInMinutes: retryIn },
  });
  return "failed";
}

/* ---------------- retry (one) ---------------- */

/** failed -> pending (system/admin), then the provider call for automatic providers. */
export async function retryShipment(env: Env, id: number, actor: Actor, source: EventSource): Promise<{ ok: true; outcome: DispatchOutcome | "pending" } | { ok: false; status: number; errors: Record<string, string> }> {
  const db = env.DB;
  const s = await loadShipment(db, id);
  if (!s) return { ok: false, status: 404, errors: { form: "notFound" } };
  const adapter = getAdapter(s.provider);
  if (s.status === "failed") {
    if (s.order_status === "cancelled") return { ok: false, status: 409, errors: { orderNo: "cancelled" } };
    const r = await transition(db, s, { to: "pending", source, actor, note: "retry", set: { retryInMinutes: null } });
    if (!r.ok) return { ok: false, status: 409, errors: { status: r.reason } };
  } else if (!(s.status === "pending" && adapter?.automatic)) {
    return { ok: false, status: 409, errors: { status: "not-retryable" } };
  }
  if (!adapter?.automatic) return { ok: true, outcome: "pending" };
  return { ok: true, outcome: await dispatch(env, id, actor) };
}

/* ---------------- admin PATCH ---------------- */

export interface PatchInput {
  status?: ShipmentStatus;
  trackingNo?: string | null;
  trackingUrl?: string | null;
  note?: string;
}

/**
 * Admin change: a status step (SHIPMENT_TRANSITIONS, with order side effects) and/or tracking fields / a note.
 * Meant for the manual provider; on an automatic provider it is an override, except `pending` (use /retry),
 * and `cancelled` first cancels at the provider.
 */
export async function patchShipment(env: Env, id: number, p: PatchInput, actor: Actor): Promise<{ ok: true } | { ok: false; status: number; errors: Record<string, string>; from?: string; to?: string }> {
  const db = env.DB;
  const s = await loadShipment(db, id);
  if (!s) return { ok: false, status: 404, errors: { form: "notFound" } };
  const adapter = getAdapter(s.provider);
  const set: TransitionInput["set"] = {};
  if (p.trackingNo !== undefined) set.trackingNo = p.trackingNo;
  if (p.trackingUrl !== undefined) set.trackingUrl = p.trackingUrl;

  if (p.status !== undefined && p.status !== s.status) {
    const to = p.status;
    if (!canShipmentTransition(s.status, to)) return { ok: false, status: 409, errors: { status: "transition" }, from: s.status, to };
    if (to === "pending" && adapter?.automatic) return { ok: false, status: 409, errors: { status: "use-retry" } };
    if (to === "cancelled" && adapter?.automatic && s.provider_ref && s.status !== "failed") {
      try {
        await adapter.cancel(env, s.provider_ref);
      } catch (err) {
        return { ok: false, status: 502, errors: { provider: err instanceof DeliveryError ? err.code : "internal" } };
      }
    }
    if (to === "pending" || to === "cancelled" || to === "failed") set.retryInMinutes = null;
    const r = await transition(db, s, { to, source: "admin", actor, note: p.note ?? null, set });
    if (!r.ok) return { ok: false, status: 409, errors: { status: r.reason } };
    return { ok: true };
  }

  // tracking / note only (status unchanged)
  const sets = ["updated_at = datetime('now')"];
  const args: (string | null)[] = [];
  if (set.trackingNo !== undefined) {
    sets.push("tracking_no = ?");
    args.push(set.trackingNo);
  }
  if (set.trackingUrl !== undefined) {
    sets.push("tracking_url = ?");
    args.push(set.trackingUrl);
  }
  try {
    await db.batch([
      db.prepare(`UPDATE shipments SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...args, s.id, s.status),
      db.prepare("UPDATE shipments SET status = '!stale' WHERE id = ? AND status <> ?").bind(s.id, s.status),
      db
        .prepare("INSERT INTO shipment_events (shipment_id, from_status, to_status, source, note) VALUES (?, ?, ?, 'admin', ?)")
        .bind(s.id, s.status, s.status, p.note ?? (set.trackingNo !== undefined || set.trackingUrl !== undefined ? "tracking updated" : null)),
      auditStatement(db, actor, "shipment.update", "shipment", s.id, {
        status: s.status,
        ...(set.trackingNo !== undefined ? { trackingNo: set.trackingNo } : {}),
        ...(set.trackingUrl !== undefined ? { trackingUrl: set.trackingUrl } : {}),
        ...(p.note ? { note: true } : {}),
      }),
    ]);
  } catch (e) {
    if (isGuardAbort(errText(e))) return { ok: false, status: 409, errors: { status: "stale" } };
    throw e;
  }
  return { ok: true };
}

/* ---------------- poll ---------------- */

/** Asks the provider for the current status and applies it when it is a valid next step. */
export async function refreshShipment(env: Env, s: ShipmentRow, actor: Actor): Promise<"updated" | "unchanged" | "unsupported" | { error: string }> {
  const adapter = getAdapter(s.provider);
  if (!adapter?.automatic || !s.provider_ref) return "unsupported";
  try {
    const r = await adapter.track(env, s.provider_ref);
    if (r.status === s.status || !canShipmentTransition(s.status, r.status) || r.status === "pending") return "unchanged";
    const res = await transition(env.DB, s, {
      to: r.status,
      source: "poll",
      actor,
      set: { ...(r.trackingNo ? { trackingNo: r.trackingNo } : {}), ...(r.trackingUrl ? { trackingUrl: r.trackingUrl } : {}) },
    });
    return res.ok ? "updated" : "unchanged";
  } catch (err) {
    return { error: err instanceof DeliveryError ? err.code : "internal" };
  }
}

/* ---------------- webhook events ---------------- */

export type EventResult = { eventId: string; result: "applied" | "ignored" | "duplicate" | "unknown-shipment" };

export async function applyProviderEvents(env: Env, adapter: DeliveryAdapter, events: import("./types").ProviderEvent[]): Promise<EventResult[]> {
  const db = env.DB;
  const out: EventResult[] = [];
  for (const ev of events) {
    let result: EventResult["result"] = "ignored";
    for (let round = 0; round < 3; round++) {
      const s = await loadShipmentByRef(db, adapter.id, ev.providerRef);
      if (!s) {
        result = "unknown-shipment";
        break;
      }
      const seen = await db.prepare("SELECT 1 AS x FROM shipment_events WHERE shipment_id = ? AND external_event_id = ?").bind(s.id, ev.eventId).first();
      if (seen) {
        result = "duplicate";
        break;
      }
      if (ev.status === s.status || !canShipmentTransition(s.status, ev.status)) {
        // out-of-order or invalid: keep a record (and the event id, so a replay is a duplicate), change nothing
        await db
          .prepare("INSERT OR IGNORE INTO shipment_events (shipment_id, from_status, to_status, source, external_event_id, note) VALUES (?, ?, ?, 'webhook', ?, ?)")
          .bind(s.id, s.status, s.status, ev.eventId, `ignored ${ev.status}`)
          .run();
        result = "ignored";
        break;
      }
      const res = await transition(db, s, {
        to: ev.status,
        source: "webhook",
        actor: "system",
        externalEventId: ev.eventId,
        set: {
          ...(ev.trackingNo ? { trackingNo: ev.trackingNo } : {}),
          ...(ev.trackingUrl ? { trackingUrl: ev.trackingUrl } : {}),
          ...(ev.status === "failed" ? { retryInMinutes: null } : {}),
        },
        auditData: { eventId: ev.eventId },
      });
      if (res.ok) {
        result = "applied";
        break;
      }
      if (res.reason === "duplicate") {
        result = "duplicate";
        break;
      }
      // stale: the shipment changed under us; re-read and decide again
    }
    out.push({ eventId: ev.eventId, result });
  }
  return out;
}
