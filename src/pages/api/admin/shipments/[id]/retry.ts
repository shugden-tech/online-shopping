// POST /api/admin/shipments/{id}/retry -> { ok, outcome, shipment }   (delivery.write)
// failed -> pending -> provider call (automatic providers). Also re-sends a `pending` automatic shipment
// whose lease has run out. 409 for any other status. A3-owned.
import type { APIRoute } from "astro";
import { authorize } from "../../../../../lib/auth";
import { loadShipment, retryShipment, shipmentView } from "../../../../../lib/delivery/service";
import { clientIp, fail, json } from "../../../../../lib/server";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "delivery.write");
    if (s instanceof Response) return s;
    const id = params.id && /^[1-9]\d{0,9}$/.test(params.id) ? Number(params.id) : 0;
    if (!id) return fail(404, { form: "notFound" });
    const out = await retryShipment(env, id, s.actor, "admin");
    if (!out.ok) return fail(out.status, out.errors);
    return json(200, { ok: true, outcome: out.outcome, shipment: shipmentView((await loadShipment(env.DB, id))!) });
  } catch (err) {
    console.error("[admin/shipment/retry]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};
