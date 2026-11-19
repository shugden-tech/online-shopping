// GET /api/admin/products/facets  [catalog.read]  (lead, 0004)
// Values for the product list filters: { ok, brands: [{ value, n }], families: [{ value, n }], counts: { status: n } }.
import { adminRoute } from "../../../../lib/catalog/route";
import { json } from "../../../../lib/server";

export const prerender = false;

export const GET = adminRoute("admin/products/facets", "catalog.read", async (_ctx, env) => {
  const db = env.DB;
  const [brands, families, statuses] = await db.batch([
    db.prepare("SELECT brand AS value, COUNT(*) AS n FROM products GROUP BY brand COLLATE NOCASE ORDER BY brand COLLATE NOCASE"),
    db.prepare("SELECT family AS value, COUNT(*) AS n FROM products WHERE family IS NOT NULL GROUP BY family ORDER BY family"),
    db.prepare("SELECT status AS value, COUNT(*) AS n FROM products GROUP BY status"),
  ]);
  return json(200, {
    ok: true,
    brands: brands!.results ?? [],
    families: families!.results ?? [],
    counts: Object.fromEntries(((statuses!.results ?? []) as { value: string; n: number }[]).map((r) => [r.value, r.n])),
  });
});
