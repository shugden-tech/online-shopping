// Customer order tracking.
//   GET  /api/orders/lookup?no=<orderNo>&phone=<last 4–8 digits>
//   POST /api/orders/lookup { orderNo, phone }            (kept for the current success page)
// Needs the order number AND the last 4–8 digits of the phone used on the order. Returns status, payment state,
// items, payment instructions while unpaid and the latest shipment — never name, address or phone.
// Not found and wrong phone give the same 404. Rate limited per IP (10 / 10 min).
import type { APIRoute } from "astro";
import { ORDER_NO_RE, loadOrder, normOrderNo, phoneMatches } from "../../../lib/orders/types";
import { lookupView } from "../../../lib/orders/view";
import { clientIp, fail, hitRateLimit, json, readJson } from "../../../lib/server";

export const prerender = false;

const LIMIT = 10; // lookups per IP per 10 minutes

async function lookup(env: Env | undefined, ip: string, orderNoRaw: unknown, phoneRaw: unknown): Promise<Response> {
  const orderNo = normOrderNo(orderNoRaw);
  const digits = typeof phoneRaw === "string" ? phoneRaw.replace(/\D/g, "") : "";
  if (!ORDER_NO_RE.test(orderNo) || digits.length < 4 || digits.length > 8) return fail(422, { form: "lookup" });
  if (!env?.DB) throw new Error("D1 binding DB is missing");
  if (!(await hitRateLimit(env.DB, `lookup:${ip}`, LIMIT, 600))) return fail(429, { form: "rate" });
  const order = await loadOrder(env.DB, orderNo);
  if (!order || !phoneMatches(order, digits)) return fail(404, { form: "notFound" });
  return json(200, await lookupView(env, order));
}

export const GET: APIRoute = async ({ request, locals, clientAddress, url }) => {
  try {
    return await lookup(locals.runtime?.env, clientIp(request, () => clientAddress), url.searchParams.get("no") ?? "", url.searchParams.get("phone") ?? "");
  } catch (err) {
    console.error("[lookup] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  try {
    const body = await readJson(request, 1024);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as { orderNo?: unknown; phone?: unknown };
    return await lookup(locals.runtime?.env, clientIp(request, () => clientAddress), v.orderNo, v.phone);
  } catch (err) {
    console.error("[lookup] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET, POST" });
