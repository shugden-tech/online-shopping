// Backend API tests: orders, idempotency, stock, rate limits, admin auth + status rules, customer lookup.
// Plain node (18+), no dependencies. Needs a running server with local D1 and migrations applied:
//   npm run db:migrate:local
//   npm run dev            (astro dev, http://localhost:4321)   — or: npm run build && npm run preview (8788)
//   BASE=http://localhost:4321 npm run test:api
// ADMIN_TOKEN is read from the environment or from .dev.vars. TURNSTILE_SECRET must be Cloudflare's
// always-pass test secret (the .dev.vars.example value). The test inventory row it creates is removed at the end.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:4321").replace(/\/$/, "");
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const ADMIN = process.env.ADMIN_TOKEN ?? /^ADMIN_TOKEN=(.*)$/m.exec(devVars)?.[1]?.trim() ?? "";
const settings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const RUN = Math.random().toString(36).slice(2, 8);
const PHONE = "99112233";

let pass = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

const ipFor = (tag) => `test-${RUN}-${tag}`;
const uuid = () => crypto.randomUUID();

async function call(method, path, { body, headers = {}, ip = ipFor("misc"), auth } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": ip,
      // a browser sends Origin on PUT/PATCH/DELETE; Astro's checkOrigin answers 403 to a body-less write without it
      Origin: BASE,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

const admin = (method, path, body) => call(method, path, { body, auth: ADMIN, ip: ipFor("admin") });

function orderBody(items) {
  return {
    name: "API Test", phone: PHONE, phone2: "", city: "ub", district: settings.districts[0].id, khoroo: "1",
    address: "Test street 1, apt 2", note: `test-api ${RUN}`, payment: "bank", locale: "mn",
    items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "",
  };
}
const order = (items, { ip, key } = {}) =>
  call("POST", "/api/orders", { body: orderBody(items), ip, headers: key ? { "Idempotency-Key": key } : {} });

const newestOrderNo = async () => (await admin("GET", "/api/admin/orders?limit=1")).data?.orders?.[0]?.order_no;
const invRow = async (slug, ml) =>
  (await admin("GET", "/api/admin/inventory")).data.items.find((r) => r.product_id === slug && r.ml === ml);
const deliveryFor = (sub) => (sub >= settings.delivery.freeThreshold ? 0 : settings.delivery.fee);

let A = null; // size used for stock tests (gets a temporary inventory row)
try {
  if (!ADMIN) throw new Error("ADMIN_TOKEN not found (set it in .dev.vars or the environment)");

  /* ---------- admin auth ---------- */
  {
    const none = await call("GET", "/api/admin/orders", { ip: ipFor("auth") });
    ok("admin: no token -> 401", none.status === 401, none.status);
    ok("admin: 401 is not cacheable", /no-store/.test(none.headers.get("cache-control") ?? ""), none.headers.get("cache-control"));
    const wrong = await call("GET", "/api/admin/orders", { ip: ipFor("auth"), auth: ADMIN + "x" });
    ok("admin: wrong token -> 401", wrong.status === 401, wrong.status);
    const inv = await call("PUT", "/api/admin/inventory", { ip: ipFor("auth"), body: { product_id: "x", ml: 5, stock: 1 } });
    ok("admin: inventory PUT without token -> 401", inv.status === 401, inv.status);
    const good = await admin("GET", "/api/admin/orders?limit=1");
    ok("admin: right token -> 200", good.status === 200, good.status);
  }

  /* ---------- pick two purchasable sizes without overrides ---------- */
  const inv = (await admin("GET", "/api/admin/inventory")).data.items;
  const candidates = inv.filter((r) => !r.override && r.json.inStock && r.json.price > 0 && (r.json.stock ?? 10) >= 3);
  A = candidates[0];
  const B = candidates.find((r) => r.product_id !== A.product_id);
  if (!A || !B) throw new Error("need two in-stock sizes in the catalog");

  /* ---------- happy path + idempotent retry ---------- */
  const key1 = uuid();
  const first = await order([{ slug: B.product_id, ml: B.ml, qty: 1 }], { ip: ipFor("happy"), key: key1 });
  ok("order: happy path -> 200 with order number", first.status === 200 && /^GZ-\d{6}-[A-Z2-9]{4}$/.test(first.data?.orderNo ?? ""), first.data);
  const expectTotal = B.json.price + deliveryFor(B.json.price);
  ok("order: total re-priced on the server", first.data?.total === expectTotal, { got: first.data?.total, expectTotal });
  const no1 = first.data?.orderNo;

  const retry = await order([{ slug: B.product_id, ml: B.ml, qty: 1 }], { ip: ipFor("happy"), key: key1 });
  ok("idempotency: retry -> 200 same order number", retry.status === 200 && retry.data?.orderNo === no1, retry.data);
  ok("idempotency: no second row", (await newestOrderNo()) === no1);

  const keyR = uuid();
  const [r1, r2] = await Promise.all([
    order([{ slug: B.product_id, ml: B.ml, qty: 1 }], { ip: ipFor("race"), key: keyR }),
    order([{ slug: B.product_id, ml: B.ml, qty: 1 }], { ip: ipFor("race"), key: keyR }),
  ]);
  ok("idempotency: two concurrent requests, same key -> one order", r1.status === 200 && r2.status === 200 && r1.data.orderNo === r2.data.orderNo, [r1.status, r1.data, r2.status, r2.data]);
  const bad = await call("POST", "/api/orders", { body: orderBody([{ slug: B.product_id, ml: B.ml, qty: 1 }]), headers: { "Idempotency-Key": "short" } });
  ok("idempotency: malformed key -> 400", bad.status === 400, bad.status);

  /* ---------- stock: oversell, decrement, cancel restores ---------- */
  const put = await admin("PUT", "/api/admin/inventory", { product_id: A.product_id, ml: A.ml, price: null, stock: 2 });
  ok("inventory: PUT stock=2 -> 200", put.status === 200 && put.data?.row?.stock === 2, put.data);
  const unknown = await admin("PUT", "/api/admin/inventory", { product_id: "no-such-product", ml: 5, price: null, stock: 2 });
  ok("inventory: unknown product id -> 404", unknown.status === 404, unknown.status);

  const before = await newestOrderNo();
  const over = await order([{ slug: A.product_id, ml: A.ml, qty: 3 }], { ip: ipFor("stock"), key: uuid() });
  ok("stock: oversell -> 409", over.status === 409 && over.data?.errors?.form === "stock", [over.status, over.data]);
  ok("stock: 409 lists what is available", over.data?.unavailable?.[0]?.available === 2, over.data?.unavailable);
  ok("stock: oversell wrote no order row", (await newestOrderNo()) === before);
  ok("stock: oversell left stock unchanged", (await invRow(A.product_id, A.ml)).override?.stock === 2);

  // mixed cart: one fine untracked line + one short tracked line -> nothing is written
  const mixed = await order([{ slug: B.product_id, ml: B.ml, qty: 1 }, { slug: A.product_id, ml: A.ml, qty: 3 }], { ip: ipFor("stock"), key: uuid() });
  ok("stock: mixed cart with one short line -> 409, no partial order", mixed.status === 409 && (await newestOrderNo()) === before, mixed.status);

  // price override + exact sell-out
  await admin("PUT", "/api/admin/inventory", { product_id: A.product_id, ml: A.ml, price: A.json.price + 1000, stock: 2 });
  const buy = await order([{ slug: A.product_id, ml: A.ml, qty: 2 }], { ip: ipFor("stock"), key: uuid() });
  const sub = (A.json.price + 1000) * 2;
  ok("stock: buying the last 2 -> 200", buy.status === 200, [buy.status, buy.data]);
  ok("inventory: D1 price overrides the product file", buy.data?.total === sub + deliveryFor(sub), { got: buy.data?.total, want: sub + deliveryFor(sub) });
  ok("stock: decremented to 0", (await invRow(A.product_id, A.ml)).override?.stock === 0);
  const sold = await order([{ slug: A.product_id, ml: A.ml, qty: 1 }], { ip: ipFor("stock2"), key: uuid() });
  ok("stock: sold out -> 409", sold.status === 409, sold.status);

  const cancel = await admin("PATCH", `/api/admin/orders/${buy.data.orderNo}`, { status: "cancelled", note: "test" });
  ok("cancel: -> 200", cancel.status === 200 && cancel.data?.order?.status === "cancelled", [cancel.status, cancel.data]);
  ok("cancel: restores stock (0 -> 2)", (await invRow(A.product_id, A.ml)).override?.stock === 2);
  const again = await admin("PATCH", `/api/admin/orders/${buy.data.orderNo}`, { status: "cancelled" });
  ok("cancel: cancelling twice -> 409, stock restored only once", again.status === 409 && (await invRow(A.product_id, A.ml)).override?.stock === 2, again.status);
  const revive = await admin("PATCH", `/api/admin/orders/${buy.data.orderNo}`, { status: "new" });
  ok("status: cancelled is final -> 409", revive.status === 409, revive.status);

  // race for the last unit: the stock CHECK in the D1 batch must let exactly one order through
  await admin("PUT", "/api/admin/inventory", { product_id: A.product_id, ml: A.ml, price: null, stock: 1 });
  const race = await Promise.all(
    [1, 2, 3, 4].map((n) => order([{ slug: A.product_id, ml: A.ml, qty: 1 }], { ip: ipFor(`last-${n}`), key: uuid() })),
  );
  const won = race.filter((r) => r.status === 200);
  ok("stock: 4 concurrent orders for the last unit -> one 200, three 409", won.length === 1 && race.filter((r) => r.status === 409).length === 3, race.map((r) => r.status));
  ok("stock: never negative after the race", (await invRow(A.product_id, A.ml)).override?.stock === 0);
  if (won[0]) await admin("PATCH", `/api/admin/orders/${won[0].data.orderNo}`, { status: "cancelled", note: "test race" });

  /* ---------- status transitions ---------- */
  const skip = await admin("PATCH", `/api/admin/orders/${no1}`, { status: "paid" });
  ok("status: new -> paid (skipping confirmed) -> 409", skip.status === 409 && skip.data?.errors?.status === "transition", skip.status);
  const bogus = await admin("PATCH", `/api/admin/orders/${no1}`, { status: "lost" });
  ok("status: unknown status -> 422", bogus.status === 422, bogus.status);
  let step = true;
  for (const s of ["confirmed", "paid", "shipped", "done"]) {
    const r = await admin("PATCH", `/api/admin/orders/${no1}`, { status: s });
    step &&= r.status === 200 && r.data?.order?.status === s;
  }
  ok("status: new -> confirmed -> paid -> shipped -> done", step);
  const back = await admin("PATCH", `/api/admin/orders/${no1}`, { status: "shipped" });
  ok("status: done -> shipped (backwards) -> 409", back.status === 409, back.status);
  const one = await admin("GET", `/api/admin/orders/${no1}`);
  ok("status: history has created + 4 admin events", one.data?.events?.length === 5 && one.data.events[0].to_status === "new" && one.data.events[4].to_status === "done", one.data?.events);
  ok("admin: order detail hides ip and idempotency key", one.data?.order && !("ip" in one.data.order) && !("idempotency_key" in one.data.order));
  const noAuthPatch = await call("PATCH", `/api/admin/orders/${no1}`, { body: { status: "cancelled" }, ip: ipFor("auth") });
  ok("admin: PATCH without token -> 401", noAuthPatch.status === 401, noAuthPatch.status);
  const filtered = await admin("GET", "/api/admin/orders?status=done&limit=2");
  ok("admin: list filters by status", filtered.status === 200 && filtered.data.orders.every((o) => o.status === "done"), filtered.data);
  const page2 = filtered.data?.nextCursor ? await admin("GET", `/api/admin/orders?status=done&limit=2&cursor=${filtered.data.nextCursor}`) : null;
  ok("admin: list paging returns older rows", !page2 || page2.data.orders.every((o) => o.id < filtered.data.nextCursor + 1));

  /* ---------- customer lookup ---------- */
  const L = (body, ip = ipFor("lookup")) => call("POST", "/api/orders/lookup", { body, ip });
  const full = await L({ orderNo: no1, phone: PHONE });
  ok("lookup: number + phone -> 200 with status and items", full.status === 200 && full.data?.status === "done" && full.data?.items?.length === 1, full.data);
  ok("lookup: returns no name / address / phone", full.data && !("name" in full.data) && !("address" in full.data) && !("phone" in full.data));
  const last4 = await L({ orderNo: no1, phone: PHONE.slice(-4) });
  ok("lookup: last 4 digits are enough", last4.status === 200, last4.status);
  const wrongPhone = await L({ orderNo: no1, phone: "88887777" });
  ok("lookup: wrong phone -> 404", wrongPhone.status === 404, wrongPhone.status);
  const noPhone = await L({ orderNo: no1 });
  ok("lookup: missing phone -> 422", noPhone.status === 422, noPhone.status);
  const ghost = await L({ orderNo: "GZ-000101-AAAA", phone: PHONE });
  ok("lookup: unknown order -> 404 (same as wrong phone)", ghost.status === 404, ghost.status);
  const lip = ipFor("lookup-rl");
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await L({ orderNo: no1, phone: "00000000" }, lip)).status);
  ok("lookup: 11th lookup in 10 min -> 429", codes.slice(0, 10).every((c) => c === 404) && codes[10] === 429, codes);

  /* ---------- order rate limit (atomic, 5 per IP per 10 min) ---------- */
  const rip = ipFor("rate");
  const rcodes = [];
  // unknown product: counted by the limiter, rejected after it, so no rows are created
  for (let i = 0; i < 6; i++) rcodes.push((await order([{ slug: `no-such-${RUN}`, ml: 5, qty: 1 }], { ip: rip, key: uuid() })).status);
  ok("rate limit: 6th order attempt -> 429", rcodes.slice(0, 5).every((c) => c === 422) && rcodes[5] === 429, rcodes);
  const cip = ipFor("rate-burst");
  const burst = await Promise.all(Array.from({ length: 8 }, () => order([{ slug: `no-such-${RUN}`, ml: 5, qty: 1 }], { ip: cip, key: uuid() })));
  const n422 = burst.filter((r) => r.status === 422).length;
  ok("rate limit: 8 concurrent attempts -> exactly 5 pass the limiter", n422 === 5 && burst.length - n422 === 3, burst.map((r) => r.status));
} catch (err) {
  failed++;
  console.log("FAIL  test run aborted:", err?.stack ?? err);
} finally {
  if (A && ADMIN) {
    const del = await admin("DELETE", `/api/admin/inventory?product_id=${encodeURIComponent(A.product_id)}&ml=${A.ml}`);
    ok("cleanup: test inventory row removed", del.status === 200 && del.data?.deleted === 1, del.status);
  }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
