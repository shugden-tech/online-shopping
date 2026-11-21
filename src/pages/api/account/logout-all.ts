// POST /api/account/logout-all -> { ok, ended } ; ends every session of this customer (all devices), this one too.
import { json } from "../../../lib/server";
import { accountRoute, clearCookies, withCookies } from "../../../lib/customers/session";
import { endSessionsStatement } from "../../../lib/customers/store";

export const prerender = false;

export const POST = accountRoute("logout-all", async (_ctx, env, s) => {
  const r = await endSessionsStatement(env.DB, s.customer.id, null).run();
  return withCookies(json(200, { ok: true, ended: r.meta.changes ?? 0 }), clearCookies());
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
