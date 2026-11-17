// Fills the server-rendered product cards (and the header's featured items) with the live store state:
// price / compare-at price, sold out, temporarily closed, price coming soon, and removes hidden products.
// Loaded lazily by shell.ts on pages that show products. Re-runs whenever the state changes.
import { formatPrice } from "../lib/price";
import { load, loadFailed, productState, skuList, skuView, subscribe, type SkuView } from "../lib/store-state";

export { load };

interface LiveText {
  loading: string; failed: string; soon: string; soonShort: string; locked: string; off: string; notSold: string;
  was: string; left: string; add: string; soldOut: string; ml: string; decantsShort: string;
}
/** Sent on `document` after each update so the shop filters can follow the live prices. */
export interface LiveDetail { hidden: string[]; from: Record<string, number | null>; sizes: Record<string, number[]> }

const doc = document;
let t: LiveText | null = null;
const text = (): LiveText => {
  if (t) return t;
  try {
    t = JSON.parse(doc.getElementById("live-i18n")?.textContent ?? "{}") as LiveText;
  } catch {
    t = {} as LiveText;
  }
  return t;
};
const loc = () => (doc.documentElement.lang === "en" ? "en" : "mn");
const money = (n: number) => formatPrice(n, loc());

function el(tag: string, cls: string, txt = ""): HTMLElement {
  const e = doc.createElement(tag);
  e.className = cls;
  e.textContent = txt;
  return e;
}

/** The price line for one size: compare-at (struck) + price, or a short note. */
export function priceNodes(v: SkuView): (Node | string)[] {
  const tx = text();
  if (v.status === "loading") return [el("i", "live-ph"), el("span", "sr-only", tx.loading)];
  if (v.status === "error") return [el("span", "live-note", tx.failed)];
  if (v.status === "hidden") return [el("span", "live-note", tx.notSold)];
  if (v.price === null) return [el("span", "live-note", tx.soon)];
  const out: (Node | string)[] = [];
  if (v.compareAt) {
    const s = el("s", "live-was", money(v.compareAt));
    s.setAttribute("aria-label", `${tx.was}: ${money(v.compareAt)}`);
    out.push(s);
  }
  out.push(money(v.price));
  return out;
}

/** Button text for a size that cannot be added (or "add" when it can). */
export function stateLabel(v: SkuView, short = false): string {
  const tx = text();
  switch (v.status) {
    case "out": return tx.soldOut;
    case "locked": case "closed": return tx.locked;
    case "soon": return short ? tx.soonShort : tx.soon;
    case "off": case "hidden": return tx.off;
    default: return tx.add;
  }
}

/** Point an add button at a size: enabled only when it can be bought, with the live price for the cart. */
function setButton(b: HTMLButtonElement, v: SkuView, ml: number) {
  b.dataset.ml = String(ml);
  b.dataset.sku = v.sku;
  b.disabled = v.status !== "ok";
  b.removeAttribute("data-wait");
  if (v.status === "ok" && v.price !== null) {
    b.dataset.price = String(v.price);
    if (v.available !== null) b.dataset.stock = String(v.available);
    else delete b.dataset.stock;
  } else {
    delete b.dataset.price;
    delete b.dataset.stock;
  }
}

const loaded = (id: string) => productState(id) !== undefined || loadFailed(id);

function updateCard(card: HTMLElement, detail: LiveDetail) {
  const id = card.dataset.pid ?? "";
  if (!loaded(id)) return;
  const tx = text();
  const p = productState(id);
  if (p && !p.visible) {
    (card.closest("li") ?? card).remove();
    detail.hidden.push(id);
    return;
  }
  const opts = [...card.querySelectorAll<HTMLButtonElement>(".pcard__dec-opt[data-ml]")];
  const views = opts.map((o) => skuView(id, Number(o.dataset.ml)));
  opts.forEach((o, k) => {
    const v = views[k]!;
    setButton(o, v, Number(o.dataset.ml));
    o.toggleAttribute("data-soft", v.status === "error" || v.status === "soon");
    o.querySelector("[data-opt-v]")?.replaceChildren(v.status === "ok" ? money(v.price!) : v.status === "error" ? "—" : stateLabel(v, true));
  });

  // main offer: the full bottle, else the first decant that can be bought (else the first decant)
  const main = card.querySelector<HTMLButtonElement>("[data-main]");
  const fullMl = Number(card.dataset.fullMl) || 0;
  let ml = fullMl;
  let mv: SkuView;
  if (fullMl || !opts.length) {
    ml = fullMl || Number(main?.dataset.ml);
    mv = skuView(id, ml);
  } else {
    let k = views.findIndex((v) => v.status === "ok");
    if (k < 0) k = Math.max(0, views.findIndex((v) => v.price !== null));
    ml = Number(opts[k]!.dataset.ml);
    mv = views[k]!;
    const label = card.querySelector("[data-price-k]");
    if (label) label.textContent = `${tx.decantsShort} · ${ml} ${tx.ml}`;
  }
  card.querySelector("[data-price-v]")?.replaceChildren(...priceNodes(mv));
  if (main) {
    setButton(main, mv, ml);
    if (main.dataset.labelTpl) main.setAttribute("aria-label", main.dataset.labelTpl.replace("{ml}", String(ml)));
    const lbl = main.querySelector("[data-add-label]");
    if (lbl) lbl.textContent = mv.status === "error" || mv.status === "loading" ? tx.add : stateLabel(mv);
  }

  // card flag: temporarily closed / sold out (instead of "new")
  const all = [mv, ...views];
  const flag = p?.saleLocked ? tx.locked : all.every((v) => v.status === "out") ? tx.soldOut : "";
  const f = card.querySelector<HTMLElement>("[data-flag]");
  if (f) {
    f.textContent = flag;
    f.hidden = !flag;
  }
  card.querySelector<HTMLElement>("[data-flag-new]")?.toggleAttribute("hidden", Boolean(flag));

  const ok = all.filter((v) => v.status === "ok" && v.price !== null);
  const priced = ok.length ? ok : all.filter((v) => v.price !== null);
  detail.from[id] = priced.length ? Math.min(...priced.map((v) => v.price!)) : null;
  detail.sizes[id] = [...new Set([...(fullMl ? [fullMl] : []), ...opts.map((o) => Number(o.dataset.ml))])].filter((m) => skuView(id, m).status === "ok");
}

/** Header mega-menu "featured" items: the lowest live price, or nothing. */
function updateFeatured(span: HTMLElement) {
  const id = span.dataset.spFrom ?? "";
  if (!loaded(id)) return;
  const p = productState(id);
  if (p && !p.visible) {
    span.closest("a")?.remove();
    return;
  }
  const views = skuList(id).map((ml) => skuView(id, ml));
  const ok = views.filter((v) => v.status === "ok" && v.price !== null);
  const priced = ok.length ? ok : views.filter((v) => v.price !== null);
  span.textContent = priced.length ? money(Math.min(...priced.map((v) => v.price!))) : "";
}

/** Wishlist drawer line: fills `box` with the live price or state; returns the view when it can be added. */
export function wishPrice(box: HTMLElement, id: string, ml: number): SkuView | null {
  const v = skuView(id, ml);
  if (v.status === "ok" && v.price !== null) {
    box.textContent = money(v.price);
    return v;
  }
  if (v.status === "loading" || v.status === "error") box.replaceChildren(...priceNodes(v));
  else {
    box.classList.add("live-note");
    box.textContent = v.price === null ? text().soon : stateLabel(v);
  }
  return null;
}

export function update(): void {
  const detail: LiveDetail = { hidden: [], from: {}, sizes: {} };
  doc.querySelectorAll<HTMLElement>("[data-card][data-pid]").forEach((c) => updateCard(c, detail));
  doc.querySelectorAll<HTMLElement>("[data-sp-from]").forEach(updateFeatured);
  // kept for islands that hydrate after this ran (ShopFilters reads it on mount)
  (window as unknown as { gzLive?: LiveDetail }).gzLive = detail;
  doc.dispatchEvent(new CustomEvent<LiveDetail>("gz:live", { detail }));
}

subscribe(update);

/** Load the state of every product on the page (one batched request per 60 ids) and paint it. */
export function run(): void {
  t = null; // the language may have changed with the page
  void load().then(update);
}
