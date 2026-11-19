// POST /api/admin/webhooks/inbound/{id}/replay  [delivery.write]  (lead, 0004) -> { ok, httpStatus, result }
// Re-applies a logged, signature-verified delivery webhook. Safe: events are de-duplicated by the provider
// event id, so an event that was already applied comes back as `duplicate`. Unsigned calls are never replayed (409).
import { auditStatement } from "../../../../../../lib/audit";
import { adminRoute } from "../../../../../../lib/catalog/route";
import { handleSigned } from "../../../../../../lib/delivery/inbound";
import { fail, json } from "../../../../../../lib/server";

export const prerender = false;

export const POST = adminRoute("admin/webhook-replay", "delivery.write", async ({ params }, env, s) => {
  const id = params.id && /^[1-9]\d{0,9}$/.test(params.id) ? Number(params.id) : 0;
  const row = id
    ? await env.DB.prepare("SELECT id, provider, signature_ok, payload FROM webhook_events WHERE id = ?1").bind(id)
        .first<{ id: number; provider: string; signature_ok: number; payload: string | null }>()
    : null;
  if (!row) return fail(404, { form: "notFound" });
  if (row.signature_ok !== 1 || !row.payload) return fail(409, { form: "unsigned" });
  const [res, result] = await handleSigned(env, row.provider, row.payload, new Headers({ "Content-Type": "application/json" }));
  await env.DB.batch([
    env.DB.prepare("UPDATE webhook_events SET replayed_at = datetime('now'), replay_count = replay_count + 1, result_json = ?2 WHERE id = ?1")
      .bind(id, JSON.stringify(result ?? null).slice(0, 4000)),
    auditStatement(env.DB, s.actor, "webhook.replay", "webhook", id, { httpStatus: res.status }),
  ]);
  return json(200, { ok: true, httpStatus: res.status, result });
});
