// GET  /api/admin/webhooks/endpoints  [settings.read]  -> { ok, items: Endpoint[], events }   (secret never returned)
// POST /api/admin/webhooks/endpoints { url, events[], description? }  [settings.write]
//   -> 201 { ok, endpoint, secret }   the secret is shown ONCE (HMAC-SHA256 key for X-Genzst-Signature)
// Lead, 0004. Contract: docs/CONTRACTS.md §8.
import { auditStatement } from "../../../../lib/audit";
import { adminRoute } from "../../../../lib/catalog/route";
import { WEBHOOK_EVENTS } from "../../../../lib/contracts";
import { fail, json, readJson } from "../../../../lib/server";
import { endpointView, parseEndpointInput, type EndpointRow } from "../../../../lib/webhook-admin";
import { newSecret } from "../../../../lib/webhooks";

export const prerender = false;

export const GET = adminRoute("admin/webhooks", "settings.read", async (_ctx, env) => {
  const res = await env.DB.prepare(
    `SELECT e.id, e.url, e.description, e.events_json, e.active, e.created_at, e.updated_at,
            (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed') AS failed,
            (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'pending') AS pending,
            (SELECT MAX(delivered_at) FROM webhook_deliveries d WHERE d.endpoint_id = e.id) AS last_delivered_at
       FROM webhook_endpoints e ORDER BY e.id`,
  ).all<EndpointRow>();
  return json(200, { ok: true, items: (res.results ?? []).map(endpointView), events: WEBHOOK_EVENTS });
});

export const POST = adminRoute("admin/webhooks", "settings.write", async ({ request }, env, s) => {
  const body = await readJson(request, 4096);
  if (body instanceof Response) return body;
  const v = parseEndpointInput(body.value, true, env.WEBHOOK_ALLOW_LOCAL === "1");
  if ("errors" in v) return fail(400, v.errors);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return fail(409, { form: "limit" });
  const secret = newSecret();
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO webhook_endpoints (url, description, events_json, secret, active) VALUES (?1, ?2, ?3, ?4, ?5)
       RETURNING id, url, description, events_json, active, created_at, updated_at`,
    ).bind(v.url!, v.description ?? null, JSON.stringify(v.events), secret, v.active === false ? 0 : 1),
    auditStatement(env.DB, s.actor, "webhook.create", "webhook", null, { url: v.url, events: v.events }),
  ]);
  const row = ins!.results?.[0] as EndpointRow;
  return json(201, { ok: true, endpoint: endpointView(row), secret });
});
