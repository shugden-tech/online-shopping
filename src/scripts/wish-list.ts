// Wishlist drawer (loaded lazily by wishlist.ts on the first open): the panel, open / close / focus, and the
// saved rows with their live price and an add button. No price is stored with the wishlist; the first render asks
// the live store state for these products.
import { load, wishPrice } from "./live-prices";
import type { PanelText, WishItem } from "./wishlist";

const doc = document;
const root = doc.documentElement;
let asked = "";

interface WishApi { items: () => WishItem[]; remove: (slug: string) => void }
let api: WishApi = { items: () => [], remove: () => {} };

const isOpen = () => root.hasAttribute("data-wish-open");
let lastOpener: HTMLElement | null = null;

function readText(): PanelText {
  try {
    const el = doc.getElementById("wish-i18n");
    return { title: "", empty: "", emptySub: "", add: "", remove: "", close: "", ...JSON.parse(el?.textContent ?? "{}") };
  } catch {
    return { title: "", empty: "", emptySub: "", add: "", remove: "", close: "" };
  }
}

/** The drawer is replaced on every view-transition swap, so it is rebuilt when missing. */
function getPanel(): HTMLElement {
  const existing = doc.getElementById("wish-panel");
  if (existing) return existing;
  const t = readText();
  const panel = doc.createElement("div");
  panel.id = "wish-panel";
  panel.className = "wish";
  const scrim = doc.createElement("div");
  scrim.className = "wish__scrim";
  scrim.dataset.wishClose = "";
  const dialog = doc.createElement("aside");
  dialog.className = "wish__panel";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t.title);
  dialog.tabIndex = -1;
  const head = doc.createElement("header");
  head.className = "wish__head";
  const title = doc.createElement("h2");
  title.className = "wish__title";
  title.textContent = t.title;
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wish__close";
  closeBtn.dataset.wishClose = "";
  closeBtn.setAttribute("aria-label", t.close);
  closeBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  head.append(title, closeBtn);
  const list = doc.createElement("div");
  list.className = "wish__list";
  list.dataset.wishList = "";
  dialog.append(head, list);
  panel.append(scrim, dialog);
  doc.body.append(panel);
  void panel.offsetWidth; // a fresh panel: let the closed state apply first so the slide-in animates
  return panel;
}

function renderList() {
  const list = getPanel().querySelector<HTMLElement>("[data-wish-list]");
  if (list) render(list, api.items(), readText(), () => isOpen() && renderList());
}

export function open(opener: HTMLElement | null, wish: WishApi) {
  api = wish;
  const panel = getPanel();
  lastOpener = opener;
  renderList();
  panel.setAttribute("data-open", "");
  root.setAttribute("data-wish-open", "");
  panel.querySelector<HTMLElement>(".wish__close")?.focus({ preventScroll: true });
}

function closePanel(restoreFocus = true) {
  const panel = doc.getElementById("wish-panel");
  root.removeAttribute("data-wish-open");
  panel?.removeAttribute("data-open");
  if (restoreFocus && lastOpener?.isConnected) lastOpener.focus({ preventScroll: true });
  lastOpener = null;
}

doc.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest || !isOpen()) return;
  if (target.closest("[data-wish-close]")) return closePanel();
  const remove = target.closest<HTMLElement>("[data-wish-remove]");
  if (remove) return api.remove(remove.dataset.wishRemove ?? "");
  // Adding from the drawer: close it so the cart drawer (opened by shell.ts) is visible.
  if (target.closest("#wish-panel [data-add]")) closePanel(false);
});
doc.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen()) closePanel();
});
const again = () => isOpen() && renderList();
doc.addEventListener("gz-wish-change", again);
doc.addEventListener("gz-wish-render", again);
doc.addEventListener("astro:before-swap", () => closePanel(false));

export function render(list: HTMLElement, items: WishItem[], t: PanelText, again: () => void): void {
  const ids = items.map((i) => i.slug).join();
  if (ids && ids !== asked) {
    asked = ids;
    void load(items.map((i) => i.slug)).then(again); // one batched request, cached for this page view
  }
  list.replaceChildren();

  if (!items.length) {
    const empty = doc.createElement("div");
    empty.className = "wish__empty";
    const h = doc.createElement("p");
    h.className = "wish__empty-title";
    h.textContent = t.empty;
    const sub = doc.createElement("p");
    sub.className = "wish__empty-sub";
    sub.textContent = t.emptySub;
    empty.append(h, sub);
    list.append(empty);
    return;
  }

  for (const item of items) {
    const row = doc.createElement("div");
    row.className = "wish__row";

    if (item.img) {
      const thumb = doc.createElement("a");
      thumb.className = "wish__thumb";
      thumb.href = item.href;
      thumb.tabIndex = -1;
      thumb.setAttribute("aria-hidden", "true");
      const img = doc.createElement("img");
      img.className = "wish__img";
      img.src = item.img;
      img.alt = "";
      img.width = 64;
      img.height = 64;
      img.loading = "lazy";
      thumb.append(img);
      row.append(thumb);
    }

    const info = doc.createElement("div");
    const brand = doc.createElement("p");
    brand.className = "wish__brand";
    brand.textContent = item.brand;
    const name = doc.createElement("a");
    name.className = "wish__name";
    name.href = item.href;
    name.textContent = item.name;
    const price = doc.createElement("p");
    price.className = "wish__price";
    const v = wishPrice(price, item.slug, item.ml);
    info.append(brand, name, price);

    const actions = doc.createElement("div");
    actions.className = "wish__actions";
    const add = doc.createElement("button");
    add.type = "button";
    add.className = "wish__add";
    // shell.ts handles the click for [data-add]; this drawer only closes itself.
    add.dataset.add = "";
    add.dataset.item = JSON.stringify(item.cart);
    add.dataset.ml = String(item.ml);
    add.textContent = t.add;
    if (v) {
      add.dataset.price = String(v.price);
      add.dataset.sku = v.sku;
      if (v.available !== null) add.dataset.stock = String(v.available);
    } else add.disabled = true;
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "wish__remove";
    remove.dataset.wishRemove = item.slug;
    remove.textContent = t.remove;
    actions.append(add, remove);
    info.append(actions);

    row.append(info);
    list.append(row);
  }
}

document.addEventListener("astro:after-swap", () => (asked = ""));
