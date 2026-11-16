// Profile page (demo account): signed-out sign-in form, or the signed-in view with orders, wishlist and top-customer opt-in.
// Built with createElement/textContent only: stored data is never parsed as HTML.
// Storage lives in src/lib/account.ts; the wishlist is only read here (key `gz_wish`, owned by wishlist.ts).
import { getAccount, setAccount, clearAccount, getOrders, cleanName, cleanPhone, type Account, type Order } from "../lib/account";
import { formatPrice } from "../lib/price";
import { fill, type Locale } from "../i18n/lite";

interface ProfileStrings {
  locale: Locale;
  shop: string;
  a: Record<string, string>;
  shopLabel: string;
  ml: string;
  wishEmpty: string;
  wishEmptySub: string;
  err: { required: string; name: string; phone: string; server: string };
}

interface WishCard {
  slug: string;
  brand: string;
  name: string;
  href: string;
  img?: string;
  ml: number;
  price: number;
}

const doc = document;
const ACCOUNT_EVENT = "gz-account-change";

const readStrings = (): ProfileStrings => {
  try {
    return JSON.parse(doc.getElementById("profile-i18n")?.textContent ?? "{}") as ProfileStrings;
  } catch {
    return { locale: "mn", shop: "/delguur/", a: {}, shopLabel: "", ml: "", wishEmpty: "", wishEmptySub: "", err: { required: "", name: "", phone: "", server: "" } };
  }
};
const S = readStrings();
const t = (key: string): string => S.a[key] ?? "";

/* ---------- safety checks for stored values ---------- */
const safeHref = (h: unknown): h is string => typeof h === "string" && h.startsWith("/") && !h.startsWith("//");
const safeImg = (s: unknown): s is string =>
  typeof s === "string" && (s.startsWith("https://") || (s.startsWith("/") && !s.startsWith("//")));

function readWish(): WishCard[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem("gz_wish") ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is WishCard => {
      if (!x || typeof x !== "object") return false;
      const i = x as Record<string, unknown>;
      return (
        typeof i.slug === "string" && typeof i.brand === "string" && typeof i.name === "string" &&
        typeof i.ml === "number" && typeof i.price === "number" && safeHref(i.href) &&
        (i.img === undefined || safeImg(i.img))
      );
    });
  } catch {
    return [];
  }
}

/* ---------- DOM helpers ---------- */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const notifyHeader = () => doc.dispatchEvent(new Event(ACCOUNT_EVENT));

/* ---------- signed-out: sign-in form ---------- */
function renderSignedOut(root: HTMLElement) {
  const card = el("div", "pf-card");
  card.append(el("h1", "t-head pf-title", t("login")), el("p", "t-body t-dim pf-prompt", t("loginPrompt")));

  const form = el("form", "pf-form");
  form.noValidate = true;
  form.setAttribute("aria-label", t("login"));

  const nameField = makeField("pf-name", t("name"), "text", "name", "given-name");
  const phoneField = makeField("pf-phone", t("phone"), "tel", "tel", "tel-national");
  phoneField.input.inputMode = "tel";
  phoneField.input.placeholder = "99112233";

  const submit = el("button", "btn btn--gold btn--block", t("submit"));
  submit.type = "submit";
  const status = el("p", "field-error pf-status");
  status.setAttribute("role", "alert");
  status.hidden = true;

  form.append(nameField.field, phoneField.field, status, submit);
  const demo = el("p", "pf-muted", t("demoNote"));
  card.append(form, demo);
  root.append(card);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const rawName = nameField.input.value;
    const rawPhone = phoneField.input.value;
    const name = cleanName(rawName);
    const phone = cleanPhone(rawPhone);
    const nameErr = name ? "" : rawName.trim() ? S.err.name : S.err.required;
    const phoneErr = phone ? "" : rawPhone.trim() ? S.err.phone : S.err.required;
    setFieldError(nameField, nameErr);
    setFieldError(phoneField, phoneErr);
    status.hidden = true;
    if (nameErr || phoneErr || !name || !phone) {
      (nameErr ? nameField.input : phoneField.input).focus();
      return;
    }
    const account: Account = { name, phone, displayName: name, showOnBoard: false, createdAt: new Date().toISOString() };
    if (!setAccount(account)) {
      status.textContent = S.err.server;
      status.hidden = false;
      return;
    }
    notifyHeader();
    init();
  });
}

interface Field {
  field: HTMLDivElement;
  input: HTMLInputElement;
  error: HTMLParagraphElement;
}

function makeField(id: string, label: string, type: string, name: string, autocomplete: string): Field {
  const field = el("div", "field");
  const lab = el("label", undefined, label);
  lab.htmlFor = id;
  const input = el("input", "input");
  input.id = id;
  input.type = type;
  input.name = name;
  input.setAttribute("autocomplete", autocomplete);
  input.setAttribute("data-field", id);
  const error = el("p", "field-error");
  error.id = `${id}-error`;
  error.hidden = true;
  input.setAttribute("aria-describedby", error.id);
  field.append(lab, input, error);
  return { field, input, error };
}

function setFieldError(f: Field, msg: string) {
  f.field.toggleAttribute("data-invalid", Boolean(msg));
  f.input.setAttribute("aria-invalid", String(Boolean(msg)));
  f.error.textContent = msg;
  f.error.hidden = !msg;
}

/* ---------- signed-in ---------- */
function section(title: string): { sec: HTMLElement; body: HTMLElement } {
  const sec = el("section", "pf-sec");
  const h = el("h2", "t-title t-gold", title);
  const body = el("div", "pf-sec__body");
  sec.append(h, body);
  return { sec, body };
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // 2026.11.16 for Mongolian (toLocaleDateString("mn") falls back to 11/16/2026 in many browsers)
  if (S.locale === "mn") return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

function renderOrders(orders: Order[], body: HTMLElement) {
  const sorted = orders.slice().sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) {
    body.append(el("p", "t-body t-dim", t("noOrders")));
    return;
  }
  const list = el("ul", "pf-orders");
  for (const o of sorted) {
    const li = el("li", "pf-order");
    const qty = o.items.reduce((n, i) => n + i.qty, 0);
    const meta = el("div", "pf-order__meta");
    meta.append(el("strong", undefined, `${t("orderNo")} ${o.no}`), el("span", "pf-muted", fmtDate(o.date)));
    li.append(meta, el("span", "pf-muted", `${qty} ${t("items")}`), el("strong", "pf-order__total", formatPrice(o.total, S.locale)));
    list.append(li);
  }
  const sum = sorted.reduce((n, o) => n + o.total, 0);
  const total = el("p", "pf-order__sum");
  total.append(el("span", undefined, t("total")), el("strong", undefined, formatPrice(sum, S.locale)));
  body.append(list, total);
}

function renderWish(body: HTMLElement) {
  const items = readWish();
  if (!items.length) {
    body.append(el("p", "t-body t-dim", S.wishEmpty), el("p", "pf-muted", S.wishEmptySub));
    const link = el("a", "btn btn--sm", S.shopLabel);
    link.href = S.shop;
    body.append(link);
    return;
  }
  const grid = el("ul", "pf-grid");
  for (const w of items) {
    const li = el("li", "pf-card-item");
    if (w.img) {
      const img = el("img", "pf-card-item__img");
      img.src = w.img;
      img.alt = "";
      img.width = 160;
      img.height = 160;
      img.loading = "lazy";
      img.decoding = "async";
      li.append(img);
    }
    const brand = el("p", "pf-brand", w.brand);
    const name = el("a", "pf-card-item__name", w.name);
    name.href = w.href;
    const price = el("p", "pf-muted", `${w.ml} ${S.ml} · ${formatPrice(w.price, S.locale)}`);
    li.append(brand, name, price);
    grid.append(li);
  }
  body.append(grid);
}

let savedTimer: number | undefined;

function renderBoard(acc: Account, body: HTMLElement) {
  const form = el("form", "pf-board");
  const check = el("label", "pf-check");
  const box = el("input");
  box.type = "checkbox";
  box.id = "pf-show";
  box.checked = acc.showOnBoard;
  check.htmlFor = box.id;
  check.append(box, el("span", undefined, t("showOnBoard")));

  const dn = makeField("pf-display", t("displayName"), "text", "displayName", "nickname");
  dn.input.value = acc.displayName;
  dn.input.maxLength = 40;

  const save = el("button", "btn btn--gold", t("save"));
  save.type = "submit";
  const status = el("p", "pf-saved");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  form.append(check, dn.field, save, status);
  body.append(form);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const current = getAccount();
    if (!current) return;
    const next: Account = {
      ...current,
      showOnBoard: box.checked,
      displayName: dn.input.value.trim().slice(0, 40) || current.name,
    };
    if (!setAccount(next)) {
      status.textContent = S.err.server;
      return;
    }
    dn.input.value = next.displayName;
    notifyHeader();
    status.textContent = t("saved");
    window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => (status.textContent = ""), 2000);
  });
}

function renderSignedIn(root: HTMLElement, acc: Account) {
  const head = el("div", "pf-head");
  head.append(el("h1", "t-head pf-title", fill(t("hello"), { name: acc.name })));
  const out = el("button", "btn", t("logout"));
  out.type = "button";
  out.addEventListener("click", () => {
    clearAccount();
    notifyHeader();
    init();
  });
  head.append(out);

  const demo = el("p", "pf-muted pf-demo", t("demoNote"));
  root.append(head, demo);

  const orders = section(t("orders"));
  renderOrders(getOrders(), orders.body);
  const wish = section(t("wishlist"));
  renderWish(wish.body);
  const board = section(t("board"));
  renderBoard(acc, board.body);
  root.append(orders.sec, wish.sec, board.sec);
}

/* ---------- entry ---------- */
function init() {
  const root = doc.querySelector<HTMLElement>("[data-profile-root]");
  if (!root) return;
  root.replaceChildren();
  const acc = getAccount();
  if (acc) renderSignedIn(root, acc);
  else renderSignedOut(root);
}

init();
doc.addEventListener("astro:page-load", init);
