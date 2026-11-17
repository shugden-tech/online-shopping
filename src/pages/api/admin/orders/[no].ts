// GET   /api/admin/orders/:no [orders.read] -> { ok, order: { ...order fields, items, events[], payments[], reservations[], shipments[] } }
// PATCH /api/admin/orders/:no { status, note? } [orders.write; `paid` also needs payments.write]
//   Transitions follow ORDER_TRANSITIONS. cancelled before paid releases held stock; after paid restores stock
//   (movement cancel_after_paid). paid commits the reservations (as a manual payment of the order total).
import type { APIRoute } from "astro";
import { authorize } from "../../../../lib/auth";
import { ORDER_STATUSES, canOrderTransition, type OrderStatus } from "../../../../lib/contracts";
import { transitionOrder } from "../../../../lib/orders/state";
import { ORDER_NO_RE, loadOrder, normOrderNo, type PaymentRow } from "../../../../lib/orders/types";
import { adminOrderView, adminPaymentView } from "../../../../lib/orders/view";
import { markPaid } from "../../../../lib/payments";
import { clientIp, fail, json, readJson } from "../../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "orders.read");
    if (s instanceof Response) return s;
    const no = normOrderNo(params.no);
    if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });
    const order = await loadOrder(env.DB, no);
    if (!order) return fail(404, { form: "notFound" });
    const [events, reservations, payments, shipments] = await env.DB.batch([
      env.DB.prepare("SELECT at, from_status AS fromStatus, to_status AS toStatus, actor, note FROM order_events WHERE order_id = ?1 ORDER BY id").bind(order.id),
      env.DB.prepare("SELECT sku_id AS skuId, qty, tracked, status, created_at AS createdAt, updated_at AS updatedAt FROM reservations WHERE order_id = ?1 ORDER BY id").bind(order.id),
      env.DB.prepare(
        "SELECT id, order_id, provider, provider_ref, amount, status, paid_amount, provider_payment_id, created_at, updated_at, paid_at FROM payments WHERE order_id = ?1 ORDER BY id",
      ).bind(order.id),
      env.DB.prepare(
        "SELECT id, provider, tracking_no AS trackingNo, tracking_url AS trackingUrl, status, created_at AS createdAt, updated_at AS updatedAt FROM shipments WHERE order_id = ?1 ORDER BY id",
      ).bind(order.id),
    ]);
    return json(200, {
      ok: true,
      order: {
        ...adminOrderView(order),
        events: events!.results ?? [],
        payments: ((payments!.results ?? []) as PaymentRow[]).map(adminPaymentView),
        reservations: ((reservations!.results ?? []) as { tracked: number }[]).map((r) => ({ ...r, tracked: r.tracked === 1 })),
        shipments: shipments!.results ?? [],
      },
    });
  } catch (err) {
    console.error("[admin/order] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const PATCH: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "orders.write");
    if (s instanceof Response) return s;
    const no = normOrderNo(params.no);
    if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });

    const body = await readJson(request, 4096);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as { status?: unknown; note?: unknown };
    const to = typeof v.status === "string" ? v.status : "";
    const note = typeof v.note === "string" ? v.note.trim().slice(0, 300) || null : null;
    if (!(ORDER_STATUSES as readonly string[]).includes(to)) return fail(422, { status: "invalid" });
    if (to === "paid" && !s.can("payments.write")) return fail(403, { form: "forbidden" });

    const order = await loadOrder(env.DB, no);
    if (!order) return fail(404, { form: "notFound" });
    const from = order.status;
    if (!canOrderTransition(from, to)) return json(409, { ok: false, errors: { status: "transition" }, from, to });

    if (to === "paid") {
      const r = await markPaid(env, order, { provider: order.payment, amount: order.total, ref: null, note: note ?? "marked paid by admin" }, s.actor);
      if (r !== "paid") return json(409, { ok: false, errors: { status: r === "transition" ? "transition" : "conflict" }, from, to, result: r });
    } else {
      const r = await transitionOrder(env.DB, order, to as OrderStatus, s.actor, { note, reason: to === "cancelled" ? "admin" : null });
      if (!r.ok) return json(409, { ok: false, errors: { status: r.code }, from, to });
    }
    const updated = await loadOrder(env.DB, no);
    return json(200, { ok: true, from, to, order: updated ? adminOrderView(updated) : null });
  } catch (err) {
    console.error("[admin/order] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET, PATCH" });
