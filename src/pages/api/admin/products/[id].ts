// GET   /api/admin/products/{id}  [catalog.read]   -> { ok, product } | 404 { id: "not_found" }
// PATCH /api/admin/products/{id}  [catalog.write]  any editable AdminProduct field -> { ok, product }
// A1-owned. Images: https on the PUBLIC_MEDIA_BASE host or a site path "/…" (else 400 { imageFront: "host" }).
import { adminRoute, pathParam } from "../../../../lib/catalog/route";
import { getAdminProduct, patchProduct } from "../../../../lib/catalog/products";
import { issuesToErrors, productPatchSchema } from "../../../../lib/catalog/validate";
import { PRODUCT_ID_RE } from "../../../../lib/contracts";
import { fail, json, readJson } from "../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/products/id", "catalog.read", async ({ params }, env) => {
  const id = pathParam(params.id);
  if (!id || !PRODUCT_ID_RE.test(id)) return fail(404, { id: "not_found" });
  const product = await getAdminProduct(env.DB, id);
  return product ? json(200, { ok: true, product }) : fail(404, { id: "not_found" });
});

export const PATCH = adminRoute("admin/products/id", "catalog.write", async ({ params, request }, env, s) => {
  const id = pathParam(params.id);
  if (!id || !PRODUCT_ID_RE.test(id)) return fail(404, { id: "not_found" });
  const body = await readJson(request, 32 * 1024);
  if (body instanceof Response) return body;
  const parsed = productPatchSchema(env.PUBLIC_MEDIA_BASE).safeParse(body.value);
  if (!parsed.success) return fail(400, issuesToErrors(parsed.error.issues));
  const product = await patchProduct(env.DB, s.actor, id, parsed.data);
  return product ? json(200, { ok: true, product }) : fail(404, { id: "not_found" });
});
