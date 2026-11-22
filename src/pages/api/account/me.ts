// GET   /api/account/me -> { ok, customer | null, google }   (google = Google sign-in is configured)
// PATCH /api/account/me { name?, displayName?, showOnBoard?, phone?, password? } -> { ok, customer, claimed? }
//   phone: set it when the account has none (Google sign-up); changing an existing phone needs `password`.
//   409 { phone: "taken" } when another account has that phone. Contract: docs/CONTRACTS.md §10.
import { cleanName, cleanPhone } from "../../../lib/phone";
import { fail, hitRateLimit, json, readJson } from "../../../lib/server";
import { verifyPassword } from "../../../lib/customers/crypto";
import { googleEnabled } from "../../../lib/customers/google";
import { accountRoute, publicAccountRoute } from "../../../lib/customers/session";
import { claimOrdersStatement, customerView, findByPhone, loadCustomer } from "../../../lib/customers/store";

export const prerender = false;

export const GET = publicAccountRoute("me", async (_ctx, env, s) =>
  json(200, { ok: true, customer: s ? customerView(s.customer) : null, google: googleEnabled(env) }),
);

export const PATCH = accountRoute("me", async ({ request }, env, s) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as Record<string, unknown>;
  const c = s.customer;
  const sets: string[] = [];
  const args: unknown[] = [];
  const errors: Record<string, string> = {};
  const put = (col: string, val: unknown) => {
    args.push(val);
    sets.push(`${col} = ?${args.length}`);
  };

  if (v.name !== undefined) {
    const n = typeof v.name === "string" ? cleanName(v.name) : null;
    if (!n) errors.name = "name";
    else put("name", n);
  }
  if (v.displayName !== undefined) {
    const d = typeof v.displayName === "string" ? v.displayName.trim().replace(/\s+/g, " ").slice(0, 40) : null;
    if (d === null) errors.displayName = "invalid";
    else put("display_name", d);
  }
  if (v.showOnBoard !== undefined) {
    if (typeof v.showOnBoard !== "boolean") errors.showOnBoard = "invalid";
    else put("show_on_board", v.showOnBoard ? 1 : 0);
  }
  let newPhone: string | null = null;
  if (v.phone !== undefined) {
    newPhone = typeof v.phone === "string" ? cleanPhone(v.phone) : null;
    if (!newPhone) errors.phone = "phone";
    else if (newPhone !== c.phone) {
      if (c.phone !== null) {
        // changing a phone that is the login: prove it is you
        if (!(await hitRateLimit(env.DB, `acct-pw:${c.id}`, 10, 600))) return fail(429, { form: "rate" });
        const pw = typeof v.password === "string" ? v.password.slice(0, 200) : "";
        const stored = c.password_hash ? { hash: c.password_hash, salt: c.password_salt!, iter: c.password_iter! } : null;
        if (!stored || !(await verifyPassword(pw, stored))) errors.password = "wrong";
      }
      if (!errors.password && (await findByPhone(env.DB, newPhone))) return fail(409, { phone: "taken" });
      if (!errors.password) put("phone", newPhone);
    } else newPhone = null;
  }
  if (Object.keys(errors).length) return fail(422, errors);
  if (!sets.length) return json(200, { ok: true, customer: customerView(c) });

  args.push(c.id);
  const stmts = [env.DB.prepare(`UPDATE customers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${args.length}`).bind(...args)];
  if (newPhone) stmts.push(claimOrdersStatement(env.DB, c.id, newPhone));
  let claimed = 0;
  try {
    const res = await env.DB.batch(stmts);
    claimed = newPhone ? (res[1]?.meta.changes ?? 0) : 0;
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return fail(409, { phone: "taken" });
    throw err;
  }
  const fresh = await loadCustomer(env.DB, c.id);
  return json(200, { ok: true, customer: customerView(fresh!), ...(newPhone ? { claimed } : {}) });
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET, PATCH" });
