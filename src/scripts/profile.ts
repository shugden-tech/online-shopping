// Profile page (/profile/, /en/profile/): real customer accounts on the server (/api/account/*, docs/CONTRACTS.md §10).
//   signed out: sign-in / register tabs (phone + password; optional Google), forgot-password help
//   signed in : profile + avatar (client-side square crop), orders (live status), wishlist, addresses, password,
//               devices / sign out everywhere, Google link, delete account
// Built with createElement/textContent only: server and stored data are never parsed as HTML.
import { call, getMe, setMe, type Me } from "./account-api";
import { cleanName, cleanPhone } from "../lib/phone";
import { formatPrice } from "../lib/price";
import { fill, type Locale } from "../i18n/lite";

interface Strings {
  locale: Locale;
  self: string;
  shop: string;
  a: Record<string, string> & { err: Record<string, string> };
  shopLabel: string;
  ml: string;
  wishEmpty: string;
  wishEmptySub: string;
  err: Record<string, string>;
  status: Record<string, string>;
  co: Record<string, string>;
  districts: { id: string; label: string }[];
  siteKey: string;
  phone: string;
}

const doc = document;
const S: Strings = (() => {
  try {
    return JSON.parse(doc.getElementById("profile-i18n")?.textContent ?? "{}") as Strings;
  } catch {
    return {} as Strings;
  }
})();
const t = (k: string): string => S.a?.[k] ?? k;
const te = (code: string | undefined): string => (code && (S.a.err[code] ?? S.err[code])) || S.err.server || "";

/* ---------------- DOM helpers ---------------- */
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | string = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  const p = typeof props === "string" ? { class: props } : props;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = String(v);
    else if (k === "text") n.textContent = String(v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v as EventListener);
    else if (k in n && typeof v !== "string") (n as unknown as Record<string, unknown>)[k] = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

let uid = 0;
interface Field { wrap: HTMLDivElement; input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; err: HTMLParagraphElement }
function field(label: string, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, hint?: string): Field {
  const id = `pf-${++uid}`;
  input.id = id;
  const err = h("p", { class: "field-error", id: `${id}-e`, hidden: true });
  input.setAttribute("aria-describedby", `${id}-e`);
  const wrap = h("div", "field", h("label", { for: id, text: label }), input, hint ? h("p", { class: "pf-muted", text: hint }) : null, err);
  return { wrap, input, err };
}
const input = (type: string, name: string, extra: Record<string, unknown> = {}) => h("input", { class: "input", type, name, ...extra });
function setErr(f: Field, msg: string) {
  f.wrap.toggleAttribute("data-invalid", !!msg);
  f.input.setAttribute("aria-invalid", String(!!msg));
  f.err.textContent = msg;
  f.err.hidden = !msg;
}
const status = (cls = "") => h("p", { class: `pf-status ${cls}`, role: "status", "aria-live": "polite" });
function say(el: HTMLElement, msg: string, bad = false) {
  el.textContent = msg;
  el.classList.toggle("is-bad", bad);
}
function busy(btn: HTMLButtonElement, on: boolean) {
  btn.disabled = on;
  btn.toggleAttribute("aria-busy", on);
}
function section(title: string, id: string): { sec: HTMLElement; body: HTMLElement } {
  const body = h("div", "pf-sec__body");
  const sec = h("section", { class: "pf-sec", "aria-labelledby": id }, h("h2", { class: "t-title pf-sec__title", id, text: title }), body);
  return { sec, body };
}
function pwInput(name: string, autocomplete: string): HTMLInputElement {
  return input("password", name, { autocomplete, maxLength: 200, required: true }) as HTMLInputElement;
}
const toDate = (sqlite: string) => new Date(/Z|T/.test(sqlite) ? sqlite : `${sqlite.replace(" ", "T")}Z`);
function fmtDate(v: string, time = false): string {
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  if (S.locale === "mn") return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}${time ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : ""}`;
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) });
}

/* ---------------- entry ---------------- */
let pollTimer: number | undefined;
let googleOn = false;

async function init() {
  const root = doc.querySelector<HTMLElement>("[data-profile-root]");
  if (!root) return;
  window.clearInterval(pollTimer);
  const flash = takeFlash();
  root.replaceChildren(h("p", { class: "pf-muted pf-loading", text: "…" }));
  const r = await call<{ customer: Me | null; google: boolean }>("me");
  googleOn = r.data.google === true;
  const me = r.ok ? r.data.customer ?? null : null;
  setMe(me);
  root.replaceChildren();
  if (r.status === 0 && !me) root.append(h("p", { class: "pf-flash is-bad", role: "alert", text: te("network") }));
  if (me) renderAccount(root, me, flash);
  else renderAuth(root, flash);
}

/** ?google=<result> after the Google round trip: shown once, then removed from the address bar. */
function takeFlash(): { text: string; bad: boolean } | null {
  const u = new URL(location.href);
  const g = u.searchParams.get("google");
  if (!g) return null;
  u.searchParams.delete("google");
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  const map: Record<string, [string, boolean]> = {
    ok: ["googleOk", false], new: ["googleNew", false], linked: ["googleLinkedMsg", false],
    taken: ["googleTaken", true], cancelled: ["googleCancelled", true], error: ["googleError", true],
  };
  const m = map[g];
  return m ? { text: t(m[0]), bad: m[1] } : null;
}

function flashEl(f: { text: string; bad: boolean } | null) {
  return f ? h("p", { class: `pf-flash${f.bad ? " is-bad" : ""}`, role: f.bad ? "alert" : "status", text: f.text }) : "";
}

/* ---------------- signed out ---------------- */
function renderAuth(root: HTMLElement, flash: { text: string; bad: boolean } | null) {
  const card = h("div", "pf-card");
  const tabs = h("div", { class: "pf-tabs", role: "tablist", "aria-label": t("account") });
  const panels: HTMLElement[] = [];
  const btns: HTMLButtonElement[] = [];
  const show = (i: number, focus = false) => {
    btns.forEach((b, n) => {
      b.setAttribute("aria-selected", String(n === i));
      b.tabIndex = n === i ? 0 : -1;
      panels[n]!.hidden = n !== i;
    });
    if (focus) btns[i]!.focus();
    if (i === 1) mountTurnstile(panels[1]!);
  };
  [t("login"), t("register")].forEach((label, i) => {
    const b = h("button", { type: "button", role: "tab", class: "pf-tab", id: `pf-tab-${i}`, "aria-controls": `pf-panel-${i}`, text: label, onclick: () => show(i) });
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") show(1 - i, true);
    });
    btns.push(b);
    tabs.append(b);
  });
  panels.push(loginPanel(), registerPanel());
  panels.forEach((p, i) => {
    p.id = `pf-panel-${i}`;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", `pf-tab-${i}`);
  });
  card.append(h("h1", { class: "t-head pf-title", text: t("title") }), flashEl(flash), tabs, ...panels);
  if (googleOn) {
    const ret = encodeURIComponent(S.self);
    card.append(
      h("p", { class: "pf-or" }, h("span", { text: t("or") })),
      h("a", { class: "btn btn--block pf-google", href: `/api/account/google/start?mode=login&return=${ret}`, "data-google": "" }, googleMark(), h("span", { text: t("google") })),
    );
  }
  root.append(card);
  show(0);
}

function googleMark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const paths: [string, string][] = [
    ["#4285F4", "M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"],
    ["#34A853", "M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"],
    ["#FBBC05", "M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z"],
    ["#EA4335", "M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"],
  ];
  for (const [fillc, d] of paths) {
    const p = doc.createElementNS(ns, "path");
    p.setAttribute("fill", fillc);
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function loginPanel(): HTMLElement {
  const phone = field(t("phone"), input("tel", "phone", { autocomplete: "tel-national", inputMode: "tel", placeholder: "99112233", required: true }));
  const pw = field(t("password"), pwInput("password", "current-password"));
  const msg = status();
  const submit = h("button", { class: "btn btn--gold btn--block", type: "submit", text: t("submit") });
  const help = h("p", { class: "pf-muted pf-help", hidden: true, text: t("forgotHelp") });
  const forgot = h("button", {
    type: "button", class: "pf-link", text: t("forgot"), "aria-expanded": "false",
    onclick: () => {
      help.hidden = !help.hidden;
      forgot.setAttribute("aria-expanded", String(!help.hidden));
      void contactPhone().then((p) => (help.textContent = p ? `${t("forgotHelp")} ${p}` : t("forgotHelp")));
    },
  });
  const form = h("form", { class: "pf-form", noValidate: true }, phone.wrap, pw.wrap, msg, submit, forgot, help);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = cleanPhone(phone.input.value);
    setErr(phone, p ? "" : phone.input.value.trim() ? S.err.phone : S.err.required);
    setErr(pw, pw.input.value ? "" : S.err.required);
    say(msg, "");
    if (!p || !pw.input.value) return (p ? pw : phone).input.focus();
    busy(submit, true);
    const r = await call<{ customer: Me }>("login", { method: "POST", body: { phone: p, password: pw.input.value } });
    busy(submit, false);
    if (!r.ok) {
      say(msg, r.status === 0 ? te("network") : te(r.data.errors?.form ?? "invalid"), true);
      return;
    }
    await afterSignIn(r.data.customer);
  });
  return h("div", "pf-panel", h("p", { class: "t-body t-dim pf-prompt", text: t("loginPrompt") }), form);
}

let tsW: { reset(): void; remove(): void } | null = null;
let tsToken = "";
function mountTurnstile(panel: HTMLElement) {
  const box = panel.querySelector<HTMLElement>("[data-ts]");
  if (!box || box.hasAttribute("data-on")) return;
  box.setAttribute("data-on", "");
  void import("./turnstile")
    .then((m) => m.mount(box, S.siteKey, S.locale, "light", (tok) => (tsToken = tok)))
    .then((w) => (tsW = w))
    .catch(() => {});
}
function resetTurnstile() {
  tsToken = "";
  tsW?.reset();
}

function registerPanel(): HTMLElement {
  const name = field(t("name"), input("text", "name", { autocomplete: "name", maxLength: 60, required: true }));
  const phone = field(t("phone"), input("tel", "phone", { autocomplete: "tel-national", inputMode: "tel", placeholder: "99112233", required: true }));
  const pw = field(t("password"), pwInput("new-password", "new-password"), t("passwordHint"));
  const hp = h("input", { type: "text", name: "website", tabIndex: -1, autocomplete: "off", class: "pf-hp", "aria-hidden": "true" });
  const ts = h("div", { class: "pf-ts", "data-ts": "" });
  const msg = status();
  const submit = h("button", { class: "btn btn--gold btn--block", type: "submit", text: t("submitRegister") });
  const form = h("form", { class: "pf-form", noValidate: true }, name.wrap, phone.wrap, pw.wrap, hp, ts, msg, submit);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = cleanName(name.input.value);
    const p = cleanPhone(phone.input.value);
    const pv = pw.input.value;
    setErr(name, n ? "" : name.input.value.trim() ? S.err.name : S.err.required);
    setErr(phone, p ? "" : phone.input.value.trim() ? S.err.phone : S.err.required);
    setErr(pw, pv.length >= 8 ? "" : pv ? te("short") : S.err.required);
    say(msg, "");
    if (!n || !p || pv.length < 8) return;
    if (!tsToken) return say(msg, S.err.turnstileMissing || te("turnstile"), true);
    busy(submit, true);
    const r = await call<{ customer: Me; claimed: number }>("register", {
      method: "POST",
      body: { name: n, phone: p, password: pv, turnstileToken: tsToken, website: (hp as HTMLInputElement).value },
    });
    busy(submit, false);
    if (!r.ok) {
      resetTurnstile();
      const er = r.data.errors ?? {};
      if (er.phone) setErr(phone, er.phone === "taken" ? te("taken") : S.err.phone);
      if (er.password) setErr(pw, te(er.password));
      if (er.name) setErr(name, S.err.name);
      say(msg, r.status === 0 ? te("network") : er.form ? te(er.form) : er.turnstile ? te("turnstile") : er.phone || er.password || er.name ? "" : te(undefined), true);
      return;
    }
    await afterSignIn(r.data.customer, r.data.claimed);
  });
  return h("div", "pf-panel", h("p", { class: "t-body t-dim pf-prompt", text: t("registerPrompt") }), form);
}

let claimedNote = 0;
async function afterSignIn(me: Me, claimed = 0) {
  tsW?.remove();
  tsW = null;
  claimedNote = claimed;
  setMe(me);
  // merge the browser wishlist with the account's (and keep them in sync from now on)
  try {
    sessionStorage.removeItem("gz-wish-merged");
  } catch {
    /* ignore */
  }
  await import("./wish-sync").then((m) => m.mergeNow()).catch(() => {});
  await init();
}

let contactCache: Promise<string> | null = null;
function contactPhone(): Promise<string> {
  contactCache ??= fetch("/api/store/info")
    .then((r) => r.json() as Promise<{ contact?: { phone?: string } }>)
    .then((d) => d.contact?.phone || S.phone || "")
    .catch(() => S.phone || "");
  return contactCache;
}

/* ---------------- signed in ---------------- */
function renderAccount(root: HTMLElement, me: Me, flash: { text: string; bad: boolean } | null) {
  const av = avatarEl(me, 56);
  const out = h("button", {
    type: "button", class: "btn", text: t("logout"),
    onclick: async () => {
      busy(out, true);
      await call("logout", { method: "POST" });
      setMe(null);
      await init();
    },
  });
  root.append(
    h("div", "pf-head", h("div", "pf-head__who", av, h("h1", { class: "t-head pf-title", text: fill(t("hello"), { name: me.displayName || me.name || "" }) }))),
    flashEl(flash),
    claimedNote ? flashEl({ text: fill(t("claimed"), { n: claimedNote }), bad: false }) : "",
    me.mustChangePassword ? h("p", { class: "pf-flash is-bad", role: "alert", text: t("mustChange") }) : "",
  );
  claimedNote = 0;
  if (!me.phone) root.append(phoneCard());

  const prof = section(t("profile"), "pf-h-profile");
  profileSection(prof.body, me);
  prof.sec.append(h("div", "pf-logout", out));
  const orders = section(t("orders"), "pf-h-orders");
  ordersSection(orders.body);
  const wish = section(t("wishlist"), "pf-h-wish");
  renderWish(wish.body);
  const addr = section(t("addresses"), "pf-h-addr");
  addressesSection(addr.body);
  const sec = section(t("security"), "pf-h-sec");
  securitySection(sec.body, me);
  const del = section(t("deleteTitle"), "pf-h-del");
  deleteSection(del.body, me);
  del.sec.classList.add("pf-sec--danger");
  root.append(prof.sec, orders.sec, wish.sec, addr.sec, sec.sec, del.sec);
}

function avatarEl(me: Me, size: number): HTMLElement {
  const box = h("span", { class: "pf-avatar", style: `width:${size}px;height:${size}px` });
  if (me.avatarUrl) box.append(h("img", { src: me.avatarUrl, alt: "", width: size, height: size, decoding: "async" }));
  else box.textContent = ((me.displayName || me.name || "•").trim()[0] ?? "•").toUpperCase();
  return box;
}

const refreshMe = async () => {
  const me = await getMe(true);
  setMe(me);
  return me;
};

function phoneCard(): HTMLElement {
  const phone = field(t("phone"), input("tel", "phone", { autocomplete: "tel-national", inputMode: "tel", placeholder: "99112233", required: true }));
  const msg = status();
  const btn = h("button", { type: "submit", class: "btn btn--gold", text: t("phoneSave") });
  const form = h("form", { class: "pf-phone", noValidate: true }, h("p", { class: "pf-flash", text: t("phoneNeeded") }), phone.wrap, msg, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = cleanPhone(phone.input.value);
    setErr(phone, p ? "" : S.err.phone);
    if (!p) return;
    busy(btn, true);
    const r = await call<{ customer: Me; claimed?: number }>("me", { method: "PATCH", body: { phone: p } });
    busy(btn, false);
    if (!r.ok) return setErr(phone, r.data.errors?.phone === "taken" ? te("taken") : te(r.data.errors?.form));
    claimedNote = r.data.claimed ?? 0;
    setMe(r.data.customer);
    await init();
  });
  return form;
}

/* ----- profile + avatar ----- */
function profileSection(body: HTMLElement, me: Me) {
  body.append(avatarEditor(me));
  const name = field(t("name"), input("text", "name", { autocomplete: "name", maxLength: 60, value: me.name }));
  const dn = field(t("displayName"), input("text", "displayName", { autocomplete: "nickname", maxLength: 40, value: me.displayName }));
  const box = h("input", { type: "checkbox", name: "showOnBoard", checked: me.showOnBoard }) as HTMLInputElement;
  const check = h("label", "pf-check", box, h("span", { text: t("showOnBoard") }));
  const phone = field(t("phone"), input("tel", "phone", { autocomplete: "tel-national", inputMode: "tel", value: me.phone ?? "" }));
  const pw = field(t("password"), pwInput("current-password", "current-password"), t("phoneChangeNeedsPassword"));
  pw.input.required = false;
  pw.wrap.hidden = true;
  phone.input.addEventListener("input", () => (pw.wrap.hidden = !me.phone || cleanPhone(phone.input.value) === me.phone));
  const msg = status();
  const save = h("button", { type: "submit", class: "btn btn--gold", text: t("save") });
  const form = h("form", { class: "pf-form pf-form--wide", noValidate: true }, name.wrap, dn.wrap, check, phone.wrap, pw.wrap, msg, save);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = cleanName(name.input.value);
    setErr(name, n ? "" : S.err.name);
    const p = phone.input.value.trim() ? cleanPhone(phone.input.value) : null;
    setErr(phone, phone.input.value.trim() && !p ? S.err.phone : "");
    if (!n || (phone.input.value.trim() && !p)) return;
    const patch: Record<string, unknown> = { name: n, displayName: dn.input.value.trim() || n, showOnBoard: box.checked };
    if (p && p !== me.phone) {
      patch.phone = p;
      if (me.phone) patch.password = pw.input.value;
    }
    busy(save, true);
    const r = await call<{ customer: Me; claimed?: number }>("me", { method: "PATCH", body: patch });
    busy(save, false);
    if (!r.ok) {
      const er = r.data.errors ?? {};
      if (er.phone) setErr(phone, er.phone === "taken" ? te("taken") : S.err.phone);
      if (er.password) setErr(pw, te("wrong"));
      return say(msg, er.form ? te(er.form) : "", !!er.form);
    }
    me = r.data.customer;
    setMe(me);
    pw.input.value = "";
    pw.wrap.hidden = true;
    say(msg, r.data.claimed ? fill(t("claimed"), { n: r.data.claimed }) : t("saved"));
  });
  body.append(form);
}

function avatarEditor(me: Me): HTMLElement {
  const wrap = h("div", "pf-av");
  const msg = status();
  const fileIn = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", class: "sr-only", id: "pf-av-file" }) as HTMLInputElement;
  const draw = () => {
    wrap.replaceChildren();
    doc.querySelector(".pf-head .pf-avatar")?.replaceWith(avatarEl(me, 56));
    const actions = h("div", "pf-av__actions",
      h("label", { class: "btn btn--sm", for: "pf-av-file", text: t("avatarChoose") }),
      me.avatarUrl ? h("button", {
        type: "button", class: "btn btn--sm pf-btn-quiet", text: t("avatarRemove"),
        onclick: async () => {
          const r = await call<{ customer: Me }>("avatar", { method: "DELETE" });
          if (r.ok) {
            me = r.data.customer;
            setMe(me);
            draw();
          } else say(msg, te(r.data.errors?.form), true);
        },
      }) : null,
    );
    wrap.append(h("p", { class: "pf-label", text: t("avatar") }), h("div", "pf-av__row", avatarEl(me, 96), h("div", "pf-av__side", actions, h("p", { class: "pf-muted", text: t("avatarHint") }))), fileIn, msg);
  };
  fileIn.addEventListener("change", () => {
    const f = fileIn.files?.[0];
    fileIn.value = "";
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return say(msg, te("type"), true);
    if (f.size > 20 * 1024 * 1024) return say(msg, te("tooLarge"), true);
    cropper(wrap, f, async (blob) => {
      if (!blob) return draw();
      if (blob.size > 2 * 1024 * 1024) {
        draw();
        return say(msg, te("tooLarge"), true);
      }
      const fd = new FormData();
      fd.append("file", blob, `avatar.${blob.type === "image/webp" ? "webp" : "jpg"}`);
      const r = await call<{ customer: Me }>("avatar", { method: "POST", form: fd });
      if (!r.ok) {
        draw();
        const c = r.data.errors?.file;
        return say(msg, c === "type" ? te("type") : c === "too_large" ? te("tooLarge") : te(r.data.errors?.form), true);
      }
      me = r.data.customer;
      setMe(me);
      draw();
      say(msg, t("saved"));
    }, () => say(msg, te("type"), true));
  });
  draw();
  return wrap;
}

/**
 * Square crop on a canvas: drag to move, slider to zoom. Saves a 512×512 WebP (JPEG where WebP encoding is not
 * supported). `done(null)` = cancelled.
 */
function cropper(wrap: HTMLElement, file: File, done: (b: Blob | null) => void, bad: () => void) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onerror = () => {
    URL.revokeObjectURL(url);
    bad();
  };
  img.onload = () => {
    const VIEW = 280;
    const canvas = h("canvas", { width: VIEW, height: VIEW, class: "pf-crop__canvas", "aria-label": t("avatar") }) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    let zoom = 1;
    let cx = img.naturalWidth / 2;
    let cy = img.naturalHeight / 2;
    const rect = () => {
      const s = side / zoom;
      cx = Math.min(Math.max(cx, s / 2), img.naturalWidth - s / 2);
      cy = Math.min(Math.max(cy, s / 2), img.naturalHeight - s / 2);
      return { sx: cx - s / 2, sy: cy - s / 2, s };
    };
    const paint = () => {
      const r = rect();
      ctx.clearRect(0, 0, VIEW, VIEW);
      ctx.drawImage(img, r.sx, r.sy, r.s, r.s, 0, 0, VIEW, VIEW);
    };
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const k = rect().s / canvas.getBoundingClientRect().width;
      cx -= (e.clientX - drag.x) * k;
      cy -= (e.clientY - drag.y) * k;
      drag = { x: e.clientX, y: e.clientY };
      paint();
    });
    const end = () => (drag = null);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    const range = h("input", { type: "range", min: "1", max: "4", step: "0.01", value: "1", class: "pf-crop__zoom", id: "pf-zoom" }) as HTMLInputElement;
    range.addEventListener("input", () => {
      zoom = Number(range.value) || 1;
      paint();
    });
    const finish = (b: Blob | null) => {
      URL.revokeObjectURL(url);
      done(b);
    };
    const save = h("button", {
      type: "button", class: "btn btn--gold btn--sm", text: t("avatarSave"),
      onclick: () => {
        busy(save, true);
        const out = h("canvas", { width: 512, height: 512 }) as HTMLCanvasElement;
        const r = rect();
        out.getContext("2d")!.drawImage(img, r.sx, r.sy, r.s, r.s, 0, 0, 512, 512);
        out.toBlob((b) => {
          if (b && b.type === "image/webp") return finish(b);
          out.toBlob((j) => finish(j), "image/jpeg", 0.88);
        }, "image/webp", 0.88);
      },
    });
    const cancel = h("button", { type: "button", class: "btn btn--sm pf-btn-quiet", text: t("cancel"), onclick: () => finish(null) });
    wrap.replaceChildren(
      h("p", { class: "pf-label", text: t("avatar") }),
      h("div", "pf-crop", canvas, h("label", { class: "pf-crop__label", for: "pf-zoom", text: t("avatarZoom") }), range, h("div", "pf-av__actions", save, cancel)),
    );
    paint();
  };
  img.src = url;
}

/* ----- orders ----- */
interface MyOrder {
  orderNo: string; createdAt: string; status: string; paymentStatus: string; total: number;
  items: { brand: string; name: string; ml: number; qty: number; price: number; bundle?: { nameMn: string; nameEn: string | null } }[];
  shipment: { status: string; trackingNo: string | null; trackingUrl: string | null } | null;
}

function ordersSection(body: HTMLElement) {
  const list = h("div", "pf-orders-wrap");
  const refresh = h("button", { type: "button", class: "pf-link", text: t("refresh"), onclick: () => void load() });
  body.append(list, refresh);
  const load = async () => {
    const r = await call<{ items: MyOrder[] }>("orders");
    if (!r.ok) {
      if (!list.childElementCount) list.append(h("p", { class: "pf-muted", text: te(r.status === 0 ? "network" : r.data.errors?.form) }));
      return;
    }
    renderOrders(list, r.data.items ?? []);
  };
  void load();
  // live status: re-check every minute while the page is visible
  pollTimer = window.setInterval(() => {
    if (doc.visibilityState === "visible" && list.isConnected) void load();
  }, 60_000);
}

function renderOrders(body: HTMLElement, orders: MyOrder[]) {
  body.replaceChildren();
  if (!orders.length) return void body.append(h("p", { class: "t-body t-dim", text: t("noOrders") }));
  const ul = h("ul", "pf-orders");
  for (const o of orders) {
    const qty = o.items.reduce((n, i) => n + i.qty, 0);
    const pay = o.paymentStatus === "paid" ? t("paid") : o.paymentStatus === "refunded" ? t("refunded") : t("unpaid");
    const lines = h("ul", "pf-order__lines");
    for (const i of o.items) {
      const name = i.bundle ? (S.locale === "en" && i.bundle.nameEn) || i.bundle.nameMn : `${i.brand} ${i.name} ${i.ml} ${S.ml}`;
      lines.append(h("li", { text: `${name} × ${i.qty}` }));
    }
    const track = o.shipment?.trackingNo
      ? o.shipment.trackingUrl && /^https:\/\//.test(o.shipment.trackingUrl)
        ? h("a", { href: o.shipment.trackingUrl, rel: "noopener noreferrer", target: "_blank", text: `${t("tracking")}: ${o.shipment.trackingNo}` })
        : h("span", { text: `${t("tracking")}: ${o.shipment.trackingNo}` })
      : null;
    ul.append(
      h("li", { class: "pf-order", "data-order": o.orderNo },
        h("div", "pf-order__meta",
          h("strong", { text: `${t("orderNo")} ${o.orderNo}` }),
          h("span", { class: "pf-muted", text: `${fmtDate(o.createdAt)} · ${qty} ${t("items")}` }),
        ),
        h("div", "pf-order__state",
          h("span", { class: `pf-badge pf-badge--${o.status}`, text: S.status[o.status] ?? o.status }),
          h("span", { class: "pf-muted", text: `${t("payStatus")}: ${pay}` }),
        ),
        h("strong", { class: "pf-order__total", text: formatPrice(o.total, S.locale) }),
        h("details", "pf-order__more", h("summary", { text: `${qty} ${t("items")}` }), lines, track),
      ),
    );
  }
  const sum = orders.filter((o) => o.status !== "cancelled").reduce((n, o) => n + o.total, 0);
  body.append(ul, h("p", "pf-order__sum", h("span", { text: t("total") }), h("strong", { text: formatPrice(sum, S.locale) })));
}

/* ----- wishlist (browser list, kept in sync with the account by wish-sync.ts) ----- */
interface WishCard { slug: string; brand: string; name: string; href: string; img?: string; ml: number }
const safeHref = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.startsWith("//");
const safeImg = (v: unknown): v is string => typeof v === "string" && (v.startsWith("https://") || safeHref(v));
function readWish(): WishCard[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem("gz_wish") ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is WishCard => {
      if (!x || typeof x !== "object") return false;
      const i = x as Record<string, unknown>;
      return typeof i.slug === "string" && typeof i.brand === "string" && typeof i.name === "string" && typeof i.ml === "number" && safeHref(i.href) && (i.img === undefined || safeImg(i.img));
    });
  } catch {
    return [];
  }
}
function renderWish(body: HTMLElement) {
  const draw = () => {
    body.replaceChildren();
    const items = readWish();
    if (!items.length) {
      body.append(h("p", { class: "t-body t-dim", text: S.wishEmpty }), h("p", { class: "pf-muted", text: S.wishEmptySub }), h("a", { class: "btn btn--sm", href: S.shop, text: S.shopLabel }));
      return;
    }
    const grid = h("ul", "pf-grid");
    for (const w of items) {
      grid.append(h("li", "pf-card-item",
        w.img ? h("img", { class: "pf-card-item__img", src: w.img, alt: "", width: 160, height: 160, loading: "lazy", decoding: "async" }) : null,
        h("p", { class: "pf-brand", text: w.brand }),
        h("a", { class: "pf-card-item__name", href: w.href, text: w.name }),
        h("p", { class: "pf-muted", text: `${w.ml} ${S.ml}` }),
      ));
    }
    body.append(grid);
  };
  draw();
  doc.addEventListener("gz-wish-reload", () => body.isConnected && draw());
  doc.addEventListener("gz-wish-change", () => body.isConnected && draw());
}

/* ----- addresses ----- */
interface Address { id: number; label: string; city: "ub" | "countryside"; district: string; khoroo: string; address: string; isDefault: boolean }

function addressesSection(body: HTMLElement) {
  const list = h("div", "pf-addr");
  const msg = status();
  let items: Address[] = [];
  const draw = () => {
    list.replaceChildren();
    if (!items.length) list.append(h("p", { class: "pf-muted", text: t("noAddresses") }));
    const ul = h("ul", "pf-addr__list");
    for (const a of items) {
      const district = a.city === "ub" ? S.districts.find((d) => d.id === a.district)?.label ?? a.district : a.district;
      const li = h("li", { class: "pf-addr__item", "data-address": a.id });
      li.append(
        h("div", "pf-addr__text",
          h("strong", { text: a.label || (a.city === "ub" ? S.co.ub : S.co.countryside) }),
          a.isDefault ? h("span", { class: "pf-badge", text: t("addressDefault") }) : null,
          h("p", { class: "pf-muted", text: [district, a.khoroo, a.address].filter(Boolean).join(", ") }),
        ),
        h("div", "pf-addr__actions",
          !a.isDefault ? h("button", { type: "button", class: "pf-link", text: t("makeDefault"), onclick: () => void save(a.id, { isDefault: true }) }) : null,
          h("button", { type: "button", class: "pf-link", text: t("edit"), onclick: () => li.replaceChildren(addressForm(a, (v) => save(a.id, v), draw)) }),
          h("button", { type: "button", class: "pf-link pf-link--bad", text: t("remove"), onclick: () => void remove(a.id) }),
        ),
      );
      ul.append(li);
    }
    if (items.length) list.append(ul);
    if (items.length < 10) {
      const add = h("button", { type: "button", class: "btn btn--sm", text: t("addressAdd") });
      add.addEventListener("click", () => add.replaceWith(addressForm(null, (v) => save(null, v), draw)));
      list.append(add);
    }
  };
  const save = async (id: number | null, v: Record<string, unknown>): Promise<Record<string, string> | null> => {
    const r = await call<{ items: Address[] }>(id ? `addresses/${id}` : "addresses", { method: id ? "PATCH" : "POST", body: v });
    if (!r.ok) {
      say(msg, r.data.errors?.form ? te(r.data.errors.form) : "", true);
      return r.data.errors ?? { form: "server" };
    }
    items = r.data.items;
    say(msg, t("saved"));
    draw();
    return null;
  };
  const remove = async (id: number) => {
    const r = await call<{ items: Address[] }>(`addresses/${id}`, { method: "DELETE" });
    if (!r.ok) return say(msg, te(r.data.errors?.form), true);
    items = r.data.items;
    draw();
  };
  body.append(list, msg);
  void call<{ items: Address[] }>("addresses").then((r) => {
    if (r.ok) items = r.data.items;
    draw();
  });
}

function addressForm(a: Address | null, submit: (v: Record<string, unknown>) => Promise<Record<string, string> | null>, cancel: () => void): HTMLElement {
  const label = field(t("addressLabel"), input("text", "label", { maxLength: 40, value: a?.label ?? "" }));
  let city: "ub" | "countryside" = a?.city ?? "ub";
  const sel = h("select", { class: "select", name: "district" }, h("option", { value: "", text: S.co.districtSelect }), ...S.districts.map((d) => h("option", { value: d.id, text: d.label }))) as HTMLSelectElement;
  sel.value = a?.city === "ub" ? a.district : "";
  const district = field(S.co.district, sel);
  const province = field(S.co.province, input("text", "province", { maxLength: 80, value: a?.city === "countryside" ? a.district : "" }));
  const khoroo = field(S.co.khoroo, input("text", "khoroo", { maxLength: 40, value: a?.khoroo ?? "" }));
  const addr = field(S.co.address, h("textarea", { class: "textarea", name: "address", rows: 3, maxLength: 300, autocomplete: "street-address" }) as HTMLTextAreaElement);
  addr.input.value = a?.address ?? "";
  const def = h("input", { type: "checkbox", name: "isDefault", checked: a?.isDefault ?? false }) as HTMLInputElement;
  const cities = h("div", { class: "pf-cities", role: "radiogroup", "aria-label": S.co.city });
  const sync = () => {
    district.wrap.hidden = city !== "ub";
    khoroo.wrap.hidden = city !== "ub";
    province.wrap.hidden = city === "ub";
  };
  for (const c of ["ub", "countryside"] as const) {
    const r = h("input", { type: "radio", name: `city-${uid}`, value: c, checked: c === city, onchange: () => ((city = c), sync()) });
    cities.append(h("label", "pf-city", r, h("span", { class: "chip", text: S.co[c] })));
  }
  sync();
  const save = h("button", { type: "submit", class: "btn btn--gold btn--sm", text: t("save") });
  const form = h("form", { class: "pf-form pf-addr__form", noValidate: true },
    label.wrap, cities, district.wrap, province.wrap, khoroo.wrap, addr.wrap,
    h("label", "pf-check", def, h("span", { text: t("addressDefault") })),
    h("div", "pf-av__actions", save, h("button", { type: "button", class: "btn btn--sm pf-btn-quiet", text: t("cancel"), onclick: cancel })),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = {
      label: label.input.value.trim(), city,
      district: city === "ub" ? sel.value : province.input.value.trim(),
      khoroo: city === "ub" ? khoroo.input.value.trim() : "",
      address: addr.input.value.trim(),
      ...(def.checked ? { isDefault: true } : {}),
    };
    setErr(district, city === "ub" && !v.district ? S.err.district : "");
    setErr(province, city === "countryside" && v.district.length < 2 ? S.err.province : "");
    setErr(addr, v.address.length < 5 ? S.err.address : "");
    if ((city === "ub" && !v.district) || (city === "countryside" && v.district.length < 2) || v.address.length < 5) return;
    busy(save, true);
    const errs = await submit(v);
    busy(save, false);
    if (errs) {
      if (errs.district) setErr(city === "ub" ? district : province, S.err[errs.district] ?? S.err.required);
      if (errs.address) setErr(addr, S.err[errs.address] ?? S.err.address);
    }
  });
  return form;
}

/* ----- password, devices, Google ----- */
function securitySection(body: HTMLElement, me: Me) {
  // password
  const cur = field(t("passwordCurrent"), pwInput("current-password", "current-password"));
  const next = field(t("passwordNew"), pwInput("new-password", "new-password"), t("passwordHint"));
  const msg = status();
  const btn = h("button", { type: "submit", class: "btn btn--gold", text: me.hasPassword ? t("changePassword") : t("setPassword") });
  const pwForm = h("form", { class: "pf-form pf-form--wide", noValidate: true, "aria-label": t("changePassword") },
    h("input", { type: "text", name: "username", autocomplete: "username", value: me.phone ?? "", hidden: true }),
    me.hasPassword ? cur.wrap : null, next.wrap, msg, btn);
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setErr(cur, me.hasPassword && !cur.input.value ? S.err.required : "");
    setErr(next, next.input.value.length >= 8 ? "" : te("short"));
    if ((me.hasPassword && !cur.input.value) || next.input.value.length < 8) return;
    busy(btn, true);
    const r = await call("password", { method: "POST", body: { current: cur.input.value, next: next.input.value } });
    busy(btn, false);
    if (!r.ok) {
      const er = r.data.errors ?? {};
      if (er.current) setErr(cur, te("wrong"));
      if (er.next) setErr(next, te(er.next));
      return say(msg, er.form ? te(er.form) : "", !!er.form);
    }
    cur.input.value = next.input.value = "";
    say(msg, t("passwordChanged"));
    const fresh = await refreshMe();
    if (fresh && (fresh.hasPassword !== me.hasPassword || me.mustChangePassword)) void init();
    void loadSessions();
  });
  body.append(h("h3", { class: "pf-sub", text: me.hasPassword ? t("changePassword") : t("setPassword") }), pwForm);

  // devices
  const devs = h("ul", "pf-devs");
  const loadSessions = async () => {
    const r = await call<{ items: { current: boolean; lastSeen: string; device: string }[] }>("sessions");
    if (!r.ok) return;
    devs.replaceChildren(...r.data.items.map((d) => h("li", "pf-dev",
      h("span", { text: d.device || "—" }),
      h("span", { class: "pf-muted", text: d.current ? t("thisDevice") : `${t("lastSeen")} ${fmtDate(d.lastSeen, true)}` }),
    )));
  };
  void loadSessions();
  const all = h("button", {
    type: "button", class: "btn", text: t("logoutAll"),
    onclick: async () => {
      busy(all, true);
      await call("logout-all", { method: "POST" });
      setMe(null);
      await init();
    },
  });
  body.append(h("h3", { class: "pf-sub", text: t("sessions") }), devs, all);

  // Google
  if (googleOn || me.google) {
    const gmsg = status();
    const row = h("div", "pf-google-row", h("span", { text: me.google ? `${t("googleLinked")}${me.email ? ` · ${me.email}` : ""}` : t("googleNotLinked") }));
    if (me.google) {
      const un = h("button", {
        type: "button", class: "btn btn--sm", text: t("googleUnlink"), disabled: !me.hasPassword || !me.phone,
        onclick: async () => {
          const r = await call<{ customer: Me }>("google/unlink", { method: "POST" });
          if (!r.ok) return say(gmsg, r.data.errors?.form === "no-password" ? t("googleUnlinkNeedPw") : te(r.data.errors?.form), true);
          setMe(r.data.customer);
          void init();
        },
      });
      row.append(un);
      if (!me.hasPassword || !me.phone) say(gmsg, t("googleUnlinkNeedPw"));
    } else if (googleOn) {
      row.append(h("a", { class: "btn btn--sm pf-google", href: `/api/account/google/start?mode=link&return=${encodeURIComponent(S.self)}` }, googleMark(), h("span", { text: t("googleLink") })));
    }
    body.append(h("h3", { class: "pf-sub", text: t("googleTitle") }), row, gmsg);
  }
}

/* ----- delete ----- */
function deleteSection(body: HTMLElement, me: Me) {
  const pw = field(t("password"), pwInput("current-password", "current-password"));
  const box = h("input", { type: "checkbox", name: "confirm" }) as HTMLInputElement;
  const msg = status();
  const btn = h("button", { type: "submit", class: "btn pf-btn-bad", text: t("deleteConfirm") });
  const form = h("form", { class: "pf-form pf-form--wide", noValidate: true },
    h("p", { class: "pf-muted", text: t("deleteText") }),
    me.hasPassword ? pw.wrap : null,
    h("label", "pf-check", box, h("span", { text: t("deleteCheck") })), msg, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!box.checked) return say(msg, te("confirm"), true);
    if (me.hasPassword && !pw.input.value) return setErr(pw, S.err.required);
    busy(btn, true);
    const r = await call("delete", { method: "POST", body: me.hasPassword ? { password: pw.input.value } : { confirm: true } });
    busy(btn, false);
    if (!r.ok) {
      if (r.data.errors?.password) return setErr(pw, te("wrong"));
      return say(msg, te(r.data.errors?.form ?? r.data.errors?.confirm), true);
    }
    setMe(null);
    await init();
    const root = doc.querySelector("[data-profile-root] .pf-card");
    root?.prepend(h("p", { class: "pf-flash", role: "status", text: t("deleted") }));
  });
  body.append(form);
}

// runs once per rendered page (the first load fires both the module and astro:page-load)
let booted: Element | null = null;
function boot() {
  const root = doc.querySelector("[data-profile-root]");
  if (!root || root === booted) return;
  booted = root;
  void init();
}
boot();
doc.addEventListener("astro:page-load", boot);
doc.addEventListener("astro:before-swap", () => window.clearInterval(pollTimer));
