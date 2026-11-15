import { signal, computed, effect } from "@preact/signals-core";

/** One cart line. Display fields are a snapshot taken when the item was added;
 *  the server always re-prices from the product collection. */
export interface CartItem {
  slug: string;
  ml: number;
  qty: number;
  price: number;
  stock?: number;
  name: string;
  brand: string;
  family: string;
  shape: string;
  /** Optimised photo URL, when the product has a real photo. */
  img?: string;
}

export const MAX_QTY = 10;
export const itemLimit = (item: { stock?: number }): number => Math.min(MAX_QTY, Math.max(0, item.stock ?? MAX_QTY));
export const MAX_LINES = 30;
const KEY = "gz-cart-v1";

function sanitize(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CartItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const i = r as Record<string, unknown>;
    if (typeof i.slug !== "string" || typeof i.ml !== "number" || typeof i.price !== "number") continue;
    const stock = typeof i.stock === "number" && Number.isFinite(i.stock) ? Math.max(0, Math.floor(i.stock)) : undefined;
    if (stock === 0) continue;
    const qty = Math.min(itemLimit({ stock }), Math.max(1, Math.floor(Number(i.qty) || 1)));
    out.push({
      slug: i.slug,
      ml: i.ml,
      qty,
      price: i.price,
      ...(stock !== undefined ? { stock } : {}),
      name: String(i.name ?? i.slug),
      brand: String(i.brand ?? ""),
      family: String(i.family ?? "amber"),
      shape: String(i.shape ?? "classic"),
      ...(typeof i.img === "string" && i.img.startsWith("/") ? { img: i.img } : {}),
    });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

function read(): CartItem[] {
  try {
    if (typeof localStorage === "undefined") return [];
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return []; // storage blocked or corrupt: the cart simply lives in memory
  }
}

export const cartItems = signal<CartItem[]>(read());
export const cartOpen = signal(false);
/** Bumped on every add; the header listens to it to pulse the cart icon. */
export const cartPulse = signal(0);

export const cartCount = computed(() => cartItems.value.reduce((n, i) => n + i.qty, 0));
export const cartSubtotal = computed(() => cartItems.value.reduce((n, i) => n + i.qty * i.price, 0));

if (typeof window !== "undefined") {
  let first = true;
  effect(() => {
    const data = JSON.stringify(cartItems.value);
    if (first) {
      first = false;
      return;
    }
    try {
      localStorage.setItem(KEY, data);
    } catch {
      /* ignore: private mode / quota */
    }
  });
  // keep several tabs in sync
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) cartItems.value = read();
  });
}

const same = (a: { slug: string; ml: number }, b: { slug: string; ml: number }) => a.slug === b.slug && a.ml === b.ml;

export function addItem(item: Omit<CartItem, "qty">, qty = 1, open = true): void {
  const limit = itemLimit(item);
  if (limit < 1) return;
  const items = cartItems.value;
  const found = items.find((i) => same(i, item));
  if (found) {
    cartItems.value = items.map((i) =>
      same(i, item) ? { ...i, ...item, qty: Math.min(limit, i.qty + qty) } : i,
    );
  } else if (items.length < MAX_LINES) {
    cartItems.value = [...items, { ...item, qty: Math.min(limit, Math.max(1, qty)) }];
  }
  cartPulse.value++;
  if (open) cartOpen.value = true;
}

export function setQty(slug: string, ml: number, qty: number): void {
  const current = cartItems.value.find((i) => same(i, { slug, ml }));
  if (qty < 1 || (current && itemLimit(current) < 1)) return removeItem(slug, ml);
  cartItems.value = cartItems.value.map((i) =>
    same(i, { slug, ml }) ? { ...i, qty: Math.min(itemLimit(i), Math.floor(qty)) } : i,
  );
}

export function removeItem(slug: string, ml: number): void {
  cartItems.value = cartItems.value.filter((i) => !same(i, { slug, ml }));
}

export function clearCart(): void {
  cartItems.value = [];
}

/** Delivery fee for a subtotal, given the shop settings. */
export function deliveryFor(subtotal: number, fee: number, freeThreshold: number): number {
  if (subtotal <= 0) return 0;
  return subtotal >= freeThreshold ? 0 : fee;
}
