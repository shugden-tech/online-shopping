// POST /api/admin/login { username, password } -> { ok, token, role }  (lead-owned)
// Convenience for demos: ADMIN_USERNAME/ADMIN_PASSWORD (owner) and STAFF_USERNAME/STAFF_PASSWORD (staff) are
// optional secrets. A correct pair returns the matching bearer token, which the UI then uses as before.
// Disabled (503) until a password of >= 12 characters is configured. Failed attempts: 20 / 10 min / IP.
import type { APIRoute } from "astro";
import { safeEqual } from "../../../lib/auth";
import { clientIp, fail, hitRateLimit, json, readJson } from "../../../lib/server";

export const prerender = false;
const MIN_PASSWORD = 12;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const accounts = [
      { role: "owner", user: env.ADMIN_USERNAME, pass: env.ADMIN_PASSWORD, token: env.ADMIN_TOKEN },
      { role: "staff", user: env.STAFF_USERNAME, pass: env.STAFF_PASSWORD, token: env.STAFF_TOKEN },
    ].filter((a) => a.user && a.pass && a.pass.length >= MIN_PASSWORD && a.token && a.token.length >= 24);
    if (!accounts.length) return fail(503, { form: "login-disabled" });
    const ip = clientIp(request, () => clientAddress);
    const body = await readJson(request, 2048);
    if (body instanceof Response) return body;
    const v = body.value as { username?: unknown; password?: unknown } | null;
    const u = typeof v?.username === "string" ? v.username : "";
    const p = typeof v?.password === "string" ? v.password : "";
    let hit: (typeof accounts)[number] | null = null;
    for (const a of accounts) {
      const [okU, okP] = await Promise.all([safeEqual(u, a.user!), safeEqual(p, a.pass!)]);
      if (okU && okP) hit = a;
    }
    if (!hit) {
      if (!(await hitRateLimit(env.DB, `admin-fail:${ip}`, 20, 600))) return fail(429, { form: "rate" });
      return fail(401, { form: "unauthorized" });
    }
    return json(200, { ok: true, token: hit.token, role: hit.role });
  } catch (err) {
    console.error("[admin/login]", err);
    return fail(500, { form: "server" });
  }
};
