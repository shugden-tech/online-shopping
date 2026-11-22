// GET   /api/admin/shipments/{id}            -> { ok, shipment, events }            (delivery.read)
// GET   /api/admin/shipments/{id}?refresh=1  -> asks the provider first (track)     (delivery.write)
// PATCH /api/admin/shipments/{id} { status?, trackingNo?, trackingUrl?, note? }     (delivery.write)
//   status follows SHIPMENT_TRANSITIONS (409 otherwise) with the order side effects of CONTRACTS §3.
//   Made for the manual provider; on an automatic provider it is an admin override ("pending" -> use /retry,
//   "cancelled" cancels at the provider first, 502 if that fails). A3-owned.
import type { APIRoute } from "astro";
import { authorize } from "../../../../lib/auth";
import { loadShipment, patchShipment, refreshShipment, shipmentEvents, shipmentView } from "../../../../lib/delivery/service";
import { patchSchema, zodErrors } from "../../../../lib/delivery/validate";
import { clientIp, fail, json, readJson } from "../../../../lib/server";

export const prerender = false;

const idOf = (v: string | undefined) => (v && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : 0);

export const GET: APIRoute = async ({ request, locals, clientAddress, params, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const refresh = url.searchParams.get("refresh") === "1";
    const s = await authorize(request, env, clientIp(request, () => clientAddress), refresh ? "delivery.write" : "delivery.read");
    if (s instanceof Response) return s;
    const id = idOf(params.id);
    if (!id) return fail(404, { form: "notFound" });
    let row = await loadShipment(env.DB, id);
    if (!row) return fail(404, { form: "notFound" });
    let refreshed: unknown;
    if (refresh) {
      refreshed = await refreshShipment(env, row, s.actor);
      row = (await loadShipment(env.DB, id))!;
    }
    return json(200, { ok: true, shipment: shipmentView(row), events: await shipmentEvents(env.DB, id), ...(refresh ? { refreshed } : {}) });
  } catch (err) {
    console.error("[admin/shipment]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};

export const PATCH: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "delivery.write");
    if (s instanceof Response) return s;
    const id = idOf(params.id);
    if (!id) return fail(404, { form: "notFound" });
    const body = await readJson(request, 4096);
    if (body instanceof Response) return body;
    const parsed = patchSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, zodErrors(parsed.error));
    const out = await patchShipment(env, id, parsed.data, s.actor);
    if (!out.ok) return json(out.status, { ok: false, errors: out.errors, ...(out.from ? { from: out.from, to: out.to } : {}) });
    const row = (await loadShipment(env.DB, id))!;
    return json(200, { ok: true, shipment: shipmentView(row), events: await shipmentEvents(env.DB, id) });
  } catch (err) {
    console.error("[admin/shipment]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};
