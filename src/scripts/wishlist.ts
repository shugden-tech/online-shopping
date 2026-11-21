// Client-side wishlist: heart buttons on product cards, a count badge in the header, and a drawer listing saved items.
// Items live in localStorage (`gz_wish`), with a memory fallback when storage is blocked. When signed in (hint
// cookie gz_in=1) ./wish-sync is loaded lazily and mirrors the list to the account (merge on sign-in).
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
  doc.dispatchEvent(new CustomEvent("gz-wish-change", { detail: items }));
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
}

function removeItem(slug: string) {
  items = items.filter((i) => i.slug !== slug);
  write();
  sync();
}

/* ---------- drawer: built and driven by ./wish-list, loaded on the first open ---------- */
const isOpen = () => root.hasAttribute("data-wish-open");
let drawer: Promise<typeof import("./wish-list")> | null = null;
const api = { items: () => items, remove: removeItem };

doc.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest) return;
  const wishToggle = target.closest<HTMLElement>("[data-wish-toggle]");
  if (wishToggle) return toggle(wishToggle);
  const opener = target.closest<HTMLElement>("[data-wish-open]:not(html)");
  if (opener) void (drawer ??= import("./wish-list")).then((m) => m.open(opener, api));
});

const reload = () => {
  items = read();
  sync();
  if (isOpen()) doc.dispatchEvent(new Event("gz-wish-render"));
};
window.addEventListener("storage", (e) => {
  if (e.key === null || e.key === KEY) reload();
});
// ./wish-sync wrote the merged account list
doc.addEventListener("gz-wish-reload", reload);
if (/(?:^|;\s*)gz_in=1(?:;|$)/.test(doc.cookie)) void import("./wish-sync");

doc.addEventListener("astro:page-load", sync);
sync();
