// GET /api/account/orders -> { ok, items }  the signed-in customer's orders from D1 (newest first, <= 100):
//   orderNo, createdAt, status, paymentStatus, payment, subtotal, delivery, total, items[], shipment | null.
//   The name, phone and address stored on the orders are never returned.
import { json } from "../../../lib/server";
import { accountRoute } from "../../../lib/customers/session";
import { myOrders } from "../../../lib/customers/store";

export const prerender = false;

export const GET = accountRoute("orders", async (_ctx, env, s) => json(200, { ok: true, items: await myOrders(env.DB, s.customer.id) }));
