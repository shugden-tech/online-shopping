// POST /api/delivery/webhook/{provider}   (public; called by the delivery company)
// Header X-Signature = hex HMAC-SHA256(DELIVERY_WEBHOOK_SECRET, raw body). Content-Type: application/json.
//   200 { ok, results: [{ eventId, result: applied|ignored|duplicate }] }
//   401 bad signature · 404 unknown provider or shipment · 400 bad payload · 503 secret not configured
// De-duplicated by the provider's event id (unique index on shipment_events). Out-of-order or invalid
// status steps are recorded as `ignored` (200), never as errors. A3-owned; every call is logged to
// webhook_events (0004) for the admin Webhook log (payload, result, replay).
import type { APIRoute } from "astro";
import { getAdapter } from "../../../../lib/delivery/registry";
import { handleSigned } from "../../../../lib/delivery/inbound";
import { verifySignature, WEBHOOK_SECRET_MIN } from "../../../../lib/delivery/signature";
import { clientIp, fail, hitRateLimit, json } from "../../../../lib/server";
import { logInbound } from "../../../../lib/webhooks";

export const prerender = false;
const MAX_BYTES = 64 * 1024;

export const POST: APIRoute = async ({ request, locals, clientAddress, params }) => {
  const env = locals.runtime?.env;
  const provider = String(params.provider ?? "").slice(0, 40);
  let raw = "";
  let sigOk = false;
  let eventIds: string[] = [];
  const log = async (res: Response, result: unknown) => {
    // never let logging break the provider's response
    try {
      if (env?.DB) await logInbound(env.DB, { provider, signatureOk: sigOk, httpStatus: res.status, eventIds, result, payload: raw }).run();
    } catch (err) {
      console.error("[delivery/webhook] log failed", (err as Error)?.message ?? err);
    }
    return res;
  };
  try {
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const adapter = getAdapter(provider);
    if (!adapter?.automatic) return log(fail(404, { provider: "unknown" }), { error: "unknown-provider" });
    const secret = env.DELIVERY_WEBHOOK_SECRET ?? "";
    if (secret.length < WEBHOOK_SECRET_MIN) {
      console.error("[delivery/webhook] DELIVERY_WEBHOOK_SECRET is not set");
      return log(fail(503, { form: "disabled" }), { error: "secret-not-set" });
    }
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) return log(fail(413, { form: "server" }), { error: "too-large" });
    raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BYTES) {
      raw = raw.slice(0, 1024);
      return log(fail(413, { form: "server" }), { error: "too-large" });
    }

    if (!(await verifySignature(secret, raw, request.headers.get("X-Signature")))) {
      const ip = clientIp(request, () => clientAddress);
      if (!(await hitRateLimit(env.DB, `delivery-webhook-fail:${ip}`, 30, 600))) return fail(429, { form: "rate" });
      raw = raw.slice(0, 2048); // unsigned bodies are kept short
      return log(fail(401, { signature: "invalid" }), { error: "bad-signature" });
    }
    sigOk = true;
    return log(...(await handleSigned(env, provider, raw, request.headers, (ids) => (eventIds = ids))));
  } catch (err) {
    console.error("[delivery/webhook]", (err as Error)?.message ?? err);
    return log(fail(500, { form: "server" }), { error: "server" });
  }
};
