#!/usr/bin/env node
// A1 catalog tests against a running `wrangler dev` (default http://localhost:8791).
//
//   npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-a1
//   npx astro build && npx wrangler dev --port 8791 --persist-to .wrangler/state-a1
//   node scripts/test-catalog.mjs            # BASE=… PERSIST=… SKIP_IMPORT=1 to override
//
// Tokens come from ADMIN_TOKEN / STAFF_TOKEN in the environment or .dev.vars. DB state that A1's API cannot
// create (an order + reservation) is written with `wrangler d1 execute --local --persist-to $PERSIST`.
// Prints "N passed, M failed" and exits 1 on any failure.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8791").replace(/\/$/, "");
const PERSIST = process.env.PERSIST ?? ".wrangler/state-a1";

function devVars() {
  const f = join(ROOT, ".dev.vars");
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}
const vars = devVars();
const ADMIN = process.env.ADMIN_TOKEN ?? vars.ADMIN_TOKEN;
const STAFF = process.env.STAFF_TOKEN ?? vars.STAFF_TOKEN;
if (!ADMIN || !STAFF) {
  console.error("ADMIN_TOKEN and STAFF_TOKEN are required (.dev.vars)");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

async function api(method, path, { token, body, headers = {}, form } = {}) {
  // Astro's checkOrigin refuses form-like / bodyless writes without a same-origin Origin; a browser sends it.
  const h = { Origin: BASE, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    h["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
const admin = (m, p, o = {}) => api(m, p, { ...o, token: ADMIN });
const staff = (m, p, o = {}) => api(m, p, { ...o, token: STAFF });

function sql(command) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "genzst", "--local", "--persist-to", PERSIST, "--json", "--command", command],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler may print notices (e.g. about proxy variables) before the JSON
  const start = out.search(/^\s*\[/m);
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  return parsed[0]?.results ?? [];
}

const state = async (ids) => api("GET", `/api/store/catalog-state?ids=${ids.map(encodeURIComponent).join(",")}`);
const skuState = async (pid, ml) => (await state([pid])).data?.products?.[0]?.skus?.find((s) => s.ml === ml);

// tiny valid images
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const mediaForm = (bytes, productId, side, type = "image/jpeg", name = "x.jpg") => {
  const f = new FormData();
  f.append("file", new Blob([bytes], { type }), name);
  f.append("productId", productId);
  f.append("side", side);
  return f;
};

const RUN = Date.now().toString(36);
const PID = `zz-a1-test-${RUN}`;
const MEDIA_BASE = "https://pub-83d529150bc84a489ddcb74b42624830.r2.dev";

async function main() {
  console.log(`A1 catalog tests against ${BASE} (persist ${PERSIST})`);

  /* ---------- importer on the DB ---------- */
  const contentIds = readdirSync(join(ROOT, "src/content/products")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  if (!process.env.SKIP_IMPORT) {
    console.log("importer");
    const run = () =>
      execFileSync("node", ["scripts/import-catalog.mjs", "--quiet", "--apply", "local", "--persist-to", PERSIST], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    run();
    const n1 = sql("SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM skus) AS s, (SELECT COUNT(*) FROM skus WHERE price IS NOT NULL OR stock IS NOT NULL) AS priced")[0];
    run(); // idempotent
    const n2 = sql("SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM skus) AS s")[0];
    check("import: applying twice changes nothing", n1.p === n2.p && n1.s === n2.s, { n1, n2 });
    const list = await admin("GET", "/api/admin/products?limit=1");
    check("import: total products >= 1000 via API", list.status === 200 && list.data.total >= 1000, list.data?.total);
    const drafts = await admin("GET", "/api/admin/products?status=draft&limit=1");
    check("import: catalog-only products are draft", drafts.data?.total >= 900, drafts.data?.total);
    let active = 0;
    let visible = 0;
    for (let i = 0; i < contentIds.length; i += 60) {
      const r = await state(contentIds.slice(i, i + 60));
      visible += (r.data?.products ?? []).filter((p) => p.visible).length;
    }
    const act = await admin("GET", "/api/admin/products?status=active&limit=1");
    active = act.data?.total;
    check(`import: all ${contentIds.length} content products are active (catalog-state visible)`, visible === contentIds.length, { visible });
    check("import: active count >= content count", active >= contentIds.length, active);
    const sample = await admin("GET", "/api/admin/products/mugler-alien-edp");
    check(
      "import: catalog product has brand/notes/images from R2 catalog, source r2-catalog",
      sample.status === 200 && sample.data.product.brand === "Mugler" && sample.data.product.notes.top.length > 0 && sample.data.product.imageFront?.startsWith(MEDIA_BASE) && sample.data.product.source === "r2-catalog",
      sample.data?.product,
    );
    const priced = sql("SELECT COUNT(*) AS n FROM skus WHERE (price IS NOT NULL OR stock IS NOT NULL) AND id NOT LIKE 'zz-%'")[0].n;
    check("import: no SKU has a price or stock (fresh DB)", priced === 0, { priced });
    const skuCount = sql("SELECT COUNT(*) AS n FROM skus WHERE id NOT LIKE 'zz-%'")[0].n;
    check("import: SKUs created from content sizes + catalog bottle sizes", skuCount >= 400, skuCount);
    const refused = (() => {
      try {
        execFileSync("node", ["scripts/import-catalog.mjs", "--quiet", "--demo-prices", "--apply", "remote"], { cwd: ROOT, stdio: "pipe" });
        return false;
      } catch (e) {
        return e.status === 2;
      }
    })();
    check("import: --demo-prices with --remote is refused", refused);
  }

  /* ---------- auth ---------- */
  console.log("auth");
  check("401 without token", (await api("GET", "/api/admin/products")).status === 401);
  check("401 with a wrong token", (await api("GET", "/api/admin/products", { token: "x".repeat(30) })).status === 401);
  check("200 staff on catalog.read (products)", (await staff("GET", "/api/admin/products?limit=2")).status === 200);
  check("200 staff on catalog.read (inventory)", (await staff("GET", "/api/admin/inventory?limit=2")).status === 200);
  check("403 staff on catalog.write (create)", (await staff("POST", "/api/admin/products", { body: { id: PID, brand: "X", name: "Y" } })).status === 403);
  check("403 staff on media.write", (await staff("POST", "/api/admin/media", { form: mediaForm(JPEG, PID, "front") })).status === 403);

  /* ---------- products ---------- */
  console.log("products");
  const created = await admin("POST", "/api/admin/products", {
    body: { id: PID, brand: "Test House", name: "A1 Probe", concentration: "EDP", gender: "unisex", notes: { top: ["Bergamot"], heart: [], base: ["Musk"] } },
  });
  check("create -> 201 draft admin product", created.status === 201 && created.data.product.status === "draft" && created.data.product.source === "admin", created);
  check("create duplicate -> 409", (await admin("POST", "/api/admin/products", { body: { id: PID, brand: "a", name: "b" } })).status === 409);
  check("create bad id -> 400", (await admin("POST", "/api/admin/products", { body: { id: "Bad Id", brand: "a", name: "b" } })).status === 400);
  check("create unknown field -> 400", (await admin("POST", "/api/admin/products", { body: { id: PID + "-x", brand: "a", name: "b", price: 5 } })).status === 400);
  const got = await admin("GET", `/api/admin/products/${PID}`);
  check("get -> product with empty skus", got.status === 200 && got.data.product.id === PID && Array.isArray(got.data.product.skus) && got.data.product.notes.base[0] === "Musk", got.data);
  check("get unknown -> 404", (await admin("GET", "/api/admin/products/zz-no-such-product")).status === 404);
  const search = await admin("GET", `/api/admin/products?q=${encodeURIComponent("A1 Probe")}`);
  check("list q= finds by name", search.status === 200 && search.data.items.some((p) => p.id === PID) && search.data.page === 1, search.data?.total);
  const byBrand = await admin("GET", `/api/admin/products?brand=${encodeURIComponent("test house")}&status=draft`);
  check("list brand= (case-insensitive) + status=", byBrand.data?.items?.some((p) => p.id === PID), byBrand.data?.total);
  check("list bad status -> 400", (await admin("GET", "/api/admin/products?status=nope")).status === 400);

  const front = `${MEDIA_BASE}/products/${PID}/front-abc.jpg`;
  const patched = await admin("PATCH", `/api/admin/products/${PID}`, { body: { status: "active", saleLocked: false, imageFront: front, imageBack: "/product-photos/x.webp", descriptionEn: "Probe" } });
  check(
    "patch status/images/description",
    patched.status === 200 && patched.data.product.status === "active" && patched.data.product.imageFront === front && patched.data.product.imageBack === "/product-photos/x.webp",
    patched.data,
  );
  const badHost = await admin("PATCH", `/api/admin/products/${PID}`, { body: { imageFront: "https://evil.example.com/a.jpg" } });
  check("patch image on another host -> 400 { imageFront: host }", badHost.status === 400 && badHost.data.errors.imageFront === "host", badHost.data);
  check("patch http (not https) media URL -> 400", (await admin("PATCH", `/api/admin/products/${PID}`, { body: { imageFront: front.replace("https:", "http:") } })).status === 400);
  check("patch protocol-relative //host -> 400", (await admin("PATCH", `/api/admin/products/${PID}`, { body: { imageBack: "//evil.example.com/a.jpg" } })).status === 400);
  check("patch empty body -> 400", (await admin("PATCH", `/api/admin/products/${PID}`, { body: {} })).status === 400);
  check("patch unknown product -> 404", (await admin("PATCH", "/api/admin/products/zz-no-such-product", { body: { name: "x" } })).status === 404);
  check("patch staff -> 403", (await staff("PATCH", `/api/admin/products/${PID}`, { body: { name: "x" } })).status === 403);

  /* ---------- SKUs + sellability ---------- */
  console.log("skus / catalog-state");
  const s5 = await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { kind: "decant", price: null } });
  check("sku upsert price null -> created", s5.status === 200 && s5.data.created === true && s5.data.sku.id === `${PID}:5` && s5.data.sku.price === null, s5.data);
  check("price null -> sellable:false", (await skuState(PID, 5))?.sellable === false);
  check("sku upsert new without kind -> 400", (await admin("PUT", `/api/admin/products/${PID}/skus/7`, { body: { price: 1000 } })).status === 400);
  check("sku bad ml -> 400", (await admin("PUT", `/api/admin/products/${PID}/skus/abc`, { body: { kind: "decant" } })).status === 400);
  check("sku price 0 -> 400", (await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { price: 0 } })).status === 400);
  check("sku compareAt <= price -> 400", (await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { price: 5000, compareAt: 4000 } })).status === 400);
  const s5b = await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { price: 45000 } });
  check("sku update price -> created:false, kind kept", s5b.status === 200 && s5b.data.created === false && s5b.data.sku.kind === "decant" && s5b.data.sku.price === 45000, s5b.data);
  let st = await skuState(PID, 5);
  check("price set + active product -> sellable:true, available null (untracked)", st?.sellable === true && st.available === null && st.price === 45000, st);
  check("staff sku upsert -> 403", (await staff("PUT", `/api/admin/products/${PID}/skus/5`, { body: { price: 1 } })).status === 403);
  check("sku on unknown product -> 404", (await admin("PUT", "/api/admin/products/zz-no-such-product/skus/5", { body: { kind: "decant" } })).status === 404);

  await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { active: false } });
  check("sku inactive -> not sellable", (await skuState(PID, 5))?.sellable === false);
  await admin("PUT", `/api/admin/products/${PID}/skus/5`, { body: { active: true } });

  await admin("PATCH", `/api/admin/products/${PID}`, { body: { status: "hidden" } });
  let ps = (await state([PID])).data.products[0];
  check("product hidden -> visible:false, nothing sellable", ps.visible === false && ps.skus.every((s) => !s.sellable), ps);
  await admin("PATCH", `/api/admin/products/${PID}`, { body: { status: "draft" } });
  ps = (await state([PID])).data.products[0];
  check("product draft -> visible:false", ps.visible === false && ps.skus.every((s) => !s.sellable), ps);
  await admin("PATCH", `/api/admin/products/${PID}`, { body: { status: "active", saleLocked: true } });
  ps = (await state([PID])).data.products[0];
  check("sale lock -> visible but not sellable", ps.visible === true && ps.saleLocked === true && ps.skus.every((s) => !s.sellable), ps);
  await admin("PATCH", `/api/admin/products/${PID}`, { body: { saleLocked: false } });
  check("unlock -> sellable again", (await skuState(PID, 5))?.sellable === true);

  const closed = await admin("PUT", "/api/admin/settings", { body: { "checkout.open": false } });
  check("settings: close checkout (lead route)", closed.status === 200, closed.data);
  const cs = await state([PID]);
  check("checkout closed -> checkoutOpen:false, not sellable", cs.data.checkoutOpen === false && cs.data.products[0].skus.every((s) => !s.sellable), cs.data);
  const reopened = await admin("PUT", "/api/admin/settings", { body: { "checkout.open": true } });
  check("settings: checkout restored", reopened.status === 200 && (await state([PID])).data.checkoutOpen === true);

  /* ---------- catalog-state contract ---------- */
  const none = await api("GET", "/api/store/catalog-state");
  check("catalog-state without ids -> 400", none.status === 400 && none.data.errors.ids === "required", none.data);
  const many = Array.from({ length: 61 }, (_, i) => `x-${i}`);
  check("catalog-state 61 ids -> 400", (await state(many)).status === 400);
  const sixty = await state([PID, ...Array.from({ length: 59 }, (_, i) => `zz-unknown-${i}`)]);
  check("catalog-state 60 ids ok; unknown ids omitted", sixty.status === 200 && sixty.data.products.length === 1 && sixty.data.products[0].id === PID, sixty.data?.products?.length);
  check("catalog-state Cache-Control public, max-age=30", sixty.headers.get("cache-control") === "public, max-age=30", sixty.headers.get("cache-control"));
  check("catalog-state shape (payments, checkoutOpen)", typeof sixty.data.payments?.qpay === "boolean" && typeof sixty.data.payments?.bank === "boolean" && typeof sixty.data.checkoutOpen === "boolean");

  /* ---------- inventory ---------- */
  console.log("inventory");
  const SKU = `${PID}:5`;
  const set = await staff("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, set: 3, reason: "restock", note: "first count" } });
  check("staff adjust set=3 (inventory.write) -> stock 3, movement +3", set.status === 200 && set.data.sku.stock === 3 && set.data.sku.available === 3 && set.data.movement.delta === 3 && set.data.movement.reason === "restock", set.data);
  const delta = await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, delta: -1, reason: "correction" } });
  check("adjust delta=-1 -> stock 2, movement -1", delta.status === 200 && delta.data.sku.stock === 2 && delta.data.movement.delta === -1, delta.data);
  st = await skuState(PID, 5);
  check("catalog-state shows available 2", st?.available === 2 && st.sellable === true, st);
  check("adjust both set and delta -> 400", (await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, set: 1, delta: 1, reason: "restock" } })).status === 400);
  check("adjust bad reason -> 400", (await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, delta: 1, reason: "sale" } })).status === 400);
  check("adjust unknown sku -> 404", (await admin("POST", "/api/admin/inventory/adjust", { body: { sku: "zz-none:5", delta: 1, reason: "restock" } })).status === 404);
  check("adjust below zero -> 409", (await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, delta: -5, reason: "correction" } })).status === 409);
  const mv = await admin("GET", `/api/admin/inventory/${encodeURIComponent(SKU)}/movements`);
  check("movements newest first (−1 then +3)", mv.status === 200 && mv.data.items.length === 2 && mv.data.items[0].delta === -1 && mv.data.items[1].delta === 3, mv.data);
  const mvRaw = await staff("GET", `/api/admin/inventory/${SKU}/movements`);
  check("movements with a raw ':' path, staff (catalog.read)", mvRaw.status === 200 && mvRaw.data.items.length === 2, mvRaw.status);
  await admin("PUT", `/api/admin/products/${PID}/skus/10`, { body: { kind: "decant", price: 80000 } });
  const untracked = await admin("POST", "/api/admin/inventory/adjust", { body: { sku: `${PID}:10`, delta: 1, reason: "restock" } });
  check("delta on untracked sku -> 409 untracked", untracked.status === 409 && untracked.data.errors.stock === "untracked", untracked.data);

  // reservation: needs an orders row (A2's table) -> SQL
  const orderNo = `GZ-A1T-${RUN}`.slice(0, 40);
  sql(
    `INSERT INTO orders (order_no, name, phone, city, address, payment, items_json, subtotal, delivery, total, locale) VALUES ('${orderNo}', 'test', '00000000', 'ub', 'x', 'bank', '[]', 0, 0, 0, 'mn');` +
      `INSERT INTO reservations (order_id, sku_id, qty, tracked, status) SELECT id, '${SKU}', 2, 1, 'held' FROM orders WHERE order_no = '${orderNo}';` +
      `UPDATE skus SET reserved = reserved + 2 WHERE id = '${SKU}';`,
  );
  st = await skuState(PID, 5);
  check("reserved 2 of 2 -> available 0, not sellable", st?.available === 0 && st.sellable === false, st);
  const inv = await admin("GET", "/api/admin/inventory?low=0");
  check("inventory ?low=0 lists the sold-out sku with reserved", inv.status === 200 && inv.data.items.some((i) => i.id === SKU && i.reserved === 2 && i.available === 0 && i.brand === "Test House"), inv.data?.items?.length);
  const below = await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, set: 1, reason: "correction" } });
  check("set below reserved -> 409 { stock: below_reserved }", below.status === 409 && below.data.errors.stock === "below_reserved", below.data);
  const belowD = await admin("POST", "/api/admin/inventory/adjust", { body: { sku: SKU, delta: -1, reason: "correction" } });
  check("delta below reserved -> 409", belowD.status === 409 && belowD.data.errors.stock === "below_reserved", belowD.data);
  const mvCount = sql(`SELECT COUNT(*) AS n FROM stock_movements WHERE sku_id = '${SKU}'`)[0].n;
  check("failed adjustments wrote no movement row", mvCount === 2, mvCount);
  const del = await admin("DELETE", `/api/admin/products/${PID}/skus/5`);
  check("delete sku with a reservation -> 409", del.status === 409 && del.data.errors.sku === "reserved", del.data);
  const del10 = await admin("DELETE", `/api/admin/products/${PID}/skus/10`);
  check("delete unreserved sku -> 200", del10.status === 200 && del10.data.ok === true, del10.data);
  check("delete again -> 404", (await admin("DELETE", `/api/admin/products/${PID}/skus/10`)).status === 404);
  check("delete staff -> 403", (await staff("DELETE", `/api/admin/products/${PID}/skus/5`)).status === 403);

  /* ---------- media ---------- */
  console.log("media");
  const up = await admin("POST", "/api/admin/media", { form: mediaForm(JPEG, PID, "front") });
  check(
    "media jpeg -> url on PUBLIC_MEDIA_BASE with products/{id}/front-{12 hex}.jpg",
    up.status === 200 && new RegExp(`^${MEDIA_BASE.replace(/\./g, "\\.")}/products/${PID}/front-[0-9a-f]{12}\\.jpg$`).test(up.data.url),
    up.data,
  );
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const upPng = await admin("POST", "/api/admin/media", { form: mediaForm(png, PID, "back", "image/png", "b.png") });
  check("media png back -> .png", upPng.status === 200 && /\/back-[0-9a-f]{12}\.png$/.test(upPng.data.url), upPng.data);
  const fake = await admin("POST", "/api/admin/media", { form: mediaForm(new TextEncoder().encode("<svg></svg>"), PID, "front", "image/jpeg", "x.jpg") });
  check("media wrong type (declared jpeg, really text) -> 400", fake.status === 400 && fake.data.errors.file === "type", fake.data);
  check("media bad side -> 400", (await admin("POST", "/api/admin/media", { form: mediaForm(JPEG, PID, "top") })).status === 400);
  check("media unknown product -> 404", (await admin("POST", "/api/admin/media", { form: mediaForm(JPEG, "zz-no-such-product", "front") })).status === 404);
  const big = new Uint8Array(5 * 1024 * 1024 + 10);
  big.set(JPEG.subarray(0, 3));
  check("media > 5 MB -> 413", (await admin("POST", "/api/admin/media", { form: mediaForm(big, PID, "front") })).status === 413);
  const usePatch = await admin("PATCH", `/api/admin/products/${PID}`, { body: { imageFront: up.data.url } });
  check("uploaded url is accepted by PATCH imageFront", usePatch.status === 200 && usePatch.data.product.imageFront === up.data.url, usePatch.data);

  /* ---------- audit ---------- */
  console.log("audit");
  const audit = sql(`SELECT action, actor, COUNT(*) AS n FROM audit_log WHERE entity_id = '${PID}' OR entity_id LIKE '${PID}:%' OR entity_id LIKE 'products/${PID}/%' GROUP BY action, actor`);
  const has = (action, actor = "admin:owner") => audit.some((r) => r.action === action && r.actor === actor);
  check("audit: product.create", has("product.create"), audit);
  check("audit: product.update", has("product.update"));
  check("audit: sku.create + sku.update", has("sku.create") && has("sku.update"));
  check("audit: sku.delete (only the successful one)", audit.find((r) => r.action === "sku.delete")?.n === 1, audit);
  check("audit: inventory.adjust by staff and owner (failed ones not logged)", has("inventory.adjust", "admin:staff") && audit.find((r) => r.action === "inventory.adjust" && r.actor === "admin:owner")?.n === 1, audit);
  check("audit: media.upload", has("media.upload"));

  // cleanup: reservation + order (test data), then the product (skus/movements cascade)
  sql(
    `DELETE FROM reservations WHERE sku_id LIKE '${PID}:%'; DELETE FROM orders WHERE order_no = '${orderNo}'; DELETE FROM products WHERE id = '${PID}';`,
  );
}

try {
  await main();
} catch (err) {
  failed++;
  console.error("  FAIL (exception)", err);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
