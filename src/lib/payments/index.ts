// A2 payments: payment instructions, QPay invoice creation, markPaid (idempotent) and QPay re-checks.
import fileSettings from "../../data/settings.json";
import { auditStatement } from "../audit";
import type { Actor, PaymentInstructions, PaymentProvider } from "../contracts";
import { commitReservations, errText, eventStatement, guard, guardOrderStatus, isGuardError } from "../orders/state";
import { loadOrder, type D1, type OrderRow, type PaymentRow, type Stmt } from "../orders/types";
import { checkInvoice, createInvoice, qpayConfigured, type QpayInvoice } from "./qpay";
import { emitStatement } from "../webhooks";

export { qpayConfigured, qpayEnabled } from "./qpay";

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

/** The instructions a customer needs to pay this order now (null when nothing is payable / no invoice yet). */
export async function instructionsFor(db: D1, order: OrderRow): Promise<PaymentInstructions | null> {
  if (order.payment === "bank") return bankInstructions(order.order_no, order.locale, await liveBank(db));
  const row = await db
    .prepare("SELECT provider_ref, data_json FROM payments WHERE order_id = ?1 AND provider = 'qpay' AND status = 'pending' AND provider_ref IS NOT NULL ORDER BY id DESC LIMIT 1")
    .bind(order.id)
    .first<Pick<PaymentRow, "provider_ref" | "data_json">>();
  return row ? qpayInstructions(row) : null;
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
    if (!row && p.provider === "qpay") return "unknown_ref";
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
      return (res[0]?.meta?.changes ?? 0) === 1 ? "recorded" : "already";
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
