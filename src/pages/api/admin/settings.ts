// GET /api/admin/settings -> { ok, settings }            (settings.read)
// PUT /api/admin/settings { key: value, ... } -> { ok, settings }  (settings.write; unknown keys -> 400)
// Lead-owned. Store controls: checkout open/closed, payment methods on/off, hold times, delivery fees.
import type { APIRoute } from "astro";
import { auditStatement } from "../../../lib/audit";
import { authorize } from "../../../lib/auth";
import type { Settings } from "../../../lib/contracts";
import { clientIp, fail, json, readJson } from "../../../lib/server";
import { checkSetting, getSettings, settingStatements } from "../../../lib/settings";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "settings.read");
    if (s instanceof Response) return s;
    return json(200, { ok: true, settings: await getSettings(env.DB) });
  } catch (err) {
    console.error("[admin/settings]", err);
    return fail(500, { form: "server" });
  }
};

export const PUT: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "settings.write");
    if (s instanceof Response) return s;
    const body = await readJson(request, 8 * 1024);
    if (body instanceof Response) return body;
    const v = body.value;
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) return fail(400, { form: "invalid" });
    const errors: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      const e = checkSetting(k, val);
      if (e) errors[k] = e;
    }
    if (Object.keys(errors).length) return fail(400, errors);
    const patch = v as Partial<Settings>;
    await env.DB.batch([...settingStatements(env.DB, patch, s.actor), auditStatement(env.DB, s.actor, "settings.update", "settings", null, patch)]);
    return json(200, { ok: true, settings: await getSettings(env.DB) });
  } catch (err) {
    console.error("[admin/settings]", err);
    return fail(500, { form: "server" });
  }
};
