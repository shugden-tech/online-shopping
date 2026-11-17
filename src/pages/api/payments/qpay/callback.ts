// GET|POST /api/payments/qpay/callback?order=<orderNo>&sig=<hex HMAC-SHA256(QPAY_CALLBACK_SECRET, orderNo)>
// QPay calls this when an invoice is paid. The body is never trusted: the order's invoices are re-checked with
// POST /v2/payment/check and the order is marked paid only when paid_amount >= amount (markPaid, idempotent).
// A valid signature always gets 200 "SUCCESS" (so QPay stops retrying); anything else gets 403.
// Note: Astro's checkOrigin answers 403 to a cross-site POST without a JSON content type before this runs;
// QPay's GET callback is not affected.
import type { APIRoute } from "astro";
import { ORDER_NO_RE, loadOrder, normOrderNo } from "../../../../lib/orders/types";
import { qpayConfigured, refreshQpay } from "../../../../lib/payments";
import { verifyOrderSig } from "../../../../lib/payments/qpay";
import { NO_STORE } from "../../../../lib/server";

export const prerender = false;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

const handle: APIRoute = async ({ locals, url }) => {
  const env = locals.runtime?.env;
  const no = normOrderNo(url.searchParams.get("order"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!env?.DB || !env.QPAY_CALLBACK_SECRET || !ORDER_NO_RE.test(no) || !(await verifyOrderSig(env.QPAY_CALLBACK_SECRET, no, sig))) {
    return text(403, "FORBIDDEN");
  }
  try {
    const order = await loadOrder(env.DB, no);
    if (order && qpayConfigured(env)) {
      const results = await refreshQpay(env, order, "system");
      if (results.length) console.log(`[qpay-callback] ${no}: ${results.join(", ")}`);
    }
  } catch (err) {
    // QPay will not retry after SUCCESS; the payment-check button and the hold sweep re-check later.
    console.error(`[qpay-callback] ${no}:`, String(err));
  }
  return text(200, "SUCCESS");
};

export const GET = handle;
export const POST = handle;
export const ALL: APIRoute = () => text(405, "METHOD NOT ALLOWED");
