// Bundles (0005) in a real browser against a LOCAL Worker + D1: list, bundle page, add to cart, buy now ->
// checkout -> order, admin "Багц" list + editor, at 1440 and 360 px. Screenshots -> docs/screens/bundles-*.png.
// Needs a sellable bundle (BUNDLE, default warm-spice-wood) in the local D1 (demo prices / stock, local only).
//   BASE=http://localhost:8796 node scripts/shot-bundles.mjs
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("playwright-core"); }

const BASE = (process.env.BASE ?? "http://localhost:8796").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error("shot-bundles runs against a LOCAL server only"); process.exit(2); }
const BUNDLE = process.env.BUNDLE ?? "warm-spice-wood";
const OUT = process.env.OUT ?? "docs/screens";
const devVars = existsSync(process.env.DEV_VARS ?? ".dev.vars") ? readFileSync(process.env.DEV_VARS ?? ".dev.vars", "utf8") : "";
const ADMIN = process.env.ADMIN_TOKEN ?? /^ADMIN_TOKEN=(.*)$/m.exec(devVars)?.[1]?.trim() ?? "";
const TURNSTILE = `window.turnstile={render(el,o){setTimeout(()=>o.callback("XXXX.DUMMY.TOKEN.XXXX"),10);return "w"},reset(){},remove(){}};`;
const EDGE = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });

let pass = 0, failN = 0;
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log("  ok  ", name); } else { failN++; console.log("  FAIL", name, info === undefined ? "" : String(info).slice(0, 300)); }
};

const browser = await pw.chromium.launch({ headless: true, ...(existsSync(EDGE) ? { executablePath: EDGE } : {}) });
const errors = [];
for (const [w, h] of [[1440, 900], [360, 780]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { "CF-Connecting-IP": `203.0.113.${(Date.now() % 100) + (w === 360 ? 100 : 1)}` } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${w}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/turnstile|favicon/i.test(m.text()) && errors.push(`${w} console: ${m.text()}`));
  await page.route("https://challenges.cloudflare.com/**", (rt) => rt.fulfill({ contentType: "text/javascript", body: TURNSTILE }));
  const imagesLoaded = () => page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    scrollTo(0, 0);
    await Promise.all([...document.querySelectorAll("main img")].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 8000); }))));
  });
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  // list
  let res = await page.goto(`${BASE}/bundles/`, { waitUntil: "load" });
  ok(`${w}: /bundles/ 200 with cards`, res.status() === 200 && (await page.locator(".bl__card").count()) >= 8);
  ok(`${w}: list has no horizontal overflow`, await noOverflow());
  await imagesLoaded();
  await page.screenshot({ path: `${OUT}/bundles-list-${w}.png`, fullPage: true });

  // bundle page
  res = await page.goto(`${BASE}/bundles/${BUNDLE}/`, { waitUntil: "load" });
  ok(`${w}: bundle page 200`, res.status() === 200);
  await page.waitForSelector('.bb[data-state="ok"]', { timeout: 10000 }).catch(() => {});
  ok(`${w}: buy block is live (sellable)`, (await page.locator('.bb[data-state="ok"]').count()) === 1);
  ok(`${w}: 3 parts listed`, (await page.locator(".bd__part").count()) === 3);
  ok(`${w}: bundle page has no horizontal overflow`, await noOverflow());
  await imagesLoaded();
  await page.screenshot({ path: `${OUT}/bundles-page-${w}.png`, fullPage: true });

  // add to cart -> drawer shows one bundle line with its parts
  await page.locator(".bb__add").click();
  await page.waitForSelector(".cd[data-open] .cd__item", { timeout: 10000 });
  await page.waitForTimeout(600);
  const line = page.locator(`.cd__item[data-sku="bundle:${BUNDLE}"]`);
  ok(`${w}: cart has the bundle line`, (await line.count()) === 1);
  ok(`${w}: cart line lists 3 parts`, (await line.locator(".cd__parts li").count()) === 3);
  await page.screenshot({ path: `${OUT}/bundles-cart-${w}.png` });
  await page.keyboard.press("Escape");

  // buy now -> checkout (qty in cart becomes 2)
  await page.locator(".bb__now").click();
  await page.waitForURL(/zahialga/, { timeout: 10000 });
  await page.waitForSelector(`.co__line[data-sku="bundle:${BUNDLE}"]`, { timeout: 10000 });
  const qty = await page.locator(`.co__line[data-sku="bundle:${BUNDLE}"] .co__qty`).textContent();
  ok(`${w}: buy now -> checkout with the bundle (qty 2)`, qty?.trim() === "2", qty);
  await page.fill("#co-name", "Bundle Browser");
  await page.fill("#co-phone", w === 1440 ? "99001144" : "99001155");
  await page.selectOption("#co-district", { index: 1 });
  await page.fill("#co-address", "1-р хороо, 5-р байр, 12 тоот");
  await page.locator('input[name="payment"][value="bank"]').check({ force: true });
  await page.waitForFunction(() => !document.querySelector(".co__submit")?.disabled, null, { timeout: 10000 });
  ok(`${w}: checkout has no horizontal overflow`, await noOverflow());
  await page.screenshot({ path: `${OUT}/bundles-checkout-${w}.png`, fullPage: true });
  await page.locator(".co__submit").click();
  await page.waitForURL(/amjilttai/, { timeout: 20000 }).catch(() => {});
  const alert = /amjilttai/.test(page.url()) ? "" : ((await page.locator(".co__alert").textContent().catch(() => "")) ?? "");
  ok(`${w}: order placed -> success page`, /amjilttai/.test(page.url()), `${page.url()} ${alert}`);
  await page.waitForTimeout(800);
  const body = await page.locator("main").innerText();
  const no = (body.match(/GZ-\d{6}-[A-Z2-9]{4}/) ?? [])[0];
  ok(`${w}: success shows the order number`, !!no);
  await page.screenshot({ path: `${OUT}/bundles-success-${w}.png` });

  // admin: bundles list + editor (+ the order with its bundle)
  await page.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => sessionStorage.setItem("gz-admin-token", t), ADMIN);
  await page.goto(`${BASE}/admin/#/bundles`, { waitUntil: "load" });
  await page.waitForSelector("tr[data-bundle]", { timeout: 15000 }).catch(() => {});
  ok(`${w}: admin Багц list`, (await page.locator("tr[data-bundle]").count()) >= 8);
  await page.screenshot({ path: `${OUT}/bundles-admin-list-${w}.png`, fullPage: w === 1440 });
  await page.goto(`${BASE}/admin/#/bundles/${BUNDLE}`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="bundle-form"]', { timeout: 15000 }).catch(() => {});
  ok(`${w}: admin bundle editor`, (await page.locator('[data-testid="bundle-parts"] li').count()) === 3);
  await page.locator('[data-testid="part-search"] input').fill("Versace");
  await page.locator('[data-testid="part-search"] button').click();
  await page.waitForSelector("[data-add-sku]", { timeout: 10000 }).catch(() => {});
  ok(`${w}: admin part search finds sizes`, (await page.locator("[data-add-sku]").count()) > 0);
  ok(`${w}: admin editor has no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${OUT}/bundles-admin-edit-${w}.png`, fullPage: true });
  if (no) {
    await page.goto(`${BASE}/admin/#/orders/${no}`, { waitUntil: "load" });
    await page.waitForSelector('[data-testid="bundle-parts"]', { timeout: 15000 }).catch(() => {});
    ok(`${w}: admin order detail shows the bundle + parts`, (await page.locator('[data-testid="bundle-parts"] li').count()) === 3);
    if (w === 1440) await page.screenshot({ path: `${OUT}/bundles-admin-order-${w}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
ok("no page errors", errors.length === 0, errors.join(" | "));
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
