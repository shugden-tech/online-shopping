// End-to-end commerce test (lead, A6): one flow across every module on ONE running Worker.
//   A1 catalog (admin product + SKU + stock, public catalog-state, hide/lock switches)
//   A2 orders + payments (QPay via scripts/mock-qpay.mjs, bank, reservation, expiry via jobs/run)
//   A3 delivery (mock provider via scripts/mock-delivery.mjs, signed webhook)
//   lead (settings, audit, jobs/run, permissions) and the built pages (/, /admin/).
//
//   node scripts/mock-qpay.mjs & node scripts/mock-delivery.mjs &
//   npx wrangler dev --port 8788 --persist-to .wrangler/state-lead
//   BASE=http://localhost:8788 PERSIST=.wrangler/state-lead node scripts/test-e2e-commerce.mjs
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://localhost:8788").replace(/\/$/, "");
const QPAY = (process.env.MOCK_QPAY ?? "http://127.0.0.1:8892").replace(/\/$/, "");
const PERSIST = process.env.PERSIST ?? ".wrangler/state-lead";
const vars = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ADMIN = vars.ADMIN_TOKEN, STAFF = vars.STAFF_TOKEN;
const settingsFile = JSON.parse(readFileSync("src/data/settings.json", "utf8"));
const RUN = Date.now().toString(36);
const PID = `e2e-${RUN}`;
const SKU = `${PID}:5`;
const PHONE = "99" + String(Date.now()).slice(-6);

let pass = 0, failN = 0;
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { failN++; console.log("  FAIL", name, info === undefined ? "" : JSON.stringify(info).slice(0, 400)); }
};

let ipN = 0;
async function call(method, path, { body, auth, headers = {}, ip } = {}) {
  const h = { Origin: BASE, "CF-Connecting-IP": ip ?? `198.51.100.${(ipN++ % 200) + 1}`, ...headers };
  if (auth) h.Authorization = `Bearer ${auth}`;
  let raw;
  if (body !== undefined) { h["Content-Type"] = "application/json"; raw = typeof body === "string" ? body : JSON.stringify(body); }
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(BASE + path, { method, headers: h, body: raw });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers };
    } catch (e) { if (i >= 1) throw e; }
  }
}
const admin = (m, p, b) => call(m, p, { body: b, auth: ADMIN });
const staff = (m, p, b) => call(m, p, { body: b, auth: STAFF });
const sql = (q) => execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--command", q], { stdio: "pipe" });
const state = async () => (await call("GET", `/api/store/catalog-state?ids=${PID}`)).data;
const skuState = async () => (await state())?.products?.[0]?.skus?.find((s) => s.sku === SKU);
const orderBody = (items, payment, extra = {}) => ({
  name: "E2E Test", phone: PHONE, phone2: "", city: "ub", district: settingsFile.districts[0].id, khoroo: "1",
  address: "E2E street 1", note: `e2e ${RUN}`, payment, locale: "mn", items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
});
const placeOrder = (items, payment, key = randomUUID()) => call("POST", "/api/orders", { body: orderBody(items, payment), headers: { "Idempotency-Key": key } });
const setSettings = (patch) => admin("PUT", "/api/admin/settings", patch);

console.log(`E2E against ${BASE} (product ${PID})`);

/* 1. pages are served */
ok("storefront home 200", (await fetch(BASE + "/")).status === 200);
const adm = await fetch(BASE + "/admin/");
ok("admin page 200 + noindex", adm.status === 200 && /noindex/.test(await adm.text()));

/* 2. permissions */
ok("me: owner", (await admin("GET", "/api/admin/me")).data?.role === "owner");
ok("me: staff", (await staff("GET", "/api/admin/me")).data?.role === "staff");
ok("no token -> 401", (await call("GET", "/api/admin/orders")).status === 401);
ok("staff cannot change settings -> 403", (await staff("PUT", "/api/admin/settings", { "checkout.open": false })).status === 403);
ok("staff cannot create products -> 403", (await staff("POST", "/api/admin/products", { id: `${PID}-x`, brand: "B", name: "N" })).status === 403);
await setSettings({ "checkout.open": true, "payments.qpay.enabled": true, "payments.bank.enabled": true });

/* 3. catalog: owner creates a product, a SKU without price, then prices and stocks it */
let r = await admin("POST", "/api/admin/products", { id: PID, brand: "E2E Brand", name: "E2E Scent", status: "active", gender: "unisex" });
ok("create product 201", r.status === 201, r);
r = await admin("PUT", `/api/admin/products/${PID}/skus/5`, { kind: "decant", price: null });
ok("SKU without price", r.status === 200 || r.status === 201, r);
ok("no price -> not sellable", (await skuState())?.sellable === false);
r = await admin("PUT", `/api/admin/products/${PID}/skus/5`, { price: 15000 });
ok("set price", r.data?.ok === true, r);
r = await admin("POST", "/api/admin/inventory/adjust", { sku: SKU, set: 3, reason: "restock", note: "e2e" });
ok("set stock 3", r.data?.ok === true && r.data?.sku?.stock === 3, r);
let s = await skuState();
ok("catalog-state: sellable, 15000, available 3", s?.sellable === true && s?.price === 15000 && s?.available === 3, s);

/* 4. the four hide/lock controls */
await admin("PATCH", `/api/admin/products/${PID}`, { status: "hidden" });
let st = await state();
ok("hidden product -> visible false, not sellable", st?.products?.[0]?.visible === false && st.products[0].skus[0].sellable === false, st);
r = await placeOrder([{ sku: SKU, qty: 1 }], "bank");
ok("order on hidden product -> 409 unavailable", r.status === 409 && r.data?.errors?.form === "unavailable", r);
await admin("PATCH", `/api/admin/products/${PID}`, { status: "active", saleLocked: true });
ok("sale-locked -> not sellable", (await skuState())?.sellable === false);
await admin("PATCH", `/api/admin/products/${PID}`, { saleLocked: false });
await setSettings({ "checkout.open": false });
ok("checkout closed -> state + 423", (await state())?.checkoutOpen === false && (await placeOrder([{ sku: SKU, qty: 1 }], "bank")).status === 423);
await setSettings({ "checkout.open": true, "payments.bank.enabled": false });
r = await placeOrder([{ sku: SKU, qty: 1 }], "bank");
ok("bank disabled -> 422", r.status === 422 && r.data?.errors?.payment === "disabled", r);
await setSettings({ "payments.bank.enabled": true });
ok("all switches back: sellable", (await skuState())?.sellable === true);

/* 5. QPay order reserves stock; oversell is refused */
const key = randomUUID();
r = await placeOrder([{ sku: SKU, qty: 2 }], "qpay", key);
const orderNo = r.data?.orderNo;
ok("qpay order 201 with invoice", r.status === 201 && r.data?.payment?.method === "qpay" && !!r.data?.payment?.invoiceId, r);
ok("total = 2 x 15000 + delivery", r.data?.subtotal === 30000 && r.data?.total === 30000 + r.data?.delivery, r.data);
const again = await placeOrder([{ sku: SKU, qty: 2 }], "qpay", key);
ok("same Idempotency-Key -> same order", again.status === 200 && again.data?.orderNo === orderNo, again);
s = await skuState();
ok("reserved: available 1", s?.available === 1, s);
r = await placeOrder([{ sku: SKU, qty: 2 }], "bank");
ok("oversell -> 409 stock", r.status === 409 && r.data?.errors?.form === "stock", r);

/* 6. customer pays in QPay -> callback -> order paid, stock committed */
const pay = await fetch(QPAY + "/_control/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice_id: again.data?.payment?.invoiceId }) });
ok("mock QPay marks invoice paid", pay.ok, pay.status);
const sig = createHmac("sha256", vars.QPAY_CALLBACK_SECRET).update(orderNo).digest("hex");
const cb = await fetch(`${BASE}/api/payments/qpay/callback?order=${orderNo}&sig=${sig}`);
ok("QPay callback 200", cb.status === 200, cb.status);
let od = (await admin("GET", `/api/admin/orders/${orderNo}`)).data?.order;
ok("order paid + payment row paid + reservation committed", od?.status === "paid" && od?.paymentStatus === "paid" && od?.payments?.[0]?.status === "paid" && od?.reservations?.[0]?.status === "committed", od);
const inv = (await admin("GET", `/api/admin/inventory?low=100`)).data?.items?.find((i) => i.id === SKU);
ok("stock 3 -> 1, reserved 0", inv?.stock === 1 && inv?.reserved === 0, inv);
const mv = (await admin("GET", `/api/admin/inventory/${encodeURIComponent(SKU)}/movements`)).data?.items ?? [];
ok("movements: restock +3, sale -2", mv.some((m) => m.reason === "sale" && m.delta === -2) && mv.some((m) => m.reason === "restock" && m.delta === 3), mv);
ok("staff cannot mark-paid -> 403", (await staff("POST", `/api/admin/orders/${orderNo}/mark-paid`, { amount: 1, reference: "x" })).status === 403);

/* 7. delivery: create shipment with the mock company, webhook delivers -> order done */
r = await admin("POST", "/api/admin/shipments", { orderNo, provider: "mock" });
const sh = r.data?.shipment ?? r.data;
ok("shipment created with tracking", r.status === 201 && sh?.status === "created" && !!sh?.trackingNo, r);
od = (await admin("GET", `/api/admin/orders/${orderNo}`)).data?.order;
ok("order -> shipped", od?.status === "shipped", od?.status);
const body = JSON.stringify({ events: [{ id: `e2e-${RUN}-1`, shipmentId: sh?.providerRef, status: "delivered" }] });
const hook = await fetch(`${BASE}/api/delivery/webhook/mock`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Signature": createHmac("sha256", vars.DELIVERY_WEBHOOK_SECRET).update(body).digest("hex") }, body,
});
ok("delivery webhook 200", hook.status === 200, hook.status);
od = (await admin("GET", `/api/admin/orders/${orderNo}`)).data?.order;
ok("order -> done", od?.status === "done", od?.status);
const look = await call("POST", "/api/orders/lookup", { body: { orderNo, phone: PHONE } });
ok("customer lookup: done, paid, tracking", look.data?.status === "done" && look.data?.paymentStatus === "paid" && !!look.data?.shipment?.trackingNo, look.data);
ok("lookup with wrong phone refused", (await call("POST", "/api/orders/lookup", { body: { orderNo, phone: "88000000" } })).data?.ok !== true);

/* 8. unpaid bank order expires through jobs/run and gives its stock back */
r = await placeOrder([{ sku: SKU, qty: 1 }], "bank");
const bankNo = r.data?.orderNo;
ok("bank order 201 with bank instructions", r.status === 201 && r.data?.payment?.method === "bank", r);
ok("last unit reserved: not sellable", (await skuState())?.available === 0 && (await skuState())?.sellable === false);
sql(`UPDATE orders SET hold_expires_at = datetime('now','-1 minute') WHERE order_no = '${bankNo}'`);
r = await admin("POST", "/api/admin/jobs/run");
ok("jobs/run expires it", r.data?.ok === true && r.data?.expired >= 1, r);
od = (await admin("GET", `/api/admin/orders/${bankNo}`)).data?.order;
ok("expired order cancelled, reservation released", od?.status === "cancelled" && od?.cancelReason === "expired" && od?.reservations?.[0]?.status === "released", od);
ok("unit is for sale again", (await skuState())?.available === 1);

/* 9. audit trail */
const audit = (await admin("GET", `/api/admin/audit?limit=200`)).data?.items ?? [];
const acts = new Set(audit.map((a) => a.action));
ok("audit has product, sku, inventory, settings, jobs", ["settings.update", "inventory.adjust", "jobs.run"].every((a) => acts.has(a)) && [...acts].some((a) => a.startsWith("product.")) && [...acts].some((a) => a.startsWith("sku.")), [...acts]);
ok("audit holds no customer phone", !JSON.stringify(audit).includes(PHONE));

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
