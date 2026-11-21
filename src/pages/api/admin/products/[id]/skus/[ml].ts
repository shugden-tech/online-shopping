// PUT    /api/admin/products/{id}/skus/{ml}  [catalog.write]  { kind?, price?, compareAt?, active? } -> { ok, sku, created }
//        (kind required when the SKU is new; price null = not for sale; only the given fields change)
// DELETE /api/admin/products/{id}/skus/{ml}  [catalog.write]  -> { ok } | 404 | 409 { sku: "reserved" }
// A1-owned.
import { adminRoute, pathParam } from "../../../../../../lib/catalog/route";
import { deleteSku, parseMl, upsertSku } from "../../../../../../lib/catalog/skus";
import { issuesToErrors, skuUpsertSchema } from "../../../../../../lib/catalog/validate";
import { PRODUCT_ID_RE } from "../../../../../../lib/contracts";
import { fail, json, readJson } from "../../../../../../lib/server";

export const prerender = false;

function target(params: Record<string, string | undefined>): { id: string; ml: number } | { error: Response } {
  const id = pathParam(params.id);
  const ml = parseMl(params.ml);
  if (!id || !PRODUCT_ID_RE.test(id)) return { error: fail(404, { id: "not_found" }) };
  if (ml === null) return { error: fail(400, { ml: "invalid" }) };
  return { id, ml };
}

export const PUT = adminRoute("admin/skus", "catalog.write", async ({ params, request }, env, s) => {
  const t = target(params);
  if ("error" in t) return t.error;
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const parsed = skuUpsertSchema.safeParse(body.value);
  if (!parsed.success) return fail(400, issuesToErrors(parsed.error.issues));
  const r = await upsertSku(env.DB, s.actor, t.id, t.ml, parsed.data);
  return r.ok ? json(200, { ok: true, sku: r.sku, created: r.created }) : fail(r.status, r.errors);
});

export const DELETE = adminRoute("admin/skus", "catalog.write", async ({ params }, env, s) => {
  const t = target(params);
  if ("error" in t) return t.error;
  const r = await deleteSku(env.DB, s.actor, t.id, t.ml);
  return r.ok ? json(200, { ok: true }) : fail(r.status, r.errors);
});
