// PATCH  /api/admin/webhooks/endpoints/{id} { url?, events?, description?, active? }  [settings.write] -> { ok, endpoint }
// DELETE /api/admin/webhooks/endpoints/{id}  [settings.write] -> { ok }   (its delivery log goes with it)
// Lead, 0004.
import { auditStatement } from "../../../../../lib/audit";
import { adminRoute } from "../../../../../lib/catalog/route";
import { fail, json, readJson } from "../../../../../lib/server";
import { endpointView, parseEndpointInput, type EndpointRow } from "../../../../../lib/webhook-admin";

export const prerender = false;
const idOf = (v: string | undefined) => (v && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : 0);

export const PATCH = adminRoute("admin/webhook", "settings.write", async ({ request, params }, env, s) => {
  const id = idOf(params.id);
  if (!id) return fail(404, { form: "notFound" });
  const body = await readJson(request, 4096);
  if (body instanceof Response) return body;
  const v = parseEndpointInput(body.value, false, env.WEBHOOK_ALLOW_LOCAL === "1");
  if ("errors" in v) return fail(400, v.errors);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (v.url !== undefined) { sets.push("url = ?"); args.push(v.url); }
  if (v.events !== undefined) { sets.push("events_json = ?"); args.push(JSON.stringify(v.events)); }
  if (v.description !== undefined) { sets.push("description = ?"); args.push(v.description); }
  if (v.active !== undefined) { sets.push("active = ?"); args.push(v.active ? 1 : 0); }
  const [upd] = await env.DB.batch([
    env.DB.prepare(`UPDATE webhook_endpoints SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?
                    RETURNING id, url, description, events_json, active, created_at, updated_at`).bind(...args, id),
    auditStatement(env.DB, s.actor, "webhook.update", "webhook", id, v),
  ]);
  const row = upd!.results?.[0] as EndpointRow | undefined;
  if (!row) return fail(404, { form: "notFound" });
  return json(200, { ok: true, endpoint: endpointView(row) });
});

export const DELETE = adminRoute("admin/webhook", "settings.write", async ({ params }, env, s) => {
  const id = idOf(params.id);
  if (!id) return fail(404, { form: "notFound" });
  const [del] = await env.DB.batch([
    env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?1").bind(id),
    auditStatement(env.DB, s.actor, "webhook.delete", "webhook", id),
  ]);
  if (!del!.meta.changes) return fail(404, { form: "notFound" });
  return json(200, { ok: true });
});
