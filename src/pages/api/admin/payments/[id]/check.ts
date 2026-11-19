// POST /api/admin/payments/{id}/check  [payments.write]  (lead, 0004)
// Asks QPay about the order of this QPay payment (POST /v2/payment/check via refreshQpay) and applies a
// confirmed payment. -> { ok, results, paymentStatus, status }. 422 { provider: "not-qpay" | "not-configured" },
// 502 { provider: "unreachable" } when QPay cannot be reached.
import { adminRoute } from "../../../../../lib/catalog/route";
import { loadOrder } from "../../../../../lib/orders/types";
import { qpayConfigured, refreshQpay } from "../../../../../lib/payments";
import { fail, json } from "../../../../../lib/server";

export const prerender = false;

export const POST = adminRoute("admin/payment-check", "payments.write", async ({ params }, env, s) => {
  const id = /^[1-9]\d{0,9}$/.test(params.id ?? "") ? Number(params.id) : 0;
  if (!id) return fail(404, { form: "notFound" });
  const p = await env.DB.prepare("SELECT p.provider, o.order_no FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?1")
    .bind(id).first<{ provider: string; order_no: string }>();
  if (!p) return fail(404, { form: "notFound" });
  if (p.provider !== "qpay") return fail(422, { provider: "not-qpay" });
  if (!qpayConfigured(env)) return fail(422, { provider: "not-configured" });
  const order = await loadOrder(env.DB, p.order_no);
  if (!order) return fail(404, { form: "notFound" });
  let results;
  try {
    results = await refreshQpay(env, order, s.actor);
  } catch (err) {
    console.error("[admin/payment-check]", String(err));
    return fail(502, { provider: "unreachable" });
  }
  const after = await loadOrder(env.DB, p.order_no);
  return json(200, { ok: true, results, paymentStatus: after?.payment_status, status: after?.status });
});
