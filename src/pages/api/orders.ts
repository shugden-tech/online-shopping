// POST /api/orders — validate, verify Turnstile, replay by idempotency key, rate-limit (atomic), check the store
// switches, price every line from D1 `skus` (never from the client), reserve stock and store the order in ONE
// D1 batch (all or nothing), then create the QPay invoice (QPay orders) and notify Telegram (optional).
// Contract: docs/CONTRACTS.md §4. Also sweeps expired holds in the background (waitUntil).
import type { APIRoute } from "astro";
import { placeOrder } from "../../lib/orders/create";
import { sweepExpiredHolds } from "../../lib/orders/holds";
import { sendTelegram, telegramText, verifyTurnstile } from "../../lib/orders/notify";
import { priceCart } from "../../lib/orders/pricing";
import { loadOrder, type OrderRow } from "../../lib/orders/types";
import { checkoutResponse } from "../../lib/orders/view";
import { issuesToErrors, orderSchema } from "../../lib/order-schema";
import { ensureQpayInvoice, qpayEnabled } from "../../lib/payments";
import { clientIp, fail, hitRateLimit, json, pruneRateLimits, readJson } from "../../lib/server";
import { getSettings } from "../../lib/settings";

export const prerender = false;

const RATE_LIMIT = 5; // orders per IP per 10 minutes
const MAX_BODY = 32 * 1024; // a full 30-line cart is ~4 KB
/** Client-generated UUID (or any 16–100 char token) sent as the `Idempotency-Key` header. */
const IDEM_RE = /^[A-Za-z0-9_-]{16,100}$/;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    // Order of checks: content type → size → JSON → idempotency key format → schema → honeypot → Turnstile →
    // idempotent replay → rate limit → store switches → price / stock → one D1 batch.
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
    const background = (p: Promise<unknown>) => (ctx?.waitUntil ? ctx.waitUntil(p) : void p.catch(() => {}));

    const ip = clientIp(request, () => clientAddress);
    if (!(await verifyTurnstile(env.TURNSTILE_SECRET, o.turnstileToken, ip))) {
      return fail(422, { turnstile: "turnstile" });
    }

    // Same key again (a retry after a lost response, a double click): answer with the stored order, insert nothing.
    const replay = async (): Promise<OrderRow | null> =>
      idemKey ? db.prepare("SELECT * FROM orders WHERE idempotency_key = ?1").bind(idemKey).first<OrderRow>() : null;
    const prior = await replay();
    if (prior) return json(200, await checkoutResponse(env, prior));

    if (!(await hitRateLimit(db, `order:${ip}`, RATE_LIMIT, 600))) return fail(429, { form: "rate" });
    if (Math.random() < 0.02) background(pruneRateLimits(db));
    // expire old holds without a cron (only for requests that passed Turnstile and the rate limit)
    background(sweepExpiredHolds(env, 20).catch((err) => console.error("[orders] hold sweep failed", err)));

    const settings = await getSettings(db);
    if (!settings["checkout.open"]) return fail(423, { form: "closed" });
    const methodOn = o.payment === "qpay" ? qpayEnabled(env, settings) : settings["payments.bank.enabled"] === true;
    if (!methodOn) return fail(422, { payment: "disabled" });

    const priced = await priceCart(db, o.items, settings, o.city);
    if (!priced.ok) return json(priced.status, { ok: false, errors: priced.errors, ...("unavailable" in priced ? { unavailable: priced.unavailable } : {}) });

    const placed = await placeOrder(db, o, priced, settings, ip, idemKey);
    if (!placed.ok) {
      if (placed.kind === "replay") {
        // a concurrent request with the same key won the insert
        const won = await replay();
        if (won) return json(200, await checkoutResponse(env, won));
        throw new Error("idempotency conflict without a row");
      }
      return json(409, { ok: false, errors: { form: "stock", sku: placed.short[0]!.sku }, unavailable: placed.short });
    }

    const order = await loadOrder(db, placed.orderNo);
    if (!order) throw new Error("order vanished after insert");
    const payment = o.payment === "qpay" ? await ensureQpayInvoice(env, order) : undefined;
    const fresh = (await loadOrder(db, placed.orderNo)) ?? order;

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      background(
        sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramText(placed.orderNo, o, priced.lines, priced.subtotal, priced.delivery, priced.total, placed.holdExpiresAt)),
      );
    } else {
      console.log(`[orders] ${placed.orderNo}: Telegram notification skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)`);
    }

    return json(201, await checkoutResponse(env, fresh, payment));
  } catch (err) {
    console.error("[orders] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
