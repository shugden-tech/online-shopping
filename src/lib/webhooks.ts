// Outbound webhooks (lead, 0004): the owner's own integrations (Telegram bots, Make, Zapier, …).
//
// Outbox pattern: emitStatement() is a prepared INSERT that goes IN THE SAME D1 BATCH as the change that
// caused the event, so an event exists exactly when the change happened. deliverDue() sends what is due:
//   POST <endpoint url>   Content-Type: application/json
//   X-Genzst-Event: order.paid
//   X-Genzst-Delivery: <delivery id>
//   X-Genzst-Timestamp: <unix seconds>
//   X-Genzst-Signature: sha256=<hex HMAC-SHA256(endpoint secret, "<timestamp>.<raw body>")>
// 2xx = delivered. Anything else is retried with the delivery module's backoff (2^n min, ≤ 6 h), 8 attempts.
// Payloads carry order numbers, statuses, totals and SKUs — never names, phones or addresses.
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./contracts";
import { hmacHex } from "./delivery/signature";

type D1 = Env["DB"];

export const WEBHOOK_TIMEOUT_MS = 8000;
// same policy as the delivery retry job (src/lib/delivery/service.ts), kept here to avoid an import cycle
const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 360);
export const isWebhookEvent = (e: string): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e);

/** A new random endpoint secret (shown to the owner once). */
export function newSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "whsec_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `https://…` only, no credentials, ≤ 500 chars. `allowLocal` (dev only, WEBHOOK_ALLOW_LOCAL=1) also takes http://127.0.0.1:port for tests. */
export function validEndpointUrl(u: unknown, allowLocal = false): u is string {
  if (typeof u !== "string" || u.length > 500) return false;
  try {
    const url = new URL(u);
    if (allowLocal && url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname) && !/^(localhost|127\.|10\.|192\.168\.|0\.)/.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Prepared INSERT of one delivery per active endpoint subscribed to `event`. Put it in the caller's batch.
 * With `orderId`, `data.orderNo` is filled in by SQL from that order.
 */
export function emitStatement(db: D1, event: WebhookEvent, data: Record<string, unknown>, orderId?: number): D1PreparedStatement {
  const payload = JSON.stringify({ id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data });
  const body = orderId === undefined ? "?2" : "json_set(?2, '$.data.orderNo', (SELECT order_no FROM orders WHERE id = ?3))";
  const stmt = db.prepare(
    `INSERT INTO webhook_deliveries (endpoint_id, event, payload_json)
     SELECT e.id, ?1, ${body} FROM webhook_endpoints e
      WHERE e.active = 1 AND EXISTS (SELECT 1 FROM json_each(e.events_json) WHERE value = ?1)`,
  );
  return orderId === undefined ? stmt.bind(event, payload) : stmt.bind(event, payload, orderId);
}

interface DueRow { id: number; endpoint_id: number; event: string; payload_json: string; attempts: number; url: string; secret: string }

/** Sends one delivery now. Returns the HTTP status (0 = network error / timeout) and a short error code. */
export async function send(url: string, secret: string, deliveryId: number, event: string, body: string): Promise<{ status: number; error: string | null }> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, `${ts}.${body}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "genzst-webhooks/1",
        "X-Genzst-Event": event,
        "X-Genzst-Delivery": String(deliveryId),
        "X-Genzst-Timestamp": ts,
        "X-Genzst-Signature": `sha256=${sig}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { status: res.status, error: res.ok ? null : `http_${res.status}` };
  } catch (err) {
    const name = (err as Error)?.name ?? "Error";
    return { status: 0, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

/** Records the outcome of one attempt (backoff / give up after MAX_ATTEMPTS). */
function resultStatement(db: D1, row: Pick<DueRow, "id" | "attempts">, r: { status: number; error: string | null }) {
  const attempts = row.attempts + 1;
  if (!r.error) {
    return db
      .prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?2, last_status = ?3, last_error = NULL, next_retry_at = NULL, delivered_at = datetime('now') WHERE id = ?1")
      .bind(row.id, attempts, r.status);
  }
  if (attempts >= MAX_ATTEMPTS) {
    return db
      .prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?2, last_status = ?3, last_error = ?4, next_retry_at = NULL WHERE id = ?1")
      .bind(row.id, attempts, r.status || null, r.error);
  }
  return db
    .prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = ?2, last_status = ?3, last_error = ?4, next_retry_at = datetime('now', ?5) WHERE id = ?1")
    .bind(row.id, attempts, r.status || null, r.error, `+${backoffMinutes(attempts)} minutes`);
}

/**
 * Sends due deliveries (pending, next_retry_at passed, endpoint active). Each row is leased for 2 minutes
 * first, so two concurrent runs never send the same delivery twice at once. Bounded and safe to call often.
 */
export async function deliverDue(env: Env, limit = 20): Promise<{ delivered: number; failed: number }> {
  const db = env.DB;
  const due = await db
    .prepare(
      `SELECT d.id, d.endpoint_id, d.event, d.payload_json, d.attempts, e.url, e.secret
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= datetime('now') AND e.active = 1
        ORDER BY d.next_retry_at, d.id LIMIT ?1`,
    )
    .bind(Math.min(100, Math.max(1, limit)))
    .all<DueRow>();
  let delivered = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    const lease = await db
      .prepare("UPDATE webhook_deliveries SET next_retry_at = datetime('now', '+2 minutes') WHERE id = ?1 AND status = 'pending' AND next_retry_at <= datetime('now')")
      .bind(row.id)
      .run();
    if (!lease.meta.changes) continue;
    const r = await send(row.url, row.secret, row.id, row.event, row.payload_json);
    await resultStatement(db, row, r).run();
    if (r.error) failed++;
    else delivered++;
  }
  return { delivered, failed };
}

/** Sends one delivery right away (admin "send test" / "retry"), whatever its status. */
export async function deliverNow(env: Env, deliveryId: number): Promise<{ status: number; error: string | null } | null> {
  const row = await env.DB
    .prepare(
      `SELECT d.id, d.endpoint_id, d.event, d.payload_json, d.attempts, e.url, e.secret
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = ?1`,
    )
    .bind(deliveryId)
    .first<DueRow>();
  if (!row) return null;
  const r = await send(row.url, row.secret, row.id, row.event, row.payload_json);
  await resultStatement(env.DB, row, r).run();
  return r;
}

/* ---------------- inbound log (delivery company webhooks) ---------------- */

export const INBOUND_PAYLOAD_MAX = 16 * 1024;

export function logInbound(
  db: D1,
  e: { provider: string; signatureOk: boolean; httpStatus: number; eventIds?: string[]; result: unknown; payload: string },
) {
  return db
    .prepare("INSERT INTO webhook_events (provider, signature_ok, http_status, event_ids, result_json, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(
      e.provider.slice(0, 40),
      e.signatureOk ? 1 : 0,
      e.httpStatus,
      e.eventIds?.length ? e.eventIds.join(",").slice(0, 1000) : null,
      JSON.stringify(e.result ?? null).slice(0, 4000),
      e.payload.slice(0, INBOUND_PAYLOAD_MAX),
    );
}

/** Old log rows and finished deliveries are pruned after 90 days (called by jobs/run). */
export function pruneStatements(db: D1) {
  return [
    db.prepare("DELETE FROM webhook_events WHERE received_at < datetime('now', '-90 days')"),
    db.prepare("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < datetime('now', '-90 days')"),
  ];
}
