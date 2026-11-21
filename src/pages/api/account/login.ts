// POST /api/account/login { phone, password } -> 200 { ok, customer } + session cookie
// One generic answer for an unknown phone, a wrong password and a Google-only account (401 { form: "invalid" });
// an unknown phone still costs one PBKDF2 so timing does not tell them apart.
// Limits (failed attempts only, so a shared mobile-carrier IP or a customer signing in on many devices is not
// locked out): 20 failures / IP / 10 min and 8 / phone / 15 min (429 { form: "rate" }, checked before the password).
import { cleanPhone } from "../../../lib/phone";
import { fail, hitRateLimit, json, readJson } from "../../../lib/server";
import { overRateLimit } from "../../../lib/customers/limits";
import { verifyPassword } from "../../../lib/customers/crypto";
import { createSession, publicAccountRoute, withCookies } from "../../../lib/customers/session";
import { customerView, findByPhone } from "../../../lib/customers/store";

export const prerender = false;

export const POST = publicAccountRoute("login", async ({ request }, env, _s, ip) => {
  const body = await readJson(request, 4 * 1024);
  if (body instanceof Response) return body;
  const v = (body.value ?? {}) as Record<string, unknown>;
  const rawPhone = typeof v.phone === "string" ? v.phone : "";
  const password = typeof v.password === "string" ? v.password.slice(0, 200) : "";
  if (!rawPhone.trim() || !password) return fail(422, { form: "required" });

  const phone = cleanPhone(rawPhone);
  const ipKey = `acct-login:${ip}`;
  const phoneKey = phone ? `acct-login-phone:${phone}` : null;
  if ((await overRateLimit(env.DB, ipKey, 20, 600)) || (phoneKey && (await overRateLimit(env.DB, phoneKey, 8, 900)))) {
    return fail(429, { form: "rate" });
  }

  const c = phone ? await findByPhone(env.DB, phone) : null;
  const stored = c?.password_hash && c.password_salt && c.password_iter
    ? { hash: c.password_hash, salt: c.password_salt, iter: c.password_iter }
    : null;
  const good = await verifyPassword(password, stored);
  if (!good || !c) {
    await hitRateLimit(env.DB, ipKey, 20, 600);
    if (phoneKey) await hitRateLimit(env.DB, phoneKey, 8, 900);
    return fail(401, { form: "invalid" });
  }

  const session = await createSession(env.DB, c.id, request);
  return withCookies(json(200, { ok: true, customer: customerView(c) }), session.cookies);
});

export const ALL = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "POST" });
