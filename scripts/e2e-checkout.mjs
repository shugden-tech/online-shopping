// Phase 7 checks: checkout form -> /api/orders -> D1 -> success page.
//   BASE=http://localhost:4321 node scripts/e2e-checkout.mjs
// Needs the dev server (astro dev, platformProxy D1) and `npx wrangler d1 migrations apply genzst --local`.
// Test rows are named "E2E ..." and use fake 10.77.x.x IPs; they are deleted at the start of every run
// (the last run's rows stay so they can be inspected).
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.env.BASE ?? "http://localhost:4321";
const edge = process.env.CHROME_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const settings = JSON.parse(readFileSync("src/data/settings.json", "utf8"));
const product = (slug) => JSON.parse(readFileSync(`src/content/products/${slug}.json`, "utf8"));
const priceOf = (slug, ml) => product(slug).sizes.find((s) => s.ml === ml).price;
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const NO_RE = /^GZ-\d{6}-[A-Z2-9]{4}$/;
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // what Cloudflare's test site keys produce

let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${cond ? "" : extra}`);
  if (!cond) fails++;
};
const J = JSON.stringify;

function d1(sql) {
  const out = execSync(`npx wrangler d1 execute genzst --local --json --command "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = out.indexOf("[");
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

// ---- clean slate ----
d1("DELETE FROM orders WHERE name LIKE 'E2E%' OR ip LIKE '10.77.%'");
console.log("cleaned previous E2E rows");

const run = 1 + Math.floor(Math.random() * 250);
const IP_FORM = `10.77.${run}.1`;
const IP_TAMPER = `10.77.${run}.2`;
const IP_RATE = `10.77.${run}.3`;
// every independent API case gets its own address, so no case depends on another's rate-limit budget
let ipSeq = 10;
const freshIp = () => `10.77.${run}.${ipSeq++}`;

// cart snapshot with deliberately wrong prices (price: 1) — the page and server must both ignore them
const snap = (slug, ml, qty) => {
  const p = product(slug);
  return { slug, ml, qty, price: 1, name: p.name, brand: p.brand, family: p.family, shape: p.bottleShape };
};
const CART = [snap("sauvage", 5, 1), snap("oud-wood", 2, 1)];
const SUBTOTAL = priceOf("sauvage", 5) + priceOf("oud-wood", 2);
const DELIVERY = SUBTOTAL >= settings.delivery.freeThreshold ? 0 : settings.delivery.fee;
const TOTAL = SUBTOTAL + DELIVERY;
console.log(`expected: subtotal ${SUBTOTAL}, delivery ${DELIVERY}, total ${TOTAL}`);

const browser = await chromium.launch({ executablePath: edge, headless: true });
const errors = [];
async function newPage(width, ip) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 500 ? 780 : 900 },
    deviceScaleFactor: width < 500 ? 2 : 1,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[${width}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[${width}] ${e}`));
  // stand-in for Cloudflare's CF-Connecting-IP so each run / scenario gets its own rate-limit bucket
  await page.route("**/api/orders", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
  return page;
}
async function openCheckout(page, path = "/zahialga/") {
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((c) => localStorage.setItem("gz-cart-v1", JSON.stringify(c)), CART);
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForSelector(".co__line");
}
const waitToken = (page) =>
  page.waitForFunction(() => document.querySelector('.co__ts input[name="cf-turnstile-response"]')?.value, null, {
    timeout: 30000,
  });
async function fillValid(page, name) {
  await page.fill("#co-name", name);
  await page.fill("#co-phone", "99112233");
  await page.fill("#co-phone2", "88112233");
  await page.selectOption("#co-district", "bayanzurkh");
  await page.fill("#co-khoroo", "3-р хороо");
  await page.fill("#co-address", "13-р хороолол, 45-р байр, 2-р орц, 31 тоот");
  await page.fill("#co-note", "18 цагаас хойш");
  await page.check('input[name="payment"][value="qpay"]', { force: true });
}
async function shot(page, path) {
  // full-page shots: start at the top, nothing focused (the fixed header would otherwise land mid-page)
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await page.waitForTimeout(400);
  await page.screenshot({ path, fullPage: true });
}
const cartLen = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("gz-cart-v1") ?? "[]").length);

// ---------- 4. bad input -> localized inline errors (mn @360, en @1440) ----------
{
  const page = await newPage(360, IP_FORM);
  await openCheckout(page);
  ok("mn: stale snapshot prices refreshed (notice shown)", await page.locator(".co__notice").isVisible());
  ok("mn: summary total = catalog total", (await page.locator("[data-total]").innerText()) === `${fmt(TOTAL)}₮`,
    await page.locator("[data-total]").innerText());
  await page.fill("#co-phone", "12345");
  await page.click(".co__submit");
  await page.waitForSelector("#co-phone-err");
  const phoneErr = await page.locator("#co-phone-err").innerText();
  ok("mn: phone error localized", phoneErr.includes("8 оронтой"), phoneErr);
  ok("mn: name required error", (await page.locator("#co-name-err").innerText()).includes("бөглөнө"));
  ok("mn: district + address errors", (await page.locator("#co-district-err").count()) === 1 && (await page.locator("#co-address-err").count()) === 1);
  ok("mn: aria-invalid + describedby", (await page.getAttribute("#co-phone", "aria-invalid")) === "true" &&
    (await page.getAttribute("#co-phone", "aria-describedby")) === "co-phone-err");
  ok("mn: top alert shows errors.fix", (await page.locator(".co__alert").innerText()).includes("Улаанаар"));
  await page.waitForTimeout(500);
  ok("mn: first invalid field focused", (await page.evaluate(() => document.activeElement?.id)) === "co-name");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("360: no horizontal overflow (filled cart, errors)", overflow === 0, `overflow=${overflow}`);
  await shot(page, "docs/screens/p7-checkout-errors-360.png");
  // countryside switch shows province input + note
  await page.check('input[name="city"][value="countryside"]', { force: true });
  ok("countryside: province input + note", (await page.locator('input[name="province"]').count()) === 1 &&
    (await page.locator(".co__hint", { hasText: "унааны" }).count()) === 1);
  await page.close();

  const en = await newPage(1440, IP_FORM);
  await openCheckout(en, "/en/checkout/");
  await en.fill("#co-phone", "12345");
  await en.click(".co__submit");
  await en.waitForSelector("#co-phone-err");
  const enErr = await en.locator("#co-phone-err").innerText();
  ok("en: phone error localized", enErr.includes("must be 8 digits"), enErr);
  ok("en: top alert", (await en.locator(".co__alert").innerText()).includes("highlighted"));
  await en.close();
}

// ---------- 4b. same bad payload straight to the API -> 422 ----------
const post = (body, ip) =>
  fetch(base + "/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
const valid = (name, extra = {}) => ({
  name, phone: "99112233", city: "ub", district: "khan-uul", khoroo: "", address: "Зайсан, 12-р байр, 4 тоот",
  note: "", payment: "bank", locale: "mn", items: [{ slug: "sauvage", ml: 5, qty: 1 }, { slug: "oud-wood", ml: 2, qty: 1 }],
  turnstileToken: DUMMY_TOKEN, website: "", ...extra,
});
{
  const r = await post(valid("E2E bad", { phone: "12345", name: "" }), freshIp());
  ok("API: bad phone -> 422 with errors.phone", r.status === 422 && r.body.errors?.phone === "phone" && r.body.errors?.name === "required", J(r));
  const r2 = await post(valid("E2E bad", { city: "countryside", district: "" }), freshIp());
  ok("API: countryside without province -> errors.district=province", r2.status === 422 && r2.body.errors?.district === "province", J(r2));
  const r3 = await post(valid("E2E bot", { website: "http://spam.example" }), freshIp());
  ok("API: honeypot filled -> 400", r3.status === 400, J(r3));
  const r4 = await post(valid("E2E soldout", { items: [{ slug: "aventus", ml: 2, qty: 1 }] }), freshIp());
  const r5 = await post(valid("E2E unknown", { items: [{ slug: "nope", ml: 5, qty: 1 }] }), freshIp());
  ok("API: unknown / sold-out item -> 422 form=items",
    r4.status === 422 && r4.body.errors?.form === "items" && r5.status === 422 && r5.body.errors?.form === "items", J(r4) + J(r5));
  const r6 = await fetch(base + "/api/orders");
  ok("API: GET -> 405", r6.status === 405 && r6.headers.get("cache-control") === "no-store");
  const raw = (body, headers) => fetch(base + "/api/orders", { method: "POST", body, headers: { "CF-Connecting-IP": freshIp(), ...headers } });
  const r7 = await raw("{nope", { "Content-Type": "application/json" });
  ok("API: bad JSON -> 400", r7.status === 400, String(r7.status));
  const r8 = await raw("{nope", {}); // text/plain from no origin: Astro's CSRF check stops it before the handler
  ok("API: non-JSON POST without origin -> 403", r8.status === 403, String(r8.status));
  const r9 = await raw(JSON.stringify(valid("E2E ctype")), { "Content-Type": "application/x-www-form-urlencoded", Origin: base });
  ok("API: same-origin non-JSON content type -> 415", r9.status === 415, String(r9.status));
  const r10 = await raw(JSON.stringify(valid("E2E big", { note: "x".repeat(40000) })), { "Content-Type": "application/json" });
  ok("API: body over 32 KB -> 413", r10.status === 413, String(r10.status));
}

// ---------- 3. tampered client prices are ignored ----------
{
  const body = valid("E2E tamper", {
    items: [{ slug: "sauvage", ml: 5, qty: 1, price: 1 }, { slug: "oud-wood", ml: 2, qty: 1, price: 1 }],
    subtotal: 1, delivery: 0, total: 1, price: 1,
  });
  const r = await post(body, IP_TAMPER);
  ok("API: tampered order accepted with server total", r.status === 200 && r.body.total === TOTAL, J(r.body));
  const [row] = d1(`SELECT subtotal, delivery, total, items_json FROM orders WHERE order_no = '${r.body.orderNo}'`);
  const items = JSON.parse(row?.items_json ?? "[]");
  ok("D1: tampered row stores catalog prices", row?.subtotal === SUBTOTAL && row?.delivery === DELIVERY && row?.total === TOTAL &&
    items.every((i) => i.price === priceOf(i.slug, i.ml)), J(row));
  console.log("      tampered row:", J(row));
}

// ---------- 2. real order through the form ----------
let orderNo = "";
{
  const page = await newPage(1440, IP_FORM);
  await openCheckout(page);
  await fillValid(page, "E2E Болд");
  await waitToken(page);
  await page.waitForTimeout(400);
  await shot(page, "docs/screens/p7-checkout-filled-1440.png");
  await page.click(".co__submit");
  await page.waitForURL(/\/zahialga\/amjilttai\/\?no=/, { timeout: 20000 });
  await page.waitForSelector("[data-order-no]:not(:empty)");
  orderNo = (await page.locator("[data-order-no]").innerText()).trim();
  ok("success page shows order number", NO_RE.test(orderNo), orderNo);
  const amount = await page.locator("[data-amount]").innerText();
  ok("success page shows amount", amount === `${fmt(TOTAL)}₮`, amount);
  ok("success page reference = order no", (await page.locator("[data-reference]").innerText()) === orderNo);
  ok("cart empty after success", (await cartLen(page)) === 0);
  ok("header badge 0", (await page.locator("[data-cart-count]").first().innerText()) === "0");
  await page.waitForTimeout(500);
  await shot(page, "docs/screens/p7-success-1440.png");
  await page.reload({ waitUntil: "networkidle" });
  ok("success page survives reload", (await page.locator("[data-order-no]").innerText()).trim() === orderNo);
  await page.goto(base + "/zahialga/amjilttai/?no=bogus", { waitUntil: "networkidle" });
  ok("invalid no -> missing message", await page.locator("[data-ok-missing]").isVisible());
  await page.close();

  const [row] = d1(`SELECT order_no,name,phone,phone2,city,district,payment,subtotal,delivery,total,items_json,ip FROM orders WHERE order_no = '${orderNo}'`);
  ok("D1 row saved with server prices", row?.subtotal === SUBTOTAL && row?.total === TOTAL && row?.payment === "qpay" &&
    row?.district === "bayanzurkh" && row?.phone2 === "88112233", J(row));
  console.log("      form row:", J(row));
}

// ---------- 5. rate limit: 5 fast orders from one IP, the 6th (through the form) gets 429 ----------
{
  const codes = [];
  for (let i = 1; i <= 5; i++) codes.push((await post(valid(`E2E rate ${i}`), IP_RATE)).status);
  ok("5 fast orders from one IP -> 200", codes.every((c) => c === 200), J(codes));
  const page = await newPage(1440, IP_RATE);
  await openCheckout(page);
  await fillValid(page, "E2E rate 6");
  await waitToken(page);
  const [resp] = await Promise.all([page.waitForResponse("**/api/orders"), page.click(".co__submit")]);
  ok("6th order -> 429", resp.status() === 429, String(resp.status()));
  await page.waitForSelector(".co__alert p");
  const alert = await page.locator(".co__alert").innerText();
  ok("form shows rate message", alert.includes("10 минутын"), alert);
  ok("cart kept after error", (await cartLen(page)) === 2);
  ok("still on checkout", page.url().endsWith("/zahialga/"));
  ok("submit re-enabled", await page.locator(".co__submit").isEnabled());
  await page.close();
  const [{ n }] = d1(`SELECT COUNT(*) AS n FROM orders WHERE ip = '${IP_RATE}'`);
  ok("D1 has exactly 5 rows for the rate-limited IP", n === 5, String(n));
}

// ---------- network failure: the request never reaches the server; the cart must survive ----------
{
  const page = await newPage(1440, freshIp());
  await openCheckout(page);
  await fillValid(page, "E2E offline");
  await waitToken(page);
  await page.route("**/api/orders", (route) => route.abort("internetdisconnected"));
  await page.click(".co__submit");
  await page.waitForSelector(".co__alert p");
  const alert = await page.locator(".co__alert").innerText();
  ok("network failure -> localized network message", alert.includes("Сүлжээний алдаа"), alert);
  ok("network failure -> cart kept, still on checkout, submit re-enabled",
    (await cartLen(page)) === 2 && page.url().endsWith("/zahialga/") && (await page.locator(".co__submit").isEnabled()));
  await page.close();
}

// ---------- 404 in English ----------
{
  const page = await newPage(1440, freshIp());
  const r = await page.goto(base + "/en/no-such-page/", { waitUntil: "networkidle" });
  const vis = await page.locator('[data-404="en"]').isVisible();
  const h1 = await page.locator('[data-404="en"] h1').innerText();
  ok("en 404: status 404, English copy and links", r.status() === 404 && vis && /evaporated/.test(h1) &&
    (await page.locator('[data-404="en"] a[href="/en/"]').count()) === 1 && (await page.evaluate(() => document.documentElement.lang)) === "en",
    `${r.status()} ${vis} ${h1} lang=${await page.evaluate(() => document.documentElement.lang)}`);
  await page.close();
}

// ---------- empty cart ----------
{
  const page = await newPage(360, IP_FORM);
  await page.goto(base + "/zahialga/", { waitUntil: "networkidle" });
  await page.waitForSelector(".co__empty");
  ok("empty cart -> message + shop link, no form", (await page.locator(".co__form").count()) === 0 &&
    (await page.locator('.co__empty a[href="/delguur/"]').count()) === 1);
  await page.close();
}

const relevant = errors.filter((e) => !/status of (429|404)|ERR_INTERNET_DISCONNECTED/.test(e)); // the deliberate 429, 404 and offline cases
console.log("console errors:", relevant.length ? relevant : "none", errors.length !== relevant.length ? `(+${errors.length - relevant.length} expected 429 / 404 / offline resource errors)` : "");
ok("no console errors", relevant.length === 0);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await browser.close();
process.exit(fails ? 1 : 0);
