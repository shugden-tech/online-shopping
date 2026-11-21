// A2: Turnstile verification and the Telegram order notification (unchanged behaviour from before A2).
import fileSettings from "../../data/settings.json";
import { formatNumber } from "../price";
import type { OrderLine } from "./types";

// Cloudflare's documented always-pass TEST secret. Its answer is always success, so it is verified locally
// (no network call) — this keeps local tests working offline. Any real secret is verified remotely.
const TURNSTILE_TEST_PASS = "1x0000000000000000000000000000000AA";

export async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  if (secret === TURNSTILE_TEST_PASS) return true;
  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip !== "unknown") body.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[orders] turnstile verify failed", err);
    return false;
  }
}

const money = (n: number) => `${formatNumber(n)}₮`;

/** Telegram HTML mode: only &, < and > need escaping. */
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PAYMENT_METHOD: Record<string, string> = { bank: "🏦 Банкны шилжүүлэг", qpay: "📱 QPay", wire: "💳 Wire" };
const methodLabel = (p: string) => PAYMENT_METHOD[p] ?? esc(p);

/** Payment state badge — the first thing the owner reads, so "paid or not" is never ambiguous. */
const PAYMENT_BADGE: Record<string, string> = {
  unpaid: "🔴 <b>ТӨЛӨГДӨӨГҮЙ</b>",
  pending: "🟡 <b>ТӨЛБӨР ХҮЛЭЭГДЭЖ БАЙНА</b>",
  paid: "🟢 <b>ТӨЛӨГДСӨН</b>",
  refunded: "↩️ <b>БУЦААН ОЛГОСОН</b>",
};
export const paymentBadge = (s: string) => PAYMENT_BADGE[s] ?? `⚪ ${esc(s)}`;

const ORDER_STATUS: Record<string, string> = {
  new: "🆕 Шинэ",
  confirmed: "☑️ Баталгаажсан",
  paid: "✅ Төлөгдсөн",
  shipped: "🚚 Хүргэлтэд гарсан",
  done: "📦 Хүргэгдсэн",
  cancelled: "❌ Цуцлагдсан",
};
export const statusLabel = (s: string) => ORDER_STATUS[s] ?? esc(s);

const LINE = "━━━━━━━━━━━━━━";

function adminLink(site: string | undefined, no: string): string[] {
  const base = (site ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? [`🔗 <a href="${esc(`${base}/admin/#/orders/${encodeURIComponent(no)}`)}">Админд нээх</a>`] : [];
}

/** "2026-11-21 08:00:00" (UTC) -> "11/21 16:00" Ulaanbaatar time. */
function ubTime(utc: string): string {
  const d = new Date(utc.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(utc) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return `${utc} UTC`;
  const u = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(u.getUTCMonth() + 1)}/${p(u.getUTCDate())} ${p(u.getUTCHours())}:${p(u.getUTCMinutes())}`;
}

export interface NotifyOrder {
  name: string;
  phone: string;
  phone2: string;
  city: string;
  district: string;
  khoroo: string;
  address: string;
  note: string;
  payment: "bank" | "qpay" | "wire";
  locale: string;
}

export interface TelegramExtra {
  /** orders.payment_status right after the order was stored (a QPay / Wire invoice makes it `pending`). */
  paymentStatus?: string;
  site?: string;
}

export function telegramText(
  no: string,
  o: NotifyOrder,
  lines: OrderLine[],
  subtotal: number,
  delivery: number,
  total: number,
  holdExpiresAt: string | null,
  extra: TelegramExtra = {},
): string {
  const district = o.city === "ub" ? (fileSettings.districts.find((d) => d.id === o.district)?.mn ?? o.district) : o.district;
  const where = [o.city === "ub" ? "Улаанбаатар" : "Орон нутаг", district, o.khoroo].filter(Boolean).join(", ");
  const count = lines.reduce((n, l) => n + l.qty, 0);
  return [
    `🛍 <b>ШИНЭ ЗАХИАЛГА</b>  <code>${esc(no)}</code>`,
    `${paymentBadge(extra.paymentStatus ?? "unpaid")}  ·  ${methodLabel(o.payment)}`,
    LINE,
    `👤 <b>${esc(o.name)}</b>`,
    `📞 ${esc([o.phone, o.phone2].filter(Boolean).join(", "))}`,
    `📍 ${esc(where)}`,
    `🏠 ${esc(o.address)}`,
    ...(o.note ? [`📝 <i>${esc(o.note)}</i>`] : []),
    LINE,
    `🧴 <b>Бараа</b> (${count} ширхэг)`,
    ...lines.flatMap((l) =>
      l.bundle
        ? [
            `▪️ 🎁 Багц «${esc(l.bundle.nameMn)}» × ${l.qty} — <b>${money(l.price * l.qty)}</b>`,
            ...l.bundle.parts.map((p) => `      · ${esc(p.brand)} ${esc(p.name)} ${p.ml} мл × ${p.qty * l.qty}`),
          ]
        : [`▪️ ${esc(l.brand)} ${esc(l.name)} <b>${l.ml} мл</b> × ${l.qty} — <b>${money(l.price * l.qty)}</b>`],
    ),
    LINE,
    `Барааны дүн: ${money(subtotal)}`,
    `🚚 Хүргэлт: ${delivery ? money(delivery) : "Үнэгүй"}`,
    `💰 <b>НИЙТ: ${money(total)}</b>`,
    ...(holdExpiresAt ? [`⏳ Нөөц дуусах: ${ubTime(holdExpiresAt)} (УБ цаг)`] : []),
    `🌐 Хэл: ${o.locale === "en" ? "🇬🇧 EN" : "🇲🇳 MN"}`,
    ...adminLink(extra.site, no),
  ].join("\n");
}

/** Order fields a status update needs (an orders row fits). */
export interface StatusOrder {
  order_no: string;
  name: string;
  phone: string;
  total: number;
  payment: string;
  /** orders.payment_status after the change, when known. */
  payment_status?: string;
}

export type StatusEvent =
  | { kind: "paid"; provider: string; amount: number; actor: string }
  | { kind: "partial"; provider: string; amount: number; due: number; actor: string }
  | { kind: "refund"; provider: string; amount: number; actor: string }
  | { kind: "status"; from: string; to: string; actor: string; reason?: string | null; note?: string | null };

const ACTOR: Record<string, string> = { system: "систем", customer: "харилцагч", owner: "эзэн", staff: "ажилтан", admin: "админ" };
const actorLabel = (a: string) => ACTOR[a] ?? esc(a);

const CANCEL_REASON: Record<string, string> = { expired: "хугацаа дууссан", customer: "харилцагч цуцалсан", admin: "админ цуцалсан", system: "систем" };

const STATUS_HEAD: Record<string, string> = {
  confirmed: "☑️ <b>БАТАЛГААЖЛАА</b> (төлбөр хүлээгдэж байна)",
  shipped: "🚚 <b>ХҮРГЭЛТЭД ГАРЛАА</b>",
  done: "📦 <b>ХҮРГЭГДЛЭЭ</b>",
  cancelled: "❌ <b>ЦУЦЛАГДЛАА</b>",
};

/** Short follow-up message when an order is paid or changes status, so the chat always shows the current state. */
export function telegramStatusText(order: StatusOrder, ev: StatusEvent, site?: string): string {
  let head: string;
  let badge: string;
  const rows: string[] = [];
  if (ev.kind === "paid") {
    head = "✅ <b>ТӨЛБӨР ТӨЛӨГДЛӨӨ</b>";
    badge = paymentBadge("paid");
    rows.push(`💵 Орсон дүн: <b>${money(ev.amount)}</b> · ${methodLabel(ev.provider)}`);
  } else if (ev.kind === "partial") {
    head = "🟠 <b>ДУТУУ ТӨЛӨЛТ</b>";
    badge = paymentBadge("pending");
    rows.push(`💵 Орсон: <b>${money(ev.amount)}</b> / ${money(ev.due)} · ${methodLabel(ev.provider)}`, `➖ Дутуу: <b>${money(Math.max(0, ev.due - ev.amount))}</b>`);
  } else if (ev.kind === "refund") {
    head = "⚠️ <b>ИЛҮҮ ТӨЛБӨР — БУЦААН ОЛГОХ</b>";
    badge = "🟣 <b>Буцаан олгох шаардлагатай</b>";
    rows.push(`💵 ${money(ev.amount)} · ${methodLabel(ev.provider)} (захиалга аль хэдийн төлөгдсөн эсвэл цуцлагдсан)`);
  } else {
    head = STATUS_HEAD[ev.to] ?? `🔄 <b>${esc(ev.to)}</b>`;
    badge =
      ev.to === "cancelled"
        ? ev.from === "paid"
          ? "🟣 <b>Төлөгдсөн байсан — буцаан олгох</b>"
          : "⚫ <b>Төлөгдөөгүй</b>"
        : paymentBadge(order.payment_status ?? (ev.to === "shipped" || ev.to === "done" ? "paid" : "unpaid"));
    rows.push(`🔄 ${statusLabel(ev.from)} → <b>${statusLabel(ev.to)}</b>`);
    if (ev.to === "cancelled" && ev.reason) rows.push(`❔ Шалтгаан: ${esc(CANCEL_REASON[ev.reason] ?? ev.reason)}`);
    if (ev.note) rows.push(`📝 <i>${esc(ev.note)}</i>`);
  }
  return [
    `${head}  <code>${esc(order.order_no)}</code>`,
    badge,
    LINE,
    `👤 ${esc(order.name)} · 📞 ${esc(order.phone)}`,
    `💰 Нийт: <b>${money(order.total)}</b>`,
    ...rows,
    `👮 ${actorLabel(ev.actor)}`,
    ...adminLink(site, order.order_no),
  ].join("\n");
}

/** Sends a status update when Telegram is configured. Never throws. */
export async function notifyTelegramStatus(env: Env, order: StatusOrder, ev: StatusEvent): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramStatusText(order, ev, env.PUBLIC_SITE_URL));
  } catch (err) {
    console.error("[orders] telegram status failed", err);
  }
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[orders] telegram responded ${res.status}`);
  } catch (err) {
    console.error("[orders] telegram send failed", err);
  }
}
