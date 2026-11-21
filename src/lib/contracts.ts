// SHARED CONTRACTS (FROZEN by A0 — lead-owned). Types, enums, state machines and setting keys that every
// module agrees on. No runtime dependencies (no zod), so islands may import the types and constants.
// The database shape is migrations/0003_commerce.sql; the HTTP shapes are docs/CONTRACTS.md.

/* ---------------- catalog ---------------- */

export const PRODUCT_STATUSES = ["draft", "active", "hidden"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const GENDERS = ["women", "men", "unisex"] as const;
export type Gender = (typeof GENDERS)[number];
export const SKU_KINDS = ["decant", "full"] as const;
export type SkuKind = (typeof SKU_KINDS)[number];

export { skuId, parseSkuId, PRODUCT_ID_RE } from "./ids";

export interface Notes { top: string[]; heart: string[]; base: string[] }

/** Admin view of a product (GET /api/admin/products/:id). */
export interface AdminProduct {
  id: string;
  brand: string;
  name: string;
  concentration: string | null;
  gender: Gender | null;
  family: string | null;
  releaseYear: number | null;
  notes: Notes;
  descriptionMn: string | null;
  descriptionEn: string | null;
  imageFront: string | null;
  imageBack: string | null;
  status: ProductStatus;
  saleLocked: boolean;
  sort: number;
  source: "r2-catalog" | "content" | "admin";
  createdAt: string;
  updatedAt: string;
  skus: AdminSku[];
}

export interface AdminSku {
  id: string;
  productId: string;
  ml: number;
  kind: SkuKind;
  price: number | null;
  compareAt: number | null;
  stock: number | null;      // null = not tracked
  reserved: number;
  available: number | null;  // stock - reserved, null when not tracked
  active: boolean;
  updatedAt: string;
}

/** Public, per-product runtime state (GET /api/store/catalog-state). */
export interface StoreProductState {
  id: string;
  visible: boolean;          // status === 'active'
  saleLocked: boolean;
  /** Admin photos (0004), present only when set. */
  imageFront?: string;
  imageBack?: string;
  skus: StoreSkuState[];
}
export interface StoreSkuState {
  sku: string;
  ml: number;
  kind: SkuKind;
  price: number | null;
  compareAt: number | null;
  /** Units that can be ordered now; null = not tracked (no limit). */
  available: number | null;
  /** price set, sku active, product active + not locked, available !== 0, checkout open. */
  sellable: boolean;
}
export interface StoreState {
  checkoutOpen: boolean;
  payments: { qpay: boolean; bank: boolean };
  products: StoreProductState[];
}

/** A SKU can be sold when every switch allows it. Single source of truth for API and storefront. */
export function isSellable(p: { status: ProductStatus; saleLocked: boolean }, s: { price: number | null; active: boolean; available: number | null }, checkoutOpen: boolean): boolean {
  return checkoutOpen && p.status === "active" && !p.saleLocked && s.active && s.price !== null && s.price > 0 && (s.available === null || s.available > 0);
}

export const STOCK_REASONS = ["restock", "correction", "sale", "cancel_after_paid", "import"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

/* ---------------- orders ---------------- */

export const ORDER_STATUSES = ["new", "confirmed", "paid", "shipped", "done", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * new        placed; stock reserved until hold_expires_at; awaiting payment
 * confirmed  owner checked the order (bank transfer flow), still awaiting payment; hold no longer expires
 * paid       payment confirmed; reservations committed (stock decremented)
 * shipped    handed to delivery
 * done       delivered
 * cancelled  terminal; held reservations released; if it was paid, stock is restored (cancel_after_paid)
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "paid", "cancelled"],
  confirmed: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: ["done"],
  done: [],
  cancelled: [],
};
export const canOrderTransition = (from: string, to: string) =>
  (ORDER_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false;

export const PAYMENT_STATUSES_ORDER = ["unpaid", "pending", "paid", "refunded"] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUSES_ORDER)[number];

export const RESERVATION_STATUSES = ["held", "committed", "released"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  held: ["committed", "released"],
  committed: [],          // a paid order's cancel restores stock via stock_movements, not by un-committing
  released: [],
};

/* ---------------- payments ---------------- */

export const PAYMENT_PROVIDERS = ["qpay", "bank"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const PAYMENT_STATUSES = ["pending", "paid", "failed", "expired", "cancelled", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["paid", "failed", "expired", "cancelled"],
  paid: ["refunded"],
  failed: [],
  expired: [],
  cancelled: [],
  refunded: [],
};
export const canPaymentTransition = (from: string, to: string) =>
  (PAYMENT_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false;

/** What POST /api/orders returns under `payment`. */
export type PaymentInstructions =
  | { method: "qpay"; invoiceId: string; qrImage: string | null; qrText: string | null; shortUrl: string | null; urls: { name: string; link: string; logo?: string }[] }
  | { method: "bank"; bank: string; account: string; holder: string; reference: string };

/* ---------------- delivery ---------------- */

export const SHIPMENT_STATUSES = ["pending", "created", "picked_up", "in_transit", "delivered", "failed", "cancelled", "returned"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  // manual delivery may skip `created` (pending -> picked_up / in_transit); 0004 added `returned`
  pending: ["created", "picked_up", "in_transit", "failed", "cancelled"],
  created: ["picked_up", "in_transit", "delivered", "failed", "cancelled"],
  picked_up: ["in_transit", "delivered", "failed", "returned"],
  in_transit: ["delivered", "failed", "returned"],
  delivered: [],
  failed: ["pending", "cancelled", "returned"],   // failed -> pending = retry
  cancelled: [],
  returned: [],                                   // parcel came back to the shop; the owner decides about the order
};
export const canShipmentTransition = (from: string, to: string) =>
  (SHIPMENT_TRANSITIONS as Record<string, readonly string[]>)[from]?.includes(to) ?? false;

/**
 * Order side effects of shipment changes (applied by the delivery module, with a conditional UPDATE):
 *   shipment -> created|picked_up|in_transit : order paid -> shipped
 *   shipment -> delivered                    : order shipped -> done
 */

/* ---------------- settings ---------------- */

/** Every store setting, with its default. Unknown keys are rejected by PUT /api/admin/settings. */
export const SETTINGS = {
  "checkout.open": true as boolean,
  "payments.qpay.enabled": true as boolean,
  "payments.bank.enabled": true as boolean,
  /** Minutes a 'new' order keeps its stock before it expires, per payment method. */
  "holds.qpay_minutes": 30 as number,
  "holds.bank_minutes": 1440 as number,
  /** Delivery fees in ₮; null = fall back to src/data/settings.json. */
  "delivery.fee_ub": null as number | null,
  "delivery.fee_countryside": null as number | null,
  "delivery.free_over": null as number | null,
  /** Default provider for new shipments. */
  "delivery.provider": "manual" as string,
  /** Short notice shown on the storefront when set (e.g. holiday closure). */
  "store.notice_mn": "" as string,
  "store.notice_en": "" as string,
  /** Bank transfer details shown to customers (0004). Empty = fall back to src/data/settings.json. */
  "bank.name": "" as string,
  "bank.account": "" as string,
  "bank.holder": "" as string,
  /** Contact info (0004). Empty = fall back to src/data/settings.json. */
  "contact.phone": "" as string,
  "contact.hours_mn": "" as string,
  "contact.hours_en": "" as string,
  "contact.instagram": "" as string,
  "contact.facebook": "" as string,
  "contact.telegram": "" as string,
};
export type SettingKey = keyof typeof SETTINGS;
export type Settings = { [K in SettingKey]: (typeof SETTINGS)[K] };

/* ---------------- outbound webhooks (0004) ---------------- */

export const WEBHOOK_EVENTS = ["order.created", "order.paid", "order.cancelled", "shipment.updated"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/* ---------------- admin auth ---------------- */

export const ROLES = ["owner", "staff"] as const;
export type Role = (typeof ROLES)[number];
export const PERMISSIONS = [
  "catalog.read", "catalog.write", "inventory.write", "media.write",
  "orders.read", "orders.write",
  "payments.read", "payments.write",
  "delivery.read", "delivery.write",
  "settings.read", "settings.write",
  "audit.read",
  // customer accounts (0007): owner only (staff has neither)
  "customers.read", "customers.write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  staff: ["catalog.read", "inventory.write", "orders.read", "orders.write", "payments.read", "delivery.read", "delivery.write", "settings.read"],
};
export type Actor = `admin:${Role}` | "system" | "customer";

/* ---------------- HTTP envelope ---------------- */

export type ApiOk<T> = { ok: true } & T;
export type ApiErr = { ok: false; errors: Record<string, string> };
export interface Page<T> { items: T[]; page: number; limit: number; total: number }
