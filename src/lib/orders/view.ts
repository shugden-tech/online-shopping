// A2: response shapes for orders (checkout response, customer lookup, admin).
import type { PaymentInstructions } from "../contracts";
import { ensureQpayInvoice, instructionsFor } from "../payments";
import { parseLines, type D1, type OrderRow } from "./types";

/** Body of POST /api/orders (201 the first time, 200 for the same Idempotency-Key). */
export async function checkoutResponse(env: Env, order: OrderRow, payment?: PaymentInstructions | null) {
  const pay = payment !== undefined ? payment : order.payment === "qpay" ? await ensureQpayInvoice(env, order) : await instructionsFor(env.DB, order);
  return {
    ok: true as const,
    orderNo: order.order_no,
    total: order.total,
    subtotal: order.subtotal,
    delivery: order.delivery,
    holdExpiresAt: order.hold_expires_at,
    payment: pay,
    ...(pay === null && order.payment === "qpay" ? { paymentError: "qpay_unavailable" } : {}),
  };
}

export async function latestShipment(db: D1, orderId: number) {
  const s = await db
    .prepare("SELECT status, tracking_no, tracking_url FROM shipments WHERE order_id = ?1 ORDER BY id DESC LIMIT 1")
    .bind(orderId)
    .first<{ status: string; tracking_no: string | null; tracking_url: string | null }>();
  return s ? { status: s.status, trackingNo: s.tracking_no, trackingUrl: s.tracking_url } : null;
}

/** Customer lookup: status, items and payment state only (no name, address or phone). */
export async function lookupView(env: Env, order: OrderRow) {
  const awaiting = (order.status === "new" || order.status === "confirmed") && order.payment_status !== "paid";
  return {
    ok: true as const,
    orderNo: order.order_no,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment,
    holdExpiresAt: order.hold_expires_at,
    createdAt: order.created_at,
    items: parseLines(order.items_json).map(({ sku, slug, brand, name, ml, qty, price }) => ({ sku, slug, brand, name, ml, qty, price })),
    subtotal: order.subtotal,
    delivery: order.delivery,
    total: order.total,
    payment: awaiting ? await instructionsFor(env.DB, order) : null,
    shipment: await latestShipment(env.DB, order.id),
  };
}

/** Admin list / detail item (camelCase; ip and idempotency key are never returned). */
export function adminOrderView(o: OrderRow) {
  return {
    id: o.id,
    orderNo: o.order_no,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    status: o.status,
    paymentStatus: o.payment_status,
    payment: o.payment,
    holdExpiresAt: o.hold_expires_at,
    cancelReason: o.cancel_reason,
    name: o.name,
    phone: o.phone,
    phone2: o.phone2,
    city: o.city,
    district: o.district,
    khoroo: o.khoroo,
    address: o.address,
    note: o.note,
    items: parseLines(o.items_json),
    subtotal: o.subtotal,
    delivery: o.delivery,
    total: o.total,
    locale: o.locale,
  };
}

export function adminPaymentView(p: {
  id: number; order_no?: string; order_id: number; provider: string; provider_ref: string | null; amount: number; status: string;
  paid_amount: number | null; provider_payment_id: string | null; created_at: string; updated_at: string; paid_at: string | null;
}) {
  return {
    id: p.id,
    orderId: p.order_id,
    ...(p.order_no !== undefined ? { orderNo: p.order_no } : {}),
    provider: p.provider,
    providerRef: p.provider_ref,
    amount: p.amount,
    status: p.status,
    paidAmount: p.paid_amount,
    providerPaymentId: p.provider_payment_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    paidAt: p.paid_at,
  };
}
