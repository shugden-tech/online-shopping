// POST /api/orders/lookup { orderNo, phone } — customer order tracking.
// Needs the order number AND the last 4–8 digits of the phone used on the order. Returns status and items
// only (no name, address or phone). Not found and wrong phone give the same 404. Rate limited per IP.
import type { APIRoute } from "astro";
import { clientIp, fail, hitRateLimit, json, ORDER_NO_RE, readJson, type OrderLine } from "../../../lib/server";

export const prerender = false;

const LIMIT = 10; // lookups per IP per 10 minutes

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const body = await readJson(request, 1024);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as { orderNo?: unknown; phone?: unknown };
    const orderNo = typeof v.orderNo === "string" ? v.orderNo.trim().toUpperCase() : "";
    const phone = typeof v.phone === "string" ? v.phone.replace(/\D/g, "") : "";
    if (!ORDER_NO_RE.test(orderNo) || phone.length < 4 || phone.length > 8) return fail(422, { form: "lookup" });

    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const ip = clientIp(request, () => clientAddress);
    if (!(await hitRateLimit(env.DB, `lookup:${ip}`, LIMIT, 600))) return fail(429, { form: "rate" });

    const row = await env.DB.prepare(
      "SELECT order_no, status, created_at, phone, items_json, subtotal, delivery, total FROM orders WHERE order_no = ?1",
    )
      .bind(orderNo)
      .first<{ order_no: string; status: string; created_at: string; phone: string; items_json: string; subtotal: number; delivery: number; total: number }>();
    if (!row || !row.phone.endsWith(phone)) return fail(404, { form: "notFound" });

    const items = (JSON.parse(row.items_json) as OrderLine[]).map(({ slug, brand, name, ml, qty, price }) => ({ slug, brand, name, ml, qty, price }));
    return json(200, {
      ok: true,
      orderNo: row.order_no,
      status: row.status,
      createdAt: row.created_at,
      items,
      subtotal: row.subtotal,
      delivery: row.delivery,
      total: row.total,
    });
  } catch (err) {
    console.error("[lookup] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
