// A5 storefront integration test: live prices / states from the catalog-state API, cart re-check, checkout
// (sku items, Idempotency-Key, 409/422/423), payment instructions (QPay polling, bank) and order tracking.
// Every /api/* call is mocked with page.route() fixtures that follow docs/CONTRACTS.md, so it runs against
// a plain static build:   npx astro build && npx wrangler dev --port 8795
//                          BASE=http://localhost:8795 node scripts/test-storefront.mjs
// Prints "N passed, M failed" and exits 1 on any failure. SHOTS=<dir> also saves screenshots.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("playwright-core");
}
const { chromium } = pw;

const BASE = process.env.BASE ?? "http://localhost:8795";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- catalog (build-time JSON: structure only; its prices are demo values that must never show) ---------- */
const dir = join(root, "src/content/products");
const products = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const bySlug = new Map(products.map((p) => [p.slug, p]));
const fmt = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}₮`;
const demoPrices = new Set(products.flatMap((p) => p.sizes.map((s) => fmt(s.price))));
/** Fixture prices end in 7: the demo JSON prices are round, so a demo price can never pass as a live one. */
const livePrice = (slug, ml) => 20007 + ((slug.length * 31 + ml * 17) % 90) * 1000;

const SOON = "chanel-bleu-de-chanel-edp";
const LOCKED = "dior-sauvage-elixir-parfum";
const OUT = "valentino-uomo-born-in-roma-intense-edp";
const HIDDEN = "maison-francis-kurkdjian-baccarat-rouge-540-edp";
const SALE = "jean-paul-gaultier-le-male-elixir-parfum";
const GOOD = products.map((p) => p.slug).find((s) => ![SOON, LOCKED, OUT, HIDDEN, SALE].includes(s) && bySlug.get(s).sizes.length >= 2);
for (const s of [SOON, LOCKED, OUT, HIDDEN, SALE, GOOD]) if (!bySlug.has(s)) throw new Error(`fixture product missing: ${s}`);

function storeState(ids, opt = {}) {
  const products = [];
  for (const id of ids) {
    const p = bySlug.get(id);
    if (!p) continue; // unknown ids are omitted (contract)
    const visible = !(opt.hidden ?? [HIDDEN]).includes(id);
    const saleLocked = (opt.locked ?? [LOCKED]).includes(id);
    const skus = p.sizes.map((s) => {
      const price = (opt.soon ?? [SOON]).includes(id) ? null : (opt.price?.[`${id}:${s.ml}`] ?? livePrice(id, s.ml));
      const available = (opt.out ?? [OUT]).includes(id) ? 0 : (opt.available?.[`${id}:${s.ml}`] ?? 5);
      const open = opt.checkoutOpen ?? true;
      return {
        sku: `${id}:${s.ml}`, ml: s.ml, kind: s.full ? "full" : "decant", price,
        compareAt: id === SALE && price ? price + 10000 : null, available,
        sellable: open && visible && !saleLocked && price !== null && price > 0 && available !== 0,
      };
    });
    products.push({ id, visible, saleLocked, skus });
  }
  return { checkoutOpen: opt.checkoutOpen ?? true, payments: opt.payments ?? { qpay: true, bank: true }, products };
}

/* ---------- harness ---------- */
let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
};
const errors = [];
const browser = await chromium.launch({ headless: true });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Always-pass Turnstile stand-in: renders → token; reset → a fresh token (like the real test key).
const TURNSTILE = `window.turnstile={render(el,o){window.__ts=o;setTimeout(()=>o.callback("test-token"),10);return "w1"},reset(){setTimeout(()=>window.__ts&&window.__ts.callback("test-token-2"),10)},remove(){}};`;

/**
 * New page with the API mocked. `opt.state` = storeState options, `opt.stateStatus` = HTTP status for
 * catalog-state, `opt.delay` ms, `opt.order` = handler(route, request) for POST /api/orders, etc.
 */
async function open(opt = {}) {
  const ctx = await browser.newContext({ viewport: opt.viewport ?? { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const log = { state: [], orders: [], checks: 0, lookups: 0 };
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e}`));
  await page.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: TURNSTILE }));
  await page.route("**/api/store/catalog-state**", async (r) => {
    const ids = (new URL(r.request().url()).searchParams.get("ids") ?? "").split(",").filter(Boolean);
    log.state.push(ids);
    if (opt.delay) await new Promise((res) => setTimeout(res, opt.delay));
    const st = typeof opt.state === "function" ? opt.state() : opt.state;
    if (opt.stateStatus && opt.stateStatus !== 200) return r.fulfill({ status: opt.stateStatus, contentType: "application/json", body: '{"ok":false,"errors":{"form":"server"}}' });
    return r.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "public, max-age=30" }, body: JSON.stringify(storeState(ids, st)) });
  });
  await page.route("**/api/orders", async (r) => {
    log.orders.push({ body: JSON.parse(r.request().postData() ?? "{}"), headers: r.request().headers() });
    return opt.order ? opt.order(r) : r.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false,"errors":{"form":"server"}}' });
  });
  await page.route("**/api/orders/lookup**", (r) => {
    log.lookups++;
    return opt.lookup ? opt.lookup(r) : r.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"errors":{"form":"notFound"}}' });
  });
  await page.route("**/api/orders/*/payment-check", (r) => {
    log.checks++;
    return opt.check ? opt.check(r, log.checks) : r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"paymentStatus":"unpaid","status":"new"}' });
  });
  if (opt.cart) {
    await page.addInitScript((c) => {
      if (!sessionStorage.getItem("gz-test-seeded")) {
        localStorage.setItem("gz-cart-v1", JSON.stringify(c));
        sessionStorage.setItem("gz-test-seeded", "1");
      }
    }, opt.cart);
  }
  return { page, ctx, log };
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const cardSel = (slug) => `[data-card][data-pid="${slug}"]`;
const line = (slug, ml, extra = {}) => {
  const p = bySlug.get(slug);
  return { slug, ml, qty: 1, price: 1000, name: p.name, brand: p.brand, family: p.family, shape: p.bottleShape ?? "classic", ...extra };
};

/* ================= 1. shop: placeholder → live prices and states ================= */
{
  const { page, ctx, log } = await open({ delay: 900, state: {} });
  await page.goto(`${BASE}/delguur/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(cardSel(GOOD));
  const early = await page.$eval(cardSel(GOOD), (c) => ({ ph: !!c.querySelector("[data-price-v] .live-ph"), text: c.querySelector(".pcard__price")?.textContent ?? "", disabled: c.querySelector("[data-main]").disabled }));
  ok("shop: quiet placeholder while loading (no number, add disabled)", early.ph && !/\d/.test(early.text.replace(/\d+\s*мл/g, "")) && early.disabled, JSON.stringify(early));
  await page.waitForFunction((s) => !document.querySelector(`[data-card][data-pid="${s}"] [data-price-v] .live-ph`), GOOD, { timeout: 10000 });
  await shot(page, "shop-desktop");
  const goodMain = await page.$eval(cardSel(GOOD), (c) => ({ v: c.querySelector("[data-price-v]").textContent.trim(), ml: Number(c.querySelector("[data-main]").dataset.ml), sku: c.querySelector("[data-main]").dataset.sku, dis: c.querySelector("[data-main]").disabled }));
  ok("shop: price comes from the API", goodMain.v === fmt(livePrice(GOOD, goodMain.ml)), JSON.stringify(goodMain));
  ok("shop: add button carries the sku id", goodMain.sku === `${GOOD}:${goodMain.ml}` && !goodMain.dis, JSON.stringify(goodMain));
  const allPrices = await page.$$eval("[data-card] [data-price-v], .pcard__dec-opt [data-opt-v]", (els) => els.map((e) => e.textContent.trim()).filter((t) => /\d/.test(t)));
  ok("shop: no demo (build-time) price rendered", allPrices.length > 50 && allPrices.every((t) => /7₮$/.test(t) && !demoPrices.has(t)), allPrices.filter((t) => !/7₮$/.test(t)).slice(0, 5).join(" | "));
  ok("shop: ids batched ≤ 60 per request", log.state.length >= 2 && log.state.every((ids) => ids.length <= 60), log.state.map((x) => x.length).join(","));
  const allIds = new Set(log.state.flat());
  ok("shop: one request per id per page view", allIds.size === log.state.flat().length, `${allIds.size} vs ${log.state.flat().length}`);
  ok("shop: hidden product card removed", (await page.locator(cardSel(HIDDEN)).count()) === 0);
  const soon = await page.$eval(cardSel(SOON), (c) => ({ v: c.querySelector("[data-price-v]").textContent.trim(), dis: c.querySelector("[data-main]").disabled }));
  ok("shop: price null → «Үнэ удахгүй», no add", soon.v === "Үнэ удахгүй" && soon.dis, JSON.stringify(soon));
  const locked = await page.$eval(cardSel(LOCKED), (c) => ({ flag: c.querySelector("[data-flag]").textContent, hidden: c.querySelector("[data-flag]").hidden, btn: c.querySelector("[data-add-label]").textContent, dis: [...c.querySelectorAll("[data-add]")].every((b) => b.disabled) }));
  ok("shop: sale-locked → «Түр хаалттай», buttons disabled", locked.flag === "Түр хаалттай" && !locked.hidden && locked.btn === "Түр хаалттай" && locked.dis, JSON.stringify(locked));
  const out = await page.$eval(cardSel(OUT), (c) => ({ flag: c.querySelector("[data-flag]").textContent, btn: c.querySelector("[data-add-label]").textContent, dis: [...c.querySelectorAll("[data-add]")].every((b) => b.disabled) }));
  ok("shop: available 0 → «Дууссан»", out.flag === "Дууссан" && out.btn === "Дууссан" && out.dis, JSON.stringify(out));
  const sale = await page.$eval(cardSel(SALE), (c) => c.querySelector("[data-price-v] .live-was")?.textContent ?? "");
  ok("shop: compare-at price shown struck through", /7₮$/.test(sale), sale);
  const count = await page.locator(".flt__count").textContent();
  ok("shop: result count excludes the hidden product", count.includes(String(products.length - 1)), count);
  // quick add → cart line with sku + live price
  await page.locator(`${cardSel(GOOD)} [data-main]`).click();
  await page.waitForSelector(".cd[data-open] .cd__item");
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem("gz-cart-v1") ?? "[]"));
  ok("cart: line stores sku and live price", cart.length === 1 && cart[0].sku === goodMain.sku && cart[0].price === livePrice(GOOD, goodMain.ml), JSON.stringify(cart));
  await page.waitForFunction(() => !document.querySelector(".cd__item .live-ph"));
  const lineTxt = await page.locator(".cd__item .cd__line").textContent();
  ok("cart drawer: line price after re-check", lineTxt.trim() === fmt(livePrice(GOOD, goodMain.ml)), lineTxt);
  await shot(page, "cart-drawer-desktop");
  await ctx.close();
}

/* ================= 2. failure note ================= */
{
  const { page, ctx } = await open({ stateStatus: 500 });
  await page.goto(`${BASE}/delguur/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((s) => document.querySelector(`[data-card][data-pid="${s}"] [data-price-v]`)?.textContent.includes("чадсангүй"), GOOD, { timeout: 10000 }).catch(() => {});
  const f = await page.$eval(cardSel(GOOD), (c) => ({ v: c.querySelector("[data-price-v]").textContent.trim(), dis: c.querySelector("[data-main]").disabled }));
  ok("failure: «Үнэ ачаалж чадсангүй», add disabled, page alive", f.v === "Үнэ ачаалж чадсангүй" && f.dis, JSON.stringify(f));
  await ctx.close();
}

/* ================= 3. home tabs + product page ================= */
{
  const { page, ctx } = await open({ state: {} });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".tabs__panel:not([hidden]) [data-card] [data-price-v]") && !document.querySelector(".tabs__panel:not([hidden]) [data-card] [data-price-v] .live-ph"), null, { timeout: 10000 });
  const homePrices = await page.$$eval(".tabs__panel [data-card] [data-price-v]", (els) => els.map((e) => e.textContent.trim()).filter((t) => /\d/.test(t)));
  ok("home tabs: live prices only", homePrices.length > 4 && homePrices.every((t) => /7₮$/.test(t)), homePrices.slice(0, 4).join(" | "));
  ok("home tabs: hidden bestseller removed", (await page.locator(`.tabs__panel ${cardSel(HIDDEN)}`).count()) === 0);

  await page.goto(`${BASE}/delguur/${GOOD}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".atc") && !document.querySelector(".atc .live-ph"), null, { timeout: 10000 });
  const chips = await page.$$eval(".atc__chip .atc__price", (els) => els.map((e) => e.textContent.trim()));
  const sizes = [...bySlug.get(GOOD).sizes].sort((a, b) => a.ml - b.ml);
  ok("product page: size chips show live prices", JSON.stringify(chips) === JSON.stringify(sizes.map((s) => fmt(livePrice(GOOD, s.ml)))), JSON.stringify(chips));
  const ld = await page.$eval('script[type="application/ld+json"]', (s) => s.textContent);
  const desc = await page.$eval('meta[name="description"]', (m) => m.content);
  ok("product page: no demo price in JSON-LD / meta description", !/offers|"price"/.test(ld) && !/₮/.test(desc), desc);
  await page.locator(".atc__btn").click();
  await page.waitForSelector(".cd[data-open] .cd__item");
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem("gz-cart-v1") ?? "[]"));
  ok("product page: add uses sku + live price", cart[0]?.sku === `${GOOD}:${sizes[0].ml}` && cart[0]?.price === livePrice(GOOD, sizes[0].ml), JSON.stringify(cart[0]));
  await page.goto(`${BASE}/delguur/${HIDDEN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".atc--off", { timeout: 10000 }).catch(() => {});
  ok("product page: hidden → «Одоогоор худалдаалагдахгүй»", ((await page.locator(".atc--off").textContent().catch(() => "")) ?? "").includes("Одоогоор худалдаалагдахгүй"));
  await page.goto(`${BASE}/delguur/${LOCKED}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.querySelector(".atc .live-ph"), null, { timeout: 10000 });
  const lb = await page.$eval(".atc__btn", (b) => ({ t: b.textContent.trim(), d: b.disabled }));
  ok("product page: sale-locked → disabled «Түр хаалттай»", lb.d && lb.t === "Түр хаалттай", JSON.stringify(lb));
  await ctx.close();
}

/* ================= 4. cart re-check: drops an unsellable line, updates a changed price, caps qty ================= */
{
  const goodMl = [...bySlug.get(GOOD).sizes].sort((a, b) => a.ml - b.ml)[0].ml;
  const outMl = bySlug.get(OUT).sizes[0].ml;
  const { page, ctx } = await open({ state: { available: { [`${GOOD}:${goodMl}`]: 2 } }, cart: [line(GOOD, goodMl, { qty: 4, price: 999 }), line(OUT, outMl)] });
  await page.goto(`${BASE}/bidnii-tuhai/`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-cart-open]").first().click();
  await page.waitForSelector(".cd__notice", { timeout: 10000 });
  const notice = await page.locator(".cd__notice").textContent();
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem("gz-cart-v1") ?? "[]"));
  ok("cart re-check: unsellable line removed with a message", cart.length === 1 && notice.includes("сагснаас хаслаа") && notice.includes(bySlug.get(OUT).name), notice);
  ok("cart re-check: changed price updated", cart[0]?.price === livePrice(GOOD, goodMl) && notice.includes("үнэ шинэчлэгдлээ"), JSON.stringify(cart[0]));
  ok("cart re-check: qty capped to available", cart[0]?.qty === 2 && notice.includes("тоог багасгалаа"), JSON.stringify(cart[0]));
  ok("cart re-check: legacy line got its sku", cart[0]?.sku === `${GOOD}:${goodMl}`);
  await shot(page, "cart-recheck-desktop");
  await ctx.close();
}

/* ================= 5. checkout ================= */
const goodMl = [...bySlug.get(GOOD).sizes].sort((a, b) => a.ml - b.ml)[0].ml;
const goodSku = `${GOOD}:${goodMl}`;
const ORDER_NO = "GZ-261117-AB2C";
const PHONE = "99112233";
const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
async function fillForm(page, pay = "qpay") {
  await page.fill("#co-name", "Тест Хэрэглэгч");
  await page.fill("#co-phone", PHONE);
  await page.selectOption("#co-district", "bayangol");
  await page.fill("#co-address", "1-р хороо, 5-р байр, 12 тоот");
  const radio = page.locator(`input[name="payment"][value="${pay}"]`);
  if (await radio.count()) await radio.check({ force: true });
  await page.waitForFunction(() => !document.querySelector(".co__submit").disabled, null, { timeout: 10000 });
}
const lookupBody = (extra = {}) => ({
  ok: true, orderNo: ORDER_NO, status: "new", createdAt: "2026-11-17 10:00:00", paymentStatus: "unpaid",
  holdExpiresAt: new Date(Date.now() + 29 * 60000).toISOString().replace("T", " ").slice(0, 19), shipment: null,
  items: [{ slug: GOOD, brand: bySlug.get(GOOD).brand, name: bySlug.get(GOOD).name, ml: goodMl, qty: 1, price: livePrice(GOOD, goodMl) }],
  subtotal: livePrice(GOOD, goodMl), delivery: 5000, total: livePrice(GOOD, goodMl) + 5000, ...extra,
});

// 5a. QPay: sends { sku, qty } + Idempotency-Key, success page shows QR / links / countdown, polls to paid
{
  const qpay = { method: "qpay", invoiceId: "inv-1", qrImage: PNG, qrText: "000201", shortUrl: "https://s.qpay.mn/abc", urls: [{ name: "Khan bank", link: "khanbank://q?qPay_QRcode=000201", logo: "https://qpay.mn/q/logo/khanbank.png" }] };
  const { page, ctx, log } = await open({
    state: {},
    cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })],
    order: (r) => r.fulfill(json(201, { ok: true, orderNo: ORDER_NO, total: livePrice(GOOD, goodMl) + 5000, subtotal: livePrice(GOOD, goodMl), delivery: 5000, holdExpiresAt: lookupBody().holdExpiresAt, payment: qpay })),
    lookup: (r) => r.fulfill(json(200, lookupBody())),
    check: (r, n) => r.fulfill(json(200, n >= 2 ? { ok: true, paymentStatus: "paid", status: "paid" } : { ok: true, paymentStatus: "unpaid", status: "new" })),
  });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("[data-total]") && !document.querySelector("[data-total] .live-ph"), null, { timeout: 10000 });
  ok("checkout: both payment options when both on", (await page.locator('input[name="payment"]').count()) === 2);
  await fillForm(page, "qpay");
  await shot(page, "checkout-desktop");
  await page.locator(".co__submit").click();
  await page.waitForURL(/amjilttai/, { timeout: 15000 });
  const sent = log.orders[0];
  ok("checkout: items sent as { sku, qty }", JSON.stringify(sent?.body.items) === JSON.stringify([{ sku: goodSku, qty: 1 }]), JSON.stringify(sent?.body.items));
  ok("checkout: Idempotency-Key header", /^[A-Za-z0-9_-]{16,100}$/.test(sent?.headers["idempotency-key"] ?? ""), sent?.headers["idempotency-key"]);
  await page.waitForSelector("[data-pay] img[data-qr]", { timeout: 10000 });
  const qr = await page.$eval("[data-pay] img[data-qr]", (i) => i.getAttribute("src"));
  ok("success: QPay QR image (base64 → data:)", qr.startsWith("data:image/png;base64,"), qr.slice(0, 40));
  ok("success: QPay short link + bank app links", (await page.locator("a[data-qpay-short]").getAttribute("href")) === "https://s.qpay.mn/abc" && (await page.locator(".ok__app").getAttribute("href")) === "khanbank://q?qPay_QRcode=000201");
  await page.waitForFunction(() => /\d+:\d\d/.test(document.querySelector("[data-hold]")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  ok("success: hold countdown for the unpaid order", /Төлбөр төлөх хугацаа: (2[89]|30):\d\d/.test((await page.locator("[data-hold]").first().textContent()) ?? ""), await page.locator("[data-hold]").first().textContent());
  ok("success: waiting state while unpaid", ((await page.locator("[data-pay-state]").textContent()) ?? "").includes("Төлбөр хүлээж байна"));
  await shot(page, "success-qpay-desktop");
  await page.waitForSelector("[data-pay-state][data-paid]", { timeout: 20000 }).catch(() => {});
  ok("success: polling payment-check every 5 s stops on paid", (await page.locator("[data-pay-state][data-paid]").count()) === 1 && log.checks === 2, `checks=${log.checks}`);
  await page.waitForTimeout(6000);
  ok("success: no more polling after paid", log.checks === 2, `checks=${log.checks}`);
  ok("success: cart cleared after the order", (await page.evaluate(() => localStorage.getItem("gz-cart-v1"))) === "[]");
  await ctx.close();
}

// 5b. 409 stock → message names the line; 423 closed; 422 payment disabled
{
  let mode = "stock";
  const { page, ctx } = await open({
    state: {},
    cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })],
    order: (r) =>
      mode === "stock" ? r.fulfill(json(409, { ok: false, errors: { form: "stock", sku: goodSku } }))
      : mode === "closed" ? r.fulfill(json(423, { ok: false, errors: { form: "closed" } }))
      : r.fulfill(json(422, { ok: false, errors: { payment: "disabled" } })),
  });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await fillForm(page, "bank");
  await page.locator(".co__submit").click();
  await page.waitForSelector(".co__alert p", { timeout: 10000 });
  const alert409 = await page.locator(".co__alert").textContent();
  ok("checkout 409 stock: message names the product", alert409.includes(bySlug.get(GOOD).name) && alert409.includes("үлдэгдэл хүрэлцэхгүй"), alert409);
  ok("checkout 409 stock: points to the line", (await page.locator(`.co__line[data-sku="${goodSku}"][data-unavailable] .co__line-err`).count()) === 1);
  await shot(page, "checkout-409-desktop");
  mode = "payment";
  await page.waitForFunction(() => !document.querySelector(".co__submit").disabled, null, { timeout: 10000 });
  await page.locator(".co__submit").click();
  await page.waitForFunction(() => document.querySelector(".co__alert")?.textContent.includes("төлбөрийн хэлбэр"), null, { timeout: 10000 }).catch(() => {});
  ok("checkout 422 payment disabled: message", ((await page.locator(".co__alert").textContent()) ?? "").includes("Энэ төлбөрийн хэлбэр одоогоор боломжгүй"), await page.locator(".co__alert").textContent());
  mode = "closed";
  await page.waitForFunction(() => !document.querySelector(".co__submit").disabled, null, { timeout: 10000 });
  await page.locator(".co__submit").click();
  await page.waitForFunction(() => document.querySelector(".co__alert")?.textContent.includes("хаалттай"), null, { timeout: 10000 }).catch(() => {});
  ok("checkout 423 closed: message", ((await page.locator(".co__alert").textContent()) ?? "").includes("Захиалга түр хаалттай"));
  await ctx.close();
}

// 5c. checkoutOpen:false → closed note, no submit; payments.qpay:false → bank only
{
  const { page, ctx, log } = await open({ state: { checkoutOpen: false }, cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })] });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".co__closed", { timeout: 10000 }).catch(() => {});
  ok("checkout closed: message and submit disabled", ((await page.locator(".co__closed").textContent().catch(() => "")) ?? "").includes("Захиалга түр хаалттай") && (await page.locator(".co__submit").isDisabled()) && log.orders.length === 0);
  await ctx.close();
}
{
  const { page, ctx } = await open({ state: { payments: { qpay: false, bank: true } }, cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })] });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.querySelector("[data-total] .live-ph"), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('input[name="payment"]').length === 1, null, { timeout: 5000 }).catch(() => {});
  const pays = await page.$$eval('input[name="payment"]', (els) => els.map((e) => e.value));
  ok("checkout: payment options follow payments.qpay/bank", JSON.stringify(pays) === '["bank"]', JSON.stringify(pays));
  await ctx.close();
}

// 5d. bank instructions
{
  const bank = { method: "bank", bank: "Хаан банк", account: "5000 1234 56", holder: "genzst ХХК", reference: ORDER_NO };
  const { page, ctx } = await open({
    state: {},
    cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })],
    order: (r) => r.fulfill(json(201, { ok: true, orderNo: ORDER_NO, total: 50007, subtotal: 45007, delivery: 5000, holdExpiresAt: null, payment: bank })),
    lookup: (r) => r.fulfill(json(200, lookupBody({ holdExpiresAt: null, total: 50007 }))),
  });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await fillForm(page, "bank");
  await page.locator(".co__submit").click();
  await page.waitForURL(/amjilttai/, { timeout: 15000 });
  await page.waitForSelector('[data-pay][data-method="bank"]', { timeout: 10000 });
  const txt = await page.locator("[data-pay]").textContent();
  ok("success: bank / account / holder / reference / amount", ["Хаан банк", "5000 1234 56", "genzst ХХК", ORDER_NO, "50,007₮"].every((x) => txt.includes(x)), txt);
  await shot(page, "success-bank-desktop");
  await ctx.close();
}

// 5e. paymentError qpay_unavailable → retry button calls payment-check and shows the QR it returns
{
  const qpay = { method: "qpay", invoiceId: "inv-2", qrImage: `data:image/png;base64,${PNG}`, qrText: null, shortUrl: null, urls: [] };
  const { page, ctx, log } = await open({
    state: {},
    cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })],
    order: (r) => r.fulfill(json(201, { ok: true, orderNo: ORDER_NO, total: 50007, subtotal: 45007, delivery: 5000, holdExpiresAt: null, payment: null, paymentError: "qpay_unavailable" })),
    lookup: (r) => r.fulfill(json(200, lookupBody({ holdExpiresAt: null }))),
    check: (r) => r.fulfill(json(200, { ok: true, paymentStatus: "unpaid", status: "new", payment: qpay })),
  });
  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await fillForm(page, "qpay");
  await page.locator(".co__submit").click();
  await page.waitForURL(/amjilttai/, { timeout: 15000 });
  await page.waitForSelector("[data-pay-state] [data-payment-check]", { timeout: 10000 });
  ok("success: qpay_unavailable → error + retry", ((await page.locator("[data-pay-state]").textContent()) ?? "").includes("QPay нэхэмжлэх үүсгэж чадсангүй"));
  await page.locator("[data-pay-state] [data-payment-check]").click();
  await page.waitForSelector("[data-pay] img[data-qr]", { timeout: 10000 }).catch(() => {});
  ok("success: retry calls payment-check and shows the QR", log.checks >= 1 && (await page.locator("[data-pay] img[data-qr]").count()) === 1, `checks=${log.checks}`);
  await ctx.close();
}

/* ================= 6. tracking lookup (anyone, number + phone) ================= */
{
  let lookupUrl = "";
  const { page, ctx } = await open({
    lookup: (r) => {
      lookupUrl = r.request().url();
      return r.fulfill(json(200, lookupBody({ status: "shipped", paymentStatus: "paid", holdExpiresAt: null, shipment: { status: "in_transit", trackingNo: "TRK123456", trackingUrl: "https://track.example.mn/TRK123456" } })));
    },
  });
  await page.goto(`${BASE}/zahialga/amjilttai/`, { waitUntil: "domcontentloaded" });
  await page.fill("#ok-track-no", ORDER_NO);
  await page.fill("#ok-track-phone", "2233");
  await page.locator(".ok__track button[type=submit]").click();
  await page.waitForSelector("[data-tracking-no]", { timeout: 10000 }).catch(() => {});
  const out = (await page.locator("[data-track-out]").textContent()) ?? "";
  const u = new URL(lookupUrl || "http://x/");
  ok("tracking: GET lookup with no + phone", u.pathname === "/api/orders/lookup" && u.searchParams.get("no") === ORDER_NO && u.searchParams.get("phone") === "2233", lookupUrl);
  ok("tracking: status, payment, shipment, tracking no + link", ["Хүргэлтэнд гарсан", "Төлөгдсөн", "Замд яваа", "TRK123456"].every((x) => out.includes(x)) && (await page.locator("a[data-tracking-url]").getAttribute("href")) === "https://track.example.mn/TRK123456", out);
  await shot(page, "track-desktop");
  await ctx.close();
}

/* ================= 7. 390 px: no horizontal overflow ================= */
{
  const { page, ctx } = await open({
    viewport: { width: 390, height: 844 },
    state: {},
    cart: [line(GOOD, goodMl, { sku: goodSku, price: livePrice(GOOD, goodMl) })],
    lookup: (r) => r.fulfill(json(200, lookupBody({ shipment: { status: "created", trackingNo: "TRK-VERY-LONG-NUMBER-1234567890", trackingUrl: null } }))),
  });
  for (const path of ["/delguur/", "/", `/delguur/${GOOD}/`, `/delguur/${LOCKED}/`, "/zahialga/", "/en/shop/"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    ok(`390px no overflow: ${path}`, await noOverflow(page));
  }
  await shot(page, "checkout-390");
  await page.goto(`${BASE}/delguur/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shot(page, "shop-390");
  // success page with QPay instructions at phone width
  await page.evaluate((no) => {
    sessionStorage.setItem("gz-last-order", JSON.stringify({ no, phone: "99112233" }));
    sessionStorage.setItem("gz-last-pay", JSON.stringify({ no, total: 50007, holdExpiresAt: null, paymentError: null, payment: { method: "qpay", invoiceId: "i", qrImage: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", qrText: null, shortUrl: "https://s.qpay.mn/x", urls: [{ name: "Trade and Development bank with a long name", link: "tdbbank://q" }] } }));
  }, ORDER_NO);
  await page.goto(`${BASE}/zahialga/amjilttai/?no=${ORDER_NO}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-pay] img[data-qr]", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  ok("390px no overflow: success (QPay + tracking)", await noOverflow(page));
  await shot(page, "success-390");
  await ctx.close();
}
{
  const { page, ctx } = await open({ state: {} });
  for (const path of ["/delguur/", "/zahialga/amjilttai/"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    ok(`1440px no overflow: ${path}`, await noOverflow(page));
  }
  await ctx.close();
}

ok("0 page errors", errors.length === 0, errors.slice(0, 5).join("\n"));
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
