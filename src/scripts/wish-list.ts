// Wishlist drawer rows (loaded lazily by wishlist.ts): saved items with their live price and an add button.
// No price is stored with the wishlist; the first render asks the live store state for these products.
import { load, wishPrice } from "./live-prices";
import type { PanelText, WishItem } from "./wishlist";

const doc = document;
let asked = "";

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
