// POST /api/admin/products/bulk  (lead, 0004)
//   { ids: string[] (1–100), action: "activate" | "hide" | "draft" }                  [catalog.write]
//   { ids, action: "price", ml: 1–1000, price: ₮ > 0 | null, kind?: "decant"|"full" } [catalog.write]
// -> { ok, changed }   One D1 batch with one audit row per product. "price" creates the size when it is
// missing (kind defaults to decant for ≤ 30 ml, else full) and clears a compare-at price that would no longer
// be above the new price. Prices are only ever what the owner typed.
import { auditStatement } from "../../../../lib/audit";
import { adminRoute } from "../../../../lib/catalog/route";
import { PRODUCT_ID_RE, SKU_KINDS, skuId } from "../../../../lib/contracts";
import { fail, json, readJson } from "../../../../lib/server";

export const prerender = false;

const STATUS: Record<string, string> = { activate: "active", hide: "hidden", draft: "draft" };

export const POST = adminRoute("admin/products/bulk", "catalog.write", async ({ request }, env, s) => {
  const body = await readJson(request, 16 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as { ids?: unknown; action?: unknown; ml?: unknown; price?: unknown; kind?: unknown };
  const ids = Array.isArray(v.ids) ? [...new Set(v.ids)] : [];
  if (!ids.length || ids.length > 100 || !ids.every((id) => typeof id === "string" && PRODUCT_ID_RE.test(id))) return fail(400, { ids: "invalid" });
  const action = typeof v.action === "string" ? v.action : "";
  const db = env.DB;
  const found = await db.prepare("SELECT id FROM products WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all<{ id: string }>();
  const existing = (found.results ?? []).map((r) => r.id);
  if (!existing.length) return fail(404, { ids: "not_found" });

  if (action in STATUS) {
    const to = STATUS[action]!;
    const res = await db.batch([
      db.prepare("UPDATE products SET status = ?1, updated_at = datetime('now') WHERE status <> ?1 AND id IN (SELECT value FROM json_each(?2))")
        .bind(to, JSON.stringify(existing)),
      ...existing.map((id) => auditStatement(db, s.actor, "product.update", "product", id, { status: to, bulk: true })),
    ]);
    return json(200, { ok: true, changed: res[0]!.meta.changes ?? 0 });
  }

  if (action === "price") {
    const ml = Number(v.ml);
    if (!Number.isInteger(ml) || ml < 1 || ml > 1000) return fail(400, { ml: "invalid" });
    const price = v.price === null ? null : Number(v.price);
    if (price !== null && (!Number.isInteger(price) || price <= 0 || price > 100_000_000)) return fail(400, { price: "invalid" });
    const kind = v.kind === undefined ? (ml <= 30 ? "decant" : "full") : String(v.kind);
    if (!(SKU_KINDS as readonly string[]).includes(kind)) return fail(400, { kind: "invalid" });
    const res = await db.batch(
      existing.flatMap((id) => [
        db
          .prepare(
            `INSERT INTO skus (id, product_id, ml, kind, price) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET price = excluded.price,
               compare_at = CASE WHEN skus.compare_at IS NOT NULL AND excluded.price IS NOT NULL AND skus.compare_at > excluded.price THEN skus.compare_at ELSE NULL END,
               updated_at = datetime('now')`,
          )
          .bind(skuId(id, ml), id, ml, kind, price),
        auditStatement(db, s.actor, "sku.update", "sku", skuId(id, ml), { price, bulk: true }),
      ]),
    );
    return json(200, { ok: true, changed: res.filter((_, i) => i % 2 === 0).reduce((a, r) => a + (r.meta.changes ?? 0), 0) });
  }
  return fail(400, { action: "invalid" });
});
