// POST /api/delivery/webhook/{provider}   (public; called by the delivery company)
// Header X-Signature = hex HMAC-SHA256(DELIVERY_WEBHOOK_SECRET, raw body). Content-Type: application/json.
//   200 { ok, results: [{ eventId, result: applied|ignored|duplicate }] }
//   401 bad signature · 404 unknown provider or shipment · 400 bad payload · 503 secret not configured
// De-duplicated by the provider's event id (unique index on shipment_events). Out-of-order or invalid
// status steps are recorded as `ignored` (200), never as errors. A3-owned.
import type { APIRoute } from "astro";
import { getAdapter } from "../../../../lib/delivery/registry";
import { applyProviderEvents } from "../../../../lib/delivery/service";
import { verifySignature, WEBHOOK_SECRET_MIN } from "../../../../lib/delivery/signature";
import { DeliveryError } from "../../../../lib/delivery/types";
import { clientIp, fail, hitRateLimit, json } from "../../../../lib/server";

export const prerender = false;
const MAX_BYTES = 64 * 1024;

export const POST: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const adapter = getAdapter(String(params.provider ?? ""));
    if (!adapter?.automatic) return fail(404, { provider: "unknown" });
    const secret = env.DELIVERY_WEBHOOK_SECRET ?? "";
    if (secret.length < WEBHOOK_SECRET_MIN) {
      console.error("[delivery/webhook] DELIVERY_WEBHOOK_SECRET is not set");
      return fail(503, { form: "disabled" });
    }
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) return fail(413, { form: "server" });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BYTES) return fail(413, { form: "server" });

    if (!(await verifySignature(secret, raw, request.headers.get("X-Signature")))) {
      const ip = clientIp(request, () => clientAddress);
      if (!(await hitRateLimit(env.DB, `delivery-webhook-fail:${ip}`, 30, 600))) return fail(429, { form: "rate" });
      return fail(401, { signature: "invalid" });
    }

    let events;
    try {
      events = adapter.parseWebhook(raw, request.headers);
    } catch (err) {
      if (err instanceof DeliveryError) return fail(400, { form: err.code });
      throw err;
    }
    const results = await applyProviderEvents(env, adapter, events);
    const unknown = results.filter((r) => r.result === "unknown-shipment");
    if (unknown.length) {
      console.warn(`[delivery/webhook] ${adapter.id}: ${unknown.length} event(s) for unknown shipments`);
      return json(404, { ok: false, errors: { shipment: "unknown" }, results });
    }
    return json(200, { ok: true, results });
  } catch (err) {
    console.error("[delivery/webhook]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};
