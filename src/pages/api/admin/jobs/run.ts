// POST /api/admin/jobs/run [orders.write] -> { ok, expired, retried, failed }  (lead-owned)
// Runs the housekeeping jobs on demand (no cron needed): expire unpaid orders past their hold (A2) and
// retry due shipments (A3). Safe to call any time; both jobs are idempotent and bounded.
import type { APIRoute } from "astro";
import { auditStatement } from "../../../../lib/audit";
import { authorize } from "../../../../lib/auth";
import { retryShipments } from "../../../../lib/delivery/retry";
import { sweepExpiredHolds } from "../../../../lib/orders/holds";
import { clientIp, fail, json } from "../../../../lib/server";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "orders.write");
    if (s instanceof Response) return s;
    const { expired } = await sweepExpiredHolds(env, 100);
    const { retried, failed } = await retryShipments(env, 50);
    await env.DB.batch([auditStatement(env.DB, s.actor, "jobs.run", "settings", null, { expired, retried, failed })]);
    return json(200, { ok: true, expired, retried, failed });
  } catch (err) {
    console.error("[admin/jobs/run]", err);
    return fail(500, { form: "server" });
  }
};
