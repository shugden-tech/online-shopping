// Payment tests (A2): QPay invoice + payment-check + signed callback against scripts/mock-qpay.mjs, partial
// payments, invoice-creation failure and recovery, hold expiry (incl. a paid-but-lost callback and a late
// payment), cancel after paid, admin payments list and permissions.
// Plain node (18+), no dependencies. Needs:
//   node scripts/mock-qpay.mjs                                         (port 8892)
//   .dev.vars: QPAY_BASE_URL=http://127.0.0.1:8892 QPAY_USERNAME=test QPAY_PASSWORD=test
//              QPAY_INVOICE_CODE=TEST_INVOICE QPAY_CALLBACK_SECRET=<any> PUBLIC_SITE_URL=http://localhost:8792
//   npx astro build && npx wrangler dev --port 8792 --persist-to .wrangler/state-a2
//   BASE=http://localhost:8792 node scripts/test-payments.mjs
// Test products are inserted with `wrangler d1 execute` (D1_PERSIST, default .wrangler/state-a2) as `tp-<run>-*`.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8792").replace(/\/$/, "");
const MOCK = (process.env.MOCK_QPAY ?? "http://127.0.0.1:8892").replace(/\/$/, "");
const PERSIST = process.env.D1_PERSIST ?? ".wrangler/state-a2";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN");
const STAFF = envVar("STAFF_TOKEN");
const SECRET = envVar("QPAY_CALLBACK_SECRET");
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const FEE = fileSettings.delivery.fee;
const RUN = Math.random().toString(36).slice(2, 8);
const PHONE = "88112244";

let pass = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) pass++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

/* ---------------- helpers ---------------- */

const q = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
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

async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // a reused keep-alive socket closed while the synchronous SQL calls ran: the request never arrived
    if (!/UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED/.test(err?.cause?.code ?? "")) throw err;
    return fetch(url, init);
  }
}

let ipSeq = 0;
const freshIp = (tag = "x") => `testpay-${RUN}-${tag}-${++ipSeq}`;
const uuid = () => crypto.randomUUID();
async function call(method, path, { body, headers = {}, ip = freshIp(), auth, origin = true } = {}) {
  const res = await fetchRetry(path.startsWith("http") ? path : BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": ip,
      ...(origin ? { Origin: BASE } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const admin = (method, path, body) => call(method, path, { body, auth: ADMIN });
const staff = (method, path, body) => call(method, path, { body, auth: STAFF });
const mock = (method, path, body) => call(method, MOCK + path, { body, origin: false });
/** QPay calling our callback: no Origin, no auth; GET by default. */
const qpayCallback = (url, init = {}) => call(init.method ?? "GET", url, { origin: false, body: init.body });

const P = (s) => `tp-${RUN}-${s}`;
const S = (s) => `${P(s)}:5`;
const sku = (s) => one(`SELECT stock, reserved FROM skus WHERE id = ${q(S(s))}`);
const orderRow = (no) => one(`SELECT id, status, payment_status, hold_expires_at, cancel_reason FROM orders WHERE order_no = ${q(no)}`);
const payments = (no) => sql(`SELECT provider, provider_ref, amount, status, paid_amount, provider_payment_id FROM payments WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(no)}) ORDER BY id`)[0];
const utc = (s) => new Date(s.replace(" ", "T") + "Z").getTime();
const sig = (no) => createHmac("sha256", SECRET).update(no).digest("hex");

function body(items, extra = {}) {
  return {
    name: "Pay Test", phone: PHONE, phone2: "", city: "ub", district: fileSettings.districts[0].id, khoroo: "",
    address: "Payment street 5", note: `test-payments ${RUN}`, payment: "qpay", locale: "en",
    items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
  };
}
const order = (items, { key = uuid(), extra } = {}) =>
  call("POST", "/api/orders", { body: body(items, extra), ip: freshIp("order"), headers: { "Idempotency-Key": key } });
const check = (no, phone = PHONE) => call("POST", `/api/orders/${no}/payment-check`, { body: { phone }, ip: freshIp("check") });
const pay = async (no, amount) => (await mock("POST", "/_control/pay", { sender_invoice_no: no, ...(amount !== undefined ? { amount } : {}) })).data;
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

let originalSettings = null;
try {
  if (!ADMIN || !STAFF || !SECRET) throw new Error("ADMIN_TOKEN, STAFF_TOKEN and QPAY_CALLBACK_SECRET are needed (environment or .dev.vars)");
  const reset = await mock("POST", "/_control/reset");
  if (reset.status !== 200) throw new Error(`mock QPay is not reachable at ${MOCK}`);

  sql(
    ["q", "r", "x", "y"]
      .map(
        (id) =>
          `INSERT INTO products (id, brand, name, status) VALUES (${q(P(id))}, 'PayBrand', ${q(`Pay ${id}`)}, 'active');
           INSERT INTO skus (id, product_id, ml, kind, price, stock) VALUES (${q(S(id))}, ${q(P(id))}, 5, 'decant', 15000, 5);`,
      )
      .join("\n"),
  );
  originalSettings = (await admin("GET", "/api/admin/settings")).data?.settings ?? null;
  await admin("PUT", "/api/admin/settings", {
    "checkout.open": true, "payments.qpay.enabled": true, "payments.bank.enabled": true, "holds.qpay_minutes": 30,
    "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null,
  });
  const TOTAL = 15000 + FEE;

  /* ---------- QPay order -> invoice ---------- */
  const key = uuid();
  const t0 = Date.now();
  const A = await order([{ sku: S("q"), qty: 1 }], { key });
  const noA = A.data?.orderNo;
  ok("qpay: order -> 201 with QPay instructions", A.status === 201 && A.data?.payment?.method === "qpay" && A.data.payment.invoiceId && A.data.payment.qrImage && A.data.payment.urls?.length === 1, [A.status, A.data]);
  ok("qpay: hold = holds.qpay_minutes (30)", Math.abs(utc(A.data?.holdExpiresAt ?? "1970-01-01 00:00:00") - t0 - 30 * 60_000) < 120_000, A.data?.holdExpiresAt);
  const invs = (await mock("GET", `/_control/invoices?sender_invoice_no=${noA}`)).data.items;
  ok("qpay: one mock invoice, amount = total, invoice_code from env", invs.length === 1 && invs[0].amount === TOTAL && invs[0].invoice_code === "TEST_INVOICE" && invs[0].invoice_id === A.data?.payment?.invoiceId, invs);
  ok("qpay: callback_url = PUBLIC_SITE_URL + signed order", invs[0]?.callback_url === `${BASE}/api/payments/qpay/callback?order=${noA}&sig=${sig(noA)}`, invs[0]?.callback_url);
  ok("qpay: payment row pending, order payment_status pending, reserved 1", payments(noA)[0]?.status === "pending" && orderRow(noA).payment_status === "pending" && sku("q").reserved === 1, payments(noA));
  const replay = await order([{ sku: S("q"), qty: 1 }], { key });
  ok("qpay: idempotent replay -> 200 same body, no second invoice", replay.status === 200 && JSON.stringify(replay.data) === JSON.stringify(A.data) && (await mock("GET", `/_control/invoices?sender_invoice_no=${noA}`)).data.items.length === 1, [replay.status, replay.data]);

  /* ---------- payment-check before paying ---------- */
  const c0 = await check(noA);
  ok("payment-check: before paying -> pending / new", c0.status === 200 && c0.data?.paymentStatus === "pending" && c0.data?.status === "new" && c0.data?.payment?.invoiceId === A.data?.payment?.invoiceId, c0.data);
  const cw = await check(noA, "00000000");
  ok("payment-check: wrong phone -> 404", cw.status === 404, cw.status);
  const cr = [];
  const rip = freshIp("check-rl");
  for (let i = 0; i < 11; i++) cr.push((await call("POST", `/api/orders/${noA}/payment-check`, { body: { phone: "00000000" }, ip: rip })).status);
  ok("payment-check: 11th call in 10 min -> 429", cr[10] === 429 && cr.slice(0, 10).every((c) => c === 404), cr);

  /* ---------- signature ---------- */
  const bad = await qpayCallback(`/api/payments/qpay/callback?order=${noA}&sig=${"0".repeat(64)}`);
  ok("callback: bad sig -> 403", bad.status === 403, bad.status);
  const none = await qpayCallback(`/api/payments/qpay/callback?order=${noA}`);
  ok("callback: missing sig -> 403", none.status === 403, none.status);
  const other = await qpayCallback(`/api/payments/qpay/callback?order=${noA}&sig=${sig("GZ-000101-AAAA")}`);
  ok("callback: another order's sig -> 403", other.status === 403, other.status);
  ok("callback: unpaid invoice + valid sig -> SUCCESS, order still new", (await qpayCallback(invs[0].callback_url)).data === "SUCCESS" && orderRow(noA).status === "new");

  /* ---------- paid via callback ---------- */
  const paid = await pay(noA);
  ok("mock: invoice paid in full", paid?.paid_amount === TOTAL, paid);
  const cb = await qpayCallback(paid.callback_url);
  ok("callback: valid sig -> 200 SUCCESS", cb.status === 200 && cb.data === "SUCCESS", [cb.status, cb.data]);
  {
    const o = orderRow(noA);
    const s = sku("q");
    const [mv, res] = sql(
      `SELECT delta, reason FROM stock_movements WHERE order_id = ${o.id};
       SELECT status FROM reservations WHERE order_id = ${o.id};`,
    );
    const pr = payments(noA)[0];
    ok("callback: order paid / payment_status paid / hold cleared", o.status === "paid" && o.payment_status === "paid" && o.hold_expires_at === null, o);
    ok("callback: stock 5 -> 4, reserved back to 0", s.stock === 4 && s.reserved === 0, s);
    ok("callback: movement sale -1, reservation committed", mv.length === 1 && mv[0].reason === "sale" && mv[0].delta === -1 && res[0]?.status === "committed", [mv, res]);
    ok("callback: payment row paid with QPay payment_id", pr.status === "paid" && pr.paid_amount === TOTAL && pr.provider_payment_id, pr);
  }
  const replays = await Promise.all([1, 2, 3].map(() => qpayCallback(paid.callback_url)));
  const postJson = await qpayCallback(paid.callback_url, { method: "POST", body: { payment_id: "forged", amount: 1 } });
  ok("callback: replays (3 concurrent + POST JSON) -> SUCCESS, nothing changes", replays.every((r) => r.data === "SUCCESS") && postJson.data === "SUCCESS" && sku("q").stock === 4 && one(`SELECT COUNT(*) AS n FROM stock_movements WHERE order_id = ${orderRow(noA).id}`).n === 1, [replays.map((r) => r.status), postJson]);
  const look = await call("GET", `/api/orders/lookup?no=${noA}&phone=${PHONE.slice(-4)}`);
  ok("lookup: paymentStatus paid, no payment instructions", look.data?.paymentStatus === "paid" && look.data?.status === "paid" && look.data?.payment === null, look.data);

  /* ---------- partial payment ---------- */
  const B = (await order([{ sku: S("r"), qty: 1 }])).data.orderNo;
  const half = await pay(B, TOTAL - 1000);
  await qpayCallback(half.callback_url);
  ok("partial: paid_amount < amount -> order new, payment pending", orderRow(B).status === "new" && orderRow(B).payment_status === "pending" && payments(B)[0].status === "pending" && payments(B)[0].paid_amount === TOTAL - 1000, [orderRow(B), payments(B)]);
  ok("partial: reservation still held", sku("r").reserved === 1 && sku("r").stock === 5);
  await pay(B, 1000);
  const cB = await check(B);
  ok("partial: rest paid -> payment-check reports paid", cB.data?.paymentStatus === "paid" && cB.data?.status === "paid" && sku("r").stock === 4 && sku("r").reserved === 0, cB.data);

  /* ---------- invoice creation failure -> recovery ---------- */
  await mock("POST", "/_control/fail-invoice", { count: 1 });
  const Cr = await order([{ sku: S("x"), qty: 1 }]);
  const C = Cr.data?.orderNo;
  ok("invoice failure: 201, payment null, paymentError qpay_unavailable", Cr.status === 201 && Cr.data?.payment === null && Cr.data?.paymentError === "qpay_unavailable", [Cr.status, Cr.data]);
  ok("invoice failure: order kept, stock reserved, payment row failed", orderRow(C)?.status === "new" && orderRow(C).payment_status === "unpaid" && sku("x").reserved === 1 && payments(C)[0]?.status === "failed", [orderRow(C), payments(C)]);
  const cC = await check(C);
  ok("invoice failure: payment-check creates the invoice", cC.status === 200 && cC.data?.payment?.method === "qpay" && cC.data.paymentStatus === "pending" && !cC.data.paymentError, cC.data);
  await pay(C);
  const cC2 = await check(C);
  ok("invoice failure: paid after recovery", cC2.data?.status === "paid" && sku("x").reserved === 0 && sku("x").stock === 4, cC2.data);

  /* ---------- hold expiry ---------- */
  const E = (await order([{ sku: S("y"), qty: 2 }])).data.orderNo; // unpaid qpay
  const Eb = (await order([{ sku: S("y"), qty: 1 }], { extra: { payment: "bank" } })).data.orderNo; // unpaid bank
  const L = (await order([{ sku: S("y"), qty: 1 }])).data.orderNo; // paid, callback lost
  await pay(L);
  ok("expiry: 4 reserved before", sku("y").reserved === 4, sku("y"));
  sql(`UPDATE orders SET hold_expires_at = datetime('now', '-1 minute') WHERE order_no IN (${[E, Eb, L].map(q).join(",")})`);
  const trigger = await order([{ sku: S("x"), qty: 1 }], { extra: { payment: "bank" } }); // POST /api/orders sweeps via waitUntil
  ok("expiry: trigger order placed", trigger.status === 201, trigger.status);
  const swept = await waitFor(() => orderRow(E).status === "cancelled" && orderRow(Eb).status === "cancelled" && orderRow(L).status !== "new");
  ok("expiry: unpaid qpay + bank orders -> cancelled, reason expired", swept && orderRow(E).cancel_reason === "expired" && orderRow(Eb).cancel_reason === "expired", [orderRow(E), orderRow(Eb)]);
  ok("expiry: qpay payment expired, payment_status back to unpaid", payments(E)[0]?.status === "expired" && orderRow(E).payment_status === "unpaid", [payments(E), orderRow(E)]);
  ok("expiry: reservations released", sql(`SELECT status FROM reservations WHERE order_id IN (${orderRow(E).id}, ${orderRow(Eb).id})`)[0].every((r) => r.status === "released"));
  ok("expiry: paid-but-lost-callback order is paid, not expired", orderRow(L).status === "paid", orderRow(L));
  ok("expiry: reserved 4 -> 0, stock 5 -> 4 (only L sold)", sku("y").reserved === 0 && sku("y").stock === 4, sku("y"));

  // the customer pays the expired invoice anyway: recorded once for a refund, order stays cancelled
  const late = await pay(E);
  const lateCb = await qpayCallback(late.callback_url);
  await qpayCallback(late.callback_url);
  const lateAudit = one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.late' AND data_json LIKE ${q(`%${E}%`)}`).n;
  ok("late payment: SUCCESS, order stays cancelled, stock untouched, flagged once", lateCb.data === "SUCCESS" && orderRow(E).status === "cancelled" && sku("y").stock === 4 && lateAudit === 1 && payments(E)[0].paid_amount === 30000 + FEE, [orderRow(E), payments(E), lateAudit]);

  /* ---------- admin: payments list, permissions, cancel after paid ---------- */
  const list = await admin("GET", "/api/admin/payments?provider=qpay&limit=100");
  ok("admin payments: list with orderNo, no QR data", list.status === 200 && list.data.items.some((p) => p.orderNo === noA && p.status === "paid") && list.data.items.every((p) => !("dataJson" in p) && !("data_json" in p)), list.status);
  const stList = await staff("GET", "/api/admin/payments?status=paid");
  ok("admin payments: staff can read (payments.read), status filter", stList.status === 200 && stList.data.items.every((p) => p.status === "paid"), stList.status);
  ok("admin payments: no token -> 401, bad filter -> 400", (await call("GET", "/api/admin/payments")).status === 401 && (await admin("GET", "/api/admin/payments?status=nope")).status === 400);
  const D = (await order([{ sku: S("r"), qty: 1 }])).data.orderNo;
  ok("perm: staff PATCH paid on a QPay order -> 403", (await staff("PATCH", `/api/admin/orders/${D}`, { status: "paid" })).status === 403);
  ok("perm: staff mark-paid -> 403", (await staff("POST", `/api/admin/orders/${D}/mark-paid`, { amount: TOTAL })).status === 403);
  const ca = await admin("PATCH", `/api/admin/orders/${noA}`, { status: "cancelled", note: "customer changed mind" });
  const mvA = sql(`SELECT reason, delta FROM stock_movements WHERE order_id = ${orderRow(noA).id} ORDER BY id`)[0];
  ok("cancel after QPay paid: stock restored 4 -> 5, movement cancel_after_paid", ca.status === 200 && sku("q").stock === 5 && mvA.map((m) => `${m.reason}${m.delta}`).join(",") === "sale-1,cancel_after_paid1", [ca.status, mvA]);
  const det = await admin("GET", `/api/admin/orders/${noA}`);
  ok("admin detail: payments + events for the QPay order", det.data?.order?.payments?.[0]?.provider === "qpay" && det.data.order.payments[0].providerRef && det.data.order.events.map((e) => e.toStatus).join(",") === "new,paid,cancelled", det.data?.order?.events);

  /* ---------- token cache ---------- */
  const stats = (await mock("GET", "/_control/stats")).data;
  ok("qpay: access token cached (<= 2 token calls for the whole run)", stats.tokens >= 1 && stats.tokens <= 2, stats);
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
