// POST /api/orders — validate, verify Turnstile, rate-limit, re-price on the server, store in D1,
// notify Telegram (optional). Prices from the client are never read.
import type { APIRoute } from "astro";
import settings from "../../data/settings.json";
import { getProducts } from "../../lib/products";
import { formatNumber } from "../../lib/price";
import { issuesToErrors, orderSchema, type OrderInput } from "../../lib/order-schema";

export const prerender = false;

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status: number, errors: Record<string, string>) => json(status, { ok: false, errors });

const RATE_LIMIT = 5; // orders per IP per 10 minutes
const MAX_BODY = 32 * 1024; // a full 30-line cart is ~4 KB
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";

interface Line { slug: string; brand: string; name: string; ml: number; qty: number; price: number }

/** GZ-YYMMDD-XXXX, date in Asia/Ulaanbaatar (UTC+8, no DST). */
function orderNumber(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 3600_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${p2(d.getUTCFullYear() % 100)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  let code = "";
  const buf = new Uint8Array(16);
  while (code.length < 4) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // rejection sampling keeps every character equally likely
      if (b < ALPHABET.length * 7 && code.length < 4) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return `GZ-${date}-${code}`;
}

async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
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

function clientIp(request: Request, getAddress: () => string): string {
  const h = request.headers.get("CF-Connecting-IP");
  if (h) return h.slice(0, 64);
  try {
    return getAddress() || "unknown";
  } catch {
    return "unknown";
  }
}

const money = (n: number) => `${formatNumber(n)}₮`;

function telegramText(no: string, o: OrderInput, lines: Line[], subtotal: number, delivery: number, total: number): string {
  const district =
    o.city === "ub" ? (settings.districts.find((d) => d.id === o.district)?.mn ?? o.district) : o.district;
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
    ...lines.map((l) => `- ${l.brand} ${l.name} ${l.ml} мл × ${l.qty} = ${money(l.price * l.qty)}`),
    "",
    `Барааны дүн: ${money(subtotal)}`,
    `Хүргэлт: ${delivery ? money(delivery) : "Үнэгүй"}`,
    `Нийт: ${money(total)}`,
    `Төлбөр: ${o.payment === "bank" ? "Банкны шилжүүлэг" : "QPay"}`,
    `Хэл: ${o.locale}`,
  ].join("\n");
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
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

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    // Order of checks: content type → size → JSON → schema → honeypot → Turnstile → rate limit → insert.
    // Everything before the rate limit is cheap and touches no storage; the rate limit runs before any D1 write.
    // (Astro's checkOrigin already answers 403 to cross-site form/text posts before this handler runs.)
    if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) return fail(415, { form: "server" });
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return fail(413, { form: "server" });
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY) return fail(413, { form: "server" });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(400, { form: "server" });
    }

    const parsed = orderSchema.safeParse(raw);
    if (!parsed.success) return fail(422, issuesToErrors(parsed.error));
    const o = parsed.data;

    // honeypot: humans never see this field
    if (o.website.trim() !== "") return fail(400, { form: "server" });

    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    if (!env.TURNSTILE_SECRET) {
      console.error("[orders] TURNSTILE_SECRET is not set");
      return fail(500, { form: "server" });
    }

    const ip = clientIp(request, () => clientAddress);
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, o.turnstileToken, ip))) {
      return fail(422, { turnstile: "turnstile" });
    }

    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE ip = ?1 AND created_at > datetime('now','-10 minutes')",
    )
      .bind(ip)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= RATE_LIMIT) return fail(429, { form: "rate" });

    // re-price every line from the product collection
    const products = new Map((await getProducts()).map((p) => [p.slug, p]));
    const merged = new Map<string, Line>();
    for (const it of o.items) {
      const p = products.get(it.slug);
      const size = p?.sizes.find((s) => s.ml === it.ml);
      if (!p || !size || !size.inStock) return fail(422, { form: "items" });
      const key = `${it.slug}:${it.ml}`;
      const prev = merged.get(key);
      const qty = (prev?.qty ?? 0) + it.qty;
      if (qty > 10) return fail(422, { form: "items" });
      merged.set(key, { slug: p.slug, brand: p.brand, name: p.name, ml: size.ml, qty, price: size.price });
    }
    const lines = [...merged.values()];
    const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
    const { fee, freeThreshold } = settings.delivery;
    const delivery = subtotal >= freeThreshold ? 0 : fee;
    const total = subtotal + delivery;

    let orderNo = "";
    for (let attempt = 0; ; attempt++) {
      orderNo = orderNumber();
      try {
        await env.DB.prepare(
          `INSERT INTO orders (order_no, name, phone, phone2, city, district, khoroo, address, note, payment,
             items_json, subtotal, delivery, total, locale, ip)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        )
          .bind(
            orderNo, o.name, o.phone, o.phone2 || null, o.city, o.district || null, o.khoroo || null,
            o.address, o.note || null, o.payment, JSON.stringify(lines), subtotal, delivery, total, o.locale, ip,
          )
          .run();
        break;
      } catch (err) {
        if (attempt < 4 && /UNIQUE/i.test(String(err))) continue;
        throw err;
      }
    }

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const task = sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramText(orderNo, o, lines, subtotal, delivery, total));
      const ctx = locals.runtime?.ctx;
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    } else {
      console.log(`[orders] ${orderNo}: Telegram notification skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)`);
    }

    return json(200, { ok: true, orderNo, total });
  } catch (err) {
    console.error("[orders] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () =>
  json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
