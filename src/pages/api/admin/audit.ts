// GET /api/admin/audit?entity=&entityId=&cursor=&limit= -> { ok, items, nextCursor }  (audit.read). Lead-owned.
import type { APIRoute } from "astro";
import { authorize } from "../../../lib/auth";
import { clientIp, fail, json } from "../../../lib/server";

export const prerender = false;
const ENTITIES = new Set(["product", "sku", "order", "payment", "shipment", "settings", "media"]);

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "audit.read");
    if (s instanceof Response) return s;
    const entity = url.searchParams.get("entity") ?? "";
    const entityId = url.searchParams.get("entityId") ?? "";
    if (entity && !ENTITIES.has(entity)) return fail(400, { entity: "invalid" });
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (entity) { args.push(entity); where.push(`entity = ?${args.length}`); }
    if (entityId) { args.push(entityId.slice(0, 200)); where.push(`entity_id = ?${args.length}`); }
    if (cursor > 0) { args.push(cursor); where.push(`id < ?${args.length}`); }
    args.push(limit + 1);
    const res = await env.DB.prepare(
      `SELECT id, at, actor, action, entity, entity_id AS entityId, data_json FROM audit_log
        ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?${args.length}`,
    ).bind(...args).all<{ id: number; data_json: string | null } & Record<string, unknown>>();
    const rows = res.results ?? [];
    const page = rows.slice(0, limit).map(({ data_json, ...r }) => ({ ...r, data: data_json ? JSON.parse(data_json) : null }));
    return json(200, { ok: true, items: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null });
  } catch (err) {
    console.error("[admin/audit]", err);
    return fail(500, { form: "server" });
  }
};
