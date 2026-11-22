// A2: order creation as ONE D1 batch (all or nothing):
//   orders insert -> skus.reserved += qty (tracked lines; the skus CHECK reserved <= stock aborts the batch on
//   oversell) -> reservations (held) -> order_events (created) -> audit_log.
import { auditStatement } from "../audit";
import { emitStatement } from "../webhooks";
import type { PaymentProvider, Settings } from "../contracts";
import { orderNumber } from "./number";
import { firstShortLine, type Reserve } from "./pricing";
import { errText, isCheckError } from "./state";
import type { D1, OrderLine, Stmt } from "./types";

export interface NewOrder {
  name: string;
  phone: string;
  phone2: string;
  city: string;
  district: string;
  khoroo: string;
  address: string;
  note: string;
  payment: PaymentProvider;
  locale: "mn" | "en";
}

export type PlaceResult =
  | { ok: true; orderNo: string; holdExpiresAt: string }
  | { ok: false; kind: "stock"; short: { sku: string; available: number }[] }
  | { ok: false; kind: "replay" };

/** SQLite datetime('now', '+N minutes') text, computed here so the response can carry it. */
export function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function holdMinutes(settings: Settings, payment: PaymentProvider): number {
  const m = payment === "qpay" ? settings["holds.qpay_minutes"] : payment === "wire" ? settings["holds.wire_minutes"] : settings["holds.bank_minutes"];
  // Wire: the hold is also the PaymentIntent's expires_at, which Wire allows 5 min – 24 h
  if (payment === "wire") return Number.isInteger(m) && m >= 5 && m <= 1440 ? m : 30;
  return Number.isInteger(m) && m > 0 ? m : payment === "qpay" ? 30 : 1440;
}

/** Audit / webhook form of a line: SKU lines as before; bundle lines add the bundle id and its parts. */
export const lineSummary = (l: OrderLine) => ({
  sku: l.sku,
  qty: l.qty,
  price: l.price,
  ...(l.bundle ? { bundle: l.bundle.id, name: l.bundle.nameMn, parts: l.bundle.parts.map((p) => ({ sku: p.sku, qty: p.qty })) } : {}),
});

/** The cart line a short SKU belongs to (its own line, else the first bundle that contains it). */
const lineOf = (lines: OrderLine[], sku: string) =>
  lines.find((l) => l.sku === sku)?.sku ?? lines.find((l) => l.bundle?.parts.some((p) => p.sku === sku))?.sku ?? sku;

export async function placeOrder(
  db: D1,
  o: NewOrder,
  priced: { lines: OrderLine[]; reserve: Reserve[]; subtotal: number; delivery: number; total: number },
  settings: Settings,
  ip: string,
  idemKey: string | null,
  /** Signed-in customer (from the session cookie, never the request body); null for a guest order. */
  customerId: number | null = null,
): Promise<PlaceResult> {
  // guest orders do not name the column, so checkout keeps working on a database without migration 0007
  const linkCol = customerId === null ? "" : ", customer_id";
  const linkVal = customerId === null ? "" : ", ?19";
  const holdExpiresAt = sqliteTime(Date.now() + holdMinutes(settings, o.payment) * 60_000);
  for (let attempt = 0; ; attempt++) {
    const orderNo = orderNumber();
    const oid = "(SELECT id FROM orders WHERE order_no = ?1)";
    const stmts: Stmt[] = [
      db
        .prepare(
          `INSERT INTO orders (order_no, name, phone, phone2, city, district, khoroo, address, note, payment,
             items_json, subtotal, delivery, total, locale, ip, idempotency_key, updated_at, payment_status, hold_expires_at${linkCol})
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), 'unpaid', ?18${linkVal})`,
        )
        .bind(
          orderNo, o.name, o.phone, o.phone2 || null, o.city, o.district || null, o.khoroo || null, o.address, o.note || null,
          o.payment, JSON.stringify(priced.lines), priced.subtotal, priced.delivery, priced.total, o.locale, ip, idemKey, holdExpiresAt, ...(customerId === null ? [] : [customerId]),
        ),
      // Every SKU reserves (standalone lines and bundle parts, summed per SKU); it is "tracked" when the SKU has a
      // stock figure at batch time. The UPDATE and the INSERT read the same row inside the transaction, so
      // reservations.tracked always matches what was reserved.
      ...priced.reserve.flatMap((l) => [
        db
          .prepare("UPDATE skus SET reserved = reserved + ?2, updated_at = datetime('now') WHERE id = ?1 AND stock IS NOT NULL")
          .bind(l.sku, l.qty),
        db
          .prepare(
            `INSERT INTO reservations (order_id, sku_id, qty, tracked)
             VALUES (${oid}, ?2, ?3, (SELECT CASE WHEN stock IS NULL THEN 0 ELSE 1 END FROM skus WHERE id = ?2))`,
          )
          .bind(orderNo, l.sku, l.qty),
      ]),
      db.prepare(`INSERT INTO order_events (order_id, from_status, to_status, actor) VALUES (${oid}, NULL, 'new', 'customer')`).bind(orderNo),
      auditStatement(db, "customer", "order.create", "order", orderNo, {
        payment: o.payment,
        total: priced.total,
        items: priced.lines.map(lineSummary),
      }),
      emitStatement(db, "order.created", {
        orderNo, payment: o.payment, subtotal: priced.subtotal, delivery: priced.delivery, total: priced.total,
        items: priced.lines.map(lineSummary),
      }),
    ];
    try {
      await db.batch(stmts);
      return { ok: true, orderNo, holdExpiresAt };
    } catch (err) {
      const msg = errText(err);
      if (isCheckError(err)) {
        // lost the race for the last units: nothing was written; report what is left now
        const short = (await firstShortLine(db, priced.reserve)).map((x) => ({ ...x, sku: lineOf(priced.lines, x.sku) }));
        return { ok: false, kind: "stock", short: short.length ? short : [{ sku: priced.lines.find((l) => l.tracked)?.sku ?? priced.lines[0]!.sku, available: 0 }] };
      }
      if (/UNIQUE/i.test(msg) && /idempotency_key/i.test(msg)) return { ok: false, kind: "replay" };
      if (attempt < 4 && /UNIQUE/i.test(msg) && /order_no/i.test(msg)) continue;
      throw err;
    }
  }
}
