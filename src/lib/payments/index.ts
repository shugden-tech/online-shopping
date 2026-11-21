// A2 payments: payment instructions, QPay invoice creation, Wire hosted checkout (0008), markPaid (idempotent)
// and the QPay / Wire re-checks.
import fileSettings from "../../data/settings.json";
import { auditStatement } from "../audit";
import type { Actor, PaymentInstructions, PaymentProvider } from "../contracts";
import { notifyTelegramStatus } from "../orders/notify";
import { commitReservations, errText, eventStatement, guard, guardOrderStatus, isGuardError } from "../orders/state";
import { loadOrder, type D1, type OrderRow, type PaymentRow, type Stmt } from "../orders/types";
import { checkInvoice, createInvoice, qpayConfigured, type QpayInvoice } from "./qpay";
import { emitStatement } from "../webhooks";
import { confirmWireIntent, createWireCheckout, createWireIntent, fetchWireIntent, WireError, wireConfigured, type WireIntent, type WireNextAction } from "./wire";
import { qrDataUri } from "./qr-svg";
import { getSettings } from "../settings";
import type { WireMode } from "../contracts";

export { qpayConfigured, qpayEnabled } from "./qpay";
export { wireConfigured, wireEnabled } from "./wire";

/* ---------------- instructions ---------------- */

export function bankInstructions(orderNo: string, locale: "mn" | "en", live?: Partial<Record<"bank.name" | "bank.account" | "bank.holder", string>>): PaymentInstructions {
  const b = fileSettings.payment.bank;
  // the owner's live values (admin settings, 0004) win over the build-time file
  return {
    method: "bank",
    bank: live?.["bank.name"] || b.name[locale],
    account: live?.["bank.account"] || b.accountNumber,
    holder: live?.["bank.holder"] || b.accountName[locale],
    reference: orderNo,
  };
}

async function liveBank(db: D1) {
  const res = await db
    .prepare("SELECT key, value_json FROM store_settings WHERE key IN ('bank.name', 'bank.account', 'bank.holder')")
    .all<{ key: "bank.name" | "bank.account" | "bank.holder"; value_json: string }>();
  const out: Partial<Record<"bank.name" | "bank.account" | "bank.holder", string>> = {};
  for (const r of res.results ?? []) {
    try {
      const v = JSON.parse(r.value_json);
      if (typeof v === "string" && v.trim()) out[r.key] = v.trim();
    } catch { /* ignore */ }
  }
  return out;
}

function qpayInstructions(row: Pick<PaymentRow, "provider_ref" | "data_json">): PaymentInstructions | null {
  if (!row.provider_ref) return null;
  let d: Partial<QpayInvoice> = {};
  try {
    d = JSON.parse(row.data_json ?? "{}") as Partial<QpayInvoice>;
  } catch {
    /* empty */
  }
  return {
    method: "qpay",
    invoiceId: row.provider_ref,
    qrImage: d.qrImage ?? null,
    qrText: d.qrText ?? null,
    shortUrl: d.shortUrl ?? null,
    urls: Array.isArray(d.urls) ? d.urls : [],
  };
}

/** What a Wire payment row keeps in data_json (no secrets: ids, Wire's public URLs and the QR payload only). */
interface WireData {
  mode?: WireMode;
  sessionId?: string | null;
  checkoutUrl?: string | null;
  /** next_action.type from the confirm (or the latest read-back). */
  action?: string | null;
  qr?: { text: string; deeplinks: { name: string; link: string }[] } | null;
  expiresAt?: number | null;
}
const readWireData = (json: string | null): WireData => {
  try {
    const d = JSON.parse(json ?? "{}") as WireData;
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
};

function wireInstructions(row: Pick<PaymentRow, "provider_ref" | "data_json">): PaymentInstructions | null {
  if (!row.provider_ref) return null;
  const d = readWireData(row.data_json);
  const url = typeof d.checkoutUrl === "string" ? d.checkoutUrl : null;
  const session = typeof d.sessionId === "string" ? d.sessionId : null;
  // rows from before direct QR mode have no `mode`: they are hosted checkouts
  const mode: WireMode = d.mode === "qr" || d.mode === "poll" || d.mode === "redirect" ? d.mode : "hosted";
  if (mode === "qr") {
    const text = typeof d.qr?.text === "string" ? d.qr.text : null;
    if (!text) return null;
    // the QR image is drawn here from qr.text (an SVG data: URI), never stored and never from the browser
    return { method: "wire", intentId: row.provider_ref, mode, sessionId: session, checkoutUrl: url, qr: { text, image: qrDataUri(text), deeplinks: Array.isArray(d.qr?.deeplinks) ? d.qr!.deeplinks : [] } };
  }
  if (mode === "poll") return { method: "wire", intentId: row.provider_ref, mode, sessionId: session, checkoutUrl: url, qr: null };
  if (!url) return null;
  return { method: "wire", intentId: row.provider_ref, mode, sessionId: session, checkoutUrl: url, qr: null };
}

/** The instructions a customer needs to pay this order now (null when nothing is payable / no invoice yet). */
export async function instructionsFor(db: D1, order: OrderRow): Promise<PaymentInstructions | null> {
  if (order.payment === "bank") return bankInstructions(order.order_no, order.locale, await liveBank(db));
  const provider = order.payment === "wire" ? "wire" : "qpay";
  const row = await db
    .prepare("SELECT provider_ref, data_json FROM payments WHERE order_id = ?1 AND provider = ?2 AND status = 'pending' AND provider_ref IS NOT NULL ORDER BY id DESC LIMIT 1")
    .bind(order.id, provider)
    .first<Pick<PaymentRow, "provider_ref" | "data_json">>();
  if (!row) return null;
  return provider === "wire" ? wireInstructions(row) : qpayInstructions(row);
}

/* ---------------- QPay invoice ---------------- */

/**
 * Makes sure a payable order has one pending QPay invoice and returns its instructions.
 * Concurrency: a pending payments row is claimed first (conditional INSERT), so two requests never both
 * create an invoice. Returns null when QPay failed (the order stays; payment-check retries later).
 */
export async function ensureQpayInvoice(env: Env, order: OrderRow): Promise<PaymentInstructions | null> {
  const db = env.DB;
  const existing = await instructionsFor(db, order);
  if (existing) return existing;
  if (!qpayConfigured(env) || !["new", "confirmed"].includes(order.status)) return null;
  // a claim whose worker died before QPay answered must not block a retry forever
  await db
    .prepare(
      `UPDATE payments SET status = 'failed', data_json = '{"error":"stale_claim"}', updated_at = datetime('now')
        WHERE order_id = ?1 AND provider = 'qpay' AND status = 'pending' AND provider_ref IS NULL AND created_at < datetime('now', '-2 minutes')`,
    )
    .bind(order.id)
    .run();
  const claim = await db
    .prepare(
      `INSERT INTO payments (order_id, provider, amount, status)
       SELECT ?1, 'qpay', ?2, 'pending'
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status IN ('new','confirmed') AND payment_status IN ('unpaid','pending'))
          AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ?1 AND provider = 'qpay' AND status = 'pending')`,
    )
    .bind(order.id, order.total)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return instructionsFor(db, order); // someone else is creating it
  const paymentId = Number(claim.meta.last_row_id);
  try {
    const inv = await createInvoice(env, order.order_no, order.total);
    await db.batch([
      db
        .prepare("UPDATE payments SET provider_ref = ?2, data_json = ?3, updated_at = datetime('now') WHERE id = ?1")
        .bind(paymentId, inv.invoiceId, JSON.stringify({ qrText: inv.qrText, qrImage: inv.qrImage, shortUrl: inv.shortUrl, urls: inv.urls })),
      db.prepare("UPDATE orders SET payment_status = 'pending', updated_at = datetime('now') WHERE id = ?1 AND payment_status = 'unpaid'").bind(order.id),
      auditStatement(db, "system", "payment.invoice", "payment", paymentId, { orderNo: order.order_no, provider: "qpay", invoiceId: inv.invoiceId, amount: order.total }),
    ]);
    return qpayInstructions({ provider_ref: inv.invoiceId, data_json: JSON.stringify(inv) });
  } catch (err) {
    console.error(`[payments] QPay invoice for ${order.order_no} failed:`, String(err));
    await db
      .prepare("UPDATE payments SET status = 'failed', data_json = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'pending'")
      .bind(paymentId, JSON.stringify({ error: String((err as Error)?.message ?? err).slice(0, 200) }))
      .run();
    return null;
  }
}

/* ---------------- Wire hosted checkout (CONTRACTS §11) ---------------- */

const utcMs = (s: string | null) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) : NaN);

/** Where Wire sends the buyer back (paid or not): the order's success page, which re-checks the payment itself. */
export function wireReturnUrl(env: Env, order: Pick<OrderRow, "order_no" | "locale">): string {
  const site = (env.PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  // = ROUTES.success in src/i18n/routes.mjs (not imported: it reads process.env at load time)
  const path = order.locale === "en" ? "/en/checkout/success/" : "/zahialga/amjilttai/";
  return `${site}${path}?no=${encodeURIComponent(order.order_no)}`;
}

/**
 * Makes sure a payable Wire order has one pending PaymentIntent and returns what the buyer needs to pay it.
 * Setting `payments.wire.mode`:
 *   "qr" (default, Wire's "build your own payment screen"): create the intent, POST /confirm, and keep the
 *        next_action: `qr` -> the QR payload + bank-app deeplinks for our order page; `poll` -> the page polls until a QR
 *        arrives (refreshWire stores it); `redirect_to_url` -> Wire's URL; any other type -> a hosted checkout session.
 *   "hosted": create the intent + a checkout session on pay.wire.mn (never /confirm: the hosted page confirms).
 * Idempotency keys: `<orderNo>-pi` / `-confirm` / `-cs` for the first attempt, `-pi-2` / `-confirm-2` / `-cs-2`, … only
 * after an attempt that created an intent or failed for good (a transient failure retries with the same keys, so Wire
 * replays). An intent that an earlier, interrupted attempt already confirmed is read back instead of confirmed again.
 * The intent expires with the order's stock hold. Returns null when Wire failed (the order stays; payment-check retries).
 */
export async function ensureWireCheckout(env: Env, order: OrderRow): Promise<PaymentInstructions | null> {
  const db = env.DB;
  const existing = await instructionsFor(db, order);
  if (existing) return existing;
  if (!wireConfigured(env) || !["new", "confirmed"].includes(order.status) || order.payment_status === "paid") return null;
  await db
    .prepare(
      `UPDATE payments SET status = 'failed', data_json = '{"error":"stale_claim","transient":true}', updated_at = datetime('now')
        WHERE order_id = ?1 AND provider = 'wire' AND status = 'pending' AND provider_ref IS NULL AND created_at < datetime('now', '-2 minutes')`,
    )
    .bind(order.id)
    .run();
  const claim = await db
    .prepare(
      `INSERT INTO payments (order_id, provider, amount, status)
       SELECT ?1, 'wire', ?2, 'pending'
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status IN ('new','confirmed') AND payment_status IN ('unpaid','pending'))
          AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ?1 AND provider = 'wire' AND status = 'pending')`,
    )
    .bind(order.id, order.total)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return instructionsFor(db, order);
  const paymentId = Number(claim.meta.last_row_id);
  const prior = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM payments WHERE order_id = ?1 AND provider = 'wire' AND id < ?2
          AND (provider_ref IS NOT NULL OR data_json IS NULL OR IFNULL(json_extract(data_json, '$.transient'), 0) = 0)`,
    )
    .bind(order.id, paymentId)
    .first<{ n: number }>();
  const suffix = (prior?.n ?? 0) > 0 ? `-${(prior?.n ?? 0) + 1}` : "";
  const hold = utcMs(order.hold_expires_at);
  const expiresAt = Math.floor((Number.isFinite(hold) ? hold : Date.now() + 60 * 60_000) / 1000);
  const direct = (await getSettings(db))["payments.wire.mode"] !== "hosted";
  let intent: WireIntent | null = null;
  try {
    intent = await createWireIntent(env, { amount: order.total, orderNo: order.order_no, expiresAt, idempotencyKey: `${order.order_no}-pi${suffix}` });
    let data: WireData;
    let confirmed = false;
    if (direct) {
      // an earlier attempt with the same keys may have confirmed this intent and then failed (e.g. our write):
      // read it back and only confirm when Wire still waits for it
      const retried = await db
        .prepare("SELECT 1 AS x FROM payments WHERE order_id = ?1 AND provider = 'wire' AND id < ?2 AND json_extract(data_json, '$.intentId') = ?3 LIMIT 1")
        .bind(order.id, paymentId, intent.id)
        .first<{ x: number }>();
      let cur = retried ? await fetchWireIntent(env, intent.id) : intent;
      if (cur.status === "requires_payment_method" || cur.status === "requires_confirmation") {
        cur = await confirmWireIntent(env, { intentId: intent.id, idempotencyKey: `${order.order_no}-confirm${suffix}` });
        confirmed = true;
      }
      intent = cur;
      data = await directData(env, order, intent, suffix);
    } else {
      const back = wireReturnUrl(env, order);
      const cs = await createWireCheckout(env, { intentId: intent.id, successUrl: back, cancelUrl: back, idempotencyKey: `${order.order_no}-cs${suffix}` });
      data = { mode: "hosted", sessionId: cs.id, checkoutUrl: cs.url, expiresAt: intent.expiresAt };
    }
    const json = JSON.stringify(data);
    await db.batch([
      db.prepare("UPDATE payments SET provider_ref = ?2, data_json = ?3, updated_at = datetime('now') WHERE id = ?1").bind(paymentId, intent.id, json),
      db.prepare("UPDATE orders SET payment_status = 'pending', updated_at = datetime('now') WHERE id = ?1 AND payment_status = 'unpaid'").bind(order.id),
      auditStatement(db, "system", "payment.invoice", "payment", paymentId, {
        orderNo: order.order_no, provider: "wire", intentId: intent.id, mode: data.mode, action: data.action ?? null, confirmed,
        sessionId: data.sessionId ?? null, amount: order.total,
      }),
    ]);
    return wireInstructions({ provider_ref: intent.id, data_json: json });
  } catch (err) {
    const we = err instanceof WireError ? err : null;
    const transient = we ? we.transient : true;
    const msg = String((err as Error)?.message ?? err).slice(0, 200);
    console.error(`[payments] Wire checkout for ${order.order_no} failed: ${msg}`);
    await db.batch([
      db
        .prepare("UPDATE payments SET status = 'failed', data_json = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'pending'")
        .bind(paymentId, JSON.stringify({ error: msg, code: we?.code ?? null, transient, intentId: intent?.id ?? null })),
      auditStatement(db, "system", "payment.error", "payment", paymentId, { orderNo: order.order_no, provider: "wire", code: we?.code ?? null, status: we?.status ?? null, transient }),
    ]);
    return null;
  }
}

/** Direct mode: what to store for a confirmed intent, by its next_action (a hosted session only for types we cannot show). */
async function directData(env: Env, order: OrderRow, intent: WireIntent, suffix: string): Promise<WireData> {
  const na: WireNextAction | null = intent.nextAction;
  const base = { action: na?.type ?? null, expiresAt: intent.expiresAt };
  if (na?.type === "qr" && "qrText" in na) return { ...base, mode: "qr", qr: { text: na.qrText, deeplinks: na.deeplinks } };
  if (na?.type === "redirect_to_url" && "url" in na && na.url) return { ...base, mode: "redirect", checkoutUrl: na.url };
  // no QR yet (poll, or nothing at all while Wire is still working on it): the order page keeps polling
  if (!na || na.type === "poll" || intent.status === "processing" || intent.status === "succeeded") return { ...base, mode: "poll" };
  // loan_app, loan_credit_decision, a QR we could not read, …: Wire's own hosted page handles it
  const back = wireReturnUrl(env, order);
  const cs = await createWireCheckout(env, { intentId: intent.id, successUrl: back, cancelUrl: back, idempotencyKey: `${order.order_no}-cs${suffix}` });
  return { ...base, mode: "hosted", sessionId: cs.id, checkoutUrl: cs.url };
}

export type WireApplyResult = MarkPaidResult | "cancelled" | "failed" | "pending" | "ignored";

/** Intent statuses in which the buyer can still pay (a failed attempt on the hosted page can be retried). */
const WIRE_OPEN = new Set(["requires_payment_method", "requires_action", "requires_confirmation", "processing"]);

/**
 * Applies what Wire says about one of our intents (always a fresh GET, never a webhook body):
 *   succeeded -> markPaid (same path as QPay: audit, order -> paid, reservations committed, once)
 *   canceled  -> the pending payment row -> cancelled (the order keeps its hold; the sweep expires it)
 *   any other final status after a `payment_failed` event -> the pending payment row -> failed
 * `failedEvent` = this call follows a payment_intent.payment_failed event.
 */
export async function applyWireIntent(
  env: Env,
  order: OrderRow,
  row: PaymentRow,
  intent: WireIntent,
  actor: Actor,
  failedEvent = false,
): Promise<WireApplyResult> {
  const db = env.DB;
  if (intent.id !== row.provider_ref || (intent.orderId && intent.orderId !== order.order_no) || intent.currency.toUpperCase() !== "MNT") {
    console.error(`[payments] Wire intent ${intent.id} does not match payment ${row.id} of ${order.order_no}`);
    return "ignored";
  }
  if (intent.status === "succeeded") {
    return markPaid(env, order, { provider: "wire", amount: intent.amount, ref: intent.id, paymentId: intent.charge ?? intent.id }, actor);
  }
  if (row.status !== "pending") return "ignored";
  const close = async (to: "cancelled" | "failed", action: string) => {
    const res = await db.batch([
      db.prepare("UPDATE payments SET status = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'pending'").bind(row.id, to),
      eventStatement(db, order.id, order.status, order.status, actor, `wire payment ${to} (${intent.status})`),
      auditStatement(db, actor, action, "payment", row.id, { orderNo: order.order_no, provider: "wire", intentId: intent.id, status: intent.status }),
    ]);
    return (res[0]?.meta?.changes ?? 0) === 1 ? to : "ignored";
  };
  if (intent.status === "canceled" || intent.status === "cancelled") return close("cancelled", "payment.cancelled");
  // direct QR mode: back at requires_payment_method means the confirmed attempt (its QR) is spent; the row is closed so
  // payment-check opens a fresh intent + confirm (`-pi-2` / `-confirm-2`) and the order page shows the new QR
  const mode = readWireData(row.data_json).mode;
  if (intent.status === "requires_payment_method" && (mode === "qr" || mode === "poll" || mode === "redirect")) return close("failed", "payment.failed");
  if (WIRE_OPEN.has(intent.status)) {
    if (failedEvent) {
      await db.batch([auditStatement(db, actor, "payment.attempt_failed", "payment", row.id, { orderNo: order.order_no, provider: "wire", intentId: intent.id, status: intent.status })]);
    }
    return "pending";
  }
  return failedEvent ? close("failed", "payment.failed") : "pending";
}

/** Asks Wire about every intent of the order that may have been paid and applies the answer. Throws when Wire is unreachable. */
export async function refreshWire(env: Env, order: OrderRow, actor: Actor = "system"): Promise<WireApplyResult[]> {
  if (!wireConfigured(env)) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM payments WHERE order_id = ?1 AND provider = 'wire' AND provider_ref IS NOT NULL
        AND (status = 'pending' OR (status IN ('expired','cancelled','failed') AND provider_payment_id IS NULL))
      ORDER BY id`,
  )
    .bind(order.id)
    .all<PaymentRow>();
  const out: WireApplyResult[] = [];
  let current = order;
  for (const row of rows.results ?? []) {
    const intent = await fetchWireIntent(env, row.provider_ref!);
    // a closed row only matters when the buyer paid it anyway (late payment, recorded for a refund)
    if (row.status !== "pending" && intent.status !== "succeeded") continue;
    const r = await applyWireIntent(env, current, row, intent, actor);
    if (r === "pending") await syncWireAction(env.DB, row, intent);
    out.push(r);
    current = (await loadOrder(env.DB, order.order_no)) ?? current;
  }
  return out;
}

/**
 * Direct mode: keeps the stored next_action in step with Wire (a `poll` that has become a QR, a QR Wire replaced), so the
 * order page shows what Wire says now. Only ever stores Wire's public payload; never changes the payment status.
 */
async function syncWireAction(db: D1, row: PaymentRow, intent: WireIntent): Promise<void> {
  const d = readWireData(row.data_json);
  if (d.mode !== "qr" && d.mode !== "poll") return;
  const na = intent.nextAction;
  let next: WireData | null = null;
  if (na?.type === "qr" && "qrText" in na && na.qrText !== d.qr?.text) next = { ...d, mode: "qr", action: "qr", qr: { text: na.qrText, deeplinks: na.deeplinks } };
  else if (d.mode === "poll" && na?.type === "redirect_to_url" && "url" in na && na.url) next = { ...d, mode: "redirect", action: na.type, checkoutUrl: na.url };
  if (!next) return;
  await db
    .prepare("UPDATE payments SET data_json = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = 'pending' AND data_json = ?3")
    .bind(row.id, JSON.stringify(next), row.data_json)
    .run();
}

/* ---------------- markPaid ---------------- */

export interface PaidInput {
  provider: PaymentProvider;
  /** Amount received so far for this payment (QPay paid_amount / the bank transfer amount). */
  amount: number;
  /** QPay invoice_id, or the bank transfer reference (null when the admin gives none). */
  ref: string | null;
  /** QPay payment_id(s), when known. */
  paymentId?: string | null;
  note?: string | null;
}

export type MarkPaidResult =
  | "paid" //          the order moved to paid now (reservations committed)
  | "already" //       this payment was processed before: nothing changed (idempotent replay)
  | "partial" //       less than the amount due: the payment stays pending
  | "recorded" //      money recorded, but the order was not payable (already paid by another payment, or cancelled): owner must refund
  | "transition" //    nothing to record and the order is not payable (e.g. bank mark-paid on a cancelled order)
  | "duplicate_ref" // the reference / QPay payment id already belongs to another payment
  | "unknown_ref"; //  QPay invoice id not found for this order

const PAYABLE = new Set(["new", "confirmed"]);
const isUnique = (err: unknown) => /UNIQUE constraint failed/i.test(errText(err));

/**
 * Records a confirmed payment and, when it covers the amount due and the order is payable, moves the order to
 * paid and commits its reservations — all in one batch, guarded so it happens at most once.
 */
export async function markPaid(env: Env, order: OrderRow, p: PaidInput, actor: Actor, attempt = 0): Promise<MarkPaidResult> {
  const db = env.DB;
  const ref = p.ref ? p.ref.slice(0, 120) : null;
  const paymentId = p.paymentId ? p.paymentId.slice(0, 200) : null;

  let row: PaymentRow | null = null;
  if (ref) {
    row = await db.prepare("SELECT * FROM payments WHERE provider = ?1 AND provider_ref = ?2").bind(p.provider, ref).first<PaymentRow>();
    if (row && row.order_id !== order.id) return "duplicate_ref";
    if (!row && p.provider !== "bank") return "unknown_ref";
  }
  if (!row && p.provider === "bank") {
    row = await db
      .prepare("SELECT * FROM payments WHERE order_id = ?1 AND provider = 'bank' AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .bind(order.id)
      .first<PaymentRow>();
  }
  if (row?.status === "paid" || row?.status === "refunded") return "already";

  // A QPay invoice that we expired / cancelled but the customer paid anyway: record it once for the owner.
  if (row && row.status !== "pending") {
    if (row.provider_payment_id || p.amount <= 0) return "already";
    try {
      const res = await db.batch([
        db
          .prepare("UPDATE payments SET paid_amount = ?2, provider_payment_id = ?3, updated_at = datetime('now') WHERE id = ?1 AND provider_payment_id IS NULL")
          .bind(row.id, p.amount, paymentId ?? `late:${row.id}`),
        eventStatement(db, order.id, order.status, order.status, actor, `late ${row.provider} payment ${p.amount}₮ on a ${row.status} invoice: refund or re-open`),
        auditStatement(db, actor, "payment.late", "payment", row.id, { orderNo: order.order_no, amount: p.amount, status: row.status }),
      ]);
      if ((res[0]?.meta?.changes ?? 0) !== 1) return "already";
      await notifyTelegramStatus(env, order, { kind: "refund", provider: row.provider, amount: p.amount, actor });
      return "recorded";
    } catch (err) {
      if (isUnique(err)) return "duplicate_ref";
      throw err;
    }
  }

  const due = row?.amount ?? order.total;

  // Not enough yet: keep (or open) a pending payment with what has arrived.
  if (p.amount < due) {
    const stmts: Stmt[] = row
      ? [
          db
            .prepare("UPDATE payments SET paid_amount = ?2, provider_ref = COALESCE(?3, provider_ref), updated_at = datetime('now') WHERE id = ?1 AND status = 'pending'")
            .bind(row.id, p.amount, ref),
        ]
      : [
          db
            .prepare("INSERT INTO payments (order_id, provider, provider_ref, amount, status, paid_amount) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)")
            .bind(order.id, p.provider, ref, due, p.amount),
        ];
    if (PAYABLE.has(order.status)) {
      stmts.push(db.prepare("UPDATE orders SET payment_status = 'pending', updated_at = datetime('now') WHERE id = ?1 AND payment_status = 'unpaid'").bind(order.id));
    }
    stmts.push(auditStatement(db, actor, "payment.partial", "payment", row?.id ?? order.order_no, { orderNo: order.order_no, provider: p.provider, paid: p.amount, due }));
    try {
      await db.batch(stmts);
    } catch (err) {
      if (isUnique(err)) return "duplicate_ref";
      throw err;
    }
    await notifyTelegramStatus(env, order, { kind: "partial", provider: p.provider, amount: p.amount, due, actor });
    return "partial";
  }

  // Full amount. The payment row write (existing pending row -> paid, or a new paid row).
  const payStmt = (): Stmt =>
    row
      ? db
          .prepare(
            `UPDATE payments SET status = 'paid', paid_amount = ?2, provider_ref = COALESCE(?3, provider_ref),
               provider_payment_id = COALESCE(?4, provider_payment_id), paid_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1 AND status = 'pending'`,
          )
          .bind(row.id, p.amount, ref, paymentId)
      : db
          .prepare(
            `INSERT INTO payments (order_id, provider, provider_ref, amount, status, paid_amount, provider_payment_id, paid_at)
             VALUES (?1, ?2, ?3, ?4, 'paid', ?5, ?6, datetime('now'))`,
          )
          .bind(order.id, p.provider, ref, due, p.amount, paymentId);
  const rowGuard = row ? [guard(db, "SELECT 1 FROM payments WHERE id = ?1 AND status = 'pending'", row.id)] : [];
  const auditData = { orderNo: order.order_no, provider: p.provider, amount: p.amount, ref, paymentId };

  let stmts: Stmt[];
  let result: MarkPaidResult;
  if (PAYABLE.has(order.status)) {
    const from = order.status;
    stmts = [
      guardOrderStatus(db, order.id, from),
      ...rowGuard,
      payStmt(),
      // any other open payment for this order (e.g. the QPay invoice of an order paid by bank) is closed
      db
        .prepare("UPDATE payments SET status = 'cancelled', updated_at = datetime('now') WHERE order_id = ?1 AND status = 'pending'")
        .bind(order.id),
      ...commitReservations(db, order.id, actor),
      db
        .prepare(
          `UPDATE orders SET status = 'paid', payment_status = 'paid', hold_expires_at = NULL, updated_at = datetime('now')
            WHERE id = ?1 AND status = ?2`,
        )
        .bind(order.id, from),
      eventStatement(db, order.id, from, "paid", actor, p.note ?? `${p.provider} ${p.amount}₮${ref ? ` ref ${ref}` : ""}`),
      auditStatement(db, actor, "order.paid", "order", order.order_no, auditData),
      emitStatement(db, "order.paid", { orderNo: order.order_no, total: order.total, provider: p.provider, amount: p.amount }),
    ];
    result = "paid";
  } else if (row) {
    // the order was paid by another payment (or moved on): keep the money on record for a refund
    stmts = [
      ...rowGuard,
      payStmt(),
      eventStatement(db, order.id, order.status, order.status, actor, `extra ${p.provider} payment ${p.amount}₮ received: refund`),
      auditStatement(db, actor, "payment.extra", "payment", row.id, auditData),
    ];
    result = "recorded";
  } else {
    return order.status === "cancelled" ? "transition" : order.payment_status === "paid" ? "already" : "transition";
  }

  try {
    await db.batch(stmts);
    await notifyTelegramStatus(
      env,
      { ...order, payment_status: result === "paid" ? "paid" : order.payment_status },
      result === "paid" ? { kind: "paid", provider: p.provider, amount: p.amount, actor } : { kind: "refund", provider: p.provider, amount: p.amount, actor },
    );
    return result;
  } catch (err) {
    if (isGuardError(err) && attempt < 2) {
      // lost a race (callback vs. admin vs. sweep): re-read and decide again
      const fresh = await loadOrder(db, order.order_no);
      return fresh ? markPaid(env, fresh, p, actor, attempt + 1) : "transition";
    }
    if (isUnique(err)) return "duplicate_ref";
    throw err;
  }
}

/* ---------------- QPay re-check (callback, payment-check, hold sweep) ---------------- */

/**
 * Asks QPay about every invoice of the order that may have been paid and applies the answer with markPaid.
 * Never trusts a callback body. Throws when QPay cannot be reached.
 */
export async function refreshQpay(env: Env, order: OrderRow, actor: Actor = "system"): Promise<MarkPaidResult[]> {
  if (!qpayConfigured(env)) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM payments WHERE order_id = ?1 AND provider = 'qpay' AND provider_ref IS NOT NULL
        AND (status = 'pending' OR (status IN ('expired','cancelled') AND provider_payment_id IS NULL))
      ORDER BY id`,
  )
    .bind(order.id)
    .all<PaymentRow>();
  const out: MarkPaidResult[] = [];
  let current = order;
  for (const row of rows.results ?? []) {
    const check = await checkInvoice(env, row.provider_ref!);
    if (check.paidAmount <= 0) continue;
    const r = await markPaid(
      env,
      current,
      { provider: "qpay", amount: check.paidAmount, ref: row.provider_ref, paymentId: check.paymentIds.length ? check.paymentIds.join(",") : null },
      actor,
    );
    out.push(r);
    current = (await loadOrder(env.DB, order.order_no)) ?? current;
  }
  return out;
}
