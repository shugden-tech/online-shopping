// A1 catalog: SKU (offer) upsert and delete. Prices are only ever what the admin typed; null = not for sale.
import { skuId, type Actor, type AdminSku } from "../contracts";
import { auditStatement } from "../audit";
import { SKU_COLS, isConstraint, toAdminSku, type D1, type SkuRow } from "./map";
import type { SkuUpsert } from "./validate";

export const parseMl = (raw: string | undefined): number | null => {
  const ml = Number(raw);
  return /^\d{1,4}$/.test(raw ?? "") && Number.isInteger(ml) && ml > 0 && ml <= 1000 ? ml : null;
};

export async function getSkuRow(db: D1, id: string): Promise<SkuRow | null> {
  return db.prepare(`SELECT ${SKU_COLS} FROM skus WHERE id = ?1`).bind(id).first<SkuRow>();
}

export type UpsertResult =
  | { ok: true; sku: AdminSku; created: boolean }
  | { ok: false; status: number; errors: Record<string, string> };

/** Inserts or updates the offer `${productId}:${ml}`. Only the given fields change on update. */
export async function upsertSku(db: D1, actor: Actor, productId: string, ml: number, input: SkuUpsert): Promise<UpsertResult> {
  const product = await db.prepare("SELECT id FROM products WHERE id = ?1").bind(productId).first<{ id: string }>();
  if (!product) return { ok: false, status: 404, errors: { id: "not_found" } };
  const id = skuId(productId, ml);
  const before = await getSkuRow(db, id);
  if (!before && !input.kind) return { ok: false, status: 400, errors: { kind: "required" } };
  const next = {
    kind: input.kind ?? before!.kind,
    price: input.price !== undefined ? input.price : (before?.price ?? null),
    compareAt: input.compareAt !== undefined ? input.compareAt : (before?.compare_at ?? null),
    active: input.active !== undefined ? input.active : before ? before.active === 1 : true,
  };
  if (next.compareAt !== null && next.price !== null && next.compareAt <= next.price) {
    return { ok: false, status: 400, errors: { compareAt: "not_above_price" } };
  }
  const audit: Record<string, unknown> = { ...input };
  if (before) audit.before = { kind: before.kind, price: before.price, compareAt: before.compare_at, active: before.active === 1 };
  await db.batch([
    db
      .prepare(
        `INSERT INTO skus (id, product_id, ml, kind, price, compare_at, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, price = excluded.price, compare_at = excluded.compare_at,
           active = excluded.active, updated_at = datetime('now')`,
      )
      .bind(id, productId, ml, next.kind, next.price, next.compareAt, next.active ? 1 : 0),
    auditStatement(db, actor, before ? "sku.update" : "sku.create", "sku", id, audit),
  ]);
  const row = await getSkuRow(db, id);
  return { ok: true, sku: toAdminSku(row!), created: !before };
}

export type DeleteResult = { ok: true } | { ok: false; status: number; errors: Record<string, string> };

/** Deletes an offer that no reservation references (any status). Its stock history goes with it (CASCADE). */
export async function deleteSku(db: D1, actor: Actor, productId: string, ml: number): Promise<DeleteResult> {
  const id = skuId(productId, ml);
  const before = await getSkuRow(db, id);
  if (!before) return { ok: false, status: 404, errors: { sku: "not_found" } };
  const ref = await db.prepare("SELECT 1 AS x FROM reservations WHERE sku_id = ?1 LIMIT 1").bind(id).first();
  if (ref) return { ok: false, status: 409, errors: { sku: "reserved" } };
  try {
    // reservations.sku_id has no ON DELETE action, so a reservation inserted meanwhile fails the whole batch.
    await db.batch([
      db.prepare("DELETE FROM skus WHERE id = ?1").bind(id),
      auditStatement(db, actor, "sku.delete", "sku", id, { kind: before.kind, price: before.price, stock: before.stock }),
    ]);
  } catch (err) {
    if (isConstraint(err, "FOREIGN KEY")) return { ok: false, status: 409, errors: { sku: "reserved" } };
    throw err;
  }
  return { ok: true };
}
