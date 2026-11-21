// Wire payment tests (0008, CONTRACTS §11): the client (imported straight from src/lib/payments/wire.ts), the hosted
// checkout order flow, the signed webhook, read-back, the hold sweep, payment-check and the admin switch.
// Plain node (22.18+, for TypeScript type stripping), no dependencies. Needs:
//   node scripts/mock-wire.mjs                                           (port 8896)
//   .dev.vars: WIRE_BASE_URL=http://127.0.0.1:8896 WIRE_API_KEY=sk_live_mock_0123456789abcdef
//              WIRE_WEBHOOK_SECRET=whsec_mock_0123456789abcdef PUBLIC_SITE_URL=<BASE>
//   fresh D1:  npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-wire
//   npx astro build && npx wrangler dev --port 8797 --persist-to .wrangler/state-wire
//   BASE=http://localhost:8797 D1_PERSIST=.wrangler/state-wire npm run test:wire
// The mock key / secret are fakes made for the mock; no real Wire key is ever used or printed.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8797").replace(/\/$/, "");
const MOCK = (process.env.MOCK_WIRE ?? "http://127.0.0.1:8896").replace(/\/$/, "");
const PERSIST = process.env.D1_PERSIST ?? ".wrangler/state-wire";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN");
const STAFF = envVar("STAFF_TOKEN");
const KEY = envVar("WIRE_API_KEY");
const SECRET = envVar("WIRE_WEBHOOK_SECRET");
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const FEE = fileSettings.delivery.fee;
const RUN = Math.random().toString(36).slice(2, 8);
const PHONE = "88112255";
const HOOK = `${BASE}/api/payments/wire/webhook`;
const SITE = (envVar("PUBLIC_SITE_URL") || BASE).replace(/\/$/, "");

const W = await import(pathToFileURL(join(root, "src/lib/payments/wire.ts")).href);

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
  return JSON.parse(out.slice(out.indexOf("["))).map((s) => (s.results ?? []).map(fix));
}
const one = (command) => sql(command)[0]?.[0] ?? null;

async function fetchRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!/UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED/.test(err?.cause?.code ?? "")) throw err;
    return fetch(url, init);
  }
}
let ipSeq = 0;
const freshIp = (tag = "x") => `testwire-${RUN}-${tag}-${++ipSeq}`;
async function call(method, path, { body, raw, headers = {}, ip = freshIp(), auth, origin = true } = {}) {
  const res = await fetchRetry(path.startsWith("http") ? path : BASE + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}),
      "CF-Connecting-IP": ip,
      ...(origin ? { Origin: BASE } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
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
const sign = (t, raw) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
/** Wire delivering a raw body to our webhook (no Origin, JSON). */
const deliver = (raw, header) => call("POST", HOOK, { raw, origin: false, headers: header === null ? {} : { "WirePayment-Signature": header ?? sign(now(), raw) } });

const P = (s) => `tw-${RUN}-${s}`;
const S = (s) => `${P(s)}:5`;
const sku = (s) => one(`SELECT stock, reserved FROM skus WHERE id = ${q(S(s))}`);
const orderRow = (no) => one(`SELECT id, status, payment_status, hold_expires_at, cancel_reason FROM orders WHERE order_no = ${q(no)}`);
const payments = (no) =>
  sql(`SELECT id, provider, provider_ref, amount, status, paid_amount, provider_payment_id, data_json FROM payments WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(no)}) ORDER BY id`)[0];
const movements = (no) => sql(`SELECT reason, delta FROM stock_movements WHERE order_id = (SELECT id FROM orders WHERE order_no = ${q(no)}) ORDER BY id`)[0];
const utc = (s) => new Date(s.replace(" ", "T") + "Z").getTime();
const intentsOf = async (no) => (await mock("GET", `/_control/intents?order_id=${no}`)).data;
const setIntent = (body) => mock("POST", "/_control/set", body);

function orderBody(items, extra = {}) {
  return {
    name: "Wire Test", phone: PHONE, phone2: "", city: "ub", district: fileSettings.districts[0].id, khoroo: "",
    address: "Wire street 7", note: `test-wire ${RUN}`, payment: "wire", locale: "en",
    items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
  };
}
const order = (items, { key = crypto.randomUUID(), extra } = {}) =>
  call("POST", "/api/orders", { body: orderBody(items, extra), ip: freshIp("order"), headers: { "Idempotency-Key": key } });
const check = (no) => call("POST", `/api/orders/${no}/payment-check`, { body: { phone: PHONE }, ip: freshIp("check") });
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
  if (!ADMIN || !STAFF || !KEY || !SECRET) throw new Error("ADMIN_TOKEN, STAFF_TOKEN, WIRE_API_KEY and WIRE_WEBHOOK_SECRET are needed (.dev.vars, pointed at the mock)");
  const reset = await mock("POST", "/_control/reset");
  if (reset.status !== 200) throw new Error(`mock Wire is not reachable at ${MOCK}`);
  const wenv = { WIRE_BASE_URL: MOCK, WIRE_API_KEY: KEY, WIRE_WEBHOOK_SECRET: SECRET };

  /* ================= 1. client (src/lib/payments/wire.ts) ================= */
  {
    const raw = JSON.stringify({ id: "evt_abcdef123456", type: "payment_intent.succeeded", data: { id: "pi_abcdef123456" } });
    const t = now();
    ok("sig: valid header -> ok", (await W.verifyWireSignature(SECRET, sign(t, raw), raw)).ok === true);
    ok("sig: wrong secret -> mismatch", (await W.verifyWireSignature(SECRET, `t=${t},v1=${createHmac("sha256", "whsec_other").update(`${t}.${raw}`).digest("hex")}`, raw)).reason === "mismatch");
    ok("sig: body changed by one byte -> mismatch", (await W.verifyWireSignature(SECRET, sign(t, raw), raw.replace("succeeded", "succeedeD"))).reason === "mismatch");
    ok("sig: t 301 s old -> stale", (await W.verifyWireSignature(SECRET, sign(t - 301, raw), raw)).reason === "stale");
    ok("sig: t 301 s in the future -> stale", (await W.verifyWireSignature(SECRET, sign(t + 301, raw), raw)).reason === "stale");
    ok("sig: t 299 s old -> ok", (await W.verifyWireSignature(SECRET, sign(t - 299, raw), raw)).ok === true);
    ok("sig: missing / malformed / no secret", (await W.verifyWireSignature(SECRET, null, raw)).reason === "missing" && (await W.verifyWireSignature(SECRET, "v1=zz", raw)).reason === "malformed" && (await W.verifyWireSignature("", sign(t, raw), raw)).reason === "no_secret");
    ok("sig: two v1 values (rotation), one right -> ok", (await W.verifyWireSignature(SECRET, `t=${t},v1=${"0".repeat(64)},${sign(t, raw).split(",")[1]}`, raw)).ok === true);
    const ev = W.parseWireEvent(raw);
    ok("parse: event id, type, intent id", ev?.id === "evt_abcdef123456" && ev.type === "payment_intent.succeeded" && ev.intentId === "pi_abcdef123456");
    ok("parse: not an event -> null", W.parseWireEvent("{}") === null && W.parseWireEvent("nope") === null);
    const n = now();
    ok("expiry: clamped to 5 min .. 24 h from now", W.wireExpiry(n, n) === n + 330 && W.wireExpiry(n + 3 * 86400, n) === n + 86340 && W.wireExpiry(n + 1800, n) === n + 1800);
    ok("base: https / localhost http only", W.wireBase({}) === "https://api.wire.mn" && W.wireBase({ WIRE_BASE_URL: "http://evil.example" }) === null && W.wireBase({ WIRE_BASE_URL: "http://127.0.0.1:8896/v1/" }) === "http://127.0.0.1:8896");

    const before = (await mock("GET", "/_control/stats")).data;
    let e1 = null;
    try {
      await W.wireCall(wenv, "/v1/payment_intents", { method: "POST", body: { amount: 1000, currency: "MNT" } });
    } catch (e) {
      e1 = e;
    }
    const after = (await mock("GET", "/_control/stats")).data;
    ok("client: POST without Idempotency-Key refused before sending", e1?.code === "idempotency_key_required" && after.posts === before.posts, [e1?.code, before, after]);
    const raw400 = await fetch(`${MOCK}/v1/payment_intents`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: "{}" });
    ok("mock: Wire answers 400 parameter_missing without the key", raw400.status === 400 && (await raw400.json()).error?.param === "Idempotency-Key");

    const key = `unit-${RUN}-pi`;
    const exp = now() + 1800;
    const a = await W.createWireIntent(wenv, { amount: 25000, orderNo: `UNIT-${RUN}`, expiresAt: exp, idempotencyKey: key });
    const b = await W.createWireIntent(wenv, { amount: 25000, orderNo: `UNIT-${RUN}`, expiresAt: exp, idempotencyKey: key });
    const st = (await mock("GET", "/_control/stats")).data;
    ok("client: intent create replay (same key + body) -> same pi, one object", a.id === b.id && /^pi_/.test(a.id) && a.status === "requires_payment_method" && st.replays >= 1, [a, b, st]);
    let e2 = null;
    try {
      await W.createWireIntent(wenv, { amount: 26000, orderNo: `UNIT-${RUN}`, expiresAt: exp, idempotencyKey: key });
    } catch (e) {
      e2 = e;
    }
    ok("client: same key, other body -> 409 idempotency_key_in_use (not transient)", e2?.status === 409 && e2.code === "idempotency_key_in_use" && e2.transient === false, [e2?.status, e2?.code]);
    const c1 = await W.createWireCheckout(wenv, { intentId: a.id, successUrl: `${BASE}/ok`, cancelUrl: `${BASE}/no`, idempotencyKey: `unit-${RUN}-cs` });
    const c2 = await W.createWireCheckout(wenv, { intentId: a.id, successUrl: `${BASE}/ok`, cancelUrl: `${BASE}/no`, idempotencyKey: `unit-${RUN}-cs` });
    ok("client: checkout session replay -> same cs and url", c1.id === c2.id && c1.url === `https://pay.wire.mn/c/${c1.id}`, [c1, c2]);
    const g = await W.fetchWireIntent(wenv, a.id);
    ok("client: GET intent", g.id === a.id && g.amount === 25000 && g.orderId === `UNIT-${RUN}` && g.currency === "MNT");
    await setIntent({ intent: a.id, status: "canceled" });
    let e3 = null;
    try {
      await W.createWireCheckout(wenv, { intentId: a.id, successUrl: `${BASE}/ok`, cancelUrl: `${BASE}/no`, idempotencyKey: `unit-${RUN}-cs2` });
    } catch (e) {
      e3 = e;
    }
    ok("client: session for a cancelled intent -> 400 payment_intent_unexpected_state", e3?.status === 400 && e3.code === "payment_intent_unexpected_state", e3?.code);
    let e4 = null;
    try {
      await W.createWireIntent(wenv, { amount: 10.5, orderNo: "X", expiresAt: exp, idempotencyKey: `unit-${RUN}-frac` });
    } catch (e) {
      e4 = e;
    }
    ok("client: fractional amount refused locally", e4?.code === "amount_invalid");
    let e5 = null;
    try {
      await W.fetchWireIntent({ ...wenv, WIRE_API_KEY: "sk_test_nope" }, a.id);
    } catch (e) {
      e5 = e;
    }
    ok("client: error envelope -> code + request_id, key never in the message", e5?.code === "test_mode_unavailable" && e5.requestId && !String(e5.message).includes("sk_test_nope"), e5?.message);
  }

  /* ================= 2. order flow against wrangler dev ================= */
  sql(
    ["a", "b", "c", "d", "e"]
      .map(
        (id) =>
          `INSERT INTO products (id, brand, name, status) VALUES (${q(P(id))}, 'WireBrand', ${q(`Wire ${id}`)}, 'active');
           INSERT INTO skus (id, product_id, ml, kind, price, stock) VALUES (${q(S(id))}, ${q(P(id))}, 5, 'decant', 20000, 6);`,
      )
      .join("\n"),
  );
  originalSettings = (await admin("GET", "/api/admin/settings")).data?.settings ?? null;
  ok("settings: payments.wire.enabled defaults to false", originalSettings?.["payments.wire.enabled"] === false && originalSettings?.["holds.wire_minutes"] === 30, originalSettings);
  await admin("PUT", "/api/admin/settings", {
    "checkout.open": true, "payments.bank.enabled": true, "payments.wire.enabled": false, "holds.wire_minutes": 30,
    "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null,
  });
  const TOTAL = 20000 + FEE;

  /* ---------- disabled ---------- */
  const st0 = await call("GET", `/api/store/catalog-state?ids=${P("a")}`);
  ok("disabled: catalog-state payments.wire false", st0.status === 200 && st0.data?.payments?.wire === false && st0.data.payments.bank === true, st0.data?.payments);
  const bd0 = await call("GET", "/api/store/bundles");
  ok("disabled: store/bundles payments.wire false", bd0.data?.payments?.wire === false, bd0.data?.payments);
  const off = await order([{ sku: S("a"), qty: 1 }]);
  ok("disabled: wire order -> 422 payment disabled, nothing reserved", off.status === 422 && off.data?.errors?.payment === "disabled" && sku("a").reserved === 0, [off.status, off.data]);
  ok("disabled: no intent created at Wire", (await intentsOf("")).items.every((i) => !String(i.metadata?.order_id ?? "").startsWith("GZ-")));

  /* ---------- switch (owner only, audited) ---------- */
  const stOn = await staff("PUT", "/api/admin/settings", { "payments.wire.enabled": true });
  ok("switch: staff cannot turn Wire on (403)", stOn.status === 403, stOn.status);
  ok("switch: holds.wire_minutes > 1440 -> 400", (await admin("PUT", "/api/admin/settings", { "holds.wire_minutes": 2000 })).status === 400);
  const on = await admin("PUT", "/api/admin/settings", { "payments.wire.enabled": true });
  const aud = one(`SELECT actor, data_json FROM audit_log WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1`);
  ok("switch: owner turns Wire on, audited", on.status === 200 && on.data.settings["payments.wire.enabled"] === true && aud?.actor === "admin:owner" && JSON.parse(aud.data_json)["payments.wire.enabled"] === true, [on.status, aud]);
  const st1 = await call("GET", `/api/store/catalog-state?ids=${P("a")}`);
  ok("enabled: catalog-state payments.wire true", st1.data?.payments?.wire === true, st1.data?.payments);

  /* ---------- order -> intent + hosted checkout ---------- */
  const key = crypto.randomUUID();
  const t0 = Date.now();
  const A = await order([{ sku: S("a"), qty: 1 }], { key });
  const noA = A.data?.orderNo;
  ok("order: 201 with Wire hosted checkout url", A.status === 201 && A.data?.payment?.method === "wire" && /^pi_/.test(A.data.payment.intentId) && /^https:\/\/pay\.wire\.mn\/c\/cs_/.test(A.data.payment.checkoutUrl), [A.status, A.data]);
  const holdMs = utc(A.data?.holdExpiresAt ?? "1970-01-01 00:00:00");
  ok("order: hold = holds.wire_minutes (30)", Math.abs(holdMs - t0 - 30 * 60_000) < 120_000, A.data?.holdExpiresAt);
  const iA = await intentsOf(noA);
  const pi = iA.items[0];
  ok("wire: one intent, amount = total (whole ₮), MNT, metadata.order_id, description", iA.items.length === 1 && pi.amount === TOTAL && pi.currency === "MNT" && pi.metadata.order_id === noA && pi.description === `GenZst ${noA}`, iA.items);
  ok("wire: intent expires_at = the order hold", Math.abs(pi.expires_at * 1000 - holdMs) < 2000, [pi.expires_at, holdMs]);
  ok("wire: idempotency keys <orderNo>-pi / <orderNo>-cs", pi._key === `${noA}-pi` && iA.sessions[0]?._key === `${noA}-cs`, [pi._key, iA.sessions[0]?._key]);
  ok("wire: success/cancel url = the order's success page", iA.sessions[0]?.success_url === `${SITE}/en/checkout/success/?no=${noA}` && iA.sessions[0]?.cancel_url === iA.sessions[0]?.success_url, iA.sessions[0]);
  const pA = payments(noA)[0];
  ok("db: payment wire / pending / provider_ref = pi / data_json has cs + url", pA?.provider === "wire" && pA.status === "pending" && pA.provider_ref === pi.id && JSON.parse(pA.data_json).checkoutUrl === A.data.payment.checkoutUrl, pA);
  ok("db: order payment_status pending, stock reserved 1", orderRow(noA).payment_status === "pending" && sku("a").reserved === 1 && sku("a").stock === 6);
  const rep = await order([{ sku: S("a"), qty: 1 }], { key });
  ok("order: idempotent replay -> 200 same body, no second intent", rep.status === 200 && JSON.stringify(rep.data) === JSON.stringify(A.data) && (await intentsOf(noA)).items.length === 1, [rep.status]);
  const look = await call("POST", "/api/orders/lookup", { body: { orderNo: noA, phone: PHONE.slice(-6) } });
  ok("lookup: paymentMethod wire + checkout url while unpaid", look.data?.paymentMethod === "wire" && look.data?.payment?.checkoutUrl === A.data.payment.checkoutUrl, look.data);

  /* ---------- webhook: signature ---------- */
  const fakeRaw = JSON.stringify({ id: `evt_bad${RUN}0000`, object: "event", type: "payment_intent.succeeded", created: now(), data: { id: pi.id, status: "succeeded", amount: TOTAL, currency: "MNT" } });
  const bad = await deliver(fakeRaw, `t=${now()},v1=${"0".repeat(64)}`);
  ok("webhook: bad signature -> 400", bad.status === 400 && bad.data?.errors?.signature === "mismatch", [bad.status, bad.data]);
  const none = await deliver(fakeRaw, null);
  ok("webhook: missing signature -> 400", none.status === 400 && none.data?.errors?.signature === "missing", [none.status, none.data]);
  const stale = await deliver(fakeRaw, sign(now() - 400, fakeRaw));
  ok("webhook: stale timestamp (400 s) -> 400 stale", stale.status === 400 && stale.data?.errors?.signature === "stale", [stale.status, stale.data]);
  const tampered = await deliver(fakeRaw.replace(String(TOTAL), String(TOTAL + 1)), sign(now(), fakeRaw));
  ok("webhook: body changed after signing -> 400", tampered.status === 400);
  ok("webhook: nothing changed by rejected deliveries", orderRow(noA).status === "new" && one(`SELECT COUNT(*) AS n FROM wire_events WHERE id = ${q(`evt_bad${RUN}0000`)}`).n === 0);
  const ping = JSON.stringify({ id: `evt_ping${RUN}0000`, object: "event", type: "endpoint.verification", created: now(), data: {} });
  ok("webhook: endpoint.verification ping -> 200", (await deliver(ping)).status === 200);

  /* ---------- body is never trusted ---------- */
  const forged = await deliver(fakeRaw); // correctly signed, but Wire says the intent is still unpaid
  ok("webhook: signed 'succeeded' for an unpaid intent -> 200 pending, order NOT paid", forged.status === 200 && forged.data?.result === "pending" && orderRow(noA).status === "new" && sku("a").stock === 6, [forged.data, orderRow(noA)]);

  /* ---------- succeeded -> paid, stock committed once ---------- */
  const evtId = `evt_paid${RUN}0000`;
  const gets0 = (await mock("GET", "/_control/stats")).data.gets;
  const paid = await setIntent({ order_id: noA, status: "succeeded", deliver: HOOK, event_id: evtId });
  const gets1 = (await mock("GET", "/_control/stats")).data.gets;
  ok("webhook: succeeded -> 200 paid", paid.data?.delivery?.status === 200 && JSON.parse(paid.data.delivery.body).result === "paid", paid.data?.delivery);
  ok("webhook: intent read back from Wire (GET) before marking paid", gets1 === gets0 + 1, [gets0, gets1]);
  {
    const o = orderRow(noA);
    const p = payments(noA)[0];
    const res = sql(`SELECT status FROM reservations WHERE order_id = ${o.id}`)[0];
    ok("paid: order paid / payment_status paid / hold cleared", o.status === "paid" && o.payment_status === "paid" && o.hold_expires_at === null, o);
    ok("paid: stock 6 -> 5, reserved 0, reservation committed", sku("a").stock === 5 && sku("a").reserved === 0 && res[0]?.status === "committed", [sku("a"), res]);
    ok("paid: one sale movement -1", JSON.stringify(movements(noA)) === JSON.stringify([{ reason: "sale", delta: -1 }]), movements(noA));
    ok("paid: payment row paid, paid_amount, charge id", p.status === "paid" && p.paid_amount === TOTAL && /^ch_/.test(p.provider_payment_id ?? ""), p);
    ok("paid: audit order.paid provider wire + order event", one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.paid' AND data_json LIKE ${q(`%${noA}%`)} AND data_json LIKE '%"provider":"wire"%'`).n === 1 && one(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ${o.id} AND to_status = 'paid'`).n === 1);
  }
  const rawPaid = JSON.stringify(paid.data.event);
  const dup = await Promise.all([1, 2, 3].map(() => deliver(rawPaid)));
  ok("duplicate event id (3 concurrent redeliveries) -> 200 duplicate, nothing changes", dup.every((r) => r.status === 200 && r.data?.duplicate === true) && sku("a").stock === 5 && movements(noA).length === 1, dup.map((r) => r.data));
  const again = await setIntent({ order_id: noA, status: "succeeded", deliver: HOOK }); // a new event id about the same paid intent
  ok("second succeeded event (new id) -> already, stock committed exactly once", JSON.parse(again.data.delivery.body).result === "already" && sku("a").stock === 5 && movements(noA).length === 1, again.data?.delivery);
  ok("wire_events: one row per accepted event id", one(`SELECT COUNT(*) AS n FROM wire_events WHERE id = ${q(evtId)} AND result = 'paid'`).n === 1);

  /* ---------- failed attempt (buyer can retry) / final failure ---------- */
  const B = (await order([{ sku: S("b"), qty: 1 }])).data.orderNo;
  const f1 = await setIntent({ order_id: B, status: "payment_failed", deliver: HOOK });
  ok("failed attempt, intent still payable -> payment stays pending, audited", JSON.parse(f1.data.delivery.body).result === "pending" && payments(B)[0].status === "pending" && one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.attempt_failed' AND data_json LIKE ${q(`%${B}%`)}`).n === 1, [f1.data?.delivery, payments(B)]);
  const f2 = await setIntent({ order_id: B, status: "payment_failed", intent_status: "failed", deliver: HOOK });
  ok("failed (intent final) -> payment failed, order keeps its hold", JSON.parse(f2.data.delivery.body).result === "failed" && payments(B)[0].status === "failed" && orderRow(B).status === "new" && sku("b").reserved === 1, [f2.data?.delivery, payments(B), orderRow(B)]);
  ok("failed: audit payment.failed", one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.failed' AND data_json LIKE ${q(`%${B}%`)}`).n === 1);
  const cB = await check(B);
  const iB = await intentsOf(B);
  ok("after failure: payment-check opens a fresh checkout with keys -pi-2 / -cs-2", cB.status === 200 && cB.data?.payment?.method === "wire" && iB.items.length === 2 && iB.items[1]._key === `${B}-pi-2` && iB.sessions[1]?._key === `${B}-cs-2`, [cB.data, iB.items.map((i) => i._key)]);
  await setIntent({ intent: iB.items[1].id, status: "succeeded", deliver: HOOK });
  ok("after failure: second intent paid -> order paid, stock 6 -> 5", orderRow(B).status === "paid" && sku("b").stock === 5 && sku("b").reserved === 0, [orderRow(B), sku("b")]);

  /* ---------- canceled ---------- */
  const C = (await order([{ sku: S("c"), qty: 1 }])).data.orderNo;
  const cc = await setIntent({ order_id: C, status: "canceled", deliver: HOOK });
  ok("canceled -> payment cancelled, order still new (hold)", JSON.parse(cc.data.delivery.body).result === "cancelled" && payments(C)[0].status === "cancelled" && orderRow(C).status === "new", [cc.data?.delivery, payments(C)]);

  /* ---------- Wire unreachable while reading back -> 503, retried later ---------- */
  const D = (await order([{ sku: S("d"), qty: 1 }])).data.orderNo;
  await mock("POST", "/_control/fail", { endpoint: "get", count: 1, status: 500 });
  const dEvt = `evt_retry${RUN}000`;
  const d1 = await setIntent({ order_id: D, status: "succeeded", deliver: HOOK, event_id: dEvt });
  ok("read-back fails -> 503 (Wire retries), event not stored", d1.data.delivery.status === 503 && one(`SELECT COUNT(*) AS n FROM wire_events WHERE id = ${q(dEvt)}`).n === 0 && orderRow(D).status === "new", d1.data?.delivery);
  const d2 = await deliver(JSON.stringify(d1.data.event));
  ok("redelivery of the same event -> 200 paid", d2.status === 200 && d2.data?.result === "paid" && orderRow(D).status === "paid", d2.data);

  /* ---------- Wire down at checkout -> recovery with the same keys ---------- */
  await mock("POST", "/_control/fail", { endpoint: "intent", count: 1, status: 500 });
  const Er = await order([{ sku: S("e"), qty: 1 }]);
  const E = Er.data?.orderNo;
  ok("checkout failure: 201, payment null, paymentError wire_unavailable, stock held", Er.status === 201 && Er.data?.payment === null && Er.data?.paymentError === "wire_unavailable" && sku("e").reserved === 1 && payments(E)[0]?.status === "failed", [Er.status, Er.data, payments(E)]);
  ok("checkout failure: audited payment.error (transient)", one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.error' AND data_json LIKE ${q(`%${E}%`)} AND data_json LIKE '%"transient":true%'`).n === 1);
  const cE = await check(E);
  const iE = await intentsOf(E);
  ok("checkout failure: payment-check creates it, same key <orderNo>-pi (transient)", cE.data?.payment?.method === "wire" && iE.items.length === 1 && iE.items[0]._key === `${E}-pi`, [cE.data, iE.items.map((i) => i._key)]);

  /* ---------- lost webhook: payment-check and the hold sweep read the intent ---------- */
  await setIntent({ order_id: E, status: "succeeded" }); // paid, no delivery
  const cE2 = await check(E);
  ok("payment-check: paid intent without webhook -> order paid", cE2.data?.status === "paid" && cE2.data?.paymentStatus === "paid" && sku("e").stock === 5, cE2.data);

  const L = (await order([{ sku: S("c"), qty: 1 }])).data.orderNo; // paid, webhook lost
  const X = (await order([{ sku: S("c"), qty: 2 }])).data.orderNo; // never paid
  await setIntent({ order_id: L, status: "succeeded" });
  sql(`UPDATE orders SET hold_expires_at = datetime('now', '-1 minute') WHERE order_no IN (${[L, X, C].map(q).join(",")})`);
  const job = await admin("POST", "/api/admin/jobs/run", {});
  ok("sweep: job ran", job.status === 200, [job.status, job.data]);
  const swept = await waitFor(() => orderRow(X).status === "cancelled" && orderRow(L).status !== "new");
  ok("sweep: paid-but-lost-webhook Wire order -> paid, not expired", swept && orderRow(L).status === "paid", orderRow(L));
  ok("sweep: unpaid Wire order -> cancelled expired, payment expired, stock released", orderRow(X).cancel_reason === "expired" && payments(X)[0].status === "expired" && orderRow(C).status === "cancelled", [orderRow(X), payments(X), orderRow(C)]);
  ok("sweep: stock c 6 -> 5 (only L sold), reserved 0", sku("c").stock === 5 && sku("c").reserved === 0, sku("c"));
  // the buyer pays the expired intent anyway: recorded once for a refund, the order stays cancelled
  const late = await setIntent({ order_id: X, status: "succeeded", deliver: HOOK });
  ok("late payment on an expired order -> recorded for refund, stock untouched", JSON.parse(late.data.delivery.body).result === "recorded" && orderRow(X).status === "cancelled" && sku("c").stock === 5 && one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.late' AND data_json LIKE ${q(`%${X}%`)}`).n === 1, late.data?.delivery);

  /* ---------- admin ---------- */
  const list = await admin("GET", "/api/admin/payments?provider=wire&limit=100");
  ok("admin payments: provider=wire filter", list.status === 200 && list.data.items.length >= 5 && list.data.items.every((p) => p.provider === "wire"), list.status);
  const Z = (await order([{ sku: S("d"), qty: 1 }])).data.orderNo;
  const zId = payments(Z)[0].id;
  await setIntent({ order_id: Z, status: "succeeded" });
  ok("admin check: staff -> 403", (await staff("POST", `/api/admin/payments/${zId}/check`, {})).status === 403);
  const ac = await admin("POST", `/api/admin/payments/${zId}/check`, {});
  ok("admin check: Wire payment re-checked -> paid", ac.status === 200 && ac.data?.status === "paid" && ac.data.results?.[0] === "paid", [ac.status, ac.data]);
  const refundRaw = JSON.stringify({ id: `evt_ref${RUN}0000`, object: "event", type: "charge.refunded", created: now(), data: { id: "re_abc123456", object: "refund", charge: payments(Z)[0].provider_payment_id, amount: TOTAL, status: "succeeded", refunded_total: TOTAL } });
  const rf = await deliver(refundRaw);
  ok("charge.refunded -> 200, recorded in the audit log for the owner", rf.status === 200 && rf.data?.result === "refund_recorded" && one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.refund_event' AND entity_id = ${q(String(zId))}`).n === 1, rf.data);
  ok("no key or secret in the audit log", one(`SELECT COUNT(*) AS n FROM audit_log WHERE data_json LIKE ${q(`%${KEY}%`)} OR data_json LIKE ${q(`%${SECRET}%`)}`).n === 0);

  const st2 = await admin("PUT", "/api/admin/settings", { "payments.wire.enabled": false });
  const offAgain = await order([{ sku: S("d"), qty: 1 }]);
  ok("switched off again -> wire order 422, catalog-state wire false", st2.status === 200 && offAgain.status === 422 && (await call("GET", `/api/store/catalog-state?ids=${P("a")}`)).data?.payments?.wire === false, offAgain.status);
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
