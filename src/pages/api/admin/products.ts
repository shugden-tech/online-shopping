// GET  /api/admin/products?q=&status=&brand=&page=&limit=  [catalog.read]  -> { ok, items, page, limit, total }
// POST /api/admin/products  [catalog.write]  -> 201 { ok, product }   (id: PRODUCT_ID_RE, unique -> 409 { id: "taken" })
// A1-owned. Contract: docs/CONTRACTS.md §4.
import { adminRoute } from "../../../lib/catalog/route";
import { createProduct, listProducts, parseProductQuery } from "../../../lib/catalog/products";
import { issuesToErrors, productCreateSchema } from "../../../lib/catalog/validate";
import { fail, json, readJson } from "../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/products", "catalog.read", async ({ url }, env) => {
  const q = parseProductQuery(url.searchParams);
  if ("errors" in q) return fail(400, q.errors);
  return json(200, { ok: true, ...(await listProducts(env.DB, q)) });
});

export const POST = adminRoute("admin/products", "catalog.write", async ({ request }, env, s) => {
  const body = await readJson(request, 32 * 1024);
  if (body instanceof Response) return body;
  const parsed = productCreateSchema(env.PUBLIC_MEDIA_BASE).safeParse(body.value);
  if (!parsed.success) return fail(400, issuesToErrors(parsed.error.issues));
  const product = await createProduct(env.DB, s.actor, parsed.data);
  if (!product) return fail(409, { id: "taken" });
  return json(201, { ok: true, product });
});
