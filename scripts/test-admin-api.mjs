// Admin rebuild (0004) API tests against a running local server (wrangler dev + local D1). Never run against production.
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-admin
//   node scripts/import-catalog.mjs --apply local --persist-to .wrangler/state-admin --demo-prices
//   node scripts/mock-qpay.mjs & PORT=8893 MOCK_API_KEY=test-key node scripts/mock-delivery.mjs &
//   npx astro build && npx wrangler dev --port 8788 --persist-to .wrangler/state-admin
//   BASE=http://localhost:8788 D1_PERSIST=.wrangler/state-admin node scripts/test-admin-api.mjs
// .dev.vars: ADMIN_TOKEN, STAFF_TOKEN, ADMIN_USERNAME/ADMIN_PASSWORD, DELIVERY_WEBHOOK_SECRET, QPay mock values,
// WEBHOOK_ALLOW_LOCAL=1 (lets an outbound endpoint be this script's http://127.0.0.1 receiver).
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8788").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error("test-admin-api runs against a LOCAL server only"); process.exit(2); }
const PERSIST = process.env.D1_PERSIST ?? ".wrangler/state-admin";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN"), STAFF = envVar("STAFF_TOKEN");
const USER = envVar("ADMIN_USERNAME"), PASS = envVar("ADMIN_PASSWORD");
const HOOK_SECRET = envVar("DELIVERY_WEBHOOK_SECRET");
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const RUN = Math.random().toString(36).slice(2, 7);

let pass = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
function sql(command) {
  const out = execFileSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.slice(out.indexOf("["))).map((s) => s.results ?? []);
}
const one = (c) => sql(c)[0]?.[0] ?? null;
let ipn = 0;
async function call(method, path, { body, headers = {}, auth = ADMIN, raw, form } = {}) {
  const init = { method, headers: { "CF-Connecting-IP": `t-${RUN}-${++ipn}`, Origin: BASE, ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } };
  if (form) init.body = form;
  else if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(BASE + path, init);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    } catch (e) { if (i) throw e; }
  }
}
const orderBody = (items, extra = {}) => ({
  name: "Admin Test", phone: "99887766", phone2: "", city: "ub", district: fileSettings.districts[0].id, khoroo: "1",
  address: "Test street 9", note: `admin-api ${RUN}`, payment: "bank", locale: "mn", items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
});
const placeOrder = (items, extra) => call("POST", "/api/orders", { body: orderBody(items, extra), auth: null, headers: { "Idempotency-Key": crypto.randomUUID() } });

// local receiver for outbound webhooks (verifies the signature)
const received = [];
let recvStatus = 200;
const recv = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(recvStatus).end("ok"); });
});
await new Promise((r) => recv.listen(0, "127.0.0.1", r));
const RECV = `http://127.0.0.1:${recv.address().port}/hook`;

const P = `aa-${RUN}`;
try {
  /* ---------- §0 login ---------- */
  let r = await call("POST", "/api/admin/login", { body: { username: USER, password: "wrong-password-123" }, auth: null });
  ok("login: wrong password -> 401", r.status === 401 && r.data?.errors?.form === "unauthorized", r);
  r = await call("POST", "/api/admin/login", { body: { username: USER, password: PASS }, auth: null });
  ok("login: username + password -> token (owner)", r.status === 200 && r.data.role === "owner" && r.data.token === ADMIN, r.status);
  r = await call("GET", "/api/admin/me", { auth: "not-a-real-token-xxxxxxxxxxxxxxxx" });
  ok("bad token -> 401", r.status === 401);

  /* ---------- stats ---------- */
  for (const range of ["today", "7d", "30d"]) {
    r = await call("GET", `/api/admin/stats?range=${range}`);
    ok(`stats ${range}: kpi + 30-day series + latest`, r.status === 200 && typeof r.data.kpi?.revenue === "number" && r.data.series?.length === 30 && Array.isArray(r.data.latest) && typeof r.data.now?.lowStock === "number", r.data);
  }
  r = await call("GET", "/api/admin/stats?range=year");
  ok("stats: bad range -> 400", r.status === 400);
  r = await call("GET", "/api/admin/stats", { auth: STAFF });
  ok("stats: staff (orders.read) allowed", r.status === 200);

  /* ---------- product list filters / facets ---------- */
  r = await call("GET", "/api/admin/products/facets");
  ok("facets: brands + families + status counts", r.status === 200 && r.data.brands.length > 10 && r.data.counts.active >= 1, r.status);
  r = await call("GET", "/api/admin/products?hasPrice=0&limit=5");
  ok("filter hasPrice=0: no priced SKU in results", r.status === 200 && r.data.items.every((p) => p.skus.every((s) => s.price === null)), r.data?.items?.[0]?.skus);
  r = await call("GET", "/api/admin/products?hasPrice=1&status=active&limit=5");
  ok("filter hasPrice=1", r.status === 200 && r.data.items.every((p) => p.skus.some((s) => s.price !== null)));
  r = await call("GET", "/api/admin/products?hasPhoto=0&gender=none&sort=updated&limit=5");
  ok("filter hasPhoto=0 + gender=none + sort", r.status === 200 && r.data.items.every((p) => !p.imageFront && p.gender === null), r.status);
  r = await call("GET", "/api/admin/products?sort=bogus");
  ok("bad sort -> 400", r.status === 400);

  /* ---------- create, bulk, live page, photos ---------- */
  const base = { brand: "Test House", name: `Admin ${RUN}`, concentration: "EDP", gender: "unisex", family: "woody", notes: { top: ["bergamot"], heart: ["rose"], base: ["musk"] }, descriptionMn: "Туршилт", status: "draft" };
  r = await call("POST", "/api/admin/products", { body: { id: `${P}-a`, ...base } });
  ok("create product", r.status === 201 && r.data.product.id === `${P}-a`, r.data);
  r = await call("POST", "/api/admin/products", { body: { id: `${P}-a`, ...base } });
  ok("duplicate id -> 409 taken", r.status === 409 && r.data.errors.id === "taken");
  await call("POST", "/api/admin/products", { body: { id: `${P}-b`, ...base, name: `Admin ${RUN} B` } });
  r = await call("POST", "/api/admin/products/bulk", { body: { ids: [`${P}-a`, `${P}-b`], action: "price", ml: 5, price: 25000 } });
  ok("bulk price: creates 5 ml SKUs", r.status === 200 && r.data.changed === 2, r.data);
  r = await call("POST", "/api/admin/products/bulk", { body: { ids: [`${P}-a`, `${P}-b`], action: "activate" } });
  ok("bulk activate", r.status === 200 && r.data.changed === 2, r.data);
  r = await call("POST", "/api/admin/products/bulk", { body: { ids: [`${P}-a`], action: "price", ml: 5, price: -1 } });
  ok("bulk bad price -> 400", r.status === 400);
  r = await call("POST", "/api/admin/products/bulk", { body: { ids: [`${P}-a`], action: "activate" }, auth: STAFF });
  ok("bulk: staff -> 403", r.status === 403);

  const page = await fetch(`${BASE}/delguur/p/${P}-a`);
  const html = await page.text();
  ok("live product page (D1 only) renders 200 with the name", page.status === 200 && html.includes(`Admin ${RUN}`), page.status);
  ok("live page is cached 60 s", /max-age=60/.test(page.headers.get("cache-control") ?? ""), page.headers.get("cache-control"));
  const en = await fetch(`${BASE}/en/shop/p/${P}-a`);
  ok("live product page (en) 200", en.status === 200);
  const built = sql("SELECT id FROM products WHERE source = 'content' AND status = 'active' LIMIT 1")[0][0]?.id;
  const red = await fetch(`${BASE}/delguur/p/${built}`, { redirect: "manual" });
  ok("built product: /delguur/p/{id} redirects to the static page", red.status === 301 && (red.headers.get("location") ?? "").includes(`/delguur/${built}`), red.status);
  await call("POST", "/api/admin/products/bulk", { body: { ids: [`${P}-b`], action: "hide" } });
  const hidden = await fetch(`${BASE}/delguur/p/${P}-b`);
  ok("hidden product page -> 404", hidden.status === 404);

  // photo upload (tiny PNG) -> PATCH -> catalog-state carries it
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "f.png");
  fd.append("productId", `${P}-a`);
  fd.append("side", "front");
  r = await call("POST", "/api/admin/media", { form: fd });
  ok("media upload -> url", r.status === 200 && /products\/aa-.*\/front-[0-9a-f]{12}\.png$/.test(r.data.url ?? ""), r.data);
  const url = r.data?.url;
  r = await call("PATCH", `/api/admin/products/${P}-a`, { body: { imageFront: url, imageBack: url } });
  ok("PATCH imageFront/imageBack", r.status === 200 && r.data.product.imageFront === url);
  r = await call("GET", `/api/store/catalog-state?ids=${P}-a`, { auth: null });
  const st = r.data.products?.[0];
  ok("catalog-state: live photos + price + sellable", st?.imageFront === url && st?.skus?.[0]?.price === 25000 && st.skus[0].sellable === true, st);

  /* ---------- settings: bank + contacts live ---------- */
  const before = (await call("GET", "/api/admin/settings")).data.settings;
  r = await call("PUT", "/api/admin/settings", { body: { "bank.name": `Test Bank ${RUN}`, "contact.phone": "+976 1111 2222", "store.notice_mn": "" } });
  ok("settings: bank + contact keys accepted", r.status === 200 && r.data.settings["bank.name"] === `Test Bank ${RUN}`, r.data);
  r = await call("GET", "/api/store/info", { auth: null });
  ok("store/info: live contact", r.status === 200 && r.data.contact.phone === "+976 1111 2222");

  /* ---------- outbound webhook endpoint ---------- */
  r = await call("POST", "/api/admin/webhooks/endpoints", { body: { url: "http://example.com/x", events: ["order.created"] } });
  ok("endpoint: http (not local) -> 400", r.status === 400 && r.data.errors.url === "invalid");
  r = await call("POST", "/api/admin/webhooks/endpoints", { body: { url: RECV, events: ["order.created", "order.paid", "order.cancelled", "shipment.updated"], description: "test" } });
  ok("endpoint created, secret shown once", r.status === 201 && /^whsec_[0-9a-f]{48}$/.test(r.data.secret ?? ""), r.data);
  const ep = r.data.endpoint, secret = r.data.secret;
  r = await call("GET", "/api/admin/webhooks/endpoints");
  ok("endpoint list never returns the secret", r.status === 200 && !JSON.stringify(r.data).includes(secret));
  r = await call("POST", `/api/admin/webhooks/endpoints/${ep.id}/test`);
  ok("test event delivered", r.status === 200 && r.data.delivery.status === "delivered" && r.data.delivery.httpStatus === 200, r.data);
  const ping = received.at(-1);
  const sig = "sha256=" + createHmac("sha256", secret).update(`${ping?.headers["x-genzst-timestamp"]}.${ping?.body}`).digest("hex");
  ok("test event signature verifies (HMAC-SHA256 of timestamp.body)", ping && ping.headers["x-genzst-signature"] === sig && ping.headers["x-genzst-event"] === "ping");
  r = await call("POST", "/api/admin/webhooks/endpoints", { body: { url: RECV, events: ["order.created"] }, auth: STAFF });
  ok("endpoint create: staff -> 403", r.status === 403);

  /* ---------- orders: created event, notes, poll, filters, mark paid, shipment ---------- */
  const poll0 = (await call("GET", "/api/admin/orders/poll")).data;
  r = await placeOrder([{ sku: `${P}-a:5`, qty: 1 }]);
  ok("order placed (bank)", r.status === 201 && r.data.payment?.method === "bank", r.data);
  const no = r.data.orderNo;
  ok("bank instructions use the live bank name", r.data.payment?.bank === `Test Bank ${RUN}`, r.data.payment);
  const poll1 = (await call("GET", "/api/admin/orders/poll")).data;
  ok("poll: latestId grows, newCount counts it", poll1.latestId > poll0.latestId && poll1.newCount >= 1, poll1);
  await call("POST", "/api/admin/jobs/run");
  const created = received.find((x) => x.headers["x-genzst-event"] === "order.created" && x.body.includes(no));
  ok("order.created delivered to the endpoint", Boolean(created));
  ok("webhook payload has no customer PII", created && !/99887766|Admin Test|Test street/.test(created.body), created?.body);

  r = await call("POST", `/api/admin/orders/${no}/notes`, { body: { note: "Called the customer" } });
  ok("internal note added", r.status === 201 && r.data.note?.note === "Called the customer", r.data);
  r = await call("POST", `/api/admin/orders/${no}/notes`, { body: { note: "" } });
  ok("empty note -> 400", r.status === 400);
  r = await call("GET", `/api/admin/orders/${no}`);
  ok("order detail includes notes", r.status === 200 && r.data.order.notes?.length === 1);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  r = await call("GET", `/api/admin/orders?from=${today}&to=${today}&q=${no}`);
  ok("orders: date range + search", r.status === 200 && r.data.items.some((o) => o.orderNo === no), r.data);
  r = await call("GET", `/api/admin/orders?from=2000-01-01&to=2000-01-02&q=${no}`);
  ok("orders: date range excludes", r.status === 200 && r.data.items.length === 0);
  r = await call("GET", "/api/admin/orders?from=yesterday");
  ok("orders: bad date -> 400", r.status === 400);

  r = await call("POST", `/api/admin/orders/${no}/mark-paid`, { body: { amount: 999999, reference: `T-${RUN}` } });
  ok("bank mark-paid", r.status === 200, r.data);
  await call("POST", "/api/admin/jobs/run");
  ok("order.paid delivered", received.some((x) => x.headers["x-genzst-event"] === "order.paid" && x.body.includes(no)));

  r = await call("POST", "/api/admin/shipments", { body: { orderNo: no, courier: "Өөрсдөө", fee: 5000, notes: "evening", trackingNo: "TRK-1" } });
  ok("shipment with courier / fee / notes / tracking", r.status === 201 && r.data.shipment.courier === "Өөрсдөө" && r.data.shipment.fee === 5000 && r.data.shipment.trackingNo === "TRK-1", r.data);
  const sid = r.data.shipment?.id;
  r = await call("PATCH", `/api/admin/shipments/${sid}`, { body: { status: "picked_up" } });
  ok("manual: pending -> picked_up", r.status === 200 && r.data.shipment.status === "picked_up", r.data);
  ok("order follows: paid -> shipped", (await call("GET", `/api/admin/orders/${no}`)).data.order.status === "shipped");
  r = await call("PATCH", `/api/admin/shipments/${sid}`, { body: { fee: 6000 } });
  ok("PATCH fee only", r.status === 200 && r.data.shipment.fee === 6000, r.data);
  r = await call("PATCH", `/api/admin/shipments/${sid}`, { body: { status: "returned", note: "nobody home" } });
  ok("picked_up -> returned", r.status === 200 && r.data.shipment.status === "returned", r.data);
  await call("POST", "/api/admin/jobs/run");
  ok("shipment.updated delivered with orderNo", received.some((x) => x.headers["x-genzst-event"] === "shipment.updated" && x.body.includes(no)));

  // failing endpoint -> retry scheduled, then manual redeliver
  recvStatus = 500;
  const o2 = await placeOrder([{ sku: `${P}-a:5`, qty: 1 }]);
  await call("POST", "/api/admin/jobs/run");
  r = await call("GET", `/api/admin/webhooks/deliveries?endpoint=${ep.id}&status=pending`);
  const pend = r.data.items?.find((d) => d.event === "order.created" && d.payload.includes(o2.data.orderNo));
  ok("failed delivery stays pending with a retry time", pend && pend.attempts === 1 && pend.lastStatus === 500 && pend.nextRetryAt, pend);
  recvStatus = 200;
  r = await call("POST", `/api/admin/webhooks/deliveries/${pend?.id}`);
  ok("manual redeliver -> delivered", r.status === 200 && r.data.delivery.status === "delivered", r.data);
  r = await call("PATCH", `/api/admin/orders/${o2.data.orderNo}`, { body: { status: "cancelled" } });
  await call("POST", "/api/admin/jobs/run");
  ok("order.cancelled delivered", r.status === 200 && received.some((x) => x.headers["x-genzst-event"] === "order.cancelled" && x.body.includes(o2.data.orderNo)));

  /* ---------- inbound delivery webhooks: log, signature, replay ---------- */
  const body = JSON.stringify({ events: [{ id: `ev-${RUN}`, shipmentId: `nope-${RUN}`, status: "in_transit" }] });
  r = await call("POST", "/api/delivery/webhook/mock", { raw: body, auth: null, headers: { "Content-Type": "application/json", "X-Signature": "0".repeat(64) } });
  ok("inbound bad signature -> 401", r.status === 401);
  const good = createHmac("sha256", HOOK_SECRET).update(body).digest("hex");
  r = await call("POST", "/api/delivery/webhook/mock", { raw: body, auth: null, headers: { "Content-Type": "application/json", "X-Signature": good } });
  ok("inbound signed, unknown shipment -> 404", r.status === 404, r);
  r = await call("GET", "/api/admin/webhooks/inbound?limit=5");
  const logged = r.data.items ?? [];
  ok("inbound calls are logged (bad + good signature)", logged.some((x) => !x.signatureOk && x.httpStatus === 401) && logged.some((x) => x.signatureOk), logged.slice(0, 2));
  const signedRow = logged.find((x) => x.signatureOk);
  r = await call("POST", `/api/admin/webhooks/inbound/${signedRow?.id}/replay`);
  ok("replay a signed call", r.status === 200 && typeof r.data.httpStatus === "number", r.data);
  const unsignedRow = logged.find((x) => !x.signatureOk);
  r = await call("POST", `/api/admin/webhooks/inbound/${unsignedRow?.id}/replay`);
  ok("unsigned call cannot be replayed -> 409", r.status === 409);

  /* ---------- payments: QPay check ---------- */
  const q = await placeOrder([{ sku: `${P}-a:5`, qty: 1 }], { payment: "qpay" });
  const qpayRow = one(`SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.order_no = '${q.data?.orderNo}' AND p.provider = 'qpay'`);
  if (qpayRow) {
    r = await call("POST", `/api/admin/payments/${qpayRow.id}/check`);
    ok("QPay status check", r.status === 200 && typeof r.data.paymentStatus === "string", r.data);
  } else ok("QPay order created (mock QPay running?)", false, q.data);
  r = await call("POST", `/api/admin/payments/${qpayRow?.id ?? 1}/check`, { auth: STAFF });
  ok("QPay check: staff -> 403", r.status === 403);

  /* ---------- inventory search ---------- */
  r = await call("GET", `/api/admin/inventory?q=${P}&limit=10`);
  ok("inventory search", r.status === 200 && r.data.items.length >= 1 && r.data.items.every((s) => s.id.startsWith(P)), r.data);

  // restore settings changed above
  await call("PUT", "/api/admin/settings", { body: { "bank.name": before["bank.name"] ?? "", "contact.phone": before["contact.phone"] ?? "" } });
  await call("DELETE", `/api/admin/webhooks/endpoints/${ep.id}`);
} catch (err) {
  failed++;
  console.error("CRASH", err);
} finally {
  recv.close();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
