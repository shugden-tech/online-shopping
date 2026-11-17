// A2 orders: row and line types shared by the order and payment modules (server-only).
import type { Actor, OrderPaymentStatus, OrderStatus, PaymentProvider } from "../contracts";

export type D1 = import("@cloudflare/workers-types").D1Database;
export type Stmt = import("@cloudflare/workers-types").D1PreparedStatement;

export const ORDER_NO_RE = /^GZ-\d{6}-[A-Z2-9]{4}$/;

/** One stored order line (orders.items_json). Prices are a snapshot of D1 `skus.price` at order time. */
export interface OrderLine {
  sku: string;
  slug: string; // product id
  brand: string;
  name: string;
  ml: number;
  qty: number;
  price: number;
  /** skus.stock was tracked when the order was priced (reservations.tracked is the source of truth). */
  tracked: boolean;
}

/** orders row (0001 + 0002 + 0003 columns). */
export interface OrderRow {
  id: number;
  order_no: string;
  created_at: string;
  updated_at: string | null;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  hold_expires_at: string | null;
  cancel_reason: string | null;
  name: string;
  phone: string;
  phone2: string | null;
  city: string;
  district: string | null;
  khoroo: string | null;
  address: string;
  note: string | null;
  payment: PaymentProvider;
  items_json: string;
  subtotal: number;
  delivery: number;
  total: number;
  locale: "mn" | "en";
  ip: string | null;
  idempotency_key: string | null;
}

export interface PaymentRow {
  id: number;
  order_id: number;
  provider: PaymentProvider;
  provider_ref: string | null;
  amount: number;
  status: string;
  paid_amount: number | null;
  provider_payment_id: string | null;
  data_json: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
}

export type { Actor };

export function parseLines(json: string): OrderLine[] {
  try {
    const v = JSON.parse(json) as Partial<OrderLine>[];
    return Array.isArray(v)
      ? v.map((l) => ({
          sku: l.sku ?? `${l.slug}:${l.ml}`,
          slug: l.slug ?? "",
          brand: l.brand ?? "",
          name: l.name ?? "",
          ml: Number(l.ml) || 0,
          qty: Number(l.qty) || 0,
          price: Number(l.price) || 0,
          tracked: l.tracked === true,
        }))
      : [];
  } catch {
    return [];
  }
}

export async function loadOrder(db: D1, orderNo: string): Promise<OrderRow | null> {
  return db.prepare("SELECT * FROM orders WHERE order_no = ?1").bind(orderNo).first<OrderRow>();
}

/** Same rule as the customer lookup: the last 4–8 digits of the phone on the order. */
export function phoneMatches(order: Pick<OrderRow, "phone">, input: unknown): boolean {
  const digits = typeof input === "string" ? input.replace(/\D/g, "") : "";
  return digits.length >= 4 && digits.length <= 8 && order.phone.endsWith(digits);
}

export const normOrderNo = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : "");
