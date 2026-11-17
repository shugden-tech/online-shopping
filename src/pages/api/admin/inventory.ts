// GET    /api/admin/inventory — every catalog size with its build-time JSON values and its D1 override (if any).
// PUT    /api/admin/inventory { product_id, ml, price: int|null, stock: int|null } — upsert one override.
// DELETE /api/admin/inventory?product_id=..&ml=.. — remove an override (back to the JSON values).
// Rule (see lib/server.ts effectiveSize): a non-null D1 price/stock wins over the JSON; NULL falls back.
// Auth: Authorization: Bearer <ADMIN_TOKEN>.
import type { APIRoute } from "astro";
import { getProducts } from "../../../lib/products";
import { clientIp, fail, json, readJson, requireAdmin, type InventoryRow } from "../../../lib/server";

export const prerender = false;

async function catalogSize(slug: string, ml: number) {
  const p = (await getProducts()).find((x) => x.slug === slug);
  return p?.sizes.find((s) => s.ml === ml);
}

const intOrNull = (v: unknown, min: number, max: number): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

export const GET: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;
    const res = await env.DB.prepare("SELECT product_id, ml, price, stock, updated_at FROM inventory").all<InventoryRow>();
    const rows = new Map((res.results ?? []).map((r) => [`${r.product_id}:${r.ml}`, r]));
    const items = (await getProducts()).flatMap((p) =>
      [...p.sizes]
        .sort((a, b) => a.ml - b.ml)
        .map((s) => {
          const r = rows.get(`${p.slug}:${s.ml}`);
          return {
            product_id: p.slug, brand: p.brand, name: p.name, ml: s.ml,
            json: { price: s.price, inStock: s.inStock, stock: s.stock ?? null },
            override: r ? { price: r.price, stock: r.stock, updated_at: r.updated_at } : null,
          };
        }),
    );
    return json(200, { ok: true, items, overrides: rows.size });
  } catch (err) {
    console.error("[admin/inventory] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const PUT: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;
    const body = await readJson(request, 4096);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as Record<string, unknown>;
    const slug = typeof v.product_id === "string" ? v.product_id : "";
    const ml = typeof v.ml === "number" ? v.ml : NaN;
    const price = intOrNull(v.price ?? null, 1, 5_000_000);
    const stock = intOrNull(v.stock ?? null, 0, 100_000);
    if (!(await catalogSize(slug, ml))) return fail(404, { product_id: "unknown" });
    if (price === undefined) return fail(422, { price: "invalid" });
    if (stock === undefined) return fail(422, { stock: "invalid" });
    const row = await env.DB.prepare(
      `INSERT INTO inventory (product_id, ml, price, stock, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))
       ON CONFLICT(product_id, ml) DO UPDATE SET price = excluded.price, stock = excluded.stock, updated_at = excluded.updated_at
       RETURNING product_id, ml, price, stock, updated_at`,
    )
      .bind(slug, ml, price, stock)
      .first<InventoryRow>();
    return json(200, { ok: true, row });
  } catch (err) {
    console.error("[admin/inventory] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const DELETE: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;
    const slug = url.searchParams.get("product_id") ?? "";
    const ml = Number(url.searchParams.get("ml"));
    const r = await env.DB.prepare("DELETE FROM inventory WHERE product_id = ?1 AND ml = ?2").bind(slug, ml).run();
    return json(200, { ok: true, deleted: r.meta?.changes ?? 0 });
  } catch (err) {
    console.error("[admin/inventory] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET, PUT, DELETE" });
