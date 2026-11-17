// GET /api/admin/inventory?low=&cursor=&limit=  [catalog.read]
//   -> { ok, items: (AdminSku & { brand, name, productStatus })[], nextCursor }
//   low = only tracked SKUs whose available (stock - reserved) <= low. Keyset by SKU id.
// A1-owned. Replaces the pre-A0 per-size override endpoint (the 0002 inventory table is dropped in 0003).
import { adminRoute } from "../../../lib/catalog/route";
import { listInventory, parseInventoryQuery } from "../../../lib/catalog/inventory";
import { fail, json } from "../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/inventory", "catalog.read", async ({ url }, env) => {
  const q = parseInventoryQuery(url.searchParams);
  if ("errors" in q) return fail(400, q.errors);
  return json(200, { ok: true, ...(await listInventory(env.DB, q)) });
});
