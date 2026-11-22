// GET  /api/admin/shipments?status=&orderNo=&cursor=&limit= -> { ok, items, nextCursor }   (delivery.read)
// POST /api/admin/shipments { orderNo, provider? } -> 201 { ok, shipment }                   (delivery.write)
//   The order must be `paid` and have no active (non-cancelled) shipment, else 409. The provider is the
//   one named, else the `delivery.provider` setting. Automatic providers are called right away; a failed
//   call leaves the shipment `failed` with next_retry_at for retryShipments(). A3-owned.
import type { APIRoute } from "astro";
import { authorize } from "../../../lib/auth";
import { SHIPMENT_STATUSES } from "../../../lib/contracts";
import { resolveProvider } from "../../../lib/delivery/registry";
import { createShipment, detailsStatement, loadShipment, patchShipment, shipmentView, type ShipmentRow } from "../../../lib/delivery/service";
import { createSchema, zodErrors } from "../../../lib/delivery/validate";
import { clientIp, fail, json, readJson } from "../../../lib/server";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "delivery.read");
    if (s instanceof Response) return s;
    const status = url.searchParams.get("status") ?? "";
    const orderNo = (url.searchParams.get("orderNo") ?? "").toUpperCase();
    if (status && !(SHIPMENT_STATUSES as readonly string[]).includes(status)) return fail(400, { status: "invalid" });
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const cursor = Number(url.searchParams.get("cursor")) || 0;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (status) { where.push("s.status = ?"); args.push(status); }
    if (orderNo) { where.push("o.order_no = ?"); args.push(orderNo.slice(0, 40)); }
    if (cursor > 0) { where.push("s.id < ?"); args.push(cursor); }
    args.push(limit + 1);
    const res = await env.DB.prepare(
      `SELECT s.id, s.order_id, s.provider, s.provider_ref, s.tracking_no, s.tracking_url, s.status, s.attempts, s.last_error,
              s.next_retry_at, s.created_at, s.updated_at, s.courier, s.fee, s.note, o.order_no, o.status AS order_status
         FROM shipments s JOIN orders o ON o.id = s.order_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY s.id DESC LIMIT ?`,
    ).bind(...args).all<ShipmentRow>();
    const rows = res.results ?? [];
    const items = rows.slice(0, limit).map(shipmentView);
    return json(200, { ok: true, items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null });
  } catch (err) {
    console.error("[admin/shipments]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const s = await authorize(request, env, clientIp(request, () => clientAddress), "delivery.write");
    if (s instanceof Response) return s;
    const body = await readJson(request, 2048);
    if (body instanceof Response) return body;
    const parsed = createSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, zodErrors(parsed.error));
    const p = await resolveProvider(env, parsed.data.provider);
    if ("error" in p) return fail(422, { provider: p.error });
    const out = await createShipment(env, parsed.data.orderNo, p.adapter, s.actor);
    if (!out.ok) return json(out.status, { ok: false, errors: out.errors, ...(out.shipmentId ? { shipmentId: out.shipmentId } : {}) });
    // optional manual-delivery details given with the create (courier, fee, notes, tracking)
    const { courier, fee, notes, trackingNo, trackingUrl } = parsed.data;
    const details = detailsStatement(env.DB, out.shipment.id, { courier, fee, notes });
    if (details) await details.run();
    if ((trackingNo || trackingUrl) && !p.adapter.automatic) {
      await patchShipment(env, out.shipment.id, { trackingNo: trackingNo || null, trackingUrl: trackingUrl || null }, s.actor);
    }
    const row = details || trackingNo || trackingUrl ? await loadShipment(env.DB, out.shipment.id) : null;
    return json(201, { ok: true, shipment: row ? shipmentView(row) : out.shipment });
  } catch (err) {
    console.error("[admin/shipments]", (err as Error)?.message ?? err);
    return fail(500, { form: "server" });
  }
};
