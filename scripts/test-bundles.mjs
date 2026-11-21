// Bundle tests (0005) against a running LOCAL server (wrangler dev + local D1 with migrations up to 0005).
// Admin CRUD + validation + permissions + audit, media upload, public state + pages, orders with bundles
// (server pricing, stock reservation across parts, sold out, mixed with SKU lines, release on cancel, commit on
// paid), webhook payload, customer lookup and admin order detail. Never run against production.
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-bundles
//   npx astro build && npx wrangler dev --port 8796 --persist-to .wrangler/state-bundles
//   BASE=http://localhost:8796 D1_PERSIST=.wrangler/state-bundles node scripts/test-bundles.mjs
// .dev.vars (or env): ADMIN_TOKEN, STAFF_TOKEN, the always-pass TURNSTILE_SECRET, WEBHOOK_ALLOW_LOCAL=1.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8796").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error("test-bundles runs against a LOCAL server only"); process.exit(2); }
const PERSIST = process.env.D1_PERSIST ?? ".wrangler/state-bundles";
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const ADMIN = envVar("ADMIN_TOKEN"), STAFF = envVar("STAFF_TOKEN");
const fileSettings = JSON.parse(readFileSync(join(root, "src/data/settings.json"), "utf8"));
const RUN = Math.random().toString(36).slice(2, 7);

let pass = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== "" ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
};
function sql(command) {
  const out = execFileSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // wrangler --json prints SQL NULL as the string "null"
  return JSON.parse(out.slice(out.indexOf("[")), (_k, v) => (v === "null" ? null : v)).map((s) => s.results ?? []);
}
const one = (c) => sql(c)[0]?.[0] ?? null;
let ipn = 0;
async function call(method, path, { body, headers = {}, auth = ADMIN, form } = {}) {
  const init = { method, headers: { "CF-Connecting-IP": `b-${RUN}-${++ipn}`, Origin: BASE, ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(BASE + path, init);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    } catch (e) { if (i >= 2) throw e; } // a kept-alive socket can be reset after a `wrangler d1 execute`
  }
}
const orderBody = (items, extra = {}) => ({
  name: "Bundle Test", phone: "99112233", phone2: "", city: "ub", district: fileSettings.districts[0].id, khoroo: "1",
  address: "Test street 5", note: `bundles ${RUN}`, payment: "bank", locale: "mn", items, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", website: "", ...extra,
});
const placeOrder = (items, extra) => call("POST", "/api/orders", { body: orderBody(items, extra), auth: null, headers: { "Idempotency-Key": crypto.randomUUID() } });
const sku = (id) => one(`SELECT stock, reserved FROM skus WHERE id = '${id}'`);

// outbound webhook receiver (order.created payload)
const received = [];
const recv = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(b); res.writeHead(200).end("ok"); }); });
await new Promise((r) => recv.listen(0, "127.0.0.1", r));

const P = `tb-${RUN}`;
const A = `${P}-a:10`, B = `${P}-b:10`, C = `${P}-c:10`;
const ID = `${P}-set`;
let endpointId = null;
try {
  /* ---------- fixtures: three products, 10 ml each; A stock 5, B stock 3, C untracked ---------- */
  for (const [x, price] of [["a", 50000], ["b", 40000], ["c", 30000]]) {
    let r = await call("POST", "/api/admin/products", { body: { id: `${P}-${x}`, brand: "Bundle House", name: `Part ${x.toUpperCase()} ${RUN}`, concentration: "EDT", notes: { top: ["bergamot"], heart: ["lavender"], base: ["musk"] }, status: "active" } });
    if (r.status !== 201) throw new Error(`fixture product ${x}: ${r.status} ${JSON.stringify(r.data)}`);
    r = await call("PUT", `/api/admin/products/${P}-${x}/skus/10`, { body: { kind: "decant", price, compareAt: null, active: true } });
    if (r.status >= 300) throw new Error(`fixture sku ${x}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  await call("POST", "/api/admin/inventory/adjust", { body: { sku: A, set: 5, reason: "restock" } });
  await call("POST", "/api/admin/inventory/adjust", { body: { sku: B, set: 3, reason: "restock" } });
  ok("fixtures: A stock 5, B stock 3, C untracked", sku(A)?.stock === 5 && sku(B)?.stock === 3 && sku(C)?.stock === null, [sku(A), sku(B), sku(C)]);

  /* ---------- admin: create + validation + permissions ---------- */
  const create = { id: ID, nameMn: `Туршилтын багц ${RUN}`, nameEn: `Test bundle ${RUN}`, descriptionMn: "Гурван үнэр", descriptionEn: "Three scents", image: "/bundles/1.webp", price: 99000, compareAt: 130000, status: "active", sort: 99, items: [{ sku: A, qty: 1 }, { sku: B, qty: 1 }, { sku: C, qty: 1, label: "C label" }] };
  let r = await call("POST", "/api/admin/bundles", { body: create });
  ok("create bundle -> 201", r.status === 201 && r.data.bundle?.id === ID && r.data.bundle.parts.length === 3, r.data);
  const b = r.data.bundle ?? {};
  ok("create: sellable, available = min(5, 3) = 3, separate total 120,000", b.sellable === true && b.available === 3 && b.separateTotal === 120000 && b.block === null, b);
  r = await call("POST", "/api/admin/bundles", { body: create });
  ok("duplicate id -> 409 taken", r.status === 409 && r.data.errors?.id === "taken");
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x`, compareAt: 90000 } });
  ok("compareAt <= price -> 400", r.status === 400 && r.data.errors?.compareAt === "compare", r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x`, items: [] } });
  ok("no parts -> 400", r.status === 400 && r.data.errors?.items, r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x`, items: [{ sku: "Not A Sku" }] } });
  ok("bad part sku -> 400", r.status === 400 && r.data.errors?.items, r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x`, items: [{ sku: A }, { sku: A }] } });
  ok("duplicate part -> 400", r.status === 400 && r.data.errors?.items === "duplicate", r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x`, image: "https://evil.example/x.jpg" } });
  ok("foreign image host -> 400", r.status === 400 && r.data.errors?.image === "host", r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: "Bad Id" } });
  ok("bad id -> 400", r.status === 400 && r.data.errors?.id, r.data);
  r = await call("POST", "/api/admin/bundles", { body: { ...create, id: `${P}-x` }, auth: STAFF });
  ok("staff create -> 403 (catalog.write)", r.status === 403, r.status);
  r = await call("GET", "/api/admin/bundles", { auth: STAFF });
  ok("staff list -> 200 (catalog.read)", r.status === 200 && r.data.items.some((x) => x.id === ID), r.status);
  r = await call("GET", "/api/admin/bundles", { auth: null });
  ok("no token -> 401", r.status === 401);
  r = await call("GET", "/api/admin/bundles");
  ok("seeded bundles present (8 owner bundles)", ["day-to-evening", "fresh-citrus", "sweet-tobacco-night"].every((id) => r.data.items.some((x) => x.id === id)), r.data.items?.map((x) => x.id));

  /* ---------- admin: edit ---------- */
  r = await call("PATCH", `/api/admin/bundles/${ID}`, { body: { nameEn: `Test bundle ${RUN} v2`, sort: 98 } });
  ok("patch name + sort", r.status === 200 && r.data.bundle.nameEn === `Test bundle ${RUN} v2` && r.data.bundle.sort === 98, r.data);
  r = await call("PATCH", `/api/admin/bundles/${ID}`, { body: { price: 140000 } });
  ok("patch price above compareAt -> 400", r.status === 400 && r.data.errors?.compareAt === "compare", r.data);
  r = await call("PATCH", `/api/admin/bundles/${ID}`, { body: { items: [{ sku: B }, { sku: A }, { sku: C, label: "C label" }] } });
  ok("patch parts (reorder)", r.status === 200 && r.data.bundle.parts.map((p) => p.sku).join() === [B, A, C].join(), r.data.bundle?.parts?.map((p) => p.sku));
  r = await call("PATCH", `/api/admin/bundles/${ID}`, { body: {} });
  ok("empty patch -> 400", r.status === 400);
  r = await call("PATCH", `/api/admin/bundles/${ID}`, { body: { price: 1 }, auth: STAFF });
  ok("staff patch -> 403", r.status === 403);
  r = await call("PATCH", `/api/admin/bundles/${P}-missing`, { body: { price: 1000 } });
  ok("patch unknown -> 404", r.status === 404);
  const audits = sql(`SELECT action FROM audit_log WHERE entity = 'bundle' AND entity_id = '${ID}' ORDER BY id`)[0].map((x) => x.action);
  ok("audit: bundle.create + bundle.update rows", audits[0] === "bundle.create" && audits.filter((a) => a === "bundle.update").length === 2, audits);

  /* ---------- media upload for a bundle ---------- */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "front.png");
  fd.append("bundleId", ID);
  fd.append("side", "front");
  r = await call("POST", "/api/admin/media", { form: fd });
  ok("media upload with bundleId -> bundles/{id}/front-…", r.status === 200 && String(r.data.key).startsWith(`bundles/${ID}/front-`), r.data);
  if (r.status === 200) {
    const p = await call("PATCH", `/api/admin/bundles/${ID}`, { body: { image: r.data.url } });
    ok("patch image to the uploaded URL", p.status === 200 && p.data.bundle.image === r.data.url, p.data);
  }
  const fd2 = new FormData();
  fd2.append("file", new Blob([png], { type: "image/png" }), "front.png");
  fd2.append("bundleId", `${P}-missing`);
  fd2.append("side", "front");
  r = await call("POST", "/api/admin/media", { form: fd2 });
  ok("media upload: unknown bundle -> 404", r.status === 404, r.data);

  /* ---------- public state + pages ---------- */
  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null });
  ok("store state: sellable, price 99,000, compareAt 130,000, available 3", r.status === 200 && r.data.bundles[0]?.sellable === true && r.data.bundles[0].price === 99000 && r.data.bundles[0].compareAt === 130000 && r.data.bundles[0].available === 3, r.data);
  ok("store state: cacheable 30 s", /max-age=30/.test(r.headers.get("cache-control") ?? ""));
  let page = await fetch(`${BASE}/bundles/${ID}/`);
  let html = await page.text();
  ok("mn bundle page 200 with name, price, parts, buttons", page.status === 200 && html.includes(create.nameMn) && /99[ ,. ]?000/.test(html) && html.includes(`Part A ${RUN}`) && html.includes("Шууд захиалах") && html.includes("Сагсанд нэмэх"), page.status);
  ok("bundle page: savings vs separate (120,000 → 21,000)", /21[ ,. ]?000/.test(html));
  ok("bundle page: links to part product pages (on-demand /delguur/p/)", html.includes(`/delguur/p/${P}-a/`));
  ok("bundle page: JSON-LD Product offer + short cache", html.includes('"@type":"Product"') && /max-age=60/.test(page.headers.get("cache-control") ?? ""));
  page = await fetch(`${BASE}/en/bundles/${ID}/`);
  html = await page.text();
  ok("en bundle page 200 with English name + Buy now", page.status === 200 && html.includes(`Test bundle ${RUN} v2`) && html.includes("Buy now"), page.status);
  page = await fetch(`${BASE}/bundles/`);
  html = await page.text();
  ok("bundle list links to the bundle page", page.status === 200 && html.includes(`/bundles/${ID}/`) && html.includes("/bundles/fresh-citrus/"));

  /* ---------- orders ---------- */
  r = await placeOrder([{ bundle: ID, qty: 2, price: 1 }]);
  const o1 = r.data?.orderNo;
  ok("order 2 bundles -> 201, priced from D1 (client price ignored)", r.status === 201 && r.data.subtotal === 198000, r.data);
  ok("reserved: A 2, B 2, C untracked", sku(A).reserved === 2 && sku(B).reserved === 2 && sku(C).reserved === 0, [sku(A), sku(B), sku(C)]);
  const res1 = sql(`SELECT sku_id, qty, tracked, status FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = '${o1}') ORDER BY sku_id`)[0];
  ok("reservations: one row per part SKU, qty 2, tracked A/B", res1.length === 3 && res1.every((x) => x.qty === 2 && x.status === "held") && res1.filter((x) => x.tracked === 1).length === 2, res1);
  const items = JSON.parse(one(`SELECT items_json FROM orders WHERE order_no = '${o1}'`).items_json);
  ok("order line: sku bundle:<id>, price 99,000, parts listed", items.length === 1 && items[0].sku === `bundle:${ID}` && items[0].price === 99000 && items[0].bundle?.parts?.length === 3 && items[0].ml === 30, items);
  const auditOrder = one(`SELECT data_json FROM audit_log WHERE action = 'order.create' AND entity_id = '${o1}'`);
  ok("audit order.create names the bundle and its parts", /"bundle":"tb-/.test(auditOrder?.data_json ?? "") && auditOrder.data_json.includes(A), auditOrder);

  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null, headers: { "Cache-Control": "no-cache" } });
  ok("after order: available 1", r.data.bundles[0]?.available === 1, r.data);
  r = await placeOrder([{ bundle: ID, qty: 2 }]);
  ok("2 more bundles (B has 1 left) -> 409 stock on the bundle line", r.status === 409 && r.data.errors?.form === "stock" && r.data.errors.sku === `bundle:${ID}`, r.data);
  r = await placeOrder([{ bundle: ID, qty: 1 }, { sku: B, qty: 1 }]);
  ok("bundle + same SKU alone (needs B 2, 1 left) -> 409 stock", r.status === 409 && r.data.errors?.form === "stock", r.data);

  // outbound webhook endpoint to see the order.created payload
  r = await call("POST", "/api/admin/webhooks/endpoints", { body: { url: `http://127.0.0.1:${recv.address().port}/hook`, events: ["order.created"], description: `bundles ${RUN}` } });
  endpointId = r.data?.endpoint?.id ?? null;
  r = await placeOrder([{ bundle: ID, qty: 1 }, { sku: A, qty: 1 }]);
  const o2 = r.data?.orderNo;
  ok("bundle + standalone SKU line -> 201, subtotal 99,000 + 50,000", r.status === 201 && r.data.subtotal === 149000, r.data);
  ok("reserved now: A 2+1+1 = 4, B 3 (sold out)", sku(A).reserved === 4 && sku(B).reserved === 3, [sku(A), sku(B)]);
  const res2 = sql(`SELECT sku_id, qty FROM reservations WHERE order_id = (SELECT id FROM orders WHERE order_no = '${o2}') ORDER BY sku_id`)[0];
  ok("one reservation per SKU (A merged: bundle part + line = 2)", res2.length === 3 && res2.find((x) => x.sku_id === A)?.qty === 2, res2);
  if (endpointId) {
    const payload = one(`SELECT payload_json FROM webhook_deliveries WHERE endpoint_id = ${endpointId} ORDER BY id DESC LIMIT 1`)?.payload_json ?? "";
    ok("webhook order.created payload includes the bundle + parts", payload.includes(`"bundle":"${ID}"`) && payload.includes(B), payload.slice(0, 300));
  } else ok("webhook endpoint created (WEBHOOK_ALLOW_LOCAL=1?)", false);

  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null, headers: { "Cache-Control": "no-cache" } });
  ok("sold out: block out, not sellable", r.data.bundles[0]?.block === "out" && r.data.bundles[0].sellable === false, r.data);
  html = await (await fetch(`${BASE}/bundles/${ID}/`)).text();
  ok("bundle page shows sold out", html.includes("Түр дууссан") && html.includes('data-state="out"'));
  r = await placeOrder([{ bundle: ID, qty: 1 }]);
  ok("order when sold out -> 409 stock", r.status === 409 && r.data.errors?.form === "stock", r.data);

  // admin order detail + customer lookup show the bundle
  r = await call("GET", `/api/admin/orders/${o2}`);
  const line = r.data?.order?.items?.find((i) => i.bundle);
  ok("admin order detail: bundle line with parts", r.status === 200 && line?.bundle?.id === ID && line.bundle.parts.length === 3, r.data?.order?.items);
  r = await call("POST", "/api/orders/lookup", { body: { orderNo: o2, phone: "112233" }, auth: null });
  ok("customer lookup: bundle line with parts (no PII)", r.status === 200 && r.data.items?.some((i) => i.bundle?.parts?.length === 3) && !JSON.stringify(r.data).includes("Test street"), r.data);

  // cancel releases every part; paid commits every part
  r = await call("PATCH", `/api/admin/orders/${o1}`, { body: { status: "cancelled" } });
  ok("cancel order 1 -> released A 2, B 2", r.status === 200 && sku(A).reserved === 2 && sku(B).reserved === 1, [r.status, sku(A), sku(B)]);
  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null, headers: { "Cache-Control": "no-cache" } });
  ok("after cancel: sellable again, available 2", r.data.bundles[0]?.sellable === true && r.data.bundles[0].available === 2, r.data);
  const due = one(`SELECT total FROM orders WHERE order_no = '${o2}'`).total;
  r = await call("POST", `/api/admin/orders/${o2}/mark-paid`, { body: { amount: due, reference: `TX-${RUN}` } });
  ok("mark order 2 paid -> stock committed (A 5-2=3, B 3-1=2)", r.status === 200 && sku(A).stock === 3 && sku(A).reserved === 0 && sku(B).stock === 2 && sku(B).reserved === 0, [r.status, r.data?.result, sku(A), sku(B)]);
  const moves = sql(`SELECT sku_id, delta FROM stock_movements WHERE reason = 'sale' AND order_id = (SELECT id FROM orders WHERE order_no = '${o2}') ORDER BY sku_id`)[0];
  ok("sale movements for tracked parts only (A −2, B −1)", moves.length === 2 && moves.find((m) => m.sku_id === A)?.delta === -2 && moves.find((m) => m.sku_id === B)?.delta === -1, moves);

  /* ---------- unavailable parts / hidden bundle ---------- */
  await call("PATCH", `/api/admin/products/${P}-c`, { body: { saleLocked: true } });
  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null, headers: { "Cache-Control": "no-cache" } });
  ok("part sale-locked -> block off", r.data.bundles[0]?.block === "off", r.data);
  r = await placeOrder([{ bundle: ID, qty: 1 }]);
  ok("order with a locked part -> 409 unavailable on the bundle line", r.status === 409 && r.data.errors?.form === "unavailable" && r.data.errors.sku === `bundle:${ID}`, r.data);
  await call("PATCH", `/api/admin/products/${P}-c`, { body: { saleLocked: false } });
  await call("PATCH", `/api/admin/bundles/${ID}`, { body: { status: "hidden" } });
  r = await placeOrder([{ bundle: ID, qty: 1 }]);
  ok("hidden bundle -> 409 unavailable", r.status === 409 && r.data.errors?.form === "unavailable", r.data);
  page = await fetch(`${BASE}/bundles/${ID}/`);
  ok("hidden bundle page -> 404", page.status === 404);
  await call("PATCH", `/api/admin/bundles/${ID}`, { body: { status: "active", price: null, compareAt: null } });
  r = await call("GET", `/api/store/bundles?ids=${ID}`, { auth: null, headers: { "Cache-Control": "no-cache" } });
  ok("no price -> block soon", r.data.bundles[0]?.block === "soon" && r.data.bundles[0].price === null, r.data);

  /* ---------- schema ---------- */
  r = await placeOrder([{ bundle: "Bad Id", qty: 1 }]);
  ok("bad bundle id -> 422 items", r.status === 422 && r.data.errors?.form === "items", r.data);
  r = await placeOrder([{ bundle: ID, sku: A, qty: 1 }]);
  ok("bundle + sku in one item -> 422 items", r.status === 422, r.data);
  r = await placeOrder([{ bundle: `${P}-nope`, qty: 1 }]);
  ok("unknown bundle -> 409 unavailable", r.status === 409 && r.data.errors?.form === "unavailable", r.data);
  r = await placeOrder([{ bundle: ID, qty: 11 }]);
  ok("qty > 10 -> 422", r.status === 422, r.status);
  r = await placeOrder([{ sku: C, qty: 1 }]);
  ok("plain SKU orders still work", r.status === 201 && r.data.subtotal === 30000, r.data);
  r = await placeOrder([{ slug: `${P}-c`, ml: 10, qty: 1 }]);
  ok("legacy { slug, ml } items still work", r.status === 201, r.data);

  /* ---------- delete ---------- */
  r = await call("DELETE", `/api/admin/bundles/${ID}`, { auth: STAFF });
  ok("staff delete -> 403", r.status === 403);
  r = await call("DELETE", `/api/admin/bundles/${ID}`);
  ok("delete -> 200", r.status === 200, r.data);
  r = await call("GET", `/api/admin/bundles/${ID}`);
  ok("deleted bundle -> 404; past order keeps its copy", r.status === 404 && JSON.parse(one(`SELECT items_json FROM orders WHERE order_no = '${o2}'`).items_json).some((i) => i.bundle?.id === ID));
  ok("audit: bundle.delete", !!one(`SELECT id FROM audit_log WHERE entity = 'bundle' AND entity_id = '${ID}' AND action = 'bundle.delete'`));
} catch (err) {
  failed++;
  console.error("CRASH", err);
} finally {
  if (endpointId) await call("DELETE", `/api/admin/webhooks/endpoints/${endpointId}`).catch(() => {});
  recv.close();
}
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
