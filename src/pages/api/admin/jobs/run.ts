// POST /api/admin/jobs/run [orders.write] -> { ok, expired, retried, failed }  (lead-owned)
// Runs the housekeeping jobs on demand (no cron needed): expire unpaid orders past their hold (A2) and
// retry due shipments (A3), and send due outbound webhooks (0004). Safe to call any time; idempotent and bounded.
import type { APIRoute } from "astro";
import { auditStatement } from "../../../../lib/audit";
import { authorize } from "../../../../lib/auth";
import { retryShipments } from "../../../../lib/delivery/retry";
import { sweepExpiredHolds } from "../../../../lib/orders/holds";
import { deliverDue, pruneStatements } from "../../../../lib/webhooks";
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
    const hooks = await deliverDue(env, 30);
    const busy = expired + retried + failed + hooks.delivered + hooks.failed > 0;
    // the admin calls this on every poll: only write an audit row when something happened
    await env.DB.batch([
      ...pruneStatements(env.DB),
      ...(busy ? [auditStatement(env.DB, s.actor, "jobs.run", "settings", null, { expired, retried, failed, webhooks: hooks })] : []),
    ]);
    return json(200, { ok: true, expired, retried, failed, webhooks: hooks });
  } catch (err) {
    console.error("[admin/jobs/run]", err);
    return fail(500, { form: "server" });
  }
};
