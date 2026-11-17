// POST /api/orders/{no}/payment-check { phone } -> { ok, paymentStatus, status, payment }
// The customer's "I have paid" button: re-checks QPay for this order (never trusting the browser) and applies a
// confirmed payment. If the QPay invoice could not be created when the order was placed, it is created here.
// Needs the last 4–8 digits of the order's phone. Rate limited 10 / 10 min / ip.
import type { APIRoute } from "astro";
import { ORDER_NO_RE, loadOrder, normOrderNo, phoneMatches } from "../../../../lib/orders/types";
import { ensureQpayInvoice, instructionsFor, qpayConfigured, refreshQpay } from "../../../../lib/payments";
import { clientIp, fail, hitRateLimit, json, readJson } from "../../../../lib/server";

export const prerender = false;

const LIMIT = 10;

export const POST: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const body = await readJson(request, 1024);
    if (body instanceof Response) return body;
    const phone = ((body.value ?? {}) as { phone?: unknown }).phone;
    const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
    const no = normOrderNo(params.no);
    if (!ORDER_NO_RE.test(no) || digits.length < 4 || digits.length > 8) return fail(422, { form: "lookup" });

    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const ip = clientIp(request, () => clientAddress);
    if (!(await hitRateLimit(env.DB, `paycheck:${ip}`, LIMIT, 600))) return fail(429, { form: "rate" });

    let order = await loadOrder(env.DB, no);
    if (!order || !phoneMatches(order, digits)) return fail(404, { form: "notFound" });

    let paymentError: string | undefined;
    if (order.payment === "qpay" && order.payment_status !== "paid" && qpayConfigured(env)) {
      try {
        if (order.status === "new" || order.status === "confirmed") {
          if (!(await ensureQpayInvoice(env, order))) paymentError = "qpay_unavailable";
        }
        await refreshQpay(env, order);
      } catch (err) {
        console.error(`[payment-check] ${no}:`, String(err));
        paymentError = "qpay_unavailable";
      }
      order = (await loadOrder(env.DB, no)) ?? order;
    }
    const awaiting = (order.status === "new" || order.status === "confirmed") && order.payment_status !== "paid";
    return json(200, {
      ok: true,
      orderNo: order.order_no,
      status: order.status,
      paymentStatus: order.payment_status,
      holdExpiresAt: order.hold_expires_at,
      payment: awaiting ? await instructionsFor(env.DB, order) : null,
      ...(paymentError && awaiting ? { paymentError } : {}),
    });
  } catch (err) {
    console.error("[payment-check] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
