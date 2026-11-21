// GET /api/account/wishlist -> { ok, items }
// PUT /api/account/wishlist { items: WishItem[], mode: "merge" | "replace" } -> { ok, items }
//   merge   = union of the server list and `items` (sign-in on a device with a local wishlist; server rows win)
//   replace = the server list becomes exactly `items` (after the customer adds / removes on a signed-in device)
//   Items are sanitized to the display fields the storefront wishlist uses; <= 200 items; bad items are skipped.
import { fail, json, readJson } from "../../../lib/server";
import { accountRoute } from "../../../lib/customers/session";
import { listWish, MAX_WISH, sanitizeWish } from "../../../lib/customers/store";

export const prerender = false;

export const GET = accountRoute("wishlist", async (_ctx, env, s) => json(200, { ok: true, items: await listWish(env.DB, s.customer.id) }));

export const PUT = accountRoute("wishlist", async ({ request }, env, s) => {
  const body = await readJson(request, 256 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as { items?: unknown; mode?: unknown };
  if (!Array.isArray(v.items) || (v.mode !== "merge" && v.mode !== "replace")) return fail(400, { form: "invalid" });
  if (v.items.length > MAX_WISH) return fail(413, { items: "limit" });
  const seen = new Set<string>();
  const clean = v.items.flatMap((i) => {
    const w = sanitizeWish(i);
    if (!w || seen.has(w.productId)) return [];
    seen.add(w.productId);
    return [w];
  });
  const cid = s.customer.id;
  const db = env.DB;
  const insert = (w: { productId: string; item: Record<string, unknown> }) =>
    db
      .prepare(
        v.mode === "merge"
          ? "INSERT OR IGNORE INTO customer_wishlist (customer_id, product_id, item_json) VALUES (?1, ?2, ?3)"
          : `INSERT INTO customer_wishlist (customer_id, product_id, item_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(customer_id, product_id) DO UPDATE SET item_json = excluded.item_json`,
      )
      .bind(cid, w.productId, JSON.stringify(w.item));
  const stmts = [
    ...(v.mode === "replace"
      ? [db.prepare(`DELETE FROM customer_wishlist WHERE customer_id = ?1 AND product_id NOT IN (SELECT value FROM json_each(?2))`).bind(cid, JSON.stringify(clean.map((w) => w.productId)))]
      : []),
    ...clean.map(insert),
  ];
  if (stmts.length) await db.batch(stmts);
  let items = await listWish(db, cid);
  if (items.length > MAX_WISH) {
    // merge can exceed the cap: keep the oldest MAX_WISH
    await db
      .prepare(
        `DELETE FROM customer_wishlist WHERE customer_id = ?1 AND product_id NOT IN
           (SELECT product_id FROM customer_wishlist WHERE customer_id = ?1 ORDER BY created_at, product_id LIMIT ?2)`,
      )
      .bind(cid, MAX_WISH)
      .run();
    items = await listWish(db, cid);
  }
  return json(200, { ok: true, items });
});
