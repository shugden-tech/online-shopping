// POST /api/admin/customers/{id}/reset-password [customers.write, owner only] -> { ok, tempPassword }
// Forgot-password help while there is no SMS: the customer phones the shop, the owner checks who they are and
// reads them the temporary password (shown ONCE, never stored in plain text or logged). Every session of the
// customer is ended and the profile asks them to choose a new password. Audit-logged (no PII).
import { auditStatement } from "../../../../../lib/audit";
import { adminRoute } from "../../../../../lib/catalog/route";
import { fail, json } from "../../../../../lib/server";
import { hashPassword, tempPassword } from "../../../../../lib/customers/crypto";

export const prerender = false;

export const POST = adminRoute("admin/customers/reset", "customers.write", async ({ params }, env, s) => {
  const id = /^\d{1,12}$/.test(params.id ?? "") ? Number(params.id) : 0;
  const c = id ? await env.DB.prepare("SELECT id, phone FROM customers WHERE id = ?1 AND deleted_at IS NULL").bind(id).first<{ id: number; phone: string | null }>() : null;
  if (!c) return fail(404, { form: "not_found" });
  if (!c.phone) return fail(409, { form: "no-phone" });
  const temp = tempPassword();
  const h = await hashPassword(temp);
  const res = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE customers SET password_hash = ?1, password_salt = ?2, password_iter = ?3, must_change_password = 1,
           updated_at = datetime('now') WHERE id = ?4 AND deleted_at IS NULL`,
      )
      .bind(h.hash, h.salt, h.iter, id),
    env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1").bind(id),
    auditStatement(env.DB, s.actor, "customer.reset_password", "customer", id),
  ]);
  return json(200, { ok: true, tempPassword: temp, sessionsEnded: res[1]?.meta.changes ?? 0 });
});
