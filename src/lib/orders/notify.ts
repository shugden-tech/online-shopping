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

export function telegramText(no: string, o: NotifyOrder, lines: OrderLine[], subtotal: number, delivery: number, total: number, holdExpiresAt: string | null): string {
  const district = o.city === "ub" ? (fileSettings.districts.find((d) => d.id === o.district)?.mn ?? o.district) : o.district;
  const where = [o.city === "ub" ? "Улаанбаатар" : "Орон нутаг", district, o.khoroo].filter(Boolean).join(", ");
  return [
    `Шинэ захиалга ${no}`,
    "",
    `Нэр: ${o.name}`,
    `Утас: ${[o.phone, o.phone2].filter(Boolean).join(", ")}`,
    `Хаяг: ${where}`,
    `${o.address}`,
    ...(o.note ? [`Тэмдэглэл: ${o.note}`] : []),
    "",
    ...lines.flatMap((l) =>
      l.bundle
        ? [
            `- Багц «${l.bundle.nameMn}» × ${l.qty} = ${money(l.price * l.qty)}`,
            ...l.bundle.parts.map((p) => `    · ${p.brand} ${p.name} ${p.ml} мл × ${p.qty * l.qty}`),
          ]
        : [`- ${l.brand} ${l.name} ${l.ml} мл × ${l.qty} = ${money(l.price * l.qty)}`],
    ),
    "",
    `Барааны дүн: ${money(subtotal)}`,
    `Хүргэлт: ${delivery ? money(delivery) : "Үнэгүй"}`,
    `Нийт: ${money(total)}`,
    `Төлбөр: ${o.payment === "bank" ? "Банкны шилжүүлэг" : o.payment === "wire" ? "Wire" : "QPay"}`,
    ...(holdExpiresAt ? [`Нөөц дуусах: ${holdExpiresAt} UTC`] : []),
    `Хэл: ${o.locale}`,
  ].join("\n");
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[orders] telegram responded ${res.status}`);
  } catch (err) {
    console.error("[orders] telegram send failed", err);
  }
}
