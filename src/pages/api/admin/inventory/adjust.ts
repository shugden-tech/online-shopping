// POST /api/admin/inventory/adjust  [inventory.write]
//   { sku, set? | delta?, reason: "restock" | "correction", note? }  (exactly one of set / delta)
//   -> { ok, sku, movement } | 404 { sku: "not_found" } | 409 { stock: "below_reserved" | "untracked" }
// A1-owned. Stock change + stock_movements row + audit row in one D1 batch.
import { adminRoute } from "../../../../lib/catalog/route";
import { adjustStock } from "../../../../lib/catalog/inventory";
import { adjustSchema, issuesToErrors } from "../../../../lib/catalog/validate";
import { fail, json, readJson } from "../../../../lib/server";

export const prerender = false;

export const POST = adminRoute("admin/inventory/adjust", "inventory.write", async ({ request }, env, s) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const parsed = adjustSchema.safeParse(body.value);
  if (!parsed.success) return fail(400, issuesToErrors(parsed.error.issues));
  const r = await adjustStock(env.DB, s.actor, parsed.data);
  return r.ok ? json(200, { ok: true, sku: r.sku, movement: r.movement }) : fail(r.status, r.errors);
});
