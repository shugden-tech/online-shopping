// GET   /api/admin/orders/:no — one order with its status history.
// PATCH /api/admin/orders/:no { status, note? } — new → confirmed → paid → shipped → done, any → cancelled.
// Cancelling restores the stock that the order took from D1 inventory, in the same batch as the status change.
// Auth: Authorization: Bearer <ADMIN_TOKEN>.
import type { APIRoute } from "astro";
import {
  canTransition, clientIp, fail, json, ORDER_NO_RE, readJson, requireAdmin, STATUSES, type OrderLine,
} from "../../../../lib/server";

export const prerender = false;

interface Row extends Record<string, unknown> { id: number; status: string; items_json: string }

async function load(db: Env["DB"], no: string) {
  return db.prepare("SELECT * FROM orders WHERE order_no = ?1").bind(no).first<Row>();
}

function view(row: Row) {
  const { items_json, ip: _ip, idempotency_key: _k, ...rest } = row;
  return { ...rest, items: JSON.parse(items_json) as OrderLine[] };
}

export const GET: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;
    const no = String(params.no ?? "").toUpperCase();
    if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });
    const row = await load(env.DB, no);
    if (!row) return fail(404, { form: "notFound" });
    const events = await env.DB.prepare(
      "SELECT at, from_status, to_status, actor, note FROM order_events WHERE order_id = ?1 ORDER BY id",
    )
      .bind(row.id)
      .all();
    return json(200, { ok: true, order: view(row), events: events.results ?? [] });
  } catch (err) {
    console.error("[admin/order] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const PATCH: APIRoute = async ({ request, locals, clientAddress, params }) => {
  try {
    const env = locals.runtime?.env;
    if (!env?.DB) throw new Error("D1 binding DB is missing");
    const db = env.DB;
    const denied = await requireAdmin(request, env, clientIp(request, () => clientAddress));
    if (denied) return denied;
    const no = String(params.no ?? "").toUpperCase();
    if (!ORDER_NO_RE.test(no)) return fail(404, { form: "notFound" });

    const body = await readJson(request, 4096);
    if (body instanceof Response) return body;
    const v = (body.value ?? {}) as { status?: unknown; note?: unknown };
    const to = typeof v.status === "string" ? v.status : "";
    const note = typeof v.note === "string" ? v.note.trim().slice(0, 300) || null : null;
    if (!(STATUSES as readonly string[]).includes(to)) return fail(422, { status: "invalid" });

    const row = await load(db, no);
    if (!row) return fail(404, { form: "notFound" });
    const from = row.status;
    if (!canTransition(from, to)) {
      return json(409, { ok: false, errors: { status: "transition" }, from, to });
    }

    // Every statement is guarded by "the status is still `from`", so a concurrent change makes the whole
    // batch a no-op (and stock is restored at most once).
    const restore =
      to === "cancelled"
        ? (JSON.parse(row.items_json) as OrderLine[])
            .filter((l) => l.tracked)
            .map((l) =>
              db
                .prepare(
                  `UPDATE inventory SET stock = stock + ?1, updated_at = datetime('now')
                    WHERE product_id = ?2 AND ml = ?3 AND stock IS NOT NULL
                      AND (SELECT status FROM orders WHERE order_no = ?4) = ?5`,
                )
                .bind(l.qty, l.slug, l.ml, no, from),
            )
        : [];
    const results = await db.batch([
      ...restore,
      db
        .prepare(
          `INSERT INTO order_events (order_id, from_status, to_status, actor, note)
           SELECT id, ?1, ?2, 'admin', ?3 FROM orders WHERE order_no = ?4 AND status = ?1`,
        )
        .bind(from, to, note, no),
      db
        .prepare("UPDATE orders SET status = ?1, updated_at = datetime('now') WHERE order_no = ?2 AND status = ?3")
        .bind(to, no, from),
    ]);
    if ((results[results.length - 1]?.meta?.changes ?? 0) !== 1) {
      return json(409, { ok: false, errors: { status: "conflict" } });
    }
    const updated = await load(db, no);
    return json(200, { ok: true, order: updated ? view(updated) : null, restored: restore.length });
  } catch (err) {
    console.error("[admin/order] unexpected error", err);
    return fail(500, { form: "server" });
  }
};

export const ALL: APIRoute = () => json(405, { ok: false, errors: { form: "method" } }, { Allow: "GET, PATCH" });
