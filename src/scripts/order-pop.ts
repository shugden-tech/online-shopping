// «Захиалгаар» popover for unpriced products. Loaded lazily by shell.ts / AddToCart on the first click, so it
// costs nothing on pages where nobody uses it. It never touches the cart or the wishlist: it only shows the
// contact actions the owner has filled in (Header.astro puts them into #live-i18n as `orderLinks`).
interface OrderText {
  orderNote: string; orderClose: string; orderCall: string; orderMessenger: string; orderInstagram: string; orderTelegram: string;
  order: string; orderLinks?: { k: string; href: string }[];
}

const doc = document;
let pop: HTMLElement | null = null;
let trigger: HTMLElement | null = null;
let n = 0;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function text(): OrderText {
  try {
    return JSON.parse(doc.getElementById("live-i18n")?.textContent ?? "{}") as OrderText;
  } catch {
    return {} as OrderText;
  }
}

function ensureStyle() {
  if (doc.getElementById("order-pop-css")) return;
  const st = doc.createElement("style");
  st.id = "order-pop-css";
  st.textContent = `
.opop{position:absolute;z-index:80;width:min(300px,calc(100vw - 24px));box-sizing:border-box;padding:14px 14px 12px;border-radius:10px;background:#fff;color:#1a1a1a;border:1px solid #1a1a1a;box-shadow:0 12px 32px rgba(0,0,0,.18);font-size:13.5px;line-height:1.45}
.opop__head{display:flex;gap:10px;align-items:flex-start}
.opop__ico{flex:none;color:#b08d57;transform-origin:50% 0}
.opop__note{margin:0}
.opop__acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.opop__a,.opop__x{min-height:40px;display:inline-flex;align-items:center;justify-content:center;padding:0 12px;border-radius:6px;font-size:12.5px;font-weight:600;text-decoration:none;cursor:pointer}
.opop__a{background:#1a1a1a;color:#fff;border:1px solid #1a1a1a}
.opop__x{background:transparent;color:#1a1a1a;border:1px solid #d6d3ce;margin-left:auto}
.opop__a:focus-visible,.opop__x:focus-visible{outline:2px solid #b08d57;outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.opop{animation:opop-in .18s ease-out}}
@keyframes opop-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-color-scheme:dark){html[data-theme="dark"] .opop{background:#1c1c1c;color:#f3f1ee;border-color:#f3f1ee}}`;
  doc.head.append(st);
}

function place() {
  if (!pop || !trigger) return;
  const r = trigger.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(12, Math.min(r.left, doc.documentElement.clientWidth - w - 12));
  // below the button, or above it when there is no room
  const below = r.bottom + 8 + h <= innerHeight || r.top < h + 16;
  pop.style.left = `${left + scrollX}px`;
  pop.style.top = `${(below ? r.bottom + 8 : r.top - h - 8) + scrollY}px`;
}

/** Short, tasteful cue (≤ 700 ms): the button pulses a ring, the bag icon wiggles. Skipped for reduced motion. */
function animate(btn: HTMLElement, ico: Element | null) {
  if (reduced() || !btn.animate) return;
  btn.animate(
    [{ boxShadow: "0 0 0 0 rgba(176,141,87,.55)" }, { boxShadow: "0 0 0 12px rgba(176,141,87,0)" }],
    { duration: 600, easing: "ease-out" },
  );
  (btn.querySelector("svg") ?? ico)?.animate?.(
    [{ transform: "rotate(0)" }, { transform: "rotate(-14deg)" }, { transform: "rotate(12deg)" }, { transform: "rotate(-6deg)" }, { transform: "rotate(0)" }],
    { duration: 600, easing: "ease-in-out" },
  );
}

export function closeOrder(restoreFocus = true) {
  if (!pop) return;
  pop.remove();
  pop = null;
  doc.removeEventListener("keydown", onKey, true);
  doc.removeEventListener("pointerdown", onOutside, true);
  removeEventListener("resize", place);
  removeEventListener("scroll", place, true);
  doc.removeEventListener("astro:after-swap", onSwap);
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus({ preventScroll: true });
  trigger = null;
}
const onSwap = () => closeOrder(false);
function onOutside(e: Event) {
  const t = e.target as Node | null;
  if (pop && t && !pop.contains(t) && !trigger?.contains(t)) closeOrder(false);
}
function onKey(e: KeyboardEvent) {
  if (!pop) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    closeOrder();
    return;
  }
  if (e.key !== "Tab") return;
  // non-modal dialog: tabbing past either end hands focus back to the button and closes it
  const items = [...pop.querySelectorAll<HTMLElement>("a,button")];
  const at = doc.activeElement;
  if ((!e.shiftKey && at === items[items.length - 1]) || (e.shiftKey && at === items[0])) {
    e.preventDefault();
    closeOrder();
  }
}

export function toggleOrder(btn: HTMLElement) {
  const was = trigger;
  if (pop) closeOrder(false);
  if (was === btn) return; // second click closes
  const tx = text();
  ensureStyle();
  trigger = btn;
  const id = `opop-${++n}`;
  const p = doc.createElement("div");
  p.className = "opop";
  p.id = id;
  p.setAttribute("role", "dialog");
  p.setAttribute("aria-labelledby", `${id}-t`);

  const head = doc.createElement("div");
  head.className = "opop__head";
  head.innerHTML = '<svg class="opop__ico" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 21a2 2 0 004 0"/></svg>';
  const note = doc.createElement("p");
  note.className = "opop__note";
  note.id = `${id}-t`;
  note.textContent = tx.orderNote ?? "";
  head.append(note);

  const acts = doc.createElement("div");
  acts.className = "opop__acts";
  const labels: Record<string, string> = { call: tx.orderCall, messenger: tx.orderMessenger, instagram: tx.orderInstagram, telegram: tx.orderTelegram };
  for (const l of (tx.orderLinks ?? []).slice(0, 3)) {
    const a = doc.createElement("a");
    a.className = "opop__a";
    a.href = l.href;
    a.textContent = labels[l.k] ?? l.k;
    if (!l.href.startsWith("tel:")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    acts.append(a);
  }
  const x = doc.createElement("button");
  x.type = "button";
  x.className = "opop__x";
  x.textContent = tx.orderClose ?? "×";
  x.addEventListener("click", () => closeOrder());
  acts.append(x);
  p.append(head, acts);

  doc.body.append(p);
  pop = p;
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-controls", id);
  place();
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onOutside, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  doc.addEventListener("astro:after-swap", onSwap);
  (acts.querySelector<HTMLElement>("a") ?? x).focus({ preventScroll: true });
  animate(btn, head.firstElementChild);
}
