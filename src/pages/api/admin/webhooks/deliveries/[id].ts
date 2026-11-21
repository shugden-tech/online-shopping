// POST /api/admin/webhooks/deliveries/{id}  [settings.write]  (lead, 0004) -> { ok, delivery: { id, status, httpStatus, error } }
// Sends one logged delivery again right away (a failed one gets a fresh set of attempts).
import { auditStatement } from "../../../../../lib/audit";
import { adminRoute } from "../../../../../lib/catalog/route";
import { fail, json } from "../../../../../lib/server";
import { deliverNow } from "../../../../../lib/webhooks";

export const prerender = false;

export const POST = adminRoute("admin/webhook-redeliver", "settings.write", async ({ params }, env, s) => {
  const id = params.id && /^[1-9]\d{0,9}$/.test(params.id) ? Number(params.id) : 0;
  if (!id) return fail(404, { form: "notFound" });
  const [reset] = await env.DB.batch([
    env.DB.prepare("UPDATE webhook_deliveries SET attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END WHERE id = ?1").bind(id),
    auditStatement(env.DB, s.actor, "webhook.redeliver", "webhook", id),
  ]);
  if (!reset!.meta.changes) return fail(404, { form: "notFound" });
  const r = await deliverNow(env, id);
  const row = await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id = ?1").bind(id).first<{ status: string }>();
  return json(200, { ok: true, delivery: { id, status: row?.status ?? "pending", httpStatus: r?.status ?? 0, error: r?.error ?? null } });
});
