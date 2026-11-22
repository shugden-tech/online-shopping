// Customer accounts: D1 reads/writes shared by the /api/account/* routes (server-only).
import { z } from "astro/zod";
import { DISTRICT_IDS, LIMITS } from "../order-validate";
import { PRODUCT_ID_RE } from "../contracts";
import { parseLines, type OrderRow } from "../orders/types";
import type { CustomerRow } from "./session";

type D1 = import("@cloudflare/workers-types").D1Database;

/** What the browser sees about the signed-in customer (no hashes, no Google id). */
export function customerView(c: CustomerRow) {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name,
    displayName: c.display_name || c.name,
    showOnBoard: c.show_on_board === 1,
    avatarUrl: c.avatar_key ? `/api/account/avatar?v=${encodeURIComponent(c.updated_at.replace(/\D/g, ""))}` : null,
    email: c.email,
    google: c.google_sub !== null,
    hasPassword: c.password_hash !== null,
    mustChangePassword: c.must_change_password === 1,
    createdAt: c.created_at,
  };
}

export const loadCustomer = (db: D1, id: number) =>
  db.prepare("SELECT * FROM customers WHERE id = ?1 AND deleted_at IS NULL").bind(id).first<CustomerRow>();

export const findByPhone = (db: D1, phone: string) =>
  db.prepare("SELECT * FROM customers WHERE phone = ?1 AND deleted_at IS NULL").bind(phone).first<CustomerRow>();

/**
 * Past guest orders become the customer's when the ORDER phone equals the ACCOUNT phone exactly (orders already
 * linked to someone are never moved). The listing never returns the name / address stored on those orders.
 */
export const claimOrdersStatement = (db: D1, customerId: number, phone: string) =>
  db.prepare("UPDATE orders SET customer_id = ?1 WHERE customer_id IS NULL AND phone = ?2").bind(customerId, phone);

/** Ends every session of a customer except `keep` (pass null to end all). */
export const endSessionsStatement = (db: D1, customerId: number, keep: string | null) =>
  keep
    ? db.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1 AND id <> ?2").bind(customerId, keep)
    : db.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1").bind(customerId);

/* ---------------- addresses ---------------- */

export const MAX_ADDRESSES = 10;

export const addressSchema = z
  .object({
    label: z.string().trim().max(40).optional().default(""),
    city: z.enum(["ub", "countryside"]),
    district: z.string().trim().max(LIMITS.province[1]),
    khoroo: z.string().trim().max(LIMITS.khoroo).optional().default(""),
    address: z.string().trim().min(LIMITS.address[0], "address").max(LIMITS.address[1], "tooLong"),
    isDefault: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.city === "ub" && !DISTRICT_IDS.includes(v.district)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["district"], message: "district" });
    if (v.city === "countryside" && v.district.length < LIMITS.province[0]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["district"], message: "province" });
  });

export interface AddressRow {
  id: number;
  customer_id: number;
  label: string;
  city: "ub" | "countryside";
  district: string;
  khoroo: string;
  address: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export const addressView = (a: AddressRow) => ({
  id: a.id,
  label: a.label,
  city: a.city,
  district: a.district,
  khoroo: a.khoroo,
  address: a.address,
  isDefault: a.is_default === 1,
});

export async function listAddresses(db: D1, customerId: number) {
  const { results } = await db
    .prepare("SELECT * FROM customer_addresses WHERE customer_id = ?1 ORDER BY is_default DESC, id")
    .bind(customerId)
    .all<AddressRow>();
  return results.map(addressView);
}

/* ---------------- wishlist ---------------- */

export const MAX_WISH = 200;
const isPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && v.length <= 300;
const isImg = (v: unknown): v is string => typeof v === "string" && v.length <= 500 && (/^https:\/\/[^\s"'<>]+$/.test(v) || isPath(v));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Keeps only the display fields the browser wishlist uses (src/scripts/wishlist.ts WishItem), with the same safety
 * rules (site-path href, https or site-path image). Returns null for anything that is not a usable item.
 */
export function sanitizeWish(v: unknown): { productId: string; item: Record<string, unknown> } | null {
  if (!v || typeof v !== "object") return null;
  const i = v as Record<string, unknown>;
  const slug = typeof i.slug === "string" ? i.slug : "";
  if (!PRODUCT_ID_RE.test(slug) || !isPath(i.href) || typeof i.ml !== "number" || !Number.isInteger(i.ml) || i.ml < 1 || i.ml > 1000) return null;
  if (i.img !== undefined && !isImg(i.img)) return null;
  const c = i.cart && typeof i.cart === "object" ? (i.cart as Record<string, unknown>) : null;
  if (!c) return null;
  const cart: Record<string, unknown> = {
    sku: str(c.sku, 130), slug, name: str(c.name, 120), brand: str(c.brand, 80), family: str(c.family, 40), shape: str(c.shape, 40),
  };
  if (c.img !== undefined && isImg(c.img)) cart.img = c.img;
  const item: Record<string, unknown> = { slug, brand: str(i.brand, 80), name: str(i.name, 120), href: i.href, ml: i.ml, cart };
  if (i.img !== undefined) item.img = i.img;
  return { productId: slug, item };
}

export async function listWish(db: D1, customerId: number): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare("SELECT item_json FROM customer_wishlist WHERE customer_id = ?1 ORDER BY created_at, product_id")
    .bind(customerId)
    .all<{ item_json: string }>();
  return results.flatMap((r) => {
    try {
      return [JSON.parse(r.item_json) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/* ---------------- orders ---------------- */

/** The customer's own orders: numbers, status, totals and lines. Never the name, phone or address on the order. */
export async function myOrders(db: D1, customerId: number) {
  const { results } = await db
    .prepare(
      `SELECT o.order_no, o.created_at, o.status, o.payment_status, o.payment, o.items_json, o.subtotal, o.delivery, o.total,
              (SELECT s.status FROM shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS ship_status,
              (SELECT s.tracking_no FROM shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS tracking_no,
              (SELECT s.tracking_url FROM shipments s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1) AS tracking_url
       FROM orders o WHERE o.customer_id = ?1 ORDER BY o.id DESC LIMIT 100`,
    )
    .bind(customerId)
    .all<Pick<OrderRow, "order_no" | "created_at" | "status" | "payment_status" | "payment" | "items_json" | "subtotal" | "delivery" | "total"> & {
      ship_status: string | null; tracking_no: string | null; tracking_url: string | null;
    }>();
  return results.map((o) => ({
    orderNo: o.order_no,
    createdAt: o.created_at,
    status: o.status,
    paymentStatus: o.payment_status,
    payment: o.payment,
    subtotal: o.subtotal,
    delivery: o.delivery,
    total: o.total,
    items: parseLines(o.items_json).map((l) => ({
      sku: l.sku, slug: l.slug, brand: l.brand, name: l.name, ml: l.ml, qty: l.qty, price: l.price,
      ...(l.bundle ? { bundle: { id: l.bundle.id, nameMn: l.bundle.nameMn, nameEn: l.bundle.nameEn } } : {}),
    })),
    shipment: o.ship_status ? { status: o.ship_status, trackingNo: o.tracking_no, trackingUrl: o.tracking_url } : null,
  }));
}
