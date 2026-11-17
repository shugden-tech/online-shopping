// Re-checks the cart against the live store state (loaded lazily: cart drawer, checkout).
// Sellable lines get the server price and are capped to what is available; lines that can no longer be
// bought are taken out and named in `cartCheck.removed`, so the drawer / checkout can say what happened.
import { cartCheck, cartItems, MAX_QTY, type CartItem } from "./cart";
import { load, skuView, storeMeta } from "./store-state";

export { storeMeta };

const label = (i: CartItem, ml: string) => `${i.brand} ${i.name} ${i.ml} ${ml}`.trim();

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
  const ok = await load(cartItems.value.map((i) => i.slug), fresh);
  if (!ok) {
    cartCheck.value = { ...cartCheck.value, status: "error" };
    return "error";
  }
  const removed: string[] = [];
  const capped: string[] = [];
  let priceChanged = false;
  const next: CartItem[] = [];
  for (const i of cartItems.value) {
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
