// GET /api/account/sessions -> { ok, items: [{ current, createdAt, lastSeen, expiresAt, device }] }
// (session ids are not exposed; POST /api/account/logout-all ends them all)
import { json } from "../../../lib/server";
import { accountRoute } from "../../../lib/customers/session";

export const prerender = false;

export const GET = accountRoute("sessions", async (_ctx, env, s) => {
  const { results } = await env.DB
    .prepare(
      `SELECT id, created_at, last_seen, expires_at, user_agent FROM customer_sessions
       WHERE customer_id = ?1 AND expires_at > datetime('now') ORDER BY last_seen DESC LIMIT 50`,
    )
    .bind(s.customer.id)
    .all<{ id: string; created_at: string; last_seen: string; expires_at: string; user_agent: string | null }>();
  return json(200, {
    ok: true,
    items: results.map((r) => ({ current: r.id === s.id, createdAt: r.created_at, lastSeen: r.last_seen, expiresAt: r.expires_at, device: r.user_agent ?? "" })),
  });
});
