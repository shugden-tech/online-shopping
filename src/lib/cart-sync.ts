// Re-checks the cart against the live store state (loaded lazily: cart drawer, checkout).
// Sellable lines get the server price and are capped to what is available; lines that can no longer be
// bought are taken out and named in `cartCheck.removed`, so the drawer / checkout can say what happened.
import { cartCheck, cartItems, MAX_QTY, type CartItem } from "./cart";
import { load, setStoreMeta, skuView, storeMeta } from "./store-state";
import type { BundleState } from "./bundles/types";

export { storeMeta };

const label = (i: CartItem, ml: string) => (i.bundle ? `${i.brand} ${i.name}` : `${i.brand} ${i.name} ${i.ml} ${ml}`).trim();

/** Live state of the cart's bundles (GET /api/store/bundles); null when it could not be loaded. */
async function loadBundles(ids: string[], fresh: boolean): Promise<Map<string, BundleState> | null> {
  if (!ids.length) return new Map();
  try {
    const res = await fetch(`/api/store/bundles?ids=${ids.map(encodeURIComponent).join(",")}`, {
      headers: { Accept: "application/json" },
      cache: fresh ? "no-cache" : "default",
    });
    const data = (await res.json()) as { ok?: boolean; bundles?: BundleState[]; checkoutOpen?: boolean; payments?: { qpay?: boolean; bank?: boolean } };
    if (!res.ok || !data.ok || !Array.isArray(data.bundles)) return null;
    // a cart of bundles only loads no product state: take the store switches from here
    if (fresh || !storeMeta()) setStoreMeta({ checkoutOpen: data.checkoutOpen === true, payments: { qpay: data.payments?.qpay === true, bank: data.payments?.bank === true } });
    return new Map(data.bundles.map((b) => [b.id, b]));
  } catch {
    return null;
  }
}

/**
 * "error" = the state could not be loaded (nothing changed), "changed" = this check updated a price, a
 * quantity or removed a line, "same" = the cart was already right. `fresh` bypasses the caches.
 */
export async function revalidateCart(ml: string, fresh = false): Promise<"error" | "changed" | "same"> {
  const prev = cartCheck.value;
  if (!cartItems.value.length && !fresh) {
    cartCheck.value = { ...prev, status: "ok" };
    return "same";
  }
  cartCheck.value = { ...prev, status: "checking" };
  const bundleIds = [...new Set(cartItems.value.flatMap((i) => (i.bundle ? [i.bundle] : [])))];
  const [ok, bundles] = await Promise.all([
    load(cartItems.value.filter((i) => !i.bundle).map((i) => i.slug), fresh),
    loadBundles(bundleIds, fresh),
  ]);
  if (!ok || !bundles) {
    cartCheck.value = { ...cartCheck.value, status: "error" };
    return "error";
  }
  const removed: string[] = [];
  const capped: string[] = [];
  let priceChanged = false;
  const next: CartItem[] = [];
  for (const i of cartItems.value) {
    if (i.bundle) {
      const b = bundles.get(i.bundle);
      if (!b || b.price === null || (b.block !== null && b.block !== "closed")) {
        removed.push(label(i, ml));
        continue;
      }
      const limit = Math.min(MAX_QTY, b.available ?? MAX_QTY);
      const qty = Math.min(i.qty, limit);
      if (qty < i.qty) capped.push(label(i, ml));
      if (b.price !== i.price) priceChanged = true;
      const { stock: _old, ...rest } = i;
      next.push({ ...rest, price: b.price, qty, ...(b.available !== null ? { stock: b.available } : {}) });
      continue;
    }
    const v = skuView(i.slug, i.ml);
    // "closed" = checkout switched off: the line stays (with its price); the checkout says it is closed.
    if ((v.status !== "ok" && v.status !== "closed") || v.price === null) {
      removed.push(label(i, ml));
      continue;
    }
    const limit = Math.min(MAX_QTY, v.available ?? MAX_QTY);
    const qty = Math.min(i.qty, limit);
    if (qty < i.qty) capped.push(label(i, ml));
    if (v.price !== i.price) priceChanged = true;
    const { stock: _old, ...rest } = i;
    next.push({ ...rest, sku: v.sku, price: v.price, qty, ...(v.available !== null ? { stock: v.available } : {}) });
  }
  const changed = removed.length > 0 || capped.length > 0 || next.some((n, k) => JSON.stringify(n) !== JSON.stringify(cartItems.value[k]));
  if (changed) cartItems.value = next;
  // keep an earlier notice until something new happens (the drawer and checkout may both re-check)
  const news = removed.length > 0 || capped.length > 0 || priceChanged;
  cartCheck.value = news
    ? { status: "ok", removed, capped, priceChanged }
    : { ...cartCheck.value, status: "ok" };
  return news ? "changed" : "same";
}

/** Did the last check change anything the customer should look at? */
export const hasNotice = () => {
  const c = cartCheck.value;
  return c.removed.length > 0 || c.capped.length > 0 || c.priceChanged;
};

// A new page view starts without old notices.
document.addEventListener("astro:after-swap", () => {
  cartCheck.value = { status: "idle", removed: [], capped: [], priceChanged: false };
});
