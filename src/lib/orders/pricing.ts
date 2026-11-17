// A2 pricing: cart items -> priced order lines, from D1 `skus` + `products` only (never from the client and
// never from the build-time JSON). Delivery comes from store settings, falling back to src/data/settings.json.
import fileSettings from "../../data/settings.json";
import { isSellable, type ProductStatus, type Settings, type SkuKind } from "../contracts";
import type { D1, OrderLine } from "./types";

/** Max units of one SKU per order (same as the cart limit). */
export const MAX_QTY_PER_SKU = 10;

interface SkuJoin {
  id: string;
  product_id: string;
  ml: number;
  kind: SkuKind;
  price: number | null;
  stock: number | null;
  reserved: number;
  active: number;
  brand: string;
  name: string;
  status: ProductStatus;
  sale_locked: number;
}

export type PriceResult =
  | { ok: true; lines: OrderLine[]; subtotal: number; delivery: number; total: number }
  | { ok: false; status: 409; errors: { form: "stock" | "unavailable"; sku: string }; unavailable?: { sku: string; available: number }[] }
  | { ok: false; status: 422; errors: { form: "items" } };

export async function loadSkus(db: D1, ids: string[]): Promise<Map<string, SkuJoin>> {
  const out = new Map<string, SkuJoin>();
  if (!ids.length) return out;
  const res = await db
    .prepare(
      `SELECT s.id, s.product_id, s.ml, s.kind, s.price, s.stock, s.reserved, s.active,
              p.brand, p.name, p.status, p.sale_locked
         FROM skus s JOIN products p ON p.id = s.product_id
        WHERE s.id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .bind(...ids)
    .all<SkuJoin>();
  for (const r of res.results ?? []) out.set(r.id, r);
  return out;
}

export function deliveryFee(settings: Settings, city: string, subtotal: number): number {
  const freeOver = settings["delivery.free_over"] ?? fileSettings.delivery.freeThreshold;
  if (subtotal >= freeOver) return 0;
  const fee = city === "countryside" ? settings["delivery.fee_countryside"] : settings["delivery.fee_ub"];
  return fee ?? fileSettings.delivery.fee;
}

/**
 * Merges duplicate SKUs, checks every line is sellable (isSellable, ignoring the availability part, which
 * is reported separately as `stock`) and prices it from D1. Checkout-open is checked by the caller (423).
 */
export async function priceCart(db: D1, items: { sku: string; qty: number }[], settings: Settings, city: string): Promise<PriceResult> {
  const qty = new Map<string, number>();
  for (const it of items) qty.set(it.sku, (qty.get(it.sku) ?? 0) + it.qty);
  for (const n of qty.values()) if (n > MAX_QTY_PER_SKU) return { ok: false, status: 422, errors: { form: "items" } };

  const rows = await loadSkus(db, [...qty.keys()]);
  const lines: OrderLine[] = [];
  for (const [sku, n] of qty) {
    const r = rows.get(sku);
    const sellable =
      r !== undefined &&
      isSellable(
        { status: r.status, saleLocked: r.sale_locked === 1 },
        { price: r.price, active: r.active === 1, available: null },
        true,
      );
    if (!r || !sellable) return { ok: false, status: 409, errors: { form: "unavailable", sku } };
    const tracked = r.stock !== null;
    if (tracked) {
      const available = r.stock! - r.reserved;
      if (available < n) return { ok: false, status: 409, errors: { form: "stock", sku }, unavailable: [{ sku, available: Math.max(0, available) }] };
    }
    lines.push({ sku, slug: r.product_id, brand: r.brand, name: r.name, ml: r.ml, qty: n, price: r.price!, tracked });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const delivery = deliveryFee(settings, city, subtotal);
  return { ok: true, lines, subtotal, delivery, total: subtotal + delivery };
}

/** After a lost race (CHECK failed in the batch): the first tracked line that no longer fits. */
export async function firstShortLine(db: D1, lines: OrderLine[]): Promise<{ sku: string; available: number }[]> {
  const rows = await loadSkus(db, lines.map((l) => l.sku));
  const out: { sku: string; available: number }[] = [];
  for (const l of lines) {
    const r = rows.get(l.sku);
    if (!r || r.stock === null) continue;
    const available = Math.max(0, r.stock - r.reserved);
    if (available < l.qty) out.push({ sku: l.sku, available });
  }
  return out;
}
