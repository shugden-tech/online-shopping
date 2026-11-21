// GET /api/admin/me -> { ok, role, permissions } (lead-owned). Lets the admin UI show only what the token may do.
import type { APIRoute } from "astro";
import { authorize } from "../../../lib/auth";
import { ROLE_PERMISSIONS } from "../../../lib/contracts";
import { clientIp, fail, json } from "../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress));
    if (s instanceof Response) return s;
    return json(200, { ok: true, role: s.role, permissions: ROLE_PERMISSIONS[s.role] });
  } catch (err) {
    console.error("[admin/me]", err);
    return fail(500, { form: "server" });
  }
};
