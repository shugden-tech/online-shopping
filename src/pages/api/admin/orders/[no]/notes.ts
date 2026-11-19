// POST /api/admin/orders/{no}/notes { note }  [orders.write]  (lead, 0004) -> 201 { ok, note: { id, at, actor, note } }
// Internal note on an order: shown only in the admin, never to the customer.
import { auditStatement } from "../../../../../lib/audit";
import { adminRoute } from "../../../../../lib/catalog/route";
import { ORDER_NO_RE, loadOrder, normOrderNo } from "../../../../../lib/orders/types";
import { fail, json, readJson } from "../../../../../lib/server";

export const prerender = false;

export const POST = adminRoute("admin/order-notes", "orders.write", async ({ request, params }, env, s) => {
  const no = normOrderNo(params.no);
  if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });
  const body = await readJson(request, 4096);
  if (body instanceof Response) return body;
  const note = typeof (body.value as { note?: unknown })?.note === "string" ? ((body.value as { note: string }).note).trim() : "";
  if (!note || note.length > 1000) return fail(400, { note: note ? "invalid" : "required" });
  const order = await loadOrder(env.DB, no);
  if (!order) return fail(404, { form: "notFound" });
  const [ins] = await env.DB.batch([
    env.DB.prepare("INSERT INTO order_notes (order_id, actor, note) VALUES (?1, ?2, ?3) RETURNING id, at, actor, note").bind(order.id, s.actor, note),
    auditStatement(env.DB, s.actor, "order.note", "order", order.order_no, { length: note.length }),
  ]);
  return json(201, { ok: true, note: ins!.results?.[0] ?? null });
});
