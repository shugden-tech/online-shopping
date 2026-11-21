// GET /api/store/bundles?ids=a,b  (public; ≤ 30 ids; no ids = every active bundle)
//   -> { ok, checkoutOpen, payments: { qpay, bank, wire }, bundles: BundleState[] }   Cache-Control: public, max-age=30
// Live price / availability of bundles for the bundle page and the cart re-check. Unknown ids are omitted;
// draft / hidden bundles come back with sellable:false, block:"hidden". Contract: docs/CONTRACTS.md §9.
import type { APIRoute } from "astro";
import { listBundles, toState } from "../../../lib/bundles/store";
import { qpayConfigured } from "../../../lib/catalog/store";
import { wireConfigured } from "../../../lib/payments/wire";
import { BUNDLE_ID_RE } from "../../../lib/bundles/types";
import { fail, json } from "../../../lib/server";
import { getSettings } from "../../../lib/settings";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const raw = url.searchParams.get("ids");
    const ids = raw === null ? null : [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids && ids.length > 30) return fail(400, { ids: "too_many" });
    const settings = await getSettings(env.DB);
    const checkoutOpen = settings["checkout.open"] === true;
    const list = await listBundles(env.DB, ids ? { ids: ids.filter((id) => BUNDLE_ID_RE.test(id)), checkoutOpen } : { status: "active", checkoutOpen });
    const payments = {
      qpay: settings["payments.qpay.enabled"] === true && qpayConfigured(env),
      bank: settings["payments.bank.enabled"] === true,
      wire: settings["payments.wire.enabled"] === true && wireConfigured(env),
    };
    return json(200, { ok: true, checkoutOpen, payments, bundles: list.map(toState) }, { "Cache-Control": "public, max-age=30" });
  } catch (err) {
    console.error("[store/bundles]", err);
    return fail(500, { form: "server" });
  }
};
