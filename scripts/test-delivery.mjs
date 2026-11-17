// Delivery module tests (A3): shipments API, manual + mock adapters, webhook, retry/backoff, order side
// effects, audit rows, no PII in logs. Plain node (18+), no dependencies.
//
// Needs (see src/lib/delivery/README.md, "Local test run"):
//   node scripts/mock-delivery.mjs > mock.log                                   (port 8893)
//   .dev.vars: DELIVERY_BASE_URL=http://127.0.0.1:8893  DELIVERY_API_KEY=test-key  DELIVERY_WEBHOOK_SECRET=...
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-a3
//   npx astro build && npx wrangler dev --port 8793 --persist-to .wrangler/state-a3 > dev.log 2>&1
//   BASE=http://localhost:8793 PERSIST=.wrangler/state-a3 LOG_FILES=dev.log,mock.log node scripts/test-delivery.mjs
//
// Orders are seeded with `wrangler d1 execute` (status paid / new) — this module never creates orders itself.
// The `delivery.provider` setting is changed during the run and set back to "manual" at the end.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8793").replace(/\/$/, "");
const MOCK = (process.env.MOCK_BASE ?? "http://127.0.0.1:8893").replace(/\/$/, "");
const PERSIST = process.env.PERSIST ?? ".wrangler/state-a3";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const v = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const OWNER = v("ADMIN_TOKEN");
const STAFF = v("STAFF_TOKEN");
const SECRET = v("DELIVERY_WEBHOOK_SECRET");
const MOCK_KEY = v("DELIVERY_API_KEY") || "test-key";
const RUN = Math.random().toString(36).slice(2, 8);

let pass = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

// Node's fetch can reuse a keep-alive socket the dev server already closed (seen after long idle gaps,
// e.g. several `wrangler d1 execute` calls): the request never reaches the server. Retry that case once.
async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = err?.cause?.code ?? "";
    if (!/^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/.test(code)) throw err;
    console.log(`note  ${init.method} ${url.replace(BASE, "")}: stale socket (${code}), retried once`);
    return fetch(url, init);
  }
}

async function call(method, path, { body, auth, headers = {}, raw } = {}) {
  const res = await fetchRetry(BASE + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": `test-delivery-${RUN}`,
      Origin: BASE,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}
const owner = (m, p, b) => call(m, p, { body: b, auth: OWNER });
const staff = (m, p, b) => call(m, p, { body: b, auth: STAFF });

async function mock(method, path, body) {
  const res = await fetch(MOCK + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_KEY}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out.slice(out.search(/^\[/m))); // wrangler may print notices first
  return parsed[parsed.length - 1]?.results ?? [];
}

const sign = (body) => createHmac("sha256", SECRET).update(body).digest("hex");
async function webhook(provider, payload, sig) {
  const raw = JSON.stringify(payload);
  return call("POST", `/api/delivery/webhook/${provider}`, { raw, headers: sig === null ? {} : { "X-Signature": sig ?? sign(raw) } });
}

const minutesAhead = (sqliteTime) => (Date.parse(sqliteTime.replace(" ", "T") + "Z") - Date.now()) / 60000;

/* ---------------- seed ---------------- */

const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const day = new Date().toISOString().slice(2, 10).replace(/-/g, "");
const orderNo = () => `GZ-${day}-${Array.from({ length: 4 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join("")}`;
// unique PII markers: they must never show up in audit rows or server/mock logs
const PII = { name: `Piiname${RUN}`, phone: `88${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, address: `Piistreet${RUN} 12` };

const O = { unpaid: orderNo(), mock: orderNo(), manual: orderNo(), retry: orderNo(), max: orderNo(), hard: orderNo(), track: orderNo(), setting: orderNo() };
const items = JSON.stringify([{ slug: "test-a", brand: "B", name: "N", ml: 5, qty: 2, price: 10000 }, { slug: "test-b", brand: "B", name: "M", ml: 10, qty: 1, price: 20000 }]);
const seed = Object.entries(O)
  .map(([k, no]) => {
    const st = k === "unpaid" ? "new" : "paid";
    return `INSERT INTO orders (order_no, status, name, phone, city, district, khoroo, address, payment, items_json, subtotal, delivery, total, locale, payment_status, updated_at)
      VALUES ('${no}', '${st}', '${PII.name}', '${PII.phone}', 'ub', 'bzd', '3', '${PII.address}', 'bank', '${items}', 40000, 5000, 45000, 'mn', '${st === "paid" ? "paid" : "unpaid"}', datetime('now'))`;
  })
  .join("; ");

async function main() {
  if (!OWNER || !STAFF || !SECRET) throw new Error("ADMIN_TOKEN, STAFF_TOKEN and DELIVERY_WEBHOOK_SECRET are needed (.dev.vars)");
  sql(seed);
  await fetch(MOCK + "/__control/reset", { method: "POST" });
  const ctl = (p, b) => fetch(MOCK + "/__control/" + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) });
  await owner("PUT", "/api/admin/settings", { "delivery.provider": "manual" });

  /* ---- auth ---- */
  ok("no token -> 401", (await call("GET", "/api/admin/shipments")).status === 401);
  ok("wrong token -> 401", (await call("GET", "/api/admin/shipments", { auth: "x".repeat(40) })).status === 401);
  ok("no token POST -> 401", (await call("POST", "/api/admin/shipments", { body: { orderNo: O.mock } })).status === 401);
  ok("no token PATCH -> 401", (await call("PATCH", "/api/admin/shipments/1", { body: { note: "x" } })).status === 401);
  ok("no token retry -> 401", (await call("POST", "/api/admin/shipments/1/retry")).status === 401);
  ok("no token run-retries -> 401", (await call("POST", "/api/admin/shipments/run-retries")).status === 401);
  ok("staff list -> 200 (delivery.read)", (await staff("GET", "/api/admin/shipments")).status === 200);
  ok("staff cannot change delivery.provider (settings.write is lead's route) -> 403", (await staff("PUT", "/api/admin/settings", { "delivery.provider": "mock" })).status === 403);

  /* ---- create: validation ---- */
  let r = await owner("POST", "/api/admin/shipments", { orderNo: O.unpaid, provider: "mock" });
  ok("create for unpaid order -> 409 not-paid", r.status === 409 && r.data?.errors?.orderNo === "not-paid", r);
  r = await owner("POST", "/api/admin/shipments", { orderNo: "GZ-000000-ZZZZ" });
  ok("create for unknown order -> 404", r.status === 404, r);
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.mock, provider: "dhl" });
  ok("unknown provider -> 422", r.status === 422 && r.data?.errors?.provider === "unknown", r);
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.mock, extra: 1 });
  ok("unknown body key -> 400", r.status === 400, r);
  r = await owner("POST", "/api/admin/shipments", { orderNo: "nope" });
  ok("bad orderNo -> 400", r.status === 400, r);

  /* ---- create with mock ---- */
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.mock, provider: "mock" });
  const sMock = r.data?.shipment;
  ok("create (mock) -> 201 created", r.status === 201 && sMock?.status === "created", r);
  ok("create (mock) has providerRef + tracking", /^MOCK-/.test(sMock?.providerRef ?? "") && /^TRK/.test(sMock?.trackingNo ?? "") && /^https:/.test(sMock?.trackingUrl ?? ""), sMock);
  ok("create (mock) attempts 1, no retry", sMock?.attempts === 1 && sMock?.nextRetryAt === null && sMock?.lastError === null, sMock);
  ok("order paid -> shipped", sMock?.orderStatus === "shipped", sMock);
  const last = (await (await fetch(MOCK + "/__control/last-create")).json()).body;
  ok("provider got only delivery fields", JSON.stringify(Object.keys(last ?? {}).sort()) === JSON.stringify(["address", "idempotencyKey", "itemsCount", "recipient", "reference"]), last && Object.keys(last));
  ok("provider got recipient name/phone + address + items count", last?.recipient?.name === PII.name && last?.recipient?.phone === PII.phone && last?.address?.line === PII.address && last?.itemsCount === 3 && last?.reference === O.mock, last?.itemsCount);
  ok("provider did not get prices/email/note", !("total" in (last ?? {})) && !JSON.stringify(last ?? {}).includes("10000"));
  let ev = sql(`SELECT from_status, to_status, actor FROM order_events WHERE order_id = (SELECT id FROM orders WHERE order_no = '${O.mock}') ORDER BY id`);
  ok("order_events paid->shipped by admin:owner", ev.length === 1 && ev[0].from_status === "paid" && ev[0].to_status === "shipped" && ev[0].actor === "admin:owner", ev);

  r = await owner("POST", "/api/admin/shipments", { orderNo: O.mock, provider: "mock" });
  ok("duplicate create -> 409 has-shipment", r.status === 409 && r.data?.errors?.orderNo === "has-shipment" && r.data?.shipmentId === sMock?.id, r);

  /* ---- manual provider (staff) ---- */
  r = await staff("POST", "/api/admin/shipments", { orderNo: O.manual, provider: "manual" });
  const sMan = r.data?.shipment;
  ok("staff create (manual) -> 201 pending, order still paid", r.status === 201 && sMan?.status === "pending" && sMan?.orderStatus === "paid" && sMan?.providerRef === null, r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { status: "created", trackingNo: "MN-123", trackingUrl: "https://courier.example.test/MN-123" });
  ok("PATCH manual -> created + tracking, order shipped", r.status === 200 && r.data?.shipment?.status === "created" && r.data?.shipment?.trackingNo === "MN-123" && r.data?.shipment?.orderStatus === "shipped", r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { trackingNo: "MN-124", note: "corrected" });
  ok("PATCH tracking only -> 200, status unchanged", r.status === 200 && r.data?.shipment?.trackingNo === "MN-124" && r.data?.shipment?.status === "created", r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { status: "pending" });
  ok("invalid transition created->pending -> 409", r.status === 409 && r.data?.errors?.status === "transition", r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { status: "lost" });
  ok("unknown status -> 400", r.status === 400, r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { trackingUrl: "http://insecure.test/x" });
  ok("non-https tracking URL -> 400", r.status === 400, r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, {});
  ok("empty PATCH -> 400", r.status === 400, r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { status: "delivered" });
  ok("PATCH manual -> delivered, order done", r.status === 200 && r.data?.shipment?.status === "delivered" && r.data?.shipment?.orderStatus === "done", r);
  r = await staff("PATCH", `/api/admin/shipments/${sMan?.id}`, { status: "in_transit" });
  ok("delivered -> in_transit -> 409", r.status === 409, r);
  ok("PATCH unknown shipment -> 404", (await staff("PATCH", "/api/admin/shipments/999999", { note: "x" })).status === 404);
  r = await staff("GET", `/api/admin/shipments/${sMan?.id}`);
  ok("GET shipment has events (pending, created, note, delivered)", r.status === 200 && r.data?.events?.length === 4 && r.data.events.every((e) => e.source === "admin"), r.data?.events);
  ev = sql(`SELECT to_status, actor FROM order_events WHERE order_id = (SELECT id FROM orders WHERE order_no = '${O.manual}') ORDER BY id`);
  ok("order_events shipped, done by admin:staff", ev.map((e) => e.to_status).join() === "shipped,done" && ev.every((e) => e.actor === "admin:staff"), ev);

  /* ---- webhook ---- */
  const ref = sMock?.providerRef;
  const e1 = { events: [{ id: `evt-${RUN}-1`, shipmentId: ref, status: "in_transit" }] };
  ok("webhook bad signature -> 401", (await webhook("mock", e1, "0".repeat(64))).status === 401);
  ok("webhook missing signature -> 401", (await webhook("mock", e1, null)).status === 401);
  ok("webhook signature of other body -> 401", (await webhook("mock", e1, sign("{}"))).status === 401);
  ok("webhook for manual provider -> 404", (await webhook("manual", e1)).status === 404);
  r = await webhook("mock", e1);
  ok("webhook in_transit -> 200 applied", r.status === 200 && r.data?.results?.[0]?.result === "applied", r);
  r = await owner("GET", `/api/admin/shipments/${sMock?.id}`);
  ok("shipment in_transit, order still shipped", r.data?.shipment?.status === "in_transit" && r.data?.shipment?.orderStatus === "shipped", r.data?.shipment);
  const e2 = { events: [{ id: `evt-${RUN}-2`, shipmentId: ref, status: "delivered" }] };
  r = await webhook("mock", e2);
  ok("webhook delivered -> 200 applied", r.status === 200 && r.data?.results?.[0]?.result === "applied", r);
  r = await owner("GET", `/api/admin/shipments/${sMock?.id}`);
  ok("shipment delivered, order done", r.data?.shipment?.status === "delivered" && r.data?.shipment?.orderStatus === "done", r.data?.shipment);
  r = await webhook("mock", e2);
  ok("replayed webhook -> 200 duplicate", r.status === 200 && r.data?.results?.[0]?.result === "duplicate", r);
  const cnt = sql(`SELECT COUNT(*) AS n FROM shipment_events WHERE external_event_id = 'evt-${RUN}-2'`);
  ok("replay wrote no second event", cnt[0]?.n === 1, cnt);
  r = await webhook("mock", { events: [{ id: `evt-${RUN}-3`, shipmentId: ref, status: "picked_up" }] });
  ok("out-of-order webhook -> 200 ignored", r.status === 200 && r.data?.results?.[0]?.result === "ignored", r);
  r = await owner("GET", `/api/admin/shipments/${sMock?.id}`);
  ok("ignored event recorded, status unchanged", r.data?.shipment?.status === "delivered" && r.data?.events?.some((e) => e.externalEventId === `evt-${RUN}-3` && /^ignored/.test(e.note ?? "")), r.data?.events);
  ev = sql(`SELECT to_status, actor FROM order_events WHERE order_id = (SELECT id FROM orders WHERE order_no = '${O.mock}') ORDER BY id`);
  ok("order_events: done by system, once", ev.map((e) => `${e.to_status}:${e.actor}`).join() === "shipped:admin:owner,done:system", ev);
  r = await webhook("mock", { events: [{ id: `evt-${RUN}-4`, shipmentId: "MOCK-NOPE-999999", status: "delivered" }] });
  ok("webhook unknown shipment -> 404", r.status === 404, r);
  r = await webhook("mock", { hello: 1 });
  ok("webhook bad payload (good sig) -> 400", r.status === 400, r);

  /* ---- provider failure + retry (provider from the setting) ---- */
  r = await owner("PUT", "/api/admin/settings", { "delivery.provider": "mock" });
  ok("owner sets delivery.provider = mock", r.status === 200, r);
  await ctl("fail-create", { count: 1, status: 500 });
  r = await staff("POST", "/api/admin/shipments", { orderNo: O.retry });
  let sR = r.data?.shipment;
  ok("create with provider down -> 201 failed (provider from setting)", r.status === 201 && sR?.provider === "mock" && sR?.status === "failed", r);
  ok("failed: attempts 1, lastError http_500, next retry ~2 min", sR?.attempts === 1 && sR?.lastError === "http_500" && sR?.nextRetryAt && Math.abs(minutesAhead(sR.nextRetryAt) - 2) < 0.6, sR);
  ok("order stays paid while shipment failed", sR?.orderStatus === "paid", sR);
  r = await owner("POST", "/api/admin/shipments/run-retries");
  r = await owner("GET", `/api/admin/shipments/${sR?.id}`);
  ok("retryShipments skips a not-yet-due shipment", r.data?.shipment?.status === "failed" && r.data?.shipment?.attempts === 1, r.data?.shipment);
  sql(`UPDATE shipments SET next_retry_at = datetime('now', '-1 minute') WHERE id = ${sR?.id}`);
  r = await owner("POST", "/api/admin/shipments/run-retries");
  ok("retryShipments -> retried >= 1", r.status === 200 && r.data?.retried >= 1, r);
  r = await owner("GET", `/api/admin/shipments/${sR?.id}`);
  sR = r.data?.shipment;
  ok("after retry: created, attempts 2, error cleared, order shipped", sR?.status === "created" && sR?.attempts === 2 && sR?.lastError === null && sR?.nextRetryAt === null && sR?.orderStatus === "shipped", sR);
  ok("retry events: failed -> pending (system) -> created", JSON.stringify(r.data?.events?.map((e) => `${e.fromStatus}>${e.toStatus}:${e.source}`)) === JSON.stringify(["null>pending:admin", "pending>failed:system", "failed>pending:system", "pending>created:system"]), r.data?.events);

  /* ---- 8 attempts -> stays failed ---- */
  await ctl("fail-create", { count: 1000, status: 503 });
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.max, provider: "mock" });
  const idMax = r.data?.shipment?.id;
  ok("create fails -> attempts 1", r.data?.shipment?.status === "failed" && r.data?.shipment?.attempts === 1, r.data);
  sql(`UPDATE shipments SET next_retry_at = datetime('now', '-1 minute') WHERE id = ${idMax}`);
  r = await owner("POST", "/api/admin/shipments/run-retries");
  ok("due retry fails again -> failed count", r.data?.failed >= 1, r);
  r = await owner("GET", `/api/admin/shipments/${idMax}`);
  ok("attempts 2, next retry ~4 min (2^2)", r.data?.shipment?.attempts === 2 && r.data?.shipment?.status === "failed" && Math.abs(minutesAhead(r.data.shipment.nextRetryAt) - 4) < 0.6, r.data?.shipment);
  sql(`UPDATE shipments SET attempts = 6, next_retry_at = datetime('now', '-1 minute') WHERE id = ${idMax}`);
  await owner("POST", "/api/admin/shipments/run-retries");
  r = await owner("GET", `/api/admin/shipments/${idMax}`);
  ok("attempt 7 -> next retry ~128 min", r.data?.shipment?.attempts === 7 && Math.abs(minutesAhead(r.data.shipment.nextRetryAt) - 128) < 0.6, r.data?.shipment);
  sql(`UPDATE shipments SET next_retry_at = datetime('now', '-1 minute') WHERE id = ${idMax}`);
  await owner("POST", "/api/admin/shipments/run-retries");
  r = await owner("GET", `/api/admin/shipments/${idMax}`);
  ok("attempt 8 -> stays failed, no next retry", r.data?.shipment?.attempts === 8 && r.data?.shipment?.status === "failed" && r.data?.shipment?.nextRetryAt === null, r.data?.shipment);
  r = await owner("POST", "/api/admin/shipments/run-retries");
  const after = await owner("GET", `/api/admin/shipments/${idMax}`);
  ok("retryShipments never picks it again", after.data?.shipment?.attempts === 8 && after.data?.shipment?.status === "failed", after.data?.shipment);
  await ctl("fail-create", { count: 0 });
  r = await owner("POST", `/api/admin/shipments/${idMax}/retry`);
  ok("admin retry after 8 attempts -> created", r.status === 200 && r.data?.outcome === "created" && r.data?.shipment?.status === "created" && r.data?.shipment?.attempts === 9, r);

  /* ---- non-retryable provider error, admin retry, cancel ---- */
  await ctl("fail-create", { count: 1, status: 422 });
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.hard, provider: "mock" });
  const idHard = r.data?.shipment?.id;
  ok("4xx from provider -> failed, no automatic retry", r.data?.shipment?.status === "failed" && r.data?.shipment?.lastError === "http_422" && r.data?.shipment?.nextRetryAt === null, r.data);
  r = await staff("PATCH", `/api/admin/shipments/${idHard}`, { status: "pending" });
  ok("PATCH failed->pending on automatic provider -> 409 use-retry", r.status === 409 && r.data?.errors?.status === "use-retry", r);
  r = await staff("POST", `/api/admin/shipments/${idHard}/retry`);
  ok("staff retry -> created", r.status === 200 && r.data?.shipment?.status === "created", r);
  ok("retry of a created shipment -> 409", (await staff("POST", `/api/admin/shipments/${idHard}/retry`)).status === 409);
  ok("retry of unknown shipment -> 404", (await staff("POST", "/api/admin/shipments/999999/retry")).status === 404);
  const refHard = r.data?.shipment?.providerRef;
  r = await staff("PATCH", `/api/admin/shipments/${idHard}`, { status: "cancelled", note: "customer asked" });
  ok("PATCH cancelled -> 200 and cancelled at provider", r.status === 200 && r.data?.shipment?.status === "cancelled" && (await mock("GET", `/v1/shipments/${refHard}`)).status === "cancelled", r);

  /* ---- track (poll) ---- */
  r = await owner("POST", "/api/admin/shipments", { orderNo: O.track, provider: "mock" });
  const sT = r.data?.shipment;
  await ctl("set-status", { id: sT?.providerRef, status: "picked_up" });
  ok("GET ?refresh=1 needs delivery.write (no token -> 401)", (await call("GET", `/api/admin/shipments/${sT?.id}?refresh=1`)).status === 401);
  r = await staff("GET", `/api/admin/shipments/${sT?.id}?refresh=1`);
  ok("refresh pulls picked_up from provider", r.data?.refreshed === "updated" && r.data?.shipment?.status === "picked_up" && r.data?.events?.at(-1)?.source === "poll", r.data);

  /* ---- list ---- */
  r = await staff("GET", "/api/admin/shipments?status=delivered&limit=200");
  ok("list ?status=delivered includes the webhook shipment", r.status === 200 && r.data?.items?.some((s) => s.id === sMock?.id) && r.data.items.every((s) => s.status === "delivered"), r.data);
  r = await staff("GET", `/api/admin/shipments?orderNo=${O.retry}`);
  ok("list ?orderNo filters", r.data?.items?.length === 1 && r.data.items[0].orderNo === O.retry, r.data);
  r = await staff("GET", "/api/admin/shipments?limit=1");
  ok("list keyset cursor", r.data?.items?.length === 1 && typeof r.data?.nextCursor === "number", r.data);
  ok("list ?status=bogus -> 400", (await staff("GET", "/api/admin/shipments?status=bogus")).status === 400);
  ok("list items carry no customer PII", !JSON.stringify((await staff("GET", "/api/admin/shipments?limit=200")).data).includes(PII.name));

  /* ---- audit ---- */
  r = await owner("GET", `/api/admin/audit?entity=shipment&entityId=${sMock?.id}`);
  const acts = (r.data?.items ?? []).map((a) => `${a.action}:${a.actor}`);
  ok("audit: create + provider accept by owner, 2 webhook changes by system", acts.includes("shipment.create:admin:owner") && acts.includes("shipment.status:admin:owner") && acts.filter((a) => a === "shipment.status:system").length === 2, acts);
  r = await owner("GET", `/api/admin/audit?entity=shipment&entityId=${sMan?.id}`);
  ok("audit: manual PATCHes by staff (create, status x2, update)", (r.data?.items ?? []).filter((a) => a.actor === "admin:staff").length === 4, r.data?.items);
  r = await owner("GET", `/api/admin/audit?entity=shipment&entityId=${idMax}`);
  // attempts 1, 2, 7, 8 really ran (3-6 were skipped with SQL above)
  ok("audit: every failed attempt recorded", (r.data?.items ?? []).filter((a) => a.data?.to === "failed").length === 4, (r.data?.items ?? []).length);

  /* ---- PII ---- */
  const leaks = sql(`SELECT COUNT(*) AS n FROM audit_log WHERE data_json LIKE '%${PII.name}%' OR data_json LIKE '%${PII.phone}%' OR data_json LIKE '%Piistreet${RUN}%'`);
  ok("no PII in audit_log", leaks[0]?.n === 0, leaks);
  const sh = sql(`SELECT COUNT(*) AS n FROM shipments WHERE COALESCE(last_error,'') || COALESCE(data_json,'') LIKE '%${RUN}%' OR COALESCE(last_error,'') LIKE '%${PII.phone}%'`);
  ok("no PII in shipments.last_error/data_json", sh[0]?.n === 0, sh);
  const ev2 = sql(`SELECT COUNT(*) AS n FROM shipment_events WHERE COALESCE(note,'') LIKE '%${RUN}%' OR COALESCE(note,'') LIKE '%${PII.phone}%'`);
  ok("no PII in shipment_events", ev2[0]?.n === 0, ev2);
  const logs = (process.env.LOG_FILES ?? "").split(",").filter(Boolean);
  if (!logs.length) console.log("SKIP  log files not given (LOG_FILES=dev.log,mock.log)");
  for (const f of logs) {
    const text = readFileSync(f, "utf8");
    ok(`no PII in ${f} (${text.length} bytes)`, text.length > 0 && !text.includes(PII.name) && !text.includes(PII.phone) && !text.includes(`Piistreet${RUN}`));
  }

  await owner("PUT", "/api/admin/settings", { "delivery.provider": "manual" });
}

try {
  await main();
} catch (err) {
  failed++;
  console.log("FAIL  crashed:", err?.message ?? err, err?.cause?.code ?? "");
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
