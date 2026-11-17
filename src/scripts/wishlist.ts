// Client-side wishlist: heart buttons on product cards, a count badge in the header, and a drawer listing saved items.
// Items live in localStorage (`gz_wish`), with a memory fallback when storage is blocked.
import "../styles/wishlist.css";
import type { CartItem } from "../lib/cart";

export interface WishItem {
  slug: string;
  brand: string;
  name: string;
  href: string;
  img?: string;
  ml: number;
  /** Old saves carried a build-time price; it is never shown (the drawer shows the live one). */
  price?: number;
  /** The cart base object (what shell.ts needs to add this item to the cart). */
  cart: Omit<CartItem, "qty" | "ml" | "price">;
}

export interface PanelText {
  title: string;
  empty: string;
  emptySub: string;
  add: string;
  remove: string;
  close: string;
}

const KEY = "gz_wish";
const doc = document;
const root = doc.documentElement;

const isItem = (v: unknown): v is WishItem => {
  if (!v || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  // href must be a site path (no javascript: or other-site links); img, when present, must be http(s) or a site path
  const safeHref = typeof i.href === "string" && i.href.startsWith("/") && !i.href.startsWith("//");
  const safeImg = i.img === undefined || (typeof i.img === "string" && /^(https:\/\/|\/(?!\/))/.test(i.img));
  return typeof i.slug === "string" && typeof i.ml === "number" && typeof i.cart === "object" && i.cart !== null && safeHref && safeImg;
};

function read(): WishItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
}

let items: WishItem[] = read();

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage blocked: keep working in memory */
  }
}

const parseItem = (el: HTMLElement): WishItem | null => {
  try {
    const v: unknown = JSON.parse(el.dataset.wishItem ?? "null");
    return isItem(v) ? v : null;
  } catch {
    return null;
  }
};

const has = (slug: string) => items.some((i) => i.slug === slug);

/* ---------- sync badge + heart buttons ---------- */
function sync() {
  const n = items.length;
  doc.querySelectorAll<HTMLElement>("[data-wish-count]").forEach((el) => {
    el.textContent = n > 99 ? "99+" : String(n);
    el.toggleAttribute("data-empty", n === 0);
  });
  doc.querySelectorAll<HTMLElement>("[data-wish-toggle]").forEach((btn) => {
    const slug = parseItem(btn)?.slug ?? btn.closest<HTMLElement>("[data-card]")?.dataset.slug ?? "";
    const on = has(slug);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", (on ? btn.dataset.labelRemove : btn.dataset.labelAdd) ?? "");
  });
}

/* A soft pulse on the header heart when something is added (wishlist.ts owns the badge sync). */
function pulseHeaderWish() {
  const btn = doc.querySelector<HTMLElement>(".hdr__wish");
  if (!btn) return;
  btn.classList.remove("is-glow");
  void btn.offsetWidth; // restart if the hearts are clicked in quick succession
  btn.classList.add("is-glow");
  const done = () => btn.classList.remove("is-glow");
  btn.addEventListener("animationend", done, { once: true });
  setTimeout(done, 1200);
}

function toggle(btn: HTMLElement) {
  const item = parseItem(btn);
  if (!item) return;
  const wasOn = has(item.slug);
  items = wasOn ? items.filter((i) => i.slug !== item.slug) : [...items, item];
  write();
  sync();
  if (!wasOn) pulseHeaderWish();
  if (isOpen()) renderList();
}

function removeItem(slug: string) {
  items = items.filter((i) => i.slug !== slug);
  write();
  sync();
  renderList();
}

/* ---------- drawer ---------- */
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
  return panel;
}

/** The saved rows (with live prices) are drawn by ./wish-list, loaded the first time the drawer opens. */
let rows: typeof import("./wish-list") | null = null;
function renderList() {
  const list = getPanel().querySelector<HTMLElement>("[data-wish-list]");
  if (!list) return;
  if (rows) rows.render(list, items, readText(), () => isOpen() && renderList());
  else void import("./wish-list").then((m) => {
    rows = m;
    renderList();
  });
}

function openPanel(opener: HTMLElement | null) {
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

/* ---------- events ---------- */
doc.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest) return;

  const wishToggle = target.closest<HTMLElement>("[data-wish-toggle]");
  if (wishToggle) {
    toggle(wishToggle);
    return;
  }

  const opener = target.closest<HTMLElement>("[data-wish-open]:not(html)");
  if (opener) {
    openPanel(opener);
    return;
  }

  if (!isOpen()) return;

  if (target.closest("[data-wish-close]")) {
    closePanel();
    return;
  }

  const remove = target.closest<HTMLElement>("[data-wish-remove]");
  if (remove) {
    removeItem(remove.dataset.wishRemove ?? "");
    return;
  }

  // Adding from the drawer: close it so the cart drawer (opened by shell.ts) is visible.
  if (target.closest("#wish-panel [data-add]")) closePanel(false);
});

doc.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen()) closePanel();
});

window.addEventListener("storage", (e) => {
  if (e.key !== null && e.key !== KEY) return;
  items = read();
  sync();
  if (isOpen()) renderList();
});

doc.addEventListener("astro:before-swap", () => closePanel(false));
doc.addEventListener("astro:page-load", () => {
  getPanel();
  sync();
});

getPanel();
sync();
