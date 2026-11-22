// Success / order-tracking page (loaded lazily by SuccessView): payment instructions from POST /api/orders
// (QPay QR + links, or bank details), order lookup (POST /api/orders/lookup), the hold-expiry
// countdown for unpaid orders, shipment tracking, and QPay payment polling (POST /api/orders/{no}/payment-check).
// Wire (0008): direct QR mode shows Wire's QR (an SVG the server drew from next_action.qr.text) and the bank-app
// deeplinks right here; the hosted fallback is a "Төлөх" button to pay.wire.mn (or Wire's redirect URL). Either way the
// order is polled the same way (the server reads the PaymentIntent back from Wire; only its webhook / read-back marks paid).
import { clearCart } from "../lib/cart";
import { formatPrice } from "../lib/price";
import type { PaymentInstructions } from "../lib/contracts";

const NO_RE = /^GZ-\d{6}-[A-Z2-9]{4}$/;
const LAST_ORDER_SLOT = "gz-last-order"; // { no, phone } from checkout-key.ts
const LAST_PAY_SLOT = "gz-last-pay"; // LastPayment from cart-checkout.ts
// QPay polling backs off: payment-check allows 10 calls per IP per 10 minutes, so 9 scheduled checks
// (frequent first, while the customer is most likely paying) leave one for the manual "check" button.
// The QPay callback normally marks the order paid long before polling would notice.
const POLL_DELAYS_S = [5, 10, 15, 30, 45, 60, 90, 150, 195];
/** Only Wire's own hosted checkout host is followed. */
const wireUrl = (u: string | null | undefined): string | null => {
  try {
    const x = u ? new URL(u) : null;
    return x && x.protocol === "https:" && (x.hostname === "pay.wire.mn" || x.hostname.endsWith(".wire.mn")) ? x.href : null;
  } catch {
    return null;
  }
};

interface Lookup {
  ok: boolean;
  orderNo: string;
  status: string;
  paymentStatus?: string;
  holdExpiresAt?: string | null;
  shipment?: { status: string; trackingNo: string | null; trackingUrl: string | null } | null;
  items: { brand: string; name: string; ml: number; qty: number; price: number; bundle?: { parts: { brand: string; name: string; ml: number; qty: number }[] } }[];
  total: number;
  /** While unpaid: the instructions stored on the server (e.g. Wire's QR after a reload / in a new tab). */
  payment?: PaymentInstructions | null;
}
interface LastPayment { no: string; total: number | null; holdExpiresAt: string | null; payment: PaymentInstructions | null; paymentError: string | null }
type S = Record<string, string> & { status: Record<string, string>; payment: Record<string, string>; ship: Record<string, string> };

const doc = document;
let timers: number[] = [];
const stopAll = () => {
  timers.forEach((id) => window.clearInterval(id));
  timers = [];
};
doc.addEventListener("astro:before-swap", stopAll);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function readJson<T>(slot: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(slot) ?? "null") as T | null;
  } catch {
    return null;
  }
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or ISO → epoch ms. */
export function parseUtc(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
const safeHttps = (u: string | null | undefined): string | null => {
  try {
    return u && new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
};
/** Bank-app deep links may use their own scheme; never script/data/file ones. */
const safeLink = (u: string): string | null => {
  try {
    return /^(javascript|data|vbscript|file|blob):$/i.test(new URL(u).protocol) ? null : u;
  } catch {
    return null;
  }
};
/** QPay's qr_image is base64 PNG; also accept a data: image or an https URL. */
export function qrSrc(img: string | null): string | null {
  if (!img) return null;
  const v = img.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) return v;
  if (safeHttps(v)) return v;
  if (/^[A-Za-z0-9+/=\s]{40,}$/.test(v)) return `data:image/png;base64,${v.replace(/\s+/g, "")}`;
  return null;
}

async function lookup(no: string, phone: string): Promise<Lookup | number> {
  try {
    const res = await fetch("/api/orders/lookup", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ orderNo: no, phone }),
      cache: "no-store",
    });
    if (!res.ok) return res.status;
    return (await res.json()) as Lookup;
  } catch {
    return 0;
  }
}
async function paymentCheck(no: string, phone: string): Promise<{ paymentStatus?: string; status?: string; payment?: PaymentInstructions } | number> {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(no)}/payment-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) return res.status;
    return (await res.json()) as { paymentStatus?: string; status?: string; payment?: PaymentInstructions };
  } catch {
    return 0;
  }
}

export function init(root: HTMLElement): void {
  stopAll();
  const locale = root.dataset.locale === "en" ? "en" : "mn";
  const money = (n: number) => formatPrice(n, locale);
  let t: S;
  try {
    t = JSON.parse(doc.getElementById("ok-i18n")?.textContent ?? "{}") as S;
  } catch {
    return;
  }
  const no = (new URLSearchParams(location.search).get("no") ?? "").trim().toUpperCase();
  const form = root.querySelector<HTMLFormElement>("[data-track-form]")!;
  const out = form.querySelector<HTMLElement>("[data-track-out]")!;
  const noInput = form.elements.namedItem("no") as HTMLInputElement;
  const phoneInput = form.elements.namedItem("phone") as HTMLInputElement;
  const payBox = root.querySelector<HTMLElement>("[data-pay]")!;
  const payState = root.querySelector<HTMLElement>("[data-pay-state]")!;

  /* ---------- countdown for an unpaid order's stock hold ---------- */
  let holdTimer = 0;
  const holdBoxes = () => [...root.querySelectorAll<HTMLElement>("[data-hold]")];
  function startHold(until: number | null) {
    window.clearInterval(holdTimer);
    if (until === null) {
      holdBoxes().forEach((b) => (b.hidden = true));
      return;
    }
    const tick = () => {
      const left = until - Date.now();
      const txt = left <= 0
        ? t.holdExpired
        : t.holdLeft.replace("{time}", `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`);
      holdBoxes().forEach((b) => (b.textContent = txt));
      if (left <= 0) window.clearInterval(holdTimer);
    };
    tick();
    holdTimer = window.setInterval(tick, 1000);
    timers.push(holdTimer);
  }
  const unpaid = (r: { status?: string; paymentStatus?: string }) =>
    (r.paymentStatus === "unpaid" || r.paymentStatus === "pending") && (r.status === "new" || r.status === "confirmed");

  /* ---------- lookup result: status, payment, hold, shipment, items ---------- */
  function render(r: Lookup) {
    out.replaceChildren();
    const rows = el("dl", "ok__track-rows");
    const row = (k: string, v: string | Node, attr?: string) => {
      const d = el("div");
      if (attr) d.setAttribute(attr, "");
      const dd = el("dd");
      dd.append(v);
      d.append(el("dt", undefined, k), dd);
      rows.append(d);
    };
    if (r.paymentStatus) row(t.paymentLabel, t.payment[r.paymentStatus] ?? r.paymentStatus, "data-payment-status");
    if (r.shipment) {
      const s = r.shipment;
      row(t.shipLabel, t.ship[s.status] ?? s.status, "data-ship-status");
      if (s.trackingNo) row(t.trackingNo, el("span", "ok__mono", s.trackingNo), "data-tracking-no");
      const url = safeHttps(s.trackingUrl);
      if (url) {
        const a = el("a", "text-link", t.trackLink);
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.dataset.trackingUrl = "";
        row(t.shipLabel, a);
      }
    }
    out.append(el("p", "ok__track-status", `${t.statusLabel}: ${t.status[r.status] ?? r.status}`), rows);
    if (unpaid(r) && r.status === "new" && r.holdExpiresAt) {
      const h = el("p", "ok__hold");
      h.dataset.hold = "";
      out.append(h);
    }
    const ul = el("ul", "ok__track-items t-small");
    for (const i of r.items ?? []) {
      const parts = i.bundle ? ` (${i.bundle.parts.map((p) => `${p.brand} ${p.name} ${p.ml} ${t.ml}`).join(", ")})` : "";
      ul.append(el("li", undefined, `${i.brand} ${i.name}${parts} · ${i.ml} ${t.ml} × ${i.qty} — ${money(i.price * i.qty)}`));
    }
    out.append(ul, el("p", undefined, `${t.amount}: ${money(r.total)}`));
    startHold(unpaid(r) && r.status === "new" ? parseUtc(r.holdExpiresAt) : null);
  }
  const message = (code: number) => {
    out.textContent = code === 404 || code === 422 ? t.trackNotFound : code === 429 ? t.trackRate : t.trackError;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = noInput.value.trim().toUpperCase();
    const ph = phoneInput.value.replace(/\D/g, "");
    if (!NO_RE.test(n) || ph.length < 6) return message(422);
    out.textContent = t.trackLoading;
    const r = await lookup(n, ph);
    if (typeof r === "number") message(r);
    else render(r);
  });

  if (!NO_RE.test(no)) {
    root.querySelector<HTMLElement>("[data-ok-missing]")!.hidden = false;
    return;
  }
  noInput.value = no;
  root.querySelector<HTMLElement>("[data-ok-found]")!.hidden = false;
  root.querySelector("[data-order-no]")!.textContent = no;

  const last = readJson<{ no: string; phone: string }>(LAST_ORDER_SLOT);
  if (!last || last.no !== no) return; // someone else's link: the tracking form is enough
  clearCart();
  phoneInput.value = last.phone;
  const pay = readJson<LastPayment>(LAST_PAY_SLOT);
  const mine = pay && pay.no === no ? pay : null;

  /* ---------- payment instructions ---------- */
  const amountRow = (total: number | null): HTMLElement | null => {
    if (total === null) return null;
    const d = el("div");
    d.dataset.amountRow = "";
    const dd = el("dd");
    dd.append(el("span", "ok__amount", money(total)), copyBtn(String(total)));
    d.append(el("dt", undefined, t.amount), dd);
    return d;
  };
  function copyBtn(value: string) {
    const b = el("button", "ok__copy", t.copy);
    b.type = "button";
    b.dataset.copyValue = value;
    return b;
  }
  function bank(p: Extract<PaymentInstructions, { method: "bank" }>, total: number | null) {
    const dl = el("dl", "ok__rows");
    const a = amountRow(total);
    if (a) dl.append(a);
    const add = (k: string, v: string, copy = false, mono = false) => {
      const d = el("div");
      const dd = el("dd");
      dd.append(el("span", mono ? "ok__mono" : undefined, v));
      if (copy) dd.append(copyBtn(v.replace(/\s+/g, "")));
      d.append(el("dt", undefined, k), dd);
      dl.append(d);
    };
    add(t.bank, p.bank);
    add(t.account, p.account, true, true);
    add(t.accountName, p.holder);
    add(t.reference, p.reference, true, true);
    payBox.dataset.method = "bank";
    payBox.replaceChildren(el("h2", "t-title", t.payTitle), dl, el("p", "t-small ok__note", t.bankNote ?? ""));
  }
  function qpay(p: Extract<PaymentInstructions, { method: "qpay" }>, total: number | null) {
    payBox.dataset.method = "qpay";
    const parts: Node[] = [el("h2", "t-title", t.qpayTitle)];
    const a = amountRow(total);
    if (a) {
      const dl = el("dl", "ok__rows");
      dl.append(a);
      parts.push(dl);
    }
    const src = qrSrc(p.qrImage);
    if (src) {
      const fig = el("figure", "ok__qr");
      const img = el("img");
      img.src = src;
      img.alt = t.qpayTitle;
      img.width = 220;
      img.height = 220;
      img.dataset.qr = "";
      fig.append(img, el("figcaption", "t-small t-dim", t.qpayScan));
      parts.push(fig);
    }
    const short = safeHttps(p.shortUrl);
    if (short) {
      const l = el("a", "btn btn--gold ok__qlink", t.qpayLink);
      l.href = short;
      l.target = "_blank";
      l.rel = "noopener noreferrer";
      l.dataset.qpayShort = "";
      parts.push(l);
    }
    const links = (p.urls ?? []).map((u) => ({ ...u, link: safeLink(u.link) })).filter((u) => u.link);
    if (links.length) {
      const box = el("details", "ok__apps");
      box.append(el("summary", undefined, t.qpayApps));
      const ul = el("ul");
      for (const u of links) {
        const li = el("li");
        const l = el("a", "ok__app");
        l.href = u.link!;
        l.rel = "noopener noreferrer";
        const logo = safeHttps(u.logo);
        if (logo) {
          const i = el("img");
          i.src = logo;
          i.alt = "";
          i.width = 28;
          i.height = 28;
          i.loading = "lazy";
          l.append(i);
        }
        l.append(el("span", undefined, u.name));
        li.append(l);
        ul.append(li);
      }
      box.append(ul);
      parts.push(box);
    }
    payBox.replaceChildren(...parts);
  }
  function wire(p: Extract<PaymentInstructions, { method: "wire" }>, total: number | null) {
    payBox.dataset.method = "wire";
    payBox.dataset.wireMode = p.mode ?? "hosted";
    const parts: Node[] = [el("h2", "t-title", t.wireTitle)];
    const a = amountRow(total);
    if (a) {
      const dl = el("dl", "ok__rows");
      dl.append(a);
      parts.push(dl);
    }
    const src = p.mode === "qr" ? qrSrc(p.qr?.image ?? null) : null;
    if (src) {
      const fig = el("figure", "ok__qr");
      const img = el("img");
      img.src = src;
      img.alt = t.wireTitle;
      img.width = 220;
      img.height = 220;
      img.dataset.wireQr = "";
      fig.append(img, el("figcaption", "t-small t-dim", t.wireScan));
      parts.push(fig);
      const links = (p.qr?.deeplinks ?? []).map((u) => ({ name: u.name, link: safeLink(u.link) })).filter((u) => u.link);
      if (links.length) {
        const box = el("div", "ok__apps ok__apps--open");
        box.append(el("p", "ok__apps-title", t.wireApps));
        const ul = el("ul");
        for (const u of links) {
          const li = el("li");
          const l = el("a", "ok__app", u.name);
          l.href = u.link!;
          l.rel = "noopener noreferrer";
          l.dataset.wireApp = "";
          li.append(l);
          ul.append(li);
        }
        box.append(ul);
        parts.push(box);
      }
      parts.push(el("p", "t-small ok__note", t.wireAuto));
    } else if (p.mode === "poll" || p.mode === "qr") {
      parts.push(el("p", "t-small ok__note", t.wirePreparing));
    } else {
      const href = p.mode === "redirect" ? safeHttps(p.checkoutUrl) : wireUrl(p.checkoutUrl);
      if (href) {
        const l = el("a", "btn btn--gold ok__qlink", t.wirePay);
        l.href = href;
        l.rel = "noopener noreferrer";
        l.dataset.wirePay = "";
        parts.push(l, el("p", "t-small ok__note", t.wireNote));
      } else parts.push(el("p", "t-small ok__note", t.wireError));
    }
    payBox.replaceChildren(...parts);
  }
  let shown = "";
  function show(p: PaymentInstructions | null, total: number | null) {
    // polling hands back the same instructions every time: only redraw when they changed (no QR flicker)
    const key = JSON.stringify([p, total]);
    if (key === shown && !payBox.hidden) return;
    shown = key;
    if (p?.method === "bank") bank(p, total);
    else if (p?.method === "qpay") qpay(p, total);
    else if (p?.method === "wire") wire(p, total);
    payBox.hidden = !p;
  }

  /* ---------- QPay: invoice failed → retry; unpaid → poll every 5 s for up to 10 min ---------- */
  let total = mine?.total ?? null;
  let pollTimer = 0;
  const say = (text: string, ...extra: Node[]) => {
    payState.replaceChildren(el("span", undefined, text), ...extra);
    payState.hidden = false;
  };
  const checkButton = (label: string, onClick: () => void) => {
    const b = el("button", "btn btn--sm ok__check", label);
    b.type = "button";
    b.dataset.paymentCheck = "";
    b.addEventListener("click", onClick);
    return b;
  };
  const paid = () => {
    window.clearInterval(pollTimer);
    window.clearInterval(holdTimer);
    holdBoxes().forEach((b) => (b.hidden = true));
    payBox.hidden = true;
    say(t.paid);
    payState.dataset.paid = "";
  };
  async function checkOnce(): Promise<void> {
    const r = await paymentCheck(no, last!.phone);
    if (typeof r === "number") return;
    if (r.payment) show(r.payment, total);
    if (r.paymentStatus === "paid" || r.status === "paid") paid();
  }
  function poll() {
    window.clearTimeout(pollTimer);
    say(t.waiting);
    const step = (i: number) => {
      if (i >= POLL_DELAYS_S.length) {
        say(t.pollStopped, checkButton(t.check, () => void checkOnce().then(() => payState.dataset.paid === undefined && poll())));
        return;
      }
      pollTimer = window.setTimeout(async () => {
        await checkOnce();
        if (payState.dataset.paid === undefined) step(i + 1);
      }, POLL_DELAYS_S[i]! * 1000);
      timers.push(pollTimer);
    };
    step(0);
  }

  if (mine?.paymentError === "qpay_unavailable" || mine?.paymentError === "wire_unavailable" || (mine && !mine.payment && mine.paymentError)) {
    payBox.hidden = true;
    const retry = checkButton(t.retry, async () => {
      retry.disabled = true;
      const r = await paymentCheck(no, last.phone);
      retry.disabled = false;
      if (typeof r === "number") return;
      if (r.paymentStatus === "paid" || r.status === "paid") return paid();
      if (r.payment) {
        show(r.payment, total);
        if (r.payment.method === "qpay" || r.payment.method === "wire") poll();
        else payState.hidden = true;
      }
    });
    say(mine.paymentError === "wire_unavailable" ? t.wireError : t.qpayError, retry);
  } else if (mine?.payment) {
    show(mine.payment, total);
    if (mine.payment.method === "qpay" || mine.payment.method === "wire") poll();
  }
  if (mine?.holdExpiresAt) {
    const h = el("p", "ok__hold");
    h.dataset.hold = "";
    payBox.after(h);
    startHold(parseUtc(mine.holdExpiresAt));
  }

  // server-verified status (and the amount when the checkout did not return one)
  void lookup(no, last.phone).then((r) => {
    if (typeof r === "number") return;
    render(r);
    if (total === null) {
      total = r.total;
      if (mine?.payment) show(mine.payment, total);
    }
    if (r.paymentStatus === "paid" || r.status === "paid" || ["shipped", "done"].includes(r.status)) {
      if (mine?.payment) paid();
    } else if (!mine?.payment && r.payment?.method === "wire" && unpaid(r)) {
      // the browser lost the checkout response (new tab, cleared storage): the server still has the QR
      show(r.payment, total);
      poll();
      if (r.status === "new") startHold(parseUtc(r.holdExpiresAt ?? null));
    } else if (unpaid(r) && r.status === "new") startHold(parseUtc(r.holdExpiresAt ?? mine?.holdExpiresAt ?? null));
  });
}
