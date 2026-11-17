// Global page behaviour: header state, mobile menu, cart badge, quick-add buttons, scroll reveal.
// Loaded once; everything re-binds on `astro:page-load` because of view transitions.
import { effect } from "@preact/signals-core";
import "./motion";
import "./wishlist";
import { addItem, cartCount, cartOpen, cartPulse, type CartItem } from "../lib/cart";

const doc = document;
const root = doc.documentElement;

/* ---------- cart badge ---------- */
function syncBadge() {
  const n = cartCount.value;
  doc.querySelectorAll<HTMLElement>("[data-cart-count]").forEach((el) => {
    el.textContent = n > 99 ? "99+" : String(n);
    el.toggleAttribute("data-empty", n === 0);
  });
  doc.querySelectorAll<HTMLElement>("[data-cart-open][data-label]").forEach((el) => {
    el.setAttribute("aria-label", (el.dataset.label ?? "").replace("{n}", String(n)));
  });
}
effect(syncBadge);

let pulseSeen = cartPulse.value;
effect(() => {
  const p = cartPulse.value;
  if (p === pulseSeen) return;
  pulseSeen = p;
  doc.querySelectorAll<HTMLElement>("[data-cart-open]:not(html)").forEach((el) => {
    el.classList.remove("is-pulse");
    void el.offsetWidth; // restart the animation
    el.classList.add("is-pulse");
  });
});

/* ---------- cart drawer: Preact + drawer code load on first intent, not on page load ---------- */
let drawer: Promise<typeof import("./cart-mount")> | null = null;
function loadDrawer() {
  drawer ??= import("./cart-mount");
  return drawer;
}
effect(() => {
  if (cartOpen.value) void loadDrawer().then((m) => m.mountCart());
});
/* ---------- live prices: product cards and the header's featured items get their numbers from the API ---------- */
let livePage = false;
function livePrices() {
  if (livePage) return;
  livePage = true;
  void import("./live-prices").then((m) => m.run());
}

const warm = (e: Event) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("[data-cart-open],[data-add],[data-warm-cart]")) void loadDrawer();
  if (t?.closest?.("[data-header]")) livePrices();
};
doc.addEventListener("pointerover", warm, { passive: true });
doc.addEventListener("focusin", warm);
doc.addEventListener("touchstart", warm, { passive: true });

/* ---------- header: transparent over the hero, solid after 40px ---------- */
let ticking = false;
function syncHeader() {
  ticking = false;
  doc.querySelector("[data-header]")?.toggleAttribute("data-scrolled", window.scrollY > 40);
}
window.addEventListener(
  "scroll",
  () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(syncHeader);
    }
  },
  { passive: true },
);

/* ---------- mobile menu ---------- */
function setMenu(open: boolean) {
  const menu = doc.getElementById("mobile-menu");
  const btn = doc.querySelector<HTMLElement>("[data-menu-toggle]");
  if (!menu || !btn) return;
  root.toggleAttribute("data-menu-open", open);
  menu.toggleAttribute("inert", !open);
  doc.querySelector(".mmenu__backdrop")?.toggleAttribute("inert", !open);
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-label", (open ? btn.dataset.closeLabel : btn.dataset.openLabel) ?? "");
  if (open) menu.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
}
const menuOpen = () => root.hasAttribute("data-menu-open");

/* ---------- delegated clicks ---------- */
doc.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest) return;

  if (menuOpen() && (target.closest("[data-menu-close]") || !target.closest("#mobile-menu, [data-menu-toggle]"))) {
    e.preventDefault();
    setMenu(false);
    doc.querySelector<HTMLElement>("[data-menu-toggle]")?.focus({ preventScroll: true });
    return;
  }

  // Sample picker: use the same explicit toggle state for mouse, touch and keyboard.
  const decToggle = target.closest<HTMLElement>("[data-decant-toggle]");
  const openDec = doc.querySelectorAll<HTMLElement>("[data-decants].is-open");
  openDec.forEach((box) => {
    if (box.contains(target) && !target.closest("[data-add]") && !decToggle) return;
    box.classList.remove("is-open");
    const toggle = box.querySelector<HTMLElement>("[data-decant-toggle]");
    toggle?.setAttribute("aria-expanded", "false");
    if (toggle?.dataset.openLabel) {
      toggle.setAttribute("aria-label", toggle.dataset.openLabel);
      toggle.setAttribute("title", toggle.dataset.openLabel);
    }
  });
  if (decToggle) {
    const box = decToggle.closest<HTMLElement>("[data-decants]");
    if (box && ![...openDec].includes(box)) {
      box.classList.add("is-open");
      decToggle.setAttribute("aria-expanded", "true");
      if (decToggle.dataset.closeLabel) {
        decToggle.setAttribute("aria-label", decToggle.dataset.closeLabel);
        decToggle.setAttribute("title", decToggle.dataset.closeLabel);
      }
    }
    return;
  }

  if (target.closest("[data-menu-toggle]")) {
    setMenu(!menuOpen());
    return;
  }
  if (menuOpen() && target.closest("#mobile-menu a")) setMenu(false);

  const opener = target.closest("[data-cart-open]:not(html)");
  if (opener) {
    if (menuOpen()) setMenu(false);
    cartOpen.value = true;
    return;
  }

  // size chips on a product card: switch the shown price and what the add button adds
  const chip = target.closest<HTMLElement>("[data-size-chip]");
  if (chip) {
    const card = chip.closest<HTMLElement>("[data-card]");
    if (!card || chip.hasAttribute("disabled")) return;
    card.querySelectorAll("[data-size-chip]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    const price = card.querySelector<HTMLElement>("[data-card-price]");
    if (price) price.textContent = chip.dataset.priceLabel ?? "";
    const add = card.querySelector<HTMLElement>("[data-add]");
    if (add) {
      add.dataset.ml = chip.dataset.ml;
      add.dataset.price = chip.dataset.price;
      if (add.dataset.labelTpl) add.setAttribute("aria-label", add.dataset.labelTpl.replace("{ml}", chip.dataset.ml ?? ""));
    }
    return;
  }

  // quick add: <button data-add data-item='{"slug":…}' data-ml="2" data-price="15000">
  const add = target.closest<HTMLElement>("[data-add]");
  if (add && !add.hasAttribute("disabled")) {
    try {
      const base = JSON.parse(add.dataset.item ?? "{}") as Omit<CartItem, "qty" | "ml" | "price">;
      const ml = Number(add.dataset.ml);
      const price = Number(add.dataset.price);
      const stock = add.dataset.stock === undefined ? undefined : Number(add.dataset.stock);
      // data-price is set only from the live store state (live-prices.ts): no live price, no add
      if (base.slug && ml > 0 && price > 0) addItem({ ...base, ml, price, sku: add.dataset.sku, ...(stock !== undefined ? { stock } : {}) });
    } catch {
      /* malformed data attribute: ignore */
    }
  }
});

doc.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen()) {
    setMenu(false);
    doc.querySelector<HTMLElement>("[data-menu-toggle]")?.focus();
  }
});

/* ---------- scroll reveal ---------- */
let io: IntersectionObserver | null = null;
function initReveal() {
  io?.disconnect();
  const els = doc.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)");
  if (!els.length) return;
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-in"));
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("is-in");
          io?.unobserve(en.target);
        }
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.08 },
  );
  els.forEach((el) => io!.observe(el));
}

doc.addEventListener("astro:page-load", () => {
  // the drawer root is replaced on every navigation: re-mount it if the code is already here
  if (drawer) void drawer.then((m) => m.mountCart());
  livePage = false;
  if (doc.querySelector("[data-pid]")) livePrices();
  syncBadge();
  syncHeader();
  initReveal();
});
doc.addEventListener("astro:before-swap", () => {
  root.removeAttribute("data-menu-open");
  cartOpen.value = false;
});

// Not needed for first paint: loaded after the page so they stay out of the initial JS budget.
void import("./account-badge");
