// Admin UI tests (A4): Playwright against the BUILT page (dist/admin/index.html). Every /api/admin/* call is
// answered by page.route() fixtures that follow docs/CONTRACTS.md shapes, so no backend is needed.
//   npx astro build && node scripts/test-admin-ui.mjs
//   BASE=http://localhost:8794 node scripts/test-admin-ui.mjs     (use an already running server instead)
//   SHOTS=output/admin-ui-shots (default)                          (screenshots, not committed)
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const SHOTS = resolve(root, process.env.SHOTS ?? "output/admin-ui-shots");
mkdirSync(SHOTS, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright-core")); }

/* ---------------- static server for dist/ ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  if (!existsSync(join(dist, "admin", "index.html"))) { console.error("dist/admin/index.html missing: run `npx astro build` first"); process.exit(1); }
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(dist, p));
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(Number(process.env.PORT ?? 8794), "127.0.0.1", r));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

/* ---------------- contract constants (mirrors src/lib/contracts.ts) ---------------- */
const ORDER_TRANSITIONS = { new: ["confirmed", "paid", "cancelled"], confirmed: ["paid", "cancelled"], paid: ["shipped", "cancelled"], shipped: ["done"], done: [], cancelled: [] };
const ALL = ["catalog.read", "catalog.write", "inventory.write", "media.write", "orders.read", "orders.write", "payments.read", "payments.write", "delivery.read", "delivery.write", "settings.read", "settings.write", "audit.read"];
const STAFF = ["catalog.read", "inventory.write", "orders.read", "orders.write", "payments.read", "delivery.read", "delivery.write", "settings.read"];
const OWNER_TOKEN = "owner-token-0123456789abcdef";
const STAFF_TOKEN = "staff-token-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MEDIA = "https://pub-test.r2.dev";

/* ---------------- fixtures ---------------- */
const sku = (productId, ml, o = {}) => ({
  id: `${productId}:${ml}`, productId, ml, kind: ml >= 50 ? "full" : "decant", price: 45000, compareAt: null,
  stock: 10, reserved: 2, available: 8, active: true, updatedAt: "2026-11-01 10:00:00", ...o,
});
function makeProduct(id, o = {}) {
  return {
    id, brand: "Mugler", name: "Alien", concentration: "EDP", gender: "women", family: "amber", releaseYear: 2005,
    notes: { top: ["Jasmine"], heart: ["Cashmeran"], base: ["Amber"] }, descriptionMn: "Тайлбар", descriptionEn: "Description",
    imageFront: `${MEDIA}/products/${id}/front-aaaaaaaaaaaa.webp`, imageBack: null, status: "active", saleLocked: false, sort: 0,
    source: "r2-catalog", createdAt: "2026-10-01 10:00:00", updatedAt: "2026-11-01 10:00:00",
    skus: [sku(id, 5, { reserved: 1, stock: 4, available: 3 }), sku(id, 10, { price: 80000 }), sku(id, 100, { stock: null, reserved: 0, available: null, price: null })],
    ...o,
  };
}
function makeOrder(no, status, o = {}) {
  return {
    id: 1, orderNo: no, createdAt: "2026-11-10 08:00:00", updatedAt: "2026-11-10 08:00:00", status,
    paymentStatus: status === "paid" || status === "shipped" || status === "done" ? "paid" : "unpaid",
    holdExpiresAt: status === "new" ? "2026-11-10 08:30:00" : null,
    name: "Бат", phone: "99112233", phone2: null, city: "ub", district: "СБД", khoroo: "1", address: "Байр 1", note: null,
    payment: "bank", items: [{ sku: "mugler-alien-edp:10", slug: "mugler-alien-edp", brand: "Mugler", name: "Alien", ml: 10, qty: 2, price: 80000 }],
    subtotal: 160000, delivery: 5000, total: 165000, locale: "mn", ...o,
  };
}

function makeMock() {
  const state = {
    expired: false,
    products: { "mugler-alien-edp": makeProduct("mugler-alien-edp"), "draft-one": makeProduct("draft-one", { status: "draft", brand: "Test", name: "Draft", skus: [] }) },
    orders: {
      "GZ-261110-AAAA": makeOrder("GZ-261110-AAAA", "new"),
      "GZ-261110-BBBB": makeOrder("GZ-261110-BBBB", "paid"),
    },
    settings: {
      "checkout.open": true, "payments.qpay.enabled": true, "payments.bank.enabled": true, "holds.qpay_minutes": 30, "holds.bank_minutes": 1440,
      "delivery.fee_ub": null, "delivery.fee_countryside": null, "delivery.free_over": null, "delivery.provider": "manual", "store.notice_mn": "", "store.notice_en": "",
    },
    shipments: { 7: { id: 7, orderNo: "GZ-261110-BBBB", provider: "manual", providerRef: null, trackingNo: null, trackingUrl: null, status: "failed", attempts: 3, lastError: "timeout", nextRetryAt: null, createdAt: "2026-11-11 10:00:00", updatedAt: "2026-11-11 11:00:00" } },
    forbidPatchOrder: false,
  };
  const log = [];
  const J = (route, status, body) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  const fail = (route, status, errors) => J(route, status, { ok: false, errors });

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const auth = req.headers()["authorization"] ?? "";
    const ct = req.headers()["content-type"] ?? "";
    const raw = req.postDataBuffer();
    let body = null;
    if (raw && ct.includes("application/json")) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = "BAD JSON"; } }
    log.push({ method, path, search: url.search, body, ct, raw: raw ? raw.toString("latin1") : null, auth });

    const role = auth === `Bearer ${OWNER_TOKEN}` ? "owner" : auth === `Bearer ${STAFF_TOKEN}` ? "staff" : null;
    if (!role || state.expired) return fail(route, 401, { form: "unauthorized" });
    const perms = role === "owner" ? ALL : STAFF;
    const need = (p) => perms.includes(p);
    const deny = (p) => (need(p) ? false : (fail(route, 403, { form: "forbidden" }), true));
    let m;

    if (path === "/api/admin/me") return J(route, 200, { ok: true, role, permissions: perms });

    if (path === "/api/admin/settings") {
      if (method === "GET") { if (deny("settings.read")) return; return J(route, 200, { ok: true, settings: state.settings }); }
      if (deny("settings.write")) return;
      Object.assign(state.settings, body);
      return J(route, 200, { ok: true, settings: state.settings });
    }
    if (path === "/api/admin/audit") {
      if (deny("audit.read")) return;
      return J(route, 200, { ok: true, items: [{ id: 3, at: "2026-11-12 09:00:00", actor: "admin:owner", action: "product.update", entity: "product", entityId: "mugler-alien-edp", data: { name: "Alien" } }], nextCursor: null });
    }
    if (path === "/api/admin/products" && method === "GET") {
      if (deny("catalog.read")) return;
      const st = url.searchParams.get("status");
      const items = Object.values(state.products).filter((p) => !st || p.status === st);
      return J(route, 200, { ok: true, items, page: Number(url.searchParams.get("page") ?? 1), limit: Number(url.searchParams.get("limit") ?? 50), total: items.length });
    }
    if (path === "/api/admin/products" && method === "POST") {
      if (deny("catalog.write")) return;
      if (state.products[body.id]) return fail(route, 409, { id: "exists" });
      state.products[body.id] = makeProduct(body.id, { ...body, skus: [] });
      return J(route, 201, { ok: true, product: state.products[body.id] });
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)\/skus\/(\d+)$/.exec(path))) {
      if (deny("catalog.write")) return;
      const p = state.products[decodeURIComponent(m[1])];
      const ml = Number(m[2]);
      if (!p) return fail(route, 404, { form: "notFound" });
      if (method === "DELETE") {
        const s = p.skus.find((x) => x.ml === ml);
        if (s?.reserved) return fail(route, 409, { sku: "reserved" });
        p.skus = p.skus.filter((x) => x.ml !== ml);
        return J(route, 200, { ok: true });
      }
      let s = p.skus.find((x) => x.ml === ml);
      const created = !s;
      if (created && !body.kind) return fail(route, 400, { kind: "required" });
      if (body.compareAt != null && (body.price == null || body.compareAt <= body.price)) return fail(route, 400, { compareAt: "invalid" });
      if (!s) { s = sku(p.id, ml, { stock: null, reserved: 0, available: null }); p.skus.push(s); }
      Object.assign(s, body, { updatedAt: new Date().toISOString() });
      return J(route, 200, { ok: true, sku: s, created });
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)$/.exec(path))) {
      const p = state.products[decodeURIComponent(m[1])];
      if (!p) return fail(route, 404, { form: "notFound" });
      if (method === "GET") { if (deny("catalog.read")) return; return J(route, 200, { ok: true, product: p }); }
      if (deny("catalog.write")) return;
      Object.assign(p, body, { updatedAt: new Date().toISOString() });
      return J(route, 200, { ok: true, product: p });
    }
    if (path === "/api/admin/media") {
      if (deny("media.write")) return;
      return J(route, 200, { ok: true, url: `${MEDIA}/products/mugler-alien-edp/front-0123456789ab.png`, key: "products/mugler-alien-edp/front-0123456789ab.png" });
    }
    if (path === "/api/admin/inventory") {
      if (deny("catalog.read")) return;
      const items = Object.values(state.products).flatMap((p) => p.skus.map((s) => ({ ...s, brand: p.brand, name: p.name }))).filter((s) => s.available !== null && s.available <= 3);
      return J(route, 200, { ok: true, items, nextCursor: null });
    }
    if (path === "/api/admin/inventory/adjust") {
      if (deny("inventory.write")) return;
      const [pid, ml] = [body.sku.slice(0, body.sku.lastIndexOf(":")), Number(body.sku.split(":").pop())];
      const s = state.products[pid]?.skus.find((x) => x.ml === ml);
      if (!s) return fail(route, 404, { sku: "notFound" });
      if (body.delta !== undefined && s.stock === null) return fail(route, 409, { stock: "untracked" });
      const next = body.set !== undefined ? body.set : (s.stock ?? 0) + body.delta;
      if (next < s.reserved) return fail(route, 409, { set: "below_reserved" });
      s.stock = next; s.available = next - s.reserved;
      return J(route, 200, { ok: true, sku: s });
    }
    if ((m = /^\/api\/admin\/inventory\/([^/]+)\/movements$/.exec(path))) {
      return J(route, 200, { ok: true, items: [{ id: 1, skuId: decodeURIComponent(m[1]), at: "2026-11-01 10:00:00", delta: 10, reason: "restock", orderId: null, actor: "admin:owner", note: "эхний" }] });
    }
    if (path === "/api/admin/orders") {
      if (deny("orders.read")) return;
      const st = url.searchParams.get("status");
      return J(route, 200, { ok: true, items: Object.values(state.orders).filter((o) => !st || o.status === st), nextCursor: null });
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/mark-paid$/.exec(path))) {
      if (deny("payments.write")) return;
      const o = state.orders[m[1]];
      o.status = "paid"; o.paymentStatus = "paid";
      return J(route, 200, { ok: true, order: o });
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)$/.exec(path))) {
      const o = state.orders[decodeURIComponent(m[1])];
      if (!o) return fail(route, 404, { form: "notFound" });
      if (method === "GET") {
        if (deny("orders.read")) return;
        return J(route, 200, {
          ok: true, order: o,
          events: [{ at: o.createdAt, fromStatus: null, toStatus: "new", actor: "customer", note: null }],
          payments: [{ id: 11, orderNo: o.orderNo, provider: "bank", providerRef: "GZ-REF", amount: o.total, status: "pending", paidAmount: null, createdAt: o.createdAt, paidAt: null }],
          reservations: [{ id: 1, sku: "mugler-alien-edp:10", qty: 2, tracked: 1, status: "held" }],
          shipments: [],
        });
      }
      if (deny("orders.write")) return;
      if (state.forbidPatchOrder) return fail(route, 403, { form: "forbidden" });
      if (!ORDER_TRANSITIONS[o.status].includes(body.status)) return fail(route, 409, { status: "transition" });
      o.status = body.status;
      return J(route, 200, { ok: true, order: o });
    }
    if (path === "/api/admin/payments") {
      if (deny("payments.read")) return;
      return J(route, 200, { ok: true, items: [{ id: 11, orderNo: "GZ-261110-AAAA", provider: "bank", providerRef: "GZ-REF", amount: 165000, status: "pending", paidAmount: null, createdAt: "2026-11-10 08:00:00", paidAt: null }], nextCursor: null });
    }
    if (path === "/api/admin/shipments" && method === "POST") {
      if (deny("delivery.write")) return;
      const s = { id: 8, orderNo: body.orderNo, provider: "manual", status: "pending", attempts: 0, createdAt: "2026-11-12 10:00:00", updatedAt: "2026-11-12 10:00:00" };
      state.shipments[8] = s;
      return J(route, 201, { ok: true, shipment: s });
    }
    if (path === "/api/admin/shipments") {
      if (deny("delivery.read")) return;
      const st = url.searchParams.get("status");
      return J(route, 200, { ok: true, items: Object.values(state.shipments).filter((s) => !st || s.status === st), nextCursor: null });
    }
    if ((m = /^\/api\/admin\/shipments\/(\d+)\/retry$/.exec(path))) {
      if (deny("delivery.write")) return;
      state.shipments[m[1]].status = "pending";
      return J(route, 200, { ok: true, shipment: state.shipments[m[1]] });
    }
    if ((m = /^\/api\/admin\/shipments\/(\d+)$/.exec(path))) {
      const s = state.shipments[m[1]];
      if (!s) return fail(route, 404, { form: "notFound" });
      if (method === "GET") return J(route, 200, { ok: true, shipment: s, events: [{ at: s.createdAt, fromStatus: null, toStatus: "pending", source: "admin", note: null }] });
      if (deny("delivery.write")) return;
      Object.assign(s, body);
      return J(route, 200, { ok: true, shipment: s });
    }
    return fail(route, 404, { form: "notFound" });
  }
  return { state, log, handle };
}

/* ---------------- harness ---------------- */
const browser = await chromium.launch();
let passed = 0, failed = 0;
const pageErrors = [];
const ok = (name, cond, extra = "") => {
  if (cond) passed++; else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
};
const last = (log, method, re) => [...log].reverse().find((r) => r.method === method && re.test(r.path));

async function open(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const mock = makeMock();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
  await page.route("**/api/admin/**", mock.handle);
  await page.route(/^https:\/\/pub-test\.r2\.dev\//, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  return { ctx, page, mock };
}
async function login(page, token, hash = "") {
  await page.goto(`${BASE}/admin/${hash}`);
  await page.waitForSelector('[data-testid="login"]');
  await page.fill('input[name="token"]', token);
  await page.click('[data-testid="login"] button[type="submit"]');
  await page.waitForSelector(".a-nav");
}
const go = async (page, hash, sel) => { await page.evaluate((h) => { location.hash = h; }, hash); if (sel) await page.waitForSelector(sel); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const settle = (page) => page.waitForTimeout(150);

try {
  /* ---- login: bad token, owner, dashboard ---- */
  {
    const { ctx, page, mock } = await open();
    await page.goto(`${BASE}/admin/`);
    await page.waitForSelector('[data-testid="login"]');
    ok("fresh load shows the login screen", await page.isVisible('input[name="token"]'));
    ok("page is noindex", (await page.getAttribute('meta[name="robots"]', "content"))?.includes("noindex"));
    ok("no storefront header/footer", (await page.locator("header.site-header, footer, .site-footer").count()) === 0);
    await page.fill('input[name="token"]', "wrong-token");
    await page.click('[data-testid="login"] button[type="submit"]');
    await page.waitForSelector(".a-msg--err");
    ok("wrong token -> 'Токен буруу'", (await page.textContent(".a-msg--err")).includes("Токен буруу"));
    await page.fill('input[name="token"]', OWNER_TOKEN);
    await page.click('[data-testid="login"] button[type="submit"]');
    await page.waitForSelector('[data-testid="dashboard"]');
    ok("owner: GET /api/admin/me sent with bearer", mock.log.some((r) => r.path === "/api/admin/me" && r.auth === `Bearer ${OWNER_TOKEN}`));
    ok("token kept in sessionStorage", (await page.evaluate(() => sessionStorage.getItem("gz-admin-token"))) === OWNER_TOKEN);
    await page.waitForFunction(() => [...document.querySelectorAll(".a-card__n")].every((n) => n.textContent !== "…"));
    const cards = await page.$$eval("[data-card]", (els) => Object.fromEntries(els.map((e) => [e.dataset.card, e.querySelector(".a-card__n").textContent])));
    ok("dashboard counts (new 1, paid 1, failed shipments 1, draft 1)", cards.new === "1" && cards.paid === "1" && cards.failedShip === "1" && cards.draft === "1", JSON.stringify(cards));
    ok("dashboard awaiting payment = new+confirmed unpaid (1)", cards.awaiting === "1", cards.awaiting);
    ok("dashboard low stock (5 ml available 3) counted", cards.low === "1" && cards.zero === "0", JSON.stringify(cards));
    const nav = await page.$$eval(".a-nav__link", (els) => els.map((e) => e.textContent));
    ok("owner nav includes settings + audit", nav.includes("Дэлгүүрийн тохиргоо") && nav.includes("Үйлдлийн түүх"), nav.join());
    await shot(page, "owner-dashboard");
    // reload keeps the session
    await page.reload();
    await page.waitForSelector('[data-testid="dashboard"]');
    ok("reload restores session from sessionStorage", true);
    await page.click('[data-testid="logout"]');
    await page.waitForSelector('[data-testid="login"]');
    ok("logout returns to login and clears token", (await page.evaluate(() => sessionStorage.getItem("gz-admin-token"))) === null);
    await ctx.close();
  }

  /* ---- staff permissions ---- */
  {
    const { ctx, page } = await open();
    await login(page, STAFF_TOKEN);
    const nav = await page.$$eval(".a-nav__link", (els) => els.map((e) => e.textContent));
    ok("staff nav hides audit", !nav.includes("Үйлдлийн түүх"), nav.join());
    await go(page, "#/settings", '[data-testid="settings-form"]');
    ok("staff: settings has no save button", (await page.locator('[data-testid="save-settings"]').count()) === 0);
    ok("staff: settings inputs disabled", await page.isDisabled('input[name="checkout.open"]'));
    await go(page, "#/orders/GZ-261110-AAAA", '[data-testid="order-actions"]');
    ok("staff: no mark-paid form", (await page.locator('[data-testid="mark-paid"]').count()) === 0);
    const staffBtns = await page.$$eval('[data-testid^="to-"]', (els) => els.map((e) => e.dataset.testid.slice(3)).sort());
    ok("staff: new order buttons = confirmed, cancelled (no paid)", staffBtns.join() === "cancelled,confirmed", staffBtns.join());
    await go(page, "#/products", "[data-product]");
    ok("staff: no 'new product' button", (await page.locator('[data-testid="new-product"]').count()) === 0);
    await go(page, "#/products/mugler-alien-edp", '[data-testid="product-form"]');
    await page.waitForSelector('[data-testid="adjust-form"]');
    ok("staff: no product save button", (await page.locator('[data-testid="save-product"]').count()) === 0);
    ok("staff: product fields disabled", await page.isDisabled('input[name="brand"]'));
    ok("staff: no image upload", (await page.locator('[data-testid="upload-front"]').count()) === 0);
    ok("staff: SKU save buttons hidden", (await page.locator('[data-action="save-sku"]').count()) === 0);
    ok("staff: inventory adjust allowed", await page.isVisible('[data-testid="adjust-form"]'));
    await go(page, "#/audit", ".a-msg--err");
    ok("staff: audit route shows 'Эрх хүрэхгүй'", (await page.textContent(".a-main")).includes("Эрх хүрэхгүй"));
    await shot(page, "staff-forbidden-audit");
    await ctx.close();
  }

  /* ---- product edit, image upload, SKU price clear, inventory adjust ---- */
  {
    const { ctx, page, mock } = await open();
    await login(page, OWNER_TOKEN, "#/products/mugler-alien-edp");
    await page.waitForSelector('[data-testid="product-form"]');
    await page.fill('input[name="name"]', "Alien Intense");
    await page.click('[data-testid="sale-lock"]');
    await page.click('input[name="status"][value="hidden"]');
    await page.click('[data-testid="save-product"]');
    await page.waitForSelector(".a-msg--ok");
    const patch = last(mock.log, "PATCH", /^\/api\/admin\/products\/mugler-alien-edp$/);
    ok("product PATCH sends only changed fields", JSON.stringify(patch?.body) === JSON.stringify({ name: "Alien Intense", status: "hidden", saleLocked: true }), JSON.stringify(patch?.body));

    // image upload: POST media (multipart) then PATCH imageFront with the returned url
    const before = mock.log.length;
    await page.setInputFiles('[data-testid="upload-front"]', { name: "front.png", mimeType: "image/png", buffer: PNG });
    await page.waitForFunction(() => document.querySelector('[data-testid="preview-front"]')?.getAttribute("src")?.includes("front-0123456789ab.png"));
    const after = mock.log.slice(before);
    const media = after.find((r) => r.method === "POST" && r.path === "/api/admin/media");
    ok("upload: POST /api/admin/media is multipart", media?.ct.startsWith("multipart/form-data"), media?.ct);
    ok("upload: multipart has file, productId, side=front",
      !!media && /name="file"; filename="front.png"/.test(media.raw) && /name="productId"\r\n\r\nmugler-alien-edp/.test(media.raw) && /name="side"\r\n\r\nfront/.test(media.raw));
    const imgPatch = after.find((r) => r.method === "PATCH");
    ok("upload: then PATCH { imageFront: url }", JSON.stringify(imgPatch?.body) === JSON.stringify({ imageFront: `${MEDIA}/products/mugler-alien-edp/front-0123456789ab.png` }), JSON.stringify(imgPatch?.body));
    ok("upload: media POST before PATCH", after.indexOf(media) < after.indexOf(imgPatch));

    // paste URL for the back image
    await page.fill('[data-testid="url-back"]', `${MEDIA}/products/mugler-alien-edp/back.webp`);
    await page.press('[data-testid="url-back"]', "Enter");
    await page.waitForSelector('[data-testid="preview-back"]');
    ok("paste URL: PATCH { imageBack }", JSON.stringify(last(mock.log, "PATCH", /products\/mugler-alien-edp$/)?.body) === JSON.stringify({ imageBack: `${MEDIA}/products/mugler-alien-edp/back.webp` }));

    // SKU price clear -> "not for sale"
    const row = page.locator('tr[data-sku="mugler-alien-edp:10"]');
    ok("10 ml has a price (no 'not for sale')", (await row.locator('[data-testid="not-for-sale"]').count()) === 0);
    ok("100 ml without price shows 'not for sale'", (await page.locator('tr[data-sku="mugler-alien-edp:100"] [data-testid="not-for-sale"]').count()) === 1);
    await row.locator('[data-field="price"]').fill("");
    ok("clearing price shows 'not for sale' immediately", await row.locator('[data-testid="not-for-sale"]').isVisible());
    await row.locator('[data-action="save-sku"]').click();
    await page.waitForFunction(() => document.querySelector("#sku-h")?.closest("section")?.querySelector(".a-msg--ok"));
    const put = last(mock.log, "PUT", /\/skus\/10$/);
    ok("SKU PUT body { kind, price:null, compareAt, active }", JSON.stringify(put?.body) === JSON.stringify({ kind: "decant", price: null, compareAt: null, active: true }), JSON.stringify(put?.body));
    ok("after save the 10 ml row still says 'not for sale'", await page.locator('tr[data-sku="mugler-alien-edp:10"] [data-testid="not-for-sale"]').isVisible());

    // SKU delete conflict (5 ml has reservations)
    await page.locator('tr[data-sku="mugler-alien-edp:5"] .a-btn--danger').click();
    await page.locator('tr[data-sku="mugler-alien-edp:5"] [data-confirm]').click();
    await page.waitForFunction(() => document.querySelector("#sku-h")?.closest("section")?.querySelector(".a-msg--err"));
    ok("SKU delete 409 explained", (await page.locator("#sku-h >> xpath=..").locator(".a-msg--err").textContent()).includes("нөөцөлсөн"));

    // compare-at must be above price (client check, no request)
    const r10 = page.locator('tr[data-sku="mugler-alien-edp:10"]');
    const nPut = mock.log.filter((r) => r.method === "PUT").length;
    await r10.locator('[data-field="price"]').fill("50000");
    await r10.locator('input[aria-label="10 мл хуучин үнэ"]').fill("40000");
    await r10.locator('[data-action="save-sku"]').click();
    await page.waitForFunction(() => document.querySelector("#sku-h")?.closest("section")?.querySelector(".a-msg--err")?.textContent.includes("Хуучин үнэ"));
    ok("compare-at <= price rejected before sending", mock.log.filter((r) => r.method === "PUT").length === nPut);
    await r10.locator('[data-field="price"]').fill("");
    await r10.locator('input[aria-label="10 мл хуучин үнэ"]').fill("");

    // untracked SKU (100 ml, stock null): only "set" is offered
    await page.selectOption('[data-testid="adjust-form"] select[name="sku"]', "mugler-alien-edp:100");
    ok("untracked SKU switches adjust mode to 'set'", (await page.inputValue('[data-testid="adjust-form"] select[name="mode"]')) === "set");
    ok("untracked SKU: '±' option disabled", await page.$eval('[data-testid="adjust-form"] option[value="delta"]', (o) => o.disabled));

    // add size
    await page.fill('[data-testid="add-sku"] input[name="ml"]', "30");
    await page.fill('[data-testid="add-sku"] input[name="price"]', "120000");
    await page.click('[data-testid="add-sku"] button[type="submit"]');
    await page.waitForSelector('tr[data-sku="mugler-alien-edp:30"]');
    ok("add size: PUT /skus/30 with price 120000", last(mock.log, "PUT", /\/skus\/30$/)?.body?.price === 120000);

    // inventory adjust (delta) + 409 (set below reserved)
    await page.selectOption('[data-testid="adjust-form"] select[name="sku"]', "mugler-alien-edp:5");
    await page.selectOption('[data-testid="adjust-form"] select[name="mode"]', "delta");
    await page.fill('[data-testid="adjust-form"] input[name="value"]', "5");
    await page.selectOption('[data-testid="adjust-form"] select[name="reason"]', "restock");
    await page.fill('[data-testid="adjust-form"] input[name="note"]', "шинэ ачаа");
    await page.click('[data-testid="adjust-form"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("#inv-h")?.closest("section")?.querySelector(".a-msg--ok"));
    const adj = last(mock.log, "POST", /^\/api\/admin\/inventory\/adjust$/);
    ok("inventory adjust body { sku, delta, reason, note }", JSON.stringify(adj?.body) === JSON.stringify({ sku: "mugler-alien-edp:5", delta: 5, reason: "restock", note: "шинэ ачаа" }), JSON.stringify(adj?.body));
    await page.selectOption('[data-testid="adjust-form"] select[name="mode"]', "set");
    await page.fill('[data-testid="adjust-form"] input[name="value"]', "0");
    await page.selectOption('[data-testid="adjust-form"] select[name="reason"]', "correction");
    await page.click('[data-testid="adjust-form"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("#inv-h")?.closest("section")?.querySelector(".a-msg--err"));
    const adj2 = last(mock.log, "POST", /^\/api\/admin\/inventory\/adjust$/);
    ok("inventory set body { sku, set, reason }", JSON.stringify(adj2?.body) === JSON.stringify({ sku: "mugler-alien-edp:5", set: 0, reason: "correction" }), JSON.stringify(adj2?.body));
    ok("inventory 409 explained in Mongolian", (await page.locator("#inv-h >> xpath=..").locator(".a-msg--err").textContent()).includes("Зөрчил"));
    await page.locator('tr[data-inv="mugler-alien-edp:5"] button').click();
    await page.waitForSelector('[data-testid="movements"] tbody tr');
    ok("movement history loads", !!last(mock.log, "GET", /^\/api\/admin\/inventory\/mugler-alien-edp%3A5\/movements$/));
    await shot(page, "owner-product-edit");
    await ctx.close();
  }

  /* ---- order transitions per status, mark-paid, cancel, create shipment, 403 ---- */
  {
    const { ctx, page, mock } = await open();
    await login(page, OWNER_TOKEN);
    for (const status of Object.keys(ORDER_TRANSITIONS)) {
      mock.state.orders["GZ-261110-CCCC"] = makeOrder("GZ-261110-CCCC", status);
      await go(page, `#/orders/x-${status}`);
      await go(page, "#/orders/GZ-261110-CCCC", '[data-testid="order-actions"]');
      await page.waitForFunction((s) => document.querySelector(".a-badge")?.textContent && document.querySelector('[data-testid="order-actions"]'), status);
      const btns = await page.$$eval('[data-testid^="to-"]', (els) => els.map((e) => e.dataset.testid.slice(3)).sort());
      const want = [...ORDER_TRANSITIONS[status]].sort();
      ok(`owner: '${status}' buttons = [${want}]`, btns.join() === want.join(), btns.join());
      const markPaid = (await page.locator('[data-testid="mark-paid"]').count()) === 1;
      ok(`owner: '${status}' mark-paid form ${status === "new" || status === "confirmed" ? "shown" : "hidden"}`, markPaid === (status === "new" || status === "confirmed"));
      ok(`owner: '${status}' create-shipment ${status === "paid" ? "shown" : "hidden"}`, ((await page.locator('[data-testid="create-shipment"]').count()) === 1) === (status === "paid"));
    }
    // transition click -> PATCH { status }
    mock.state.orders["GZ-261110-CCCC"] = makeOrder("GZ-261110-CCCC", "new");
    await go(page, "#/orders/x", null);
    await go(page, "#/orders/GZ-261110-CCCC", '[data-testid="to-confirmed"]');
    await page.click('[data-testid="to-confirmed"]');
    await page.waitForSelector('[data-testid="order-actions"] .a-msg--ok');
    ok("confirm: PATCH { status: 'confirmed' }", JSON.stringify(last(mock.log, "PATCH", /orders\/GZ-261110-CCCC$/)?.body) === JSON.stringify({ status: "confirmed" }));
    // mark paid
    await page.fill('[data-testid="mark-paid"] input[name="reference"]', "TXN-778");
    await page.click('[data-testid="mark-paid"] button[type="submit"]');
    await page.waitForSelector('[data-testid="create-shipment"]');
    ok("mark-paid body { amount, reference }", JSON.stringify(last(mock.log, "POST", /mark-paid$/)?.body) === JSON.stringify({ amount: 165000, reference: "TXN-778" }));
    // create shipment
    await page.click('[data-testid="create-shipment"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="order-actions"] .a-msg--ok')?.textContent.includes("Хүргэлт үүслээ"));
    ok("create shipment: POST /api/admin/shipments { orderNo }", JSON.stringify(last(mock.log, "POST", /^\/api\/admin\/shipments$/)?.body) === JSON.stringify({ orderNo: "GZ-261110-CCCC" }));
    // cancel needs confirmation
    const n = mock.log.length;
    await page.click('[data-testid="to-cancelled"]');
    ok("cancel asks for confirmation first (no request yet)", !mock.log.slice(n).some((r) => r.method === "PATCH"));
    await page.click('[data-testid="order-actions"] [data-confirm]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="to-cancelled"]') && document.querySelector('[data-testid="order-actions"] .a-msg--ok'));
    ok("cancel: PATCH { status: 'cancelled' }", JSON.stringify(last(mock.log, "PATCH", /orders\/GZ-261110-CCCC$/)?.body) === JSON.stringify({ status: "cancelled" }));
    await shot(page, "owner-order-cancelled");
    // 403 readable
    mock.state.forbidPatchOrder = true;
    await go(page, "#/orders/GZ-261110-AAAA", '[data-testid="to-confirmed"]');
    await page.click('[data-testid="to-confirmed"]');
    await page.waitForSelector('[data-testid="order-actions"] .a-msg--err');
    ok("403 -> 'Эрх хүрэхгүй'", (await page.textContent('[data-testid="order-actions"] .a-msg--err')).includes("Эрх хүрэхгүй"));
    // staff per-status buttons match the map minus 'paid'
    await ctx.close();
  }
  {
    const { ctx, page, mock } = await open();
    await login(page, STAFF_TOKEN);
    for (const status of Object.keys(ORDER_TRANSITIONS)) {
      mock.state.orders["GZ-261110-CCCC"] = makeOrder("GZ-261110-CCCC", status);
      await go(page, `#/orders/x-${status}`);
      await go(page, "#/orders/GZ-261110-CCCC", '[data-testid="order-actions"]');
      const btns = await page.$$eval('[data-testid^="to-"]', (els) => els.map((e) => e.dataset.testid.slice(3)).sort());
      const want = ORDER_TRANSITIONS[status].filter((s) => s !== "paid").sort();
      ok(`staff: '${status}' buttons = [${want}]`, btns.join() === want.join(), btns.join());
    }
    await ctx.close();
  }

  /* ---- shipments: retry failed, settings save body, audit, 401 -> login ---- */
  {
    const { ctx, page, mock } = await open();
    await login(page, OWNER_TOKEN, "#/shipments");
    await page.waitForSelector("[data-shipment]");
    await go(page, "#/shipments/7", '[data-testid="shipment-actions"]');
    await page.click('[data-testid="retry"]');
    await page.waitForSelector('[data-testid="shipment-actions"] .a-msg--ok');
    ok("failed shipment: retry -> POST /shipments/7/retry", !!last(mock.log, "POST", /^\/api\/admin\/shipments\/7\/retry$/));
    await page.fill('input[name="trackingNo"]', "TRK-1");
    await page.click('[data-testid="shipment-actions"] form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="shipment-actions"] .a-msg--ok')?.textContent.includes("Трак"));
    ok("tracking PATCH { trackingNo, trackingUrl:null }", JSON.stringify(last(mock.log, "PATCH", /shipments\/7$/)?.body) === JSON.stringify({ trackingNo: "TRK-1", trackingUrl: null }));
    const shipBtns = await page.$$eval('[data-testid="shipment-actions"] [data-to]', (els) => els.map((e) => e.dataset.to).sort());
    ok("pending shipment buttons = created, failed (+ cancel)", shipBtns.join() === "created,failed" && (await page.locator('[data-testid="ship-cancel"]').count()) === 1, shipBtns.join());

    await go(page, "#/settings", '[data-testid="save-settings"]');
    await page.click('input[name="checkout.open"]');
    await page.click('input[name="payments.qpay.enabled"]');
    await page.fill('input[name="delivery.fee_ub"]', "5000");
    await page.fill('input[name="holds.bank_minutes"]', "720");
    await page.fill('textarea[name="store.notice_mn"]', "Баярын амралт");
    await page.click('[data-testid="save-settings"]');
    await page.waitForSelector('[data-testid="settings-form"] .a-msg--ok');
    const put = last(mock.log, "PUT", /^\/api\/admin\/settings$/);
    ok("settings PUT sends only changed keys", JSON.stringify(put?.body) === JSON.stringify({ "checkout.open": false, "payments.qpay.enabled": false, "holds.bank_minutes": 720, "delivery.fee_ub": 5000, "store.notice_mn": "Баярын амралт" }), JSON.stringify(put?.body));
    await page.fill('input[name="delivery.fee_ub"]', "");
    await page.click('[data-testid="save-settings"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-form"] .a-msg--ok')?.textContent.includes("(1"));
    ok("settings: empty fee -> null (default)", JSON.stringify(last(mock.log, "PUT", /settings$/)?.body) === JSON.stringify({ "delivery.fee_ub": null }));
    const explain = await page.textContent(".a-explain");
    ok("settings explains the 4 hide/lock controls", ["Бараа нуух", "Худалдаа түгжих", "Төлбөрийн арга унтраах", "Захиалга хаах"].every((t) => explain.includes(t)));
    await shot(page, "owner-settings");

    await go(page, "#/audit?entity=product&entityId=mugler-alien-edp", "[data-audit]");
    ok("audit: entity filter sent", last(mock.log, "GET", /^\/api\/admin\/audit$/)?.search.includes("entity=product"));
    await go(page, "#/payments", "[data-payment]");
    ok("payments list renders", (await page.locator("[data-payment]").count()) === 1);

    mock.state.expired = true;
    await go(page, "#/orders");
    await page.waitForSelector('[data-testid="login"]');
    ok("401 -> back to login with message", (await page.textContent(".a-login")).includes("Дахин нэвтэрнэ"));
    await ctx.close();
  }

  /* ---- 390 px: no horizontal overflow ---- */
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await login(page, OWNER_TOKEN);
    for (const [hash, sel, name] of [
      ["#/", '[data-testid="dashboard"]', "m-dashboard"],
      ["#/orders", "[data-order]", "m-orders"],
      ["#/orders/GZ-261110-AAAA", '[data-testid="order-actions"]', "m-order"],
      ["#/products", "[data-product]", "m-products"],
      ["#/products/mugler-alien-edp", '[data-testid="adjust-form"]', "m-product"],
      ["#/shipments/7", '[data-testid="shipment-actions"]', "m-shipment"],
      ["#/settings", '[data-testid="settings-form"]', "m-settings"],
      ["#/audit", "[data-audit]", "m-audit"],
    ]) {
      await go(page, hash, sel);
      await settle(page);
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth }));
      ok(`390px ${hash}: no horizontal overflow`, w.sw <= w.iw && w.bw <= w.iw, JSON.stringify(w));
      await shot(page, name);
    }
    // keyboard: from a fresh load the first Tab reaches the skip link, Enter moves focus to <main>
    await page.reload();
    await page.waitForSelector('[data-testid="audit"], [data-audit]');
    await page.keyboard.press("Tab");
    ok("keyboard: first Tab focuses the skip link", (await page.evaluate(() => document.activeElement?.className)) === "a-skip");
    await page.keyboard.press("Enter");
    ok("keyboard: skip link moves focus to main", (await page.evaluate(() => document.activeElement?.id)) === "a-main");
    await ctx.close();
  }
} catch (err) {
  failed++;
  console.log(`FAIL  unexpected: ${err?.stack ?? err}`);
}

ok("0 page errors", pageErrors.length === 0, pageErrors.join(" | "));
await browser.close();
server?.close();
console.log(`\n${passed} passed, ${failed} failed`);
console.log(`screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
