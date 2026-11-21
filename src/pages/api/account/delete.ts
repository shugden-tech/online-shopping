// POST /api/account/delete { password } (or { confirm: true } for a Google-only account without a password)
//   -> { ok } + cookies cleared.
// The customer row stays as a tombstone (orders reference it) with every personal field removed; sessions,
// addresses, wishlist and the avatar are deleted. Orders are kept for the accounts: finished ones (done /
// cancelled) lose name, phones, address and note; open orders keep them until they are delivered.
import { fail, hitRateLimit, json, readJson } from "../../../lib/server";
import { verifyPassword } from "../../../lib/customers/crypto";
import { accountRoute, clearCookies, withCookies } from "../../../lib/customers/session";

export const prerender = false;

export const POST = accountRoute("delete", async ({ request }, env, s) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as Record<string, unknown>;
  const c = s.customer;
  if (!(await hitRateLimit(env.DB, `acct-pw:${c.id}`, 10, 600))) return fail(429, { form: "rate" });
  if (c.password_hash) {
    const pw = typeof v.password === "string" ? v.password.slice(0, 200) : "";
    if (!(await verifyPassword(pw, { hash: c.password_hash, salt: c.password_salt!, iter: c.password_iter! }))) return fail(422, { password: "wrong" });
  } else if (v.confirm !== true) return fail(422, { confirm: "required" });

  if (c.avatar_key && env.MEDIA && /^customers\/\d+\.(jpg|png|webp)$/.test(c.avatar_key)) await env.MEDIA.delete(c.avatar_key);
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1").bind(c.id),
    db.prepare("DELETE FROM customer_addresses WHERE customer_id = ?1").bind(c.id),
    db.prepare("DELETE FROM customer_wishlist WHERE customer_id = ?1").bind(c.id),
    db
      .prepare(
        `UPDATE orders SET name = '-', phone = '00000000', phone2 = NULL, khoroo = NULL, address = '-', note = NULL, ip = NULL
         WHERE customer_id = ?1 AND status IN ('done', 'cancelled')`,
      )
      .bind(c.id),
    db
      .prepare(
        `UPDATE customers SET phone = NULL, name = '', display_name = '', password_hash = NULL, password_salt = NULL,
           password_iter = NULL, must_change_password = 0, avatar_key = NULL, show_on_board = 0, google_sub = NULL, email = NULL,
           deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`,
      )
      .bind(c.id),
  ]);
  return withCookies(json(200, { ok: true }), clearCookies());
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
