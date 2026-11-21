// POST /api/payments/wire/webhook — Wire event deliveries (CONTRACTS §11).
//   1. raw body (≤ 64 KB) + `WirePayment-Signature: t=…,v1=…` verified with WIRE_WEBHOOK_SECRET (HMAC-SHA256 over
//      "t.rawBody", |now − t| ≤ 300 s, constant time). Bad / stale / missing signature -> 400 (Wire drops it).
//   2. de-duplicated by event id in wire_events (INSERT OR IGNORE): a redelivery answers 200 and changes nothing.
//   3. payment_intent.* -> the intent is read back with GET /v1/payment_intents/{id} (the body is never trusted)
//      and applied with applyWireIntent (succeeded -> markPaid, exactly like the QPay callback).
//   4. 200 once accepted. If Wire cannot be reached to read the intent, the event row is removed again and the
//      answer is 503, so Wire retries the delivery later. endpoint.verification pings get 200.
// Wire sends JSON (Content-Type: application/json), so Astro's checkOrigin does not block it.
import type { APIRoute } from "astro";
import { auditStatement } from "../../../../lib/audit";
import type { OrderRow, PaymentRow } from "../../../../lib/orders/types";
import { applyWireIntent } from "../../../../lib/payments";
import { WIRE_SIGNATURE_HEADER, fetchWireIntent, parseWireEvent, verifyWireSignature, wireConfigured } from "../../../../lib/payments/wire";
import { json } from "../../../../lib/server";

export const prerender = false;

const MAX_BODY = 64 * 1024;

const out = (status: number, body: Record<string, unknown>) => json(status, body);

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  if (!env?.DB) return out(503, { ok: false, errors: { form: "server" } });
  // not set up yet: 503 so Wire keeps retrying until the owner has stored the secret
  if (!env.WIRE_WEBHOOK_SECRET) return out(503, { ok: false, errors: { wire: "not-configured" } });
  const len = Number(request.headers.get("Content-Length") ?? 0);
  if (len > MAX_BODY) return out(413, { ok: false, errors: { form: "tooLarge" } });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return out(413, { ok: false, errors: { form: "tooLarge" } });

  const sig = await verifyWireSignature(env.WIRE_WEBHOOK_SECRET, request.headers.get(WIRE_SIGNATURE_HEADER), raw);
  if (!sig.ok) return out(400, { ok: false, errors: { signature: sig.reason } });
  // the verification ping is answered 2xx whatever its id looks like (it changes nothing)
  if (/"type"\s*:\s*"endpoint\.verification"/.test(raw)) return out(200, { ok: true, result: "verified" });
  const event = parseWireEvent(raw);
  if (!event) return out(400, { ok: false, errors: { form: "invalid" } });

  const db = env.DB;
  const claim = await db
    .prepare("INSERT OR IGNORE INTO wire_events (id, type, object_id) VALUES (?1, ?2, ?3)")
    .bind(event.id, event.type, event.objectId ? event.objectId.slice(0, 80) : null)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return out(200, { ok: true, duplicate: true });

  let result: string;
  try {
    result = await handle(env, event);
  } catch (err) {
    console.error(`[wire-webhook] ${event.id} ${event.type}:`, String((err as Error)?.message ?? err));
    await db.prepare("DELETE FROM wire_events WHERE id = ?1").bind(event.id).run().catch(() => {});
    return out(503, { ok: false, errors: { wire: "retry" } });
  }
  await db.prepare("UPDATE wire_events SET result = ?2 WHERE id = ?1").bind(event.id, result).run().catch(() => {});
  return out(200, { ok: true, result });
};

async function handle(env: Env, event: NonNullable<ReturnType<typeof parseWireEvent>>): Promise<string> {
  const db = env.DB;
  if (event.type === "charge.refunded") {
    // a refund done in the Wire dashboard: kept on record for the owner (CONTRACTS §11, refund TODO)
    const row = event.charge
      ? await db.prepare("SELECT id, order_id FROM payments WHERE provider = 'wire' AND provider_payment_id = ?1").bind(event.charge).first<{ id: number; order_id: number }>()
      : null;
    await db.batch([
      auditStatement(db, "system", "payment.refund_event", "payment", row?.id ?? null, {
        provider: "wire", eventId: event.id, refundId: event.objectId, charge: event.charge, amount: event.amount,
      }),
    ]);
    return row ? "refund_recorded" : "unknown";
  }
  if (!event.type.startsWith("payment_intent.")) return "ignored";
  if (!event.intentId) return "ignored";
  const row = await db.prepare("SELECT * FROM payments WHERE provider = 'wire' AND provider_ref = ?1").bind(event.intentId).first<PaymentRow>();
  if (!row) return "unknown"; // not one of ours (another integration on the same Wire project)
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?1").bind(row.order_id).first<OrderRow>();
  if (!order) return "unknown";
  if (!wireConfigured(env)) throw new Error("WIRE_API_KEY missing: cannot read the intent back");
  const intent = await fetchWireIntent(env, event.intentId); // never trust the body
  const r = await applyWireIntent(env, order, row, intent, "system", event.type === "payment_intent.payment_failed");
  console.log(`[wire-webhook] ${order.order_no} ${event.type} -> ${r}`);
  return r;
}

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
