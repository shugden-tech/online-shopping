// GET /api/admin/payments?status=&provider=&limit=&cursor= [payments.read]
// Newest first, keyset paging: { ok, items, nextCursor }. Provider data (QR images) is not returned.
import type { APIRoute } from "astro";
import { authorize } from "../../../lib/auth";
import { PAYMENT_PROVIDERS, PAYMENT_STATUSES } from "../../../lib/contracts";
import type { PaymentRow } from "../../../lib/orders/types";
import { adminPaymentView } from "../../../lib/orders/view";
import { clientIp, fail, json } from "../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "payments.read");
    if (s instanceof Response) return s;

    const status = url.searchParams.get("status") ?? "";
    if (status && !(PAYMENT_STATUSES as readonly string[]).includes(status)) return fail(400, { status: "invalid" });
    const provider = url.searchParams.get("provider") ?? "";
    if (provider && !(PAYMENT_PROVIDERS as readonly string[]).includes(provider)) return fail(400, { provider: "invalid" });
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const cursor = Number(url.searchParams.get("cursor")) || 0;

    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status) { args.push(status); where.push(`p.status = ?${args.length}`); }
    if (provider) { args.push(provider); where.push(`p.provider = ?${args.length}`); }
    if (cursor > 0) { args.push(cursor); where.push(`p.id < ?${args.length}`); }
    args.push(limit + 1);
    const res = await env.DB.prepare(
      `SELECT p.id, p.order_id, o.order_no, p.provider, p.provider_ref, p.amount, p.status, p.paid_amount, p.provider_payment_id,
              p.created_at, p.updated_at, p.paid_at
         FROM payments p JOIN orders o ON o.id = p.order_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY p.id DESC LIMIT ?${args.length}`,
    )
      .bind(...args)
      .all<PaymentRow & { order_no: string }>();
    const rows = res.results ?? [];
    const page = rows.slice(0, limit);
    return json(200, { ok: true, items: page.map(adminPaymentView), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null });
  } catch (err) {
    console.error("[admin/payments] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET" });
