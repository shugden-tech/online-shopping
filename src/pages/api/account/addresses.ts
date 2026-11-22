// GET  /api/account/addresses -> { ok, items }
// POST /api/account/addresses { label?, city, district, khoroo?, address, isDefault? } -> 201 { ok, address, items }
//   <= 10 per customer (409 { form: "limit" }). The first address is the default; isDefault moves the default.
import { issuesToErrors } from "../../../lib/order-schema";
import { fail, json, readJson } from "../../../lib/server";
import { accountRoute } from "../../../lib/customers/session";
import { addressSchema, addressView, listAddresses, MAX_ADDRESSES, type AddressRow } from "../../../lib/customers/store";

export const prerender = false;

export const GET = accountRoute("addresses", async (_ctx, env, s) => json(200, { ok: true, items: await listAddresses(env.DB, s.customer.id) }));

export const POST = accountRoute("addresses", async ({ request }, env, s) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const parsed = addressSchema.safeParse(body.value);
  if (!parsed.success) return fail(422, issuesToErrors(parsed.error));
  const a = parsed.data;
  const cid = s.customer.id;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?1").bind(cid).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ADDRESSES) return fail(409, { form: "limit" });
  const makeDefault = a.isDefault === true || (count?.n ?? 0) === 0;
  const res = await env.DB.batch([
    ...(makeDefault ? [env.DB.prepare("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?1 AND is_default = 1").bind(cid)] : []),
    env.DB
      .prepare(
        `INSERT INTO customer_addresses (customer_id, label, city, district, khoroo, address, is_default)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`,
      )
      .bind(cid, a.label, a.city, a.district, a.khoroo, a.address, makeDefault ? 1 : 0),
  ]);
  const row = (res[res.length - 1]!.results as AddressRow[])[0]!;
  return json(201, { ok: true, address: addressView(row), items: await listAddresses(env.DB, cid) });
});
