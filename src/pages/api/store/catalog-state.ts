// GET /api/store/catalog-state?ids=a,b,…  (public; <= 60 ids; no ids -> 400)  -> { ok, ...StoreState } (contracts.ts)
// Cache-Control: public, max-age=30. Unknown ids are omitted; draft/hidden products -> visible:false, nothing sellable.
// A1-owned.
import type { APIRoute } from "astro";
import { getStoreState, parseIds, qpayConfigured } from "../../../lib/catalog/store";
import { wireConfigured } from "../../../lib/payments/wire";
import { fail, json } from "../../../lib/server";
import { getSettings } from "../../../lib/settings";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const ids = parseIds(url.searchParams.get("ids"));
    if (!Array.isArray(ids)) return fail(400, { ids: ids.error });
    const state = await getStoreState(env.DB, ids, await getSettings(env.DB), { qpayConfigured: qpayConfigured(env), wireConfigured: wireConfigured(env) });
    return json(200, { ok: true, ...state }, { "Cache-Control": "public, max-age=30" });
  } catch (err) {
    console.error("[store/catalog-state]", err);
    return fail(500, { form: "server" });
  }
};
