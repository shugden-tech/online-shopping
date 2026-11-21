// GET /api/admin/webhooks/deliveries?endpoint=&status=&cursor=&limit=  [settings.read]  (lead, 0004)
// Outbound delivery log, newest first, keyset: { ok, items, nextCursor }.
import { adminRoute } from "../../../../lib/catalog/route";
import { fail, json } from "../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/webhook-deliveries", "settings.read", async ({ url }, env) => {
  const endpoint = Number(url.searchParams.get("endpoint")) || 0;
  const status = url.searchParams.get("status") ?? "";
  if (status && !["pending", "delivered", "failed"].includes(status)) return fail(400, { status: "invalid" });
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const cursor = Number(url.searchParams.get("cursor")) || 0;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (endpoint) { where.push("d.endpoint_id = ?"); args.push(endpoint); }
  if (status) { where.push("d.status = ?"); args.push(status); }
  if (cursor) { where.push("d.id < ?"); args.push(cursor); }
  args.push(limit + 1);
  const res = await env.DB.prepare(
    `SELECT d.id, d.endpoint_id AS endpointId, e.url, d.event, d.payload_json AS payload, d.status, d.attempts,
            d.next_retry_at AS nextRetryAt, d.last_status AS lastStatus, d.last_error AS lastError,
            d.created_at AS createdAt, d.delivered_at AS deliveredAt
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.id DESC LIMIT ?`,
  ).bind(...args).all<{ id: number }>();
  const rows = res.results ?? [];
  const items = rows.slice(0, limit);
  return json(200, { ok: true, items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null });
});
