// POST /api/account/logout -> { ok } ; ends this session and clears the cookies (works without a session too).
import { json } from "../../../lib/server";
import { clearCookies, publicAccountRoute, withCookies } from "../../../lib/customers/session";

export const prerender = false;

export const POST = publicAccountRoute("logout", async (_ctx, env, s) => {
  if (s) await env.DB.prepare("DELETE FROM customer_sessions WHERE id = ?1").bind(s.id).run();
  return withCookies(json(200, { ok: true }), clearCookies());
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
