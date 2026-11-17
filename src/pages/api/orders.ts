// POST /api/orders — validate, verify Turnstile, replay by idempotency key, rate-limit (atomic), re-price on
// the server (D1 inventory overrides the build-time JSON), decrement tracked stock and store the order in ONE
// D1 batch (all or nothing), notify Telegram (optional). Prices from the client are never read.
import type { APIRoute } from "astro";
import settings from "../../data/settings.json";
import { getProducts } from "../../lib/products";
import { formatNumber } from "../../lib/price";
import { issuesToErrors, orderSchema, type OrderInput } from "../../lib/order-schema";
import {
  clientIp, effectiveSize, fail, hitRateLimit, json, loadInventory, pruneRateLimits, readJson, type OrderLine,
} from "../../lib/server";

export const prerender = false;

const RATE_LIMIT = 5; // orders per IP per 10 minutes
const MAX_BODY = 32 * 1024; // a full 30-line cart is ~4 KB
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
/** Client-generated UUID (or any 16–100 char token) sent as the `Idempotency-Key` header. */
const IDEM_RE = /^[A-Za-z0-9_-]{16,100}$/;
// Cloudflare's documented always-pass TEST secret. Its answer is always success, so it is verified locally
// (no network call) — this keeps local tests working offline. Any real secret is verified remotely.
const TURNSTILE_TEST_PASS = "1x0000000000000000000000000000000AA";

type Line = OrderLine;

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
    // Order of checks: content type → size → JSON → idempotency key format → schema → honeypot → Turnstile →
    // idempotent replay → rate limit → re-price / stock → one D1 batch (stock decrements + order + event).
    // Everything before the replay lookup is cheap and touches no storage.
    // (Astro's checkOrigin already answers 403 to cross-site form/text posts before this handler runs.)
    const body = await readJson(request, MAX_BODY);
    if (body instanceof Response) return body;
    const raw = body.value;

    const idemRaw =
      request.headers.get("Idempotency-Key") ??
      (raw && typeof raw === "object" && typeof (raw as { idempotencyKey?: unknown }).idempotencyKey === "string"
        ? (raw as { idempotencyKey: string }).idempotencyKey
        : null);
    if (idemRaw !== null && !IDEM_RE.test(idemRaw)) return fail(400, { form: "server" });
    const idemKey = idemRaw;

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
    const db = env.DB;
    const ctx = locals.runtime?.ctx;

    const ip = clientIp(request, () => clientAddress);
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, o.turnstileToken, ip))) {
      return fail(422, { turnstile: "turnstile" });
    }

    // Same key again (a retry after a lost response, a double click): return the stored order, insert nothing.
    const replay = async () =>
      idemKey
        ? db.prepare("SELECT order_no, total FROM orders WHERE idempotency_key = ?1").bind(idemKey).first<{ order_no: string; total: number }>()
        : null;
    const prior = await replay();
    if (prior) return json(200, { ok: true, orderNo: prior.order_no, total: prior.total, replayed: true });

    if (!(await hitRateLimit(db, `order:${ip}`, RATE_LIMIT, 600))) return fail(429, { form: "rate" });
    if (Math.random() < 0.02) ctx?.waitUntil?.(pruneRateLimits(db));

    // re-price every line: D1 inventory row (if any) over the build-time product JSON
    const products = new Map((await getProducts()).map((p) => [p.slug, p]));
    const inventory = await loadInventory(db, o.items);
    const merged = new Map<string, Line>();
    const short: { slug: string; ml: number; available: number }[] = [];
    for (const it of o.items) {
      const p = products.get(it.slug);
      const size = p?.sizes.find((s) => s.ml === it.ml);
      if (!p || !size) return fail(422, { form: "items" });
      const key = `${it.slug}:${it.ml}`;
      const eff = effectiveSize(size, inventory.get(key));
      const prev = merged.get(key);
      const qty = (prev?.qty ?? 0) + it.qty;
      if (eff.tracked) {
        if (qty > 10) return fail(422, { form: "items" });
      } else {
        if (!eff.inStock) return fail(422, { form: "items" });
        if (qty > Math.min(10, eff.stock ?? 10)) return fail(422, { form: "items" });
      }
      merged.set(key, { slug: p.slug, brand: p.brand, name: p.name, ml: size.ml, qty, price: eff.price, ...(eff.tracked ? { tracked: true } : {}) });
    }
    const lines = [...merged.values()];
    for (const l of lines) {
      const eff = l.tracked ? inventory.get(`${l.slug}:${l.ml}`) : undefined;
      if (eff && l.qty > (eff.stock ?? 0)) short.push({ slug: l.slug, ml: l.ml, available: eff.stock ?? 0 });
    }
    if (short.length) return json(409, { ok: false, errors: { form: "stock" }, unavailable: short });
    if (lines.some((l) => l.price <= 0)) return fail(422, { form: "items" });

    const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
    const { fee, freeThreshold } = settings.delivery;
    const delivery = subtotal >= freeThreshold ? 0 : fee;
    const total = subtotal + delivery;

    // One batch = one transaction. The stock CHECK (stock >= 0) aborts the whole batch if a concurrent
    // order got there first, so there is never an order without its stock, or stock taken without an order.
    let orderNo = "";
    for (let attempt = 0; ; attempt++) {
      orderNo = orderNumber();
      const stmts = [
        ...lines
          .filter((l) => l.tracked)
          .map((l) =>
            db
              .prepare(
                "UPDATE inventory SET stock = stock - ?1, updated_at = datetime('now') WHERE product_id = ?2 AND ml = ?3 AND stock IS NOT NULL",
              )
              .bind(l.qty, l.slug, l.ml),
          ),
        db
          .prepare(
            `INSERT INTO orders (order_no, name, phone, phone2, city, district, khoroo, address, note, payment,
               items_json, subtotal, delivery, total, locale, ip, idempotency_key, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'))`,
          )
          .bind(
            orderNo, o.name, o.phone, o.phone2 || null, o.city, o.district || null, o.khoroo || null,
            o.address, o.note || null, o.payment, JSON.stringify(lines), subtotal, delivery, total, o.locale, ip, idemKey,
          ),
        db
          .prepare(
            "INSERT INTO order_events (order_id, from_status, to_status, actor) SELECT id, NULL, 'new', 'customer' FROM orders WHERE order_no = ?1",
          )
          .bind(orderNo),
      ];
      try {
        await db.batch(stmts);
        break;
      } catch (err) {
        const msg = String((err as { cause?: unknown })?.cause ?? err) + String(err);
        if (/inventory_stock_nonnegative|CHECK constraint/i.test(msg)) {
          // lost a race for the last units: report what is left now
          const now = await loadInventory(db, lines);
          const unavailable = lines
            .filter((l) => l.tracked)
            .map((l) => ({ slug: l.slug, ml: l.ml, available: now.get(`${l.slug}:${l.ml}`)?.stock ?? 0 }))
            .filter((u) => u.available < (merged.get(`${u.slug}:${u.ml}`)?.qty ?? 0));
          return json(409, { ok: false, errors: { form: "stock" }, unavailable });
        }
        if (/idempotency_key/i.test(msg)) {
          // a concurrent request with the same key won the insert
          const won = await replay();
          if (won) return json(200, { ok: true, orderNo: won.order_no, total: won.total, replayed: true });
        }
        if (attempt < 4 && /UNIQUE/i.test(msg) && /order_no/i.test(msg)) continue;
        throw err;
      }
    }

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const task = sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramText(orderNo, o, lines, subtotal, delivery, total));
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
