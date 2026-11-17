// Client helper for the live store state (GET /api/store/catalog-state, docs/CONTRACTS.md §4).
// The static pages carry no prices or stock: everything sellable comes from here.
// - batches the product ids on the page (`data-pid` / `data-sp-from`) plus any ids asked for, ≤ 60 per request
// - one fetch per id per page view, kept in memory; reset after an Astro view-transition swap
// - never throws: a failed request marks its ids as "error" so the page can say so
import { PRODUCT_ID_RE, skuId, type StoreProductState, type StoreState } from "./contracts";

export type SkuStatus = "loading" | "error" | "hidden" | "locked" | "soon" | "out" | "off" | "closed" | "ok";
export interface SkuView {
  sku: string;
  status: SkuStatus;
  price: number | null;
  compareAt: number | null;
  /** null = not tracked (no limit) */
  available: number | null;
}
export type StoreMeta = Pick<StoreState, "checkoutOpen" | "payments">;

const MAX_IDS = 60;
let gen = 0;
let known = new Map<string, StoreProductState | null>(); // null = id unknown to the server
let pending = new Map<string, Promise<boolean>>();
let failed = new Set<string>();
let meta: StoreMeta | null = null;
const subs = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}
const emit = () => subs.forEach((fn) => fn());

/** Product ids that the current page shows. */
export function pageIds(): string[] {
  const out: string[] = [];
  document.querySelectorAll<HTMLElement>("[data-pid],[data-sp-from]").forEach((el) => out.push(el.dataset.pid ?? el.dataset.spFrom ?? ""));
  return out;
}

async function fetchChunk(ids: string[], fresh: boolean): Promise<boolean> {
  try {
    const res = await fetch(`/api/store/catalog-state?ids=${ids.join(",")}`, {
      headers: { Accept: "application/json" },
      cache: fresh ? "no-cache" : "default",
    });
    const data = (await res.json()) as Partial<StoreState> & { ok?: boolean };
    if (!res.ok || data.ok === false || !Array.isArray(data.products)) throw new Error(String(res.status));
    meta = { checkoutOpen: data.checkoutOpen === true, payments: { qpay: data.payments?.qpay === true, bank: data.payments?.bank === true } };
    for (const id of ids) {
      known.set(id, null);
      failed.delete(id);
    }
    for (const p of data.products) if (p && ids.includes(p.id) && Array.isArray(p.skus)) known.set(p.id, p);
    return true;
  } catch {
    for (const id of ids) if (!known.has(id) || fresh) failed.add(id);
    return false;
  }
}

/**
 * Make sure the state of `ids` (and, unless `fresh`, every product on the page) is loaded.
 * `fresh` skips the memory and HTTP caches (used right before checkout). Resolves true when all loaded.
 */
export function load(ids: string[] = [], fresh = false): Promise<boolean> {
  const want = [...new Set(fresh ? ids : [...ids, ...pageIds()])].filter((id) => PRODUCT_ID_RE.test(id));
  const g = gen;
  const waits: Promise<boolean>[] = [];
  const todo: string[] = [];
  for (const id of want) {
    const p = pending.get(id);
    if (p && !fresh) waits.push(p);
    else if (fresh || !known.has(id)) todo.push(id);
  }
  for (let i = 0; i < todo.length; i += MAX_IDS) {
    const chunk = todo.slice(i, i + MAX_IDS);
    const pr = fetchChunk(chunk, fresh);
    chunk.forEach((id) => pending.set(id, pr));
    waits.push(
      pr.then((ok) => {
        if (g === gen) chunk.forEach((id) => pending.get(id) === pr && pending.delete(id));
        return ok;
      }),
    );
  }
  if (!waits.length) return Promise.resolve(want.every((id) => known.has(id)));
  return Promise.all(waits).then((r) => {
    if (g === gen) emit();
    return r.every(Boolean);
  });
}

export const storeMeta = (): StoreMeta | null => meta;
/** undefined = not loaded (yet), null = unknown to the server. */
export const productState = (id: string): StoreProductState | null | undefined => known.get(id);
export const loadFailed = (id: string): boolean => failed.has(id) && !known.has(id);

/** What a size of a product can do right now. */
export function skuView(id: string, ml: number): SkuView {
  const sku = skuId(id, ml);
  const p = known.get(id);
  const v: SkuView = { sku, status: "soon", price: null, compareAt: null, available: null };
  if (p === undefined) return { ...v, status: failed.has(id) ? "error" : "loading" };
  if (p === null) return v;
  if (!p.visible) return { ...v, status: "hidden" };
  const s = p.skus.find((x) => x.sku === sku) ?? p.skus.find((x) => x.ml === ml);
  if (!s) return { ...v, status: p.saleLocked ? "locked" : "soon" };
  const price = typeof s.price === "number" && s.price > 0 ? s.price : null;
  const out: SkuView = {
    sku: s.sku || sku,
    status: "ok",
    price,
    compareAt: price !== null && typeof s.compareAt === "number" && s.compareAt > price ? s.compareAt : null,
    available: typeof s.available === "number" ? Math.max(0, s.available) : null,
  };
  out.status = p.saleLocked ? "locked"
    : price === null ? "soon"
    : out.available === 0 ? "out"
    : !meta?.checkoutOpen ? "closed"
    : !s.sellable ? "off"
    : "ok";
  return out;
}

/** Every size the server knows for a product, smallest first. */
export const skuList = (id: string): number[] => (known.get(id)?.skus ?? []).map((s) => s.ml).sort((a, b) => a - b);

/** Sizes of a product that can be bought now, cheapest first. */
export const buyable = (id: string): SkuView[] =>
  skuList(id).map((ml) => skuView(id, ml)).filter((v) => v.status === "ok" && v.price !== null).sort((a, b) => a.price! - b.price!);

// A view-transition swap is a new page view: forget the state so each page shows fresh numbers.
document.addEventListener("astro:after-swap", () => {
  gen++;
  known = new Map();
  pending = new Map();
  failed = new Set();
  meta = null;
});
