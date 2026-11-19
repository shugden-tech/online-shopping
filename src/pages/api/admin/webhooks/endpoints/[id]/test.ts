// POST /api/admin/webhooks/endpoints/{id}/test  [settings.write]  (lead, 0004)
// Queues a signed `ping` event for this endpoint and sends it right away.
//   -> { ok, delivery: { id, status, httpStatus, error } }   (ok is true even when the endpoint answered badly)
import { auditStatement } from "../../../../../../lib/audit";
import { adminRoute } from "../../../../../../lib/catalog/route";
import { fail, json } from "../../../../../../lib/server";
import { deliverNow } from "../../../../../../lib/webhooks";

export const prerender = false;

export const POST = adminRoute("admin/webhook-test", "settings.write", async ({ params }, env, s) => {
  const id = params.id && /^[1-9]\d{0,9}$/.test(params.id) ? Number(params.id) : 0;
  const ep = id ? await env.DB.prepare("SELECT id FROM webhook_endpoints WHERE id = ?1").bind(id).first() : null;
  if (!ep) return fail(404, { form: "notFound" });
  const payload = JSON.stringify({ id: crypto.randomUUID(), event: "ping", createdAt: new Date().toISOString(), data: { message: "genzst test event" } });
  const [ins] = await env.DB.batch([
    env.DB.prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload_json, next_retry_at) VALUES (?1, 'ping', ?2, NULL) RETURNING id").bind(id, payload),
    auditStatement(env.DB, s.actor, "webhook.test", "webhook", id),
  ]);
  const deliveryId = (ins!.results?.[0] as { id: number }).id;
  const r = await deliverNow(env, deliveryId);
  const row = await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id = ?1").bind(deliveryId).first<{ status: string }>();
  return json(200, { ok: true, delivery: { id: deliveryId, status: row?.status ?? "pending", httpStatus: r?.status ?? 0, error: r?.error ?? null } });
});
