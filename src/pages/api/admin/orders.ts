// GET /api/admin/orders?status=new&limit=50&cursor=<id> — newest first, keyset paging (`nextCursor`).
// Auth: Authorization: Bearer <ADMIN_TOKEN>.
import type { APIRoute } from "astro";
import { clientIp, fail, json, requireAdmin, STATUSES } from "../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;

    const status = url.searchParams.get("status") ?? "";
    if (status && !(STATUSES as readonly string[]).includes(status)) return fail(400, { status: "invalid" });
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const cursor = Number(url.searchParams.get("cursor")) || 0;

    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status) { args.push(status); where.push(`status = ?${args.length}`); }
    if (cursor > 0) { args.push(cursor); where.push(`id < ?${args.length}`); }
    args.push(limit + 1);
    const res = await env.DB.prepare(
      `SELECT id, order_no, created_at, updated_at, status, name, phone, phone2, city, district, khoroo, address, note,
              payment, items_json, subtotal, delivery, total, locale
         FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY id DESC LIMIT ?${args.length}`,
    )
      .bind(...args)
      .all<Record<string, unknown> & { id: number; items_json: string }>();
    const rows = res.results ?? [];
    const page = rows.slice(0, limit);
    const orders = page.map(({ items_json, ...r }) => ({ ...r, items: JSON.parse(items_json) }));
    return json(200, { ok: true, orders, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null });
  } catch (err) {
    console.error("[admin/orders] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET" });
