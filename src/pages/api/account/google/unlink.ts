// POST /api/account/google/unlink -> { ok, customer }
// Only when the account can still sign in without Google (it has a phone and a password): else 409 { form: "no-password" }.
import { fail, json } from "../../../../lib/server";
import { accountRoute } from "../../../../lib/customers/session";
import { customerView, loadCustomer } from "../../../../lib/customers/store";

export const prerender = false;

export const POST = accountRoute("google/unlink", async (_ctx, env, s) => {
  const c = s.customer;
  if (!c.google_sub) return json(200, { ok: true, customer: customerView(c) });
  if (!c.password_hash || !c.phone) return fail(409, { form: "no-password" });
  await env.DB.prepare("UPDATE customers SET google_sub = NULL, email = NULL, updated_at = datetime('now') WHERE id = ?1").bind(c.id).run();
  return json(200, { ok: true, customer: customerView((await loadCustomer(env.DB, c.id))!) });
});
