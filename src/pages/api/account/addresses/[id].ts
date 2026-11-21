// PATCH  /api/account/addresses/{id} { label?, city?, district?, khoroo?, address?, isDefault? } -> { ok, items }
// DELETE /api/account/addresses/{id} -> { ok, items }   (deleting the default makes the oldest remaining one default)
// Only the customer's own addresses (else 404).
import { issuesToErrors } from "../../../../lib/order-schema";
import { fail, json, readJson } from "../../../../lib/server";
import { accountRoute } from "../../../../lib/customers/session";
import { addressSchema, listAddresses, type AddressRow } from "../../../../lib/customers/store";

export const prerender = false;

const idOf = (p: string | undefined) => (p && /^\d{1,12}$/.test(p) ? Number(p) : null);

export const PATCH = accountRoute("addresses", async ({ request, params }, env, s) => {
  const id = idOf(params.id);
  const cid = s.customer.id;
  const row = id ? await env.DB.prepare("SELECT * FROM customer_addresses WHERE id = ?1 AND customer_id = ?2").bind(id, cid).first<AddressRow>() : null;
  if (!row) return fail(404, { form: "not_found" });
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const patch = (body.value && typeof body.value === "object" ? body.value : {}) as Record<string, unknown>;
  const merged = {
    label: row.label, city: row.city, district: row.district, khoroo: row.khoroo, address: row.address,
    ...Object.fromEntries(Object.entries(patch).filter(([k]) => ["label", "city", "district", "khoroo", "address", "isDefault"].includes(k))),
  };
  const parsed = addressSchema.safeParse(merged);
  if (!parsed.success) return fail(422, issuesToErrors(parsed.error));
  const a = parsed.data;
  const makeDefault = a.isDefault === true && row.is_default !== 1;
  await env.DB.batch([
    ...(makeDefault ? [env.DB.prepare("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?1 AND is_default = 1").bind(cid)] : []),
    env.DB
      .prepare(
        `UPDATE customer_addresses SET label = ?1, city = ?2, district = ?3, khoroo = ?4, address = ?5,
           is_default = CASE WHEN ?6 = 1 THEN 1 ELSE is_default END, updated_at = datetime('now') WHERE id = ?7 AND customer_id = ?8`,
      )
      .bind(a.label, a.city, a.district, a.khoroo, a.address, makeDefault ? 1 : 0, id, cid),
  ]);
  return json(200, { ok: true, items: await listAddresses(env.DB, cid) });
});

export const DELETE = accountRoute("addresses", async ({ params }, env, s) => {
  const id = idOf(params.id);
  const cid = s.customer.id;
  const row = id ? await env.DB.prepare("SELECT is_default FROM customer_addresses WHERE id = ?1 AND customer_id = ?2").bind(id, cid).first<{ is_default: number }>() : null;
  if (!row) return fail(404, { form: "not_found" });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM customer_addresses WHERE id = ?1 AND customer_id = ?2").bind(id, cid),
    ...(row.is_default === 1
      ? [env.DB.prepare(
          `UPDATE customer_addresses SET is_default = 1 WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = ?1 ORDER BY id LIMIT 1)`,
        ).bind(cid)]
      : []),
  ]);
  return json(200, { ok: true, items: await listAddresses(env.DB, cid) });
});
