// GET /api/admin/orders?status=&paymentStatus=&q=&limit=&cursor= [orders.read]
// Newest first, keyset paging: { ok, items, nextCursor }. Items include paymentStatus and holdExpiresAt.
// q matches part of the order number, phone or name.
import type { APIRoute } from "astro";
import { authorize } from "../../../lib/auth";
import { ORDER_STATUSES, PAYMENT_STATUSES_ORDER } from "../../../lib/contracts";
import type { OrderRow } from "../../../lib/orders/types";
import { adminOrderView } from "../../../lib/orders/view";
import { clientIp, fail, json } from "../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "orders.read");
    if (s instanceof Response) return s;

    const status = url.searchParams.get("status") ?? "";
    if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) return fail(400, { status: "invalid" });
    const pstatus = url.searchParams.get("paymentStatus") ?? "";
    if (pstatus && !(PAYMENT_STATUSES_ORDER as readonly string[]).includes(pstatus)) return fail(400, { paymentStatus: "invalid" });
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const cursor = Number(url.searchParams.get("cursor")) || 0;

    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status) { args.push(status); where.push(`status = ?${args.length}`); }
    if (pstatus) { args.push(pstatus); where.push(`payment_status = ?${args.length}`); }
    if (q) {
      args.push(q.toUpperCase(), q, q.toLowerCase());
      const n = args.length;
      where.push(`(instr(order_no, ?${n - 2}) > 0 OR instr(phone, ?${n - 1}) > 0 OR instr(lower(name), ?${n}) > 0)`);
    }
    if (cursor > 0) { args.push(cursor); where.push(`id < ?${args.length}`); }
    args.push(limit + 1);
    const res = await env.DB.prepare(
      `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?${args.length}`,
    )
      .bind(...args)
      .all<OrderRow>();
    const rows = res.results ?? [];
    const page = rows.slice(0, limit);
    return json(200, { ok: true, items: page.map(adminOrderView), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null });
  } catch (err) {
    console.error("[admin/orders] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET" });
