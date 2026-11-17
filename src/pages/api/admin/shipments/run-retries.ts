// POST /api/admin/shipments/run-retries?limit= -> { ok, retried, failed }   (delivery.write)
// Runs retryShipments(env, limit) now: the delivery half of POST /api/admin/jobs/run, for the admin UI's
// "retry due shipments" button and for scripts/test-delivery.mjs. A3-owned.
import type { APIRoute } from "astro";
import { authorize } from "../../../../lib/auth";
import { retryShipments } from "../../../../lib/delivery/retry";
import { clientIp, fail, json } from "../../../../lib/server";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "delivery.write");
    if (s instanceof Response) return s;
    const limit = Number(url.searchParams.get("limit")) || 20;
    return json(200, { ok: true, ...(await retryShipments(env, limit)) });
  } catch (err) {
    console.error("[admin/shipments/run-retries]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};
