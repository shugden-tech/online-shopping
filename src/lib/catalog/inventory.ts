// A1 catalog: inventory list, admin stock adjustments (restock / correction) and movement history.
// Stock arithmetic: docs/CONTRACTS.md §3. The skus CHECK (reserved <= stock, stock >= 0) is the guard: an
// adjustment that would go below reserved fails the whole batch, movement and audit row included.
import type { Actor, AdminSku, ProductStatus } from "../contracts";
import { auditStatement } from "../audit";
import { SKU_COLS, isConstraint, toAdminSku, type D1, type SkuRow } from "./map";
import { getSkuRow } from "./skus";
import type { AdjustInput } from "./validate";

export interface InventoryItem extends AdminSku {
  brand: string;
  name: string;
  productStatus: ProductStatus;
}

export interface InventoryQuery {
  low?: number;
  /** 0004: brand / name / SKU id contains */
  q?: string;
  /** 0004: only SKUs whose stock is tracked */
  tracked?: boolean;
  /** 0004: only SKUs of active products */
  active?: boolean;
  cursor?: string;
  limit: number;
}

export function parseInventoryQuery(sp: URLSearchParams): InventoryQuery | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const lowRaw = sp.get("low");
  const low = lowRaw === null || lowRaw === "" ? undefined : Number(lowRaw);
  if (low !== undefined && (!Number.isInteger(low) || low < 0 || low > 100_000)) errors.low = "invalid";
  const cursor = sp.get("cursor") || undefined;
  if (cursor && cursor.length > 140) errors.cursor = "invalid";
  const limit = sp.has("limit") ? Number(sp.get("limit")) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) errors.limit = "invalid";
  const q = (sp.get("q") ?? "").trim().slice(0, 80) || undefined;
  const tracked = sp.get("tracked") === "1" || undefined;
  const active = sp.get("active") === "1" || undefined;
  if (Object.keys(errors).length) return { errors };
  return { low, q, tracked, active, cursor, limit };
}

/** Keyset list ordered by SKU id. `low` = tracked SKUs whose available (stock - reserved) is <= low. */
export async function listInventory(db: D1, q: InventoryQuery): Promise<{ items: InventoryItem[]; nextCursor: string | null }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `?${args.length}`;
  };
  if (q.low !== undefined) where.push(`s.stock IS NOT NULL AND s.stock - s.reserved <= ${arg(q.low)}`);
  if (q.q) {
    const p = arg(`%${q.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where.push(`(p.brand LIKE ${p} ESCAPE '\\' OR p.name LIKE ${p} ESCAPE '\\' OR s.id LIKE ${p} ESCAPE '\\')`);
  }
  if (q.tracked) where.push("s.stock IS NOT NULL");
  if (q.active) where.push("p.status = 'active'");
  if (q.cursor) where.push(`s.id > ${arg(q.cursor)}`);
  const sql = `SELECT ${SKU_COLS.split(", ").map((c) => "s." + c).join(", ")}, p.brand, p.name, p.status AS product_status
    FROM skus s JOIN products p ON p.id = s.product_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY s.id LIMIT ${arg(q.limit + 1)}`;
  const res = await db.prepare(sql).bind(...args).all<SkuRow & { brand: string; name: string; product_status: string }>();
  const rows = res.results ?? [];
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return {
    items: page.map((r) => ({ ...toAdminSku(r), brand: r.brand, name: r.name, productStatus: r.product_status as ProductStatus })),
    nextCursor: more ? page[page.length - 1]!.id : null,
  };
}

export interface Movement {
  id: number;
  skuId: string;
  at: string;
  delta: number;
  reason: string;
  orderId: number | null;
  actor: string;
  note: string | null;
}

interface MovementRow { id: number; sku_id: string; at: string; delta: number; reason: string; order_id: number | null; actor: string; note: string | null }
const toMovement = (r: MovementRow): Movement => ({
  id: r.id, skuId: r.sku_id, at: r.at, delta: r.delta, reason: r.reason, orderId: r.order_id, actor: r.actor, note: r.note,
});

/** Newest first. `cursor` = the last movement id of the previous page. */
export async function listMovements(db: D1, sku: string, cursor: number | undefined, limit = 50): Promise<{ items: Movement[]; nextCursor: string | null }> {
  const res = await db
    .prepare(
      `SELECT id, sku_id, at, delta, reason, order_id, actor, note FROM stock_movements
       WHERE sku_id = ?1 ${cursor ? "AND id < ?3" : ""} ORDER BY id DESC LIMIT ?2`,
    )
    .bind(...(cursor ? [sku, limit + 1, cursor] : [sku, limit + 1]))
    .all<MovementRow>();
  const rows = res.results ?? [];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { items: page.map(toMovement), nextCursor: more ? String(page[page.length - 1]!.id) : null };
}

export type AdjustResult =
  | { ok: true; sku: AdminSku; movement: Movement }
  | { ok: false; status: number; errors: Record<string, string> };

/**
 * `set` makes stock = n (an untracked SKU becomes tracked; the movement delta is n - old, old NULL = 0).
 * `delta` adds to a tracked stock (an untracked SKU is refused: 409 { stock: "untracked" }).
 * The movement row reads the old stock inside the same batch, so it always matches the change made.
 */
export async function adjustStock(db: D1, actor: Actor, input: AdjustInput): Promise<AdjustResult> {
  if ((input.set === undefined) === (input.delta === undefined)) return { ok: false, status: 400, errors: { form: "set_or_delta" } };
  const before = await getSkuRow(db, input.sku);
  if (!before) return { ok: false, status: 404, errors: { sku: "not_found" } };
  if (input.delta !== undefined && before.stock === null) return { ok: false, status: 409, errors: { stock: "untracked" } };
  const note = input.note || null;
  const stmts =
    input.set !== undefined
      ? [
          db
            .prepare(
              `INSERT INTO stock_movements (sku_id, delta, reason, actor, note)
               SELECT id, ?2 - COALESCE(stock, 0), ?3, ?4, ?5 FROM skus WHERE id = ?1`,
            )
            .bind(input.sku, input.set, input.reason, actor, note),
          db.prepare("UPDATE skus SET stock = ?2, updated_at = datetime('now') WHERE id = ?1").bind(input.sku, input.set),
        ]
      : [
          db
            .prepare(
              `INSERT INTO stock_movements (sku_id, delta, reason, actor, note)
               SELECT id, ?2, ?3, ?4, ?5 FROM skus WHERE id = ?1 AND stock IS NOT NULL`,
            )
            .bind(input.sku, input.delta, input.reason, actor, note),
          db
            .prepare("UPDATE skus SET stock = stock + ?2, updated_at = datetime('now') WHERE id = ?1 AND stock IS NOT NULL")
            .bind(input.sku, input.delta),
        ];
  let results;
  try {
    results = await db.batch([
      ...stmts,
      db
        .prepare(`SELECT id, sku_id, at, delta, reason, order_id, actor, note FROM stock_movements WHERE id = last_insert_rowid() AND sku_id = ?1`)
        .bind(input.sku),
      auditStatement(db, actor, "inventory.adjust", "sku", input.sku, {
        set: input.set, delta: input.delta, reason: input.reason, note: input.note, stockBefore: before.stock, reserved: before.reserved,
      }),
    ]);
  } catch (err) {
    if (isConstraint(err, "CHECK")) return { ok: false, status: 409, errors: { stock: "below_reserved" } };
    throw err;
  }
  const mv = (results[2]?.results?.[0] ?? null) as MovementRow | null;
  const after = await getSkuRow(db, input.sku);
  if (!mv || !after) return { ok: false, status: 409, errors: { sku: "changed" } };
  return { ok: true, sku: toAdminSku(after), movement: toMovement(mv) };
}
