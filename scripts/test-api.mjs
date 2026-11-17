// Order API tests (A2): pricing from D1 skus, reservations, idempotency, oversell + races, unsellable SKUs,
// store switches, admin transitions / permissions, bank mark-paid, customer lookup, rate limits.
// Plain node (18+), no dependencies. Needs a built site served by wrangler with local D1 + migrations:
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-a2
//   npx astro build && npx wrangler dev --port 8792 --persist-to .wrangler/state-a2
//   BASE=http://localhost:8792 node scripts/test-api.mjs
// Test products/SKUs are inserted with `wrangler d1 execute` into the same persist dir (D1_PERSIST, default
// .wrangler/state-a2) under ids `ta-<run>-*`; store settings are restored at the end.
// ADMIN_TOKEN / STAFF_TOKEN come from the environment or .dev.vars; TURNSTILE_SECRET must be the always-pass test secret.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8792").replace(/\/$/, "");
const PERSIST = process.env.D1_PERSIST ?? ".wrangler/state-a2";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN");
const STAFF = envVar("STAFF_TOKEN");
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const RUN = Math.random().toString(36).slice(2, 8);
const PHONE = "99112233";

let pass = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

/* ---------------- helpers ---------------- */

const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
/** Runs SQL against the local D1 the server uses; returns one result array per statement. */
function sql(command) {
  const out = execFileSync(
    process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const fix = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === "null" ? null : v]));
  // wrangler may print notices (e.g. about a proxy) before the JSON
  return JSON.parse(out.slice(out.indexOf("["))).map((s) => (s.results ?? []).map(fix));
}
const one = (command) => sql(command)[0]?.[0] ?? null;

let ipSeq = 0;
const freshIp = (tag = "x") => `test-${RUN}-${tag}-${++ipSeq}`;
const uuid = () => crypto.randomUUID();

/**
 * fetch that retries once when a reused keep-alive socket was already closed by the server (the request never
 * reached it: the synchronous `wrangler d1 execute` calls above leave sockets idle long enough for that).
 */
async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = err?.cause?.code ?? "";
    if (!/UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED/.test(code)) throw err;
    return fetch(url, init);
  }
}

async function call(method, path, { body, headers = {}, ip = freshIp(), auth } = {}) {
  const res = await fetchRetry(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": ip,
      Origin: BASE,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
const admin = (method, path, body) => call(method, path, { body, auth: ADMIN });
const staff = (method, path, body) => call(method, path, { body, auth: STAFF });

function orderBody(items, extra = {}) {
  return {
    name: "API Test", phone: PHONE, phone2: "", city: "ub", district: fileSettings.districts[0].id, khoroo: "1",
    address: "Test street 1, apt 2", note: `test-api ${RUN}`, payment: "bank", locale: "mn",
    items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
  };
}
const order = (items, { ip = freshIp("order"), key = uuid(), extra } = {}) =>
  call("POST", "/api/orders", { body: orderBody(items, extra), ip, headers: key ? { "Idempotency-Key": key } : {} });

const P = (s) => `ta-${RUN}-${s}`;
const S = (s, ml = 5) => `${P(s)}:${ml}`;
const skuRow = (id) => one(`SELECT stock, reserved FROM skus WHERE id = ${q(id)}`);
const ordersWithKey = (key) => one(`SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ${q(key)}`).n;
const utc = (s) => new Date(s.replace(" ", "T") + "Z").getTime();
const FEE = fileSettings.delivery.fee;
const FREE = fileSettings.delivery.freeThreshold;
const deliveryFor = (sub) => (sub >= FREE ? 0 : FEE);

let originalSettings = null;
try {
  if (!ADMIN || !STAFF) throw new Error("ADMIN_TOKEN and STAFF_TOKEN are needed (environment or .dev.vars)");

  /* ---------- seed (SQL) + known store settings ---------- */
  const products = [
    // id, status, sale_locked, [ml, price, stock, active]
    ["a", "active", 0, [5, 12000, 2, 1]], // tracked, 2 units
    ["b", "active", 0, [10, 30000, null, 1]], // untracked
    ["c", "active", 0, [5, 9000, 1, 1]], // last unit race
    ["d", "active", 0, [5, 8000, 5, 1]], // admin transitions
    ["e", "active", 0, [5, 7000, 5, 1]], // cancel / concurrent
    ["np", "active", 0, [5, null, 5, 1]], // price NULL
    ["hid", "hidden", 0, [5, 5000, 5, 1]],
    ["drf", "draft", 0, [5, 5000, 5, 1]],
    ["lck", "active", 1, [5, 5000, 5, 1]],
    ["ina", "active", 0, [5, 5000, 5, 0]],
  ];
  sql(
    products
      .map(
        ([id, status, locked, [ml, price, stock, active]]) =>
          `INSERT INTO products (id, brand, name, status, sale_locked) VALUES (${q(P(id))}, 'TestBrand', ${q(`Test ${id}`)}, ${q(status)}, ${locked});
           INSERT INTO skus (id, product_id, ml, kind, price, stock, active) VALUES (${q(S(id, ml))}, ${q(P(id))}, ${ml}, 'decant', ${q(price)}, ${q(stock)}, ${active});`,
      )
      .join("\n"),
  );
  originalSettings = (await admin("GET", "/api/admin/settings")).data?.settings ?? null;
  const reset = await admin("PUT", "/api/admin/settings", {
    "checkout.open": true, "payments.bank.enabled": true, "payments.qpay.enabled": true,
    "holds.bank_minutes": 1440, "holds.qpay_minutes": 30,
    "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null,
  });
  if (reset.status !== 200) throw new Error(`could not set store settings: ${reset.status} ${JSON.stringify(reset.data)}`);

  /* ---------- admin auth ---------- */
  {
    const none = await call("GET", "/api/admin/orders");
    ok("admin: no token -> 401", none.status === 401, none.status);
    ok("admin: 401 is not cacheable", /no-store/.test(none.headers.get("cache-control") ?? ""), none.headers.get("cache-control"));
    const wrong = await call("GET", "/api/admin/orders", { auth: ADMIN + "x" });
    ok("admin: wrong token -> 401", wrong.status === 401, wrong.status);
    const good = await admin("GET", "/api/admin/orders?limit=1");
    ok("admin: owner token -> 200 { items, nextCursor }", good.status === 200 && Array.isArray(good.data?.items) && "nextCursor" in good.data, good.status);
    const st = await staff("GET", "/api/admin/orders?limit=1");
    ok("admin: staff can list orders (orders.read)", st.status === 200, st.status);
  }

  /* ---------- happy bank order ---------- */
  const key1 = uuid();
  const t0 = Date.now();
  const first = await order([{ sku: S("a"), qty: 1 }], { key: key1 });
  const no1 = first.data?.orderNo;
  ok("order: happy path -> 201 with order number", first.status === 201 && /^GZ-\d{6}-[A-Z2-9]{4}$/.test(no1 ?? ""), [first.status, first.data]);
  ok("order: totals from D1 skus + delivery", first.data?.subtotal === 12000 && first.data?.delivery === deliveryFor(12000) && first.data?.total === 12000 + deliveryFor(12000), first.data);
  const holdMs = first.data?.holdExpiresAt ? utc(first.data.holdExpiresAt) - t0 : 0;
  ok("order: bank hold = holds.bank_minutes (1440)", Math.abs(holdMs - 1440 * 60_000) < 120_000, first.data?.holdExpiresAt);
  const bank = fileSettings.payment.bank;
  ok(
    "order: bank instructions with the order number as reference",
    first.data?.payment?.method === "bank" && first.data.payment.reference === no1 && first.data.payment.account === bank.accountNumber && first.data.payment.bank === bank.name.mn,
    first.data?.payment,
  );
  {
    const [o, r, ev, au] = sql(
      `SELECT status, payment_status, hold_expires_at FROM orders WHERE order_no = ${q(no1)};
       SELECT sku_id, qty, tracked, status FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(no1)});
       SELECT to_status, actor FROM order_events WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(no1)});
       SELECT action, data_json FROM audit_log WHERE entity = 'order' AND entity_id = ${q(no1)};`,
    );
    ok("order: stored as new / unpaid with hold", o[0]?.status === "new" && o[0]?.payment_status === "unpaid" && o[0]?.hold_expires_at === first.data?.holdExpiresAt, o);
    ok("order: reservation held + tracked", r.length === 1 && r[0].sku_id === S("a") && r[0].qty === 1 && r[0].tracked === 1 && r[0].status === "held", r);
    ok("order: skus.reserved += qty", skuRow(S("a")).reserved === 1);
    ok("order: created event + audit row (no PII)", ev.length === 1 && ev[0].to_status === "new" && au.length === 1 && au[0].action === "order.create" && !au[0].data_json.includes(PHONE), [ev, au]);
  }

  /* ---------- idempotency ---------- */
  const retry = await order([{ sku: S("a"), qty: 1 }], { key: key1 });
  ok("idempotency: same key -> 200 with the same body", retry.status === 200 && JSON.stringify(retry.data) === JSON.stringify(first.data), [retry.status, retry.data]);
  ok("idempotency: no second row, no second reservation", ordersWithKey(key1) === 1 && skuRow(S("a")).reserved === 1);
  {
    const keyR = uuid();
    const [r1, r2] = await Promise.all([order([{ sku: S("b", 10), qty: 1 }], { key: keyR }), order([{ sku: S("b", 10), qty: 1 }], { key: keyR })]);
    const codes = [r1.status, r2.status].sort();
    ok("idempotency: two concurrent requests, same key -> 201 + 200, one order", codes[0] === 200 && codes[1] === 201 && r1.data.orderNo === r2.data.orderNo && ordersWithKey(keyR) === 1, [r1.status, r1.data, r2.status, r2.data]);
  }
  const badKey = await call("POST", "/api/orders", { body: orderBody([{ sku: S("a"), qty: 1 }]), headers: { "Idempotency-Key": "short" } });
  ok("idempotency: malformed key -> 400", badKey.status === 400, badKey.status);

  /* ---------- legacy items + untracked stock ---------- */
  {
    const legacy = await order([{ slug: P("b"), ml: 10, qty: 3, price: 1 }]);
    ok("order: legacy { slug, ml } item accepted, client price ignored", legacy.status === 201 && legacy.data?.subtotal === 90000, [legacy.status, legacy.data]);
    const r = one(`SELECT tracked, status FROM reservations WHERE sku_id = ${q(S("b", 10))} AND order_id = (SELECT id FROM orders WHERE order_no = ${q(legacy.data?.orderNo)})`);
    ok("order: untracked SKU -> reservation tracked=0, skus.reserved untouched", r?.tracked === 0 && skuRow(S("b", 10)).reserved === 0, r);
    const dup = await order([{ sku: S("b", 10), qty: 6 }, { slug: P("b"), ml: 10, qty: 5 }]);
    ok("order: duplicate lines merged; > 10 of one SKU -> 422", dup.status === 422 && dup.data?.errors?.form === "items", [dup.status, dup.data]);
    const badSku = await order([{ sku: "Not A Sku", qty: 1 }]);
    ok("order: malformed sku -> 422 items", badSku.status === 422 && badSku.data?.errors?.form === "items", [badSku.status, badSku.data]);
  }

  /* ---------- oversell ---------- */
  {
    const key = uuid();
    const before = skuRow(S("a"));
    const over = await order([{ sku: S("a"), qty: 2 }], { key }); // stock 2, reserved 1 -> available 1
    ok("stock: oversell -> 409 { form: stock, sku }", over.status === 409 && over.data?.errors?.form === "stock" && over.data?.errors?.sku === S("a"), [over.status, over.data]);
    ok("stock: oversell wrote no order and changed no reservation", ordersWithKey(key) === 0 && JSON.stringify(skuRow(S("a"))) === JSON.stringify(before));
    const key2 = uuid();
    const mixed = await order([{ sku: S("b", 10), qty: 1 }, { sku: S("a"), qty: 2 }], { key: key2 });
    ok("stock: mixed cart with one short line -> 409, nothing written", mixed.status === 409 && ordersWithKey(key2) === 0 && skuRow(S("a")).reserved === 1, mixed.status);
  }

  /* ---------- race for the last unit ---------- */
  {
    const race = await Promise.all([1, 2, 3, 4].map(() => order([{ sku: S("c"), qty: 1 }])));
    const codes = race.map((r) => r.status);
    ok("stock: 4 concurrent orders for the last unit -> 1x201, 3x409", codes.filter((c) => c === 201).length === 1 && codes.filter((c) => c === 409).length === 3, codes);
    ok("stock: losers answer { form: stock, sku }", race.filter((r) => r.status === 409).every((r) => r.data?.errors?.form === "stock" && r.data?.errors?.sku === S("c")), race.map((r) => r.data));
    const row = skuRow(S("c"));
    ok("stock: reserved = 1, stock = 1 after the race", row.reserved === 1 && row.stock === 1, row);
    ok("stock: exactly one reservation row", one(`SELECT COUNT(*) AS n FROM reservations WHERE sku_id = ${q(S("c"))}`).n === 1);
  }

  /* ---------- unsellable ---------- */
  for (const [id, label] of [["np", "price NULL"], ["hid", "hidden product"], ["drf", "draft product"], ["lck", "sale-locked product"], ["ina", "inactive SKU"], ["zz", "unknown SKU"]]) {
    const r = await order([{ sku: S(id), qty: 1 }]);
    ok(`unavailable: ${label} -> 409 { form: unavailable, sku }`, r.status === 409 && r.data?.errors?.form === "unavailable" && r.data?.errors?.sku === S(id), [r.status, r.data]);
  }

  /* ---------- store switches ---------- */
  {
    await admin("PUT", "/api/admin/settings", { "checkout.open": false });
    const closed = await order([{ sku: S("b", 10), qty: 1 }]);
    ok("switch: checkout closed -> 423 { form: closed }", closed.status === 423 && closed.data?.errors?.form === "closed", [closed.status, closed.data]);
    await admin("PUT", "/api/admin/settings", { "checkout.open": true, "payments.bank.enabled": false });
    const noBank = await order([{ sku: S("b", 10), qty: 1 }]);
    ok("switch: bank disabled -> 422 { payment: disabled }", noBank.status === 422 && noBank.data?.errors?.payment === "disabled", [noBank.status, noBank.data]);
    await admin("PUT", "/api/admin/settings", { "payments.bank.enabled": true, "payments.qpay.enabled": false });
    const noQpay = await order([{ sku: S("b", 10), qty: 1 }], { extra: { payment: "qpay" } });
    ok("switch: QPay disabled -> 422 { payment: disabled }", noQpay.status === 422 && noQpay.data?.errors?.payment === "disabled", [noQpay.status, noQpay.data]);
    await admin("PUT", "/api/admin/settings", { "payments.qpay.enabled": true, "delivery.fee_ub": 7000, "delivery.fee_countryside": 11000, "delivery.free_over": 200000 });
    const ub = await order([{ sku: S("b", 10), qty: 1 }]);
    const cs = await order([{ sku: S("b", 10), qty: 1 }], { extra: { city: "countryside", district: "Darkhan" } });
    const free = await order([{ sku: S("b", 10), qty: 7 }]);
    ok("delivery: fee from settings (ub 7000 / countryside 11000 / free over 200000)", ub.data?.delivery === 7000 && cs.data?.delivery === 11000 && free.data?.delivery === 0 && free.data?.total === 210000, [ub.data, cs.data, free.data]);
    await admin("PUT", "/api/admin/settings", { "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null });
  }

  /* ---------- admin transitions ---------- */
  {
    const X = (await order([{ sku: S("d"), qty: 2 }])).data.orderNo;
    const skip = await admin("PATCH", `/api/admin/orders/${X}`, { status: "shipped" });
    ok("status: new -> shipped -> 409 transition", skip.status === 409 && skip.data?.errors?.status === "transition", [skip.status, skip.data]);
    const bogus = await admin("PATCH", `/api/admin/orders/${X}`, { status: "lost" });
    ok("status: unknown status -> 422", bogus.status === 422, bogus.status);
    const stPaid = await staff("PATCH", `/api/admin/orders/${X}`, { status: "paid" });
    ok("perm: staff PATCH paid -> 403 (needs payments.write)", stPaid.status === 403, stPaid.status);
    const conf = await staff("PATCH", `/api/admin/orders/${X}`, { status: "confirmed", note: "called the customer" });
    ok("status: staff new -> confirmed -> 200, hold cleared", conf.status === 200 && conf.data?.order?.status === "confirmed" && conf.data.order.holdExpiresAt === null, [conf.status, conf.data]);
    const paid = await admin("PATCH", `/api/admin/orders/${X}`, { status: "paid" });
    ok("status: owner confirmed -> paid -> 200", paid.status === 200 && paid.data?.order?.status === "paid" && paid.data.order.paymentStatus === "paid", [paid.status, paid.data]);
    const [mv, res, pay] = sql(
      `SELECT delta, reason FROM stock_movements WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(X)});
       SELECT status FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(X)});
       SELECT provider, status, amount FROM payments WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(X)});`,
    );
    const d = skuRow(S("d"));
    ok("paid: stock -= qty, reserved -= qty", d.stock === 3 && d.reserved === 0, d);
    ok("paid: movement sale -2, reservation committed, bank payment row paid", mv.length === 1 && mv[0].delta === -2 && mv[0].reason === "sale" && res[0]?.status === "committed" && pay[0]?.status === "paid" && pay[0]?.provider === "bank", [mv, res, pay]);
    let step = true;
    for (const s of ["shipped", "done"]) {
      const r = await admin("PATCH", `/api/admin/orders/${X}`, { status: s });
      step &&= r.status === 200 && r.data?.order?.status === s;
    }
    ok("status: paid -> shipped -> done", step);
    const back = await admin("PATCH", `/api/admin/orders/${X}`, { status: "shipped" });
    ok("status: done -> shipped (backwards) -> 409", back.status === 409, back.status);
    const det = await admin("GET", `/api/admin/orders/${X}`);
    ok("detail: events new, confirmed, paid, shipped, done", det.data?.order?.events?.map((e) => e.toStatus).join(",") === "new,confirmed,paid,shipped,done", det.data?.order?.events);
    ok("detail: hides ip and idempotency key; has reservations + payments", det.data?.order && !("ip" in det.data.order) && !("idempotencyKey" in det.data.order) && !("idempotency_key" in det.data.order) && det.data.order.reservations?.[0]?.skuId === S("d") && det.data.order.payments?.length === 1 && Array.isArray(det.data.order.shipments), det.data);
    const noAuth = await call("PATCH", `/api/admin/orders/${X}`, { body: { status: "cancelled" } });
    ok("admin: PATCH without token -> 401", noAuth.status === 401, noAuth.status);

    // cancel before paid releases; twice -> 409
    const Y = (await order([{ sku: S("e"), qty: 2 }])).data.orderNo;
    ok("cancel: reserved 2 before", skuRow(S("e")).reserved === 2);
    const c1 = await staff("PATCH", `/api/admin/orders/${Y}`, { status: "cancelled", note: "test" });
    const e1 = skuRow(S("e"));
    const ry = one(`SELECT status, cancel_reason, hold_expires_at FROM orders WHERE order_no = ${q(Y)}`);
    ok("cancel before paid: 200, reserved released, stock unchanged", c1.status === 200 && e1.reserved === 0 && e1.stock === 5, [c1.status, e1]);
    ok("cancel before paid: reservation released, reason admin", one(`SELECT status FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(Y)})`)?.status === "released" && ry.cancel_reason === "admin", ry);
    const c2 = await admin("PATCH", `/api/admin/orders/${Y}`, { status: "cancelled" });
    ok("cancel: twice -> 409, released only once", c2.status === 409 && skuRow(S("e")).reserved === 0, c2.status);
    const revive = await admin("PATCH", `/api/admin/orders/${Y}`, { status: "new" });
    ok("status: cancelled is final -> 409", revive.status === 409, revive.status);

    // cancel after paid restores stock
    const Z = (await order([{ sku: S("e"), qty: 1 }])).data.orderNo;
    const zp = await admin("POST", `/api/admin/orders/${Z}/mark-paid`, { amount: 7000 + FEE, reference: `TX-${RUN}-Z` });
    ok("mark-paid: full amount -> paid", zp.status === 200 && zp.data?.result === "paid" && zp.data.order?.status === "paid", [zp.status, zp.data]);
    ok("mark-paid: stock 5 -> 4", skuRow(S("e")).stock === 4 && skuRow(S("e")).reserved === 0);
    const zc = await admin("PATCH", `/api/admin/orders/${Z}`, { status: "cancelled", note: "refund" });
    const zmv = sql(`SELECT delta, reason FROM stock_movements WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(Z)}) ORDER BY id`)[0];
    ok("cancel after paid: stock restored (4 -> 5), movement cancel_after_paid", zc.status === 200 && skuRow(S("e")).stock === 5 && zmv.map((m) => `${m.reason}${m.delta}`).join(",") === "sale-1,cancel_after_paid1", [zc.status, zmv]);
    ok("cancel after paid: reservation stays committed, payment stays paid", one(`SELECT status FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(Z)})`)?.status === "committed" && one(`SELECT payment_status FROM orders WHERE order_no = ${q(Z)}`)?.payment_status === "paid");

    // mark-paid: permissions, partial, idempotent, duplicate reference, validation
    const W = (await order([{ sku: S("e"), qty: 1 }])).data.orderNo;
    const due = 7000 + FEE;
    const sm = await staff("POST", `/api/admin/orders/${W}/mark-paid`, { amount: due, reference: "x" });
    ok("perm: staff mark-paid -> 403", sm.status === 403, sm.status);
    const inv = await admin("POST", `/api/admin/orders/${W}/mark-paid`, { amount: -5 });
    ok("mark-paid: invalid amount -> 422", inv.status === 422 && inv.data?.errors?.amount === "invalid", inv.status);
    const part = await admin("POST", `/api/admin/orders/${W}/mark-paid`, { amount: due - 1000, reference: `TX-${RUN}-W` });
    ok("mark-paid: partial -> stays new, payment pending", part.status === 200 && part.data?.result === "partial" && part.data.order?.status === "new" && part.data.order.paymentStatus === "pending", [part.status, part.data]);
    ok("mark-paid: partial keeps the reservation held", skuRow(S("e")).reserved === 1);
    const full = await admin("POST", `/api/admin/orders/${W}/mark-paid`, { amount: due, reference: `TX-${RUN}-W` });
    ok("mark-paid: full -> paid, one bank payment row", full.data?.result === "paid" && one(`SELECT COUNT(*) AS n FROM payments WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(W)})`).n === 1, full.data);
    const again = await admin("POST", `/api/admin/orders/${W}/mark-paid`, { amount: due, reference: `TX-${RUN}-W` });
    ok("mark-paid: same reference again -> 200 already, stock untouched", again.status === 200 && again.data?.result === "already" && skuRow(S("e")).stock === 4, [again.status, again.data]);
    const V = (await order([{ sku: S("e"), qty: 1 }])).data.orderNo;
    const dupRef = await admin("POST", `/api/admin/orders/${V}/mark-paid`, { amount: due, reference: `TX-${RUN}-W` });
    ok("mark-paid: reference of another order -> 409 duplicate", dupRef.status === 409 && dupRef.data?.errors?.reference === "duplicate", [dupRef.status, dupRef.data]);
    await admin("PATCH", `/api/admin/orders/${V}`, { status: "cancelled" });
    const onCancelled = await admin("POST", `/api/admin/orders/${V}/mark-paid`, { amount: due, reference: `TX-${RUN}-V` });
    ok("mark-paid: cancelled order -> 409 transition", onCancelled.status === 409 && onCancelled.data?.errors?.status === "transition", [onCancelled.status, onCancelled.data]);

    // cancel and mark-paid at the same time: exactly one wins, stock arithmetic stays consistent
    const R = (await order([{ sku: S("e"), qty: 1 }])).data.orderNo;
    const before = skuRow(S("e"));
    const [pc, pp] = await Promise.all([
      admin("PATCH", `/api/admin/orders/${R}`, { status: "cancelled" }),
      admin("POST", `/api/admin/orders/${R}/mark-paid`, { amount: due, reference: `TX-${RUN}-R` }),
    ]);
    const final = one(`SELECT status FROM orders WHERE order_no = ${q(R)}`).status;
    const after = skuRow(S("e"));
    const consistent =
      final === "cancelled"
        ? after.reserved === before.reserved - 1 && after.stock === before.stock
        : final === "paid" && after.reserved === before.reserved - 1 && after.stock === before.stock - 1;
    ok("race: cancel vs mark-paid -> one winner, stock consistent", [pc.status, pp.status].includes(200) && consistent, { pc: [pc.status, pc.data?.errors], pp: [pp.status, pp.data?.result ?? pp.data?.errors], final, before, after });

    // list
    const listed = await admin("GET", `/api/admin/orders?q=${encodeURIComponent(X)}`);
    ok("list: q finds the order by number; item has paymentStatus + holdExpiresAt", listed.data?.items?.length === 1 && listed.data.items[0].orderNo === X && "paymentStatus" in listed.data.items[0] && "holdExpiresAt" in listed.data.items[0], listed.data);
    const filtered = await admin("GET", "/api/admin/orders?status=cancelled&limit=2");
    ok("list: filters by status, pages with nextCursor", filtered.status === 200 && filtered.data.items.every((o) => o.status === "cancelled") && filtered.data.nextCursor !== null, filtered.data);
    const page2 = await admin("GET", `/api/admin/orders?status=cancelled&limit=2&cursor=${filtered.data?.nextCursor}`);
    ok("list: next page has older rows", page2.status === 200 && page2.data.items.every((o) => o.id < filtered.data.nextCursor), page2.data);
    const badStatus = await admin("GET", "/api/admin/orders?status=lost");
    ok("list: unknown status -> 400", badStatus.status === 400, badStatus.status);
  }

  /* ---------- customer lookup ---------- */
  {
    const lip = freshIp("lookup");
    const G = (no, phone) => call("GET", `/api/orders/lookup?no=${encodeURIComponent(no)}&phone=${encodeURIComponent(phone)}`, { ip: lip });
    const full = await G(no1, PHONE);
    ok("lookup GET: 200 with status, paymentStatus, holdExpiresAt, shipment", full.status === 200 && full.data?.status === "new" && full.data?.paymentStatus === "unpaid" && full.data?.holdExpiresAt === first.data.holdExpiresAt && full.data?.shipment === null, full.data);
    ok("lookup: unpaid bank order shows bank instructions", full.data?.payment?.method === "bank" && full.data.payment.reference === no1, full.data?.payment);
    ok("lookup: returns no name / address / phone", full.data && !("name" in full.data) && !("address" in full.data) && !("phone" in full.data));
    const last4 = await G(no1, PHONE.slice(-4));
    ok("lookup: last 4 digits are enough", last4.status === 200, last4.status);
    const wrong = await G(no1, "88887777");
    ok("lookup: wrong phone -> 404", wrong.status === 404, wrong.status);
    const post = await call("POST", "/api/orders/lookup", { body: { orderNo: no1, phone: PHONE }, ip: freshIp("lookup") });
    ok("lookup POST (legacy) still works", post.status === 200 && post.data?.orderNo === no1, post.status);
    const missing = await call("POST", "/api/orders/lookup", { body: { orderNo: no1 } });
    ok("lookup: missing phone -> 422", missing.status === 422, missing.status);
    const ghost = await call("GET", `/api/orders/lookup?no=GZ-000101-AAAA&phone=${PHONE}`);
    ok("lookup: unknown order -> 404 (same as wrong phone)", ghost.status === 404, ghost.status);
    const rip = freshIp("lookup-rl");
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await call("GET", `/api/orders/lookup?no=${no1}&phone=00000000`, { ip: rip })).status);
    ok("lookup: 11th lookup in 10 min -> 429", codes.slice(0, 10).every((c) => c === 404) && codes[10] === 429, codes);
  }

  /* ---------- order rate limit (atomic, 5 per IP per 10 min) ---------- */
  {
    const rip = freshIp("rate");
    const rcodes = [];
    // unknown SKU: counted by the limiter, rejected after it (409), so no rows are created
    for (let i = 0; i < 6; i++) rcodes.push((await order([{ sku: S("nosuch"), qty: 1 }], { ip: rip })).status);
    ok("rate limit: 6th order attempt -> 429", rcodes.slice(0, 5).every((c) => c === 409) && rcodes[5] === 429, rcodes);
    const cip = freshIp("rate-burst");
    const burst = await Promise.all(Array.from({ length: 8 }, () => order([{ sku: S("nosuch"), qty: 1 }], { ip: cip })));
    const n409 = burst.filter((r) => r.status === 409).length;
    ok("rate limit: 8 concurrent attempts -> exactly 5 pass the limiter", n409 === 5 && burst.length - n409 === 3, burst.map((r) => r.status));
  }
} catch (err) {
  failed++;
  console.log("FAIL  test run aborted:", err?.stack ?? err);
} finally {
  if (originalSettings && ADMIN) {
    const r = await admin("PUT", "/api/admin/settings", originalSettings);
    ok("cleanup: store settings restored", r.status === 200, r.status);
  }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
