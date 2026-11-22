// POST /api/account/register { phone, password, name, turnstileToken, website }  -> 201 { ok, customer, claimed }
// Turnstile + honeypot like the checkout; 5 sign-ups / IP / hour and 3 / phone / hour. Past guest orders whose phone
// equals the new account's phone are linked to it. Contract: docs/CONTRACTS.md §10.
import { verifyTurnstile } from "../../../lib/orders/notify";
import { cleanName, cleanPhone } from "../../../lib/phone";
import { fail, hitRateLimit, json, readJson } from "../../../lib/server";
import { hashPassword, passwordProblem } from "../../../lib/customers/crypto";
import { createSession, publicAccountRoute, withCookies } from "../../../lib/customers/session";
import { claimOrdersStatement, customerView, findByPhone, loadCustomer } from "../../../lib/customers/store";

export const prerender = false;

export const POST = publicAccountRoute("register", async ({ request }, env, _s, ip) => {
  const body = await readJson(request, 8 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  if (s("website").trim() !== "") return fail(400, { form: "server" });

  const phone = cleanPhone(s("phone"));
  const name = cleanName(s("name"));
  const password = s("password");
  const errors: Record<string, string> = {};
  if (!phone) errors.phone = s("phone").trim() ? "phone" : "required";
  if (!name) errors.name = s("name").trim() ? "name" : "required";
  const pw = passwordProblem(password, phone);
  if (pw) errors.password = pw;
  const token = s("turnstileToken");
  if (!token) errors.turnstile = "turnstileMissing";
  if (Object.keys(errors).length) return fail(422, errors);

  if (!env.TURNSTILE_SECRET) {
    console.error("[account/register] TURNSTILE_SECRET is not set");
    return fail(500, { form: "server" });
  }
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip))) return fail(422, { turnstile: "turnstile" });
  if (!(await hitRateLimit(env.DB, `acct-reg:${ip}`, 5, 3600))) return fail(429, { form: "rate" });
  if (!(await hitRateLimit(env.DB, `acct-reg-phone:${phone}`, 3, 3600))) return fail(429, { form: "rate" });

  if (await findByPhone(env.DB, phone!)) return fail(409, { phone: "taken" });
  const h = await hashPassword(password);
  let id: number;
  try {
    const row = await env.DB
      .prepare(
        `INSERT INTO customers (phone, name, display_name, password_hash, password_salt, password_iter)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5) RETURNING id`,
      )
      .bind(phone, name, h.hash, h.salt, h.iter)
      .first<{ id: number }>();
    id = row!.id;
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return fail(409, { phone: "taken" });
    throw err;
  }
  const claim = await claimOrdersStatement(env.DB, id, phone!).run();
  const session = await createSession(env.DB, id, request);
  const customer = await loadCustomer(env.DB, id);
  return withCookies(json(201, { ok: true, customer: customerView(customer!), claimed: claim.meta.changes ?? 0 }), session.cookies);
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
