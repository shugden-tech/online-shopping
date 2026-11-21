// POST /api/admin/orders/:no/mark-paid { amount, reference? } [payments.write]
// Bank transfer confirmed by the owner. Creates / updates a `bank` payment row; when the amount covers the order
// total the order becomes paid and its reservations are committed (one batch). Less than the total keeps the
// payment pending. Idempotent: the same reference again changes nothing. A reference already used for another
// order -> 409 { reference: "duplicate" }.
import type { APIRoute } from "astro";
import { authorize } from "../../../../../lib/auth";
import { ORDER_NO_RE, loadOrder, normOrderNo } from "../../../../../lib/orders/types";
import { adminOrderView } from "../../../../../lib/orders/view";
import { markPaid } from "../../../../../lib/payments";
import { clientIp, fail, json, readJson } from "../../../../../lib/server";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "payments.write");
    if (s instanceof Response) return s;
    const no = normOrderNo(params.no);
    if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });

    const body = await readJson(request, 2048);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as { amount?: unknown; reference?: unknown };
    const errors: Record<string, string> = {};
    const amount = v.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000_000) errors.amount = "invalid";
    const reference = typeof v.reference === "string" ? v.reference.trim() : v.reference == null ? "" : null;
    if (reference === null || reference.length > 120) errors.reference = "invalid";
    if (Object.keys(errors).length) return fail(422, errors);

    const order = await loadOrder(env.DB, no);
    if (!order) return fail(404, { form: "notFound" });
    const r = await markPaid(env, order, { provider: "bank", amount: amount as number, ref: reference || null }, s.actor);
    if (r === "transition") return json(409, { ok: false, errors: { status: "transition" }, from: order.status, to: "paid" });
    if (r === "duplicate_ref") return fail(409, { reference: "duplicate" });
    if (r === "unknown_ref") return fail(409, { reference: "unknown" });
    const updated = await loadOrder(env.DB, no);
    return json(200, { ok: true, result: r, order: updated ? adminOrderView(updated) : null });
  } catch (err) {
    console.error("[admin/mark-paid] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
