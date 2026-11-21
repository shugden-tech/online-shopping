// GET /api/admin/webhooks/inbound?provider=&cursor=&limit=  [delivery.read]  (lead, 0004)
// Log of every call to /api/delivery/webhook/{provider}: { ok, items, nextCursor }.
import { adminRoute } from "../../../../lib/catalog/route";
import { json } from "../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/webhook-inbound", "delivery.read", async ({ url }, env) => {
  const provider = (url.searchParams.get("provider") ?? "").slice(0, 40);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const cursor = Number(url.searchParams.get("cursor")) || 0;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (provider) { where.push("provider = ?"); args.push(provider); }
  if (cursor) { where.push("id < ?"); args.push(cursor); }
  args.push(limit + 1);
  const res = await env.DB.prepare(
    `SELECT id, received_at AS receivedAt, provider, signature_ok AS signatureOk, http_status AS httpStatus, event_ids AS eventIds,
            result_json AS result, payload, replayed_at AS replayedAt, replay_count AS replayCount
       FROM webhook_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
  ).bind(...args).all<{ id: number; signatureOk: number }>();
  const rows = res.results ?? [];
  const items = rows.slice(0, limit).map((r) => ({ ...r, signatureOk: r.signatureOk === 1 }));
  return json(200, { ok: true, items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null });
});
