// POST /api/account/password { current?, next } -> { ok, ended }
//   `current` is required when the account has a password (a Google-only account sets its first one without it).
//   Every OTHER session of the customer is ended; this one stays signed in. 10 tries / customer / 10 min.
import { fail, hitRateLimit, json, readJson } from "../../../lib/server";
import { hashPassword, passwordProblem, verifyPassword } from "../../../lib/customers/crypto";
import { accountRoute } from "../../../lib/customers/session";
import { endSessionsStatement } from "../../../lib/customers/store";

export const prerender = false;

export const POST = accountRoute("password", async ({ request }, env, s) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as Record<string, unknown>;
  const c = s.customer;
  const next = typeof v.next === "string" ? v.next : "";
  if (!(await hitRateLimit(env.DB, `acct-pw:${c.id}`, 10, 600))) return fail(429, { form: "rate" });
  if (c.password_hash) {
    const current = typeof v.current === "string" ? v.current.slice(0, 200) : "";
    if (!(await verifyPassword(current, { hash: c.password_hash, salt: c.password_salt!, iter: c.password_iter! }))) {
      return fail(422, { current: "wrong" });
    }
  }
  const problem = passwordProblem(next, c.phone);
  if (problem) return fail(422, { next: problem });
  const h = await hashPassword(next);
  const res = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE customers SET password_hash = ?1, password_salt = ?2, password_iter = ?3, must_change_password = 0,
           updated_at = datetime('now') WHERE id = ?4`,
      )
      .bind(h.hash, h.salt, h.iter, c.id),
    endSessionsStatement(env.DB, c.id, s.id),
  ]);
  return json(200, { ok: true, ended: res[1]?.meta.changes ?? 0 });
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
