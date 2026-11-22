// GET /api/admin/inventory/{sku}/movements?cursor=  [catalog.read]  -> { ok, items: Movement[], nextCursor }
// Newest first. {sku} is the SKU id `${productId}:${ml}` (":" may be sent as %3A).
// A1-owned.
import { adminRoute, pathParam } from "../../../../../lib/catalog/route";
import { listMovements } from "../../../../../lib/catalog/inventory";
import { getSkuRow } from "../../../../../lib/catalog/skus";
import { parseSkuId } from "../../../../../lib/contracts";
import { fail, json } from "../../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/inventory/movements", "catalog.read", async ({ params, url }, env) => {
  const sku = pathParam(params.sku);
  if (!sku || !parseSkuId(sku)) return fail(404, { sku: "not_found" });
  const c = url.searchParams.get("cursor");
  const cursor = c ? Number(c) : undefined;
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) return fail(400, { cursor: "invalid" });
  if (!(await getSkuRow(env.DB, sku))) return fail(404, { sku: "not_found" });
  return json(200, { ok: true, ...(await listMovements(env.DB, sku, cursor)) });
});
