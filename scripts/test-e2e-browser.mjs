// Real-browser end-to-end test (lead, A6): the built storefront + admin against the REAL Worker and D1
// (no API mocks). Only Cloudflare's Turnstile script is stubbed (it cannot be reached from CI).
//   needs: wrangler dev on BASE with the catalog imported (scripts/test-catalog.mjs does that), mock-qpay.
//   BASE=http://localhost:8788 node scripts/test-e2e-browser.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); } catch { pw = require("playwright-core"); }
const { chromium } = pw;
import { readFileSync, readdirSync } from "node:fs";

const BASE = (process.env.BASE ?? "http://localhost:8788").replace(/\/$/, "");
const vars = Object.fromEntries(readFileSync(".dev.vars", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ADMIN = vars.ADMIN_TOKEN;
const TURNSTILE = `window.turnstile={render(el,o){setTimeout(()=>o.callback("XXXX.DUMMY.TOKEN.XXXX"),10);return "w"},reset(){},remove(){}};`;
const fmt = (n) => n.toLocaleString("en-US");

let pass = 0, failN = 0;
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log("  ok  ", name); } else { failN++; console.log("  FAIL", name, info === undefined ? "" : String(info).slice(0, 300)); }
};
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Origin: BASE, Authorization: `Bearer ${ADMIN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// a storefront product (it has a built page) — price its smallest size and give it 2 in stock
const file = readdirSync("src/content/products").filter((f) => f.endsWith(".json")).sort()[0];
const prod = JSON.parse(readFileSync(`src/content/products/${file}`, "utf8"));
const id = file.replace(/\.json$/, "");
const ml = [...prod.sizes].sort((a, b) => a.ml - b.ml)[0].ml;
const sku = `${id}:${ml}`;
const PRICE = 12300;
await api("PUT", "/api/admin/settings", { "checkout.open": true, "payments.bank.enabled": true });
// the product may not be in D1 yet (fresh database without the catalog import): create it, ignore "exists"
await api("POST", "/api/admin/products", { id, brand: prod.brand, name: prod.name, status: "active" });
await api("PATCH", `/api/admin/products/${id}`, { status: "active", saleLocked: false });
let r = await api("PUT", `/api/admin/products/${id}/skus/${ml}`, { kind: "decant", price: PRICE, active: true });
ok(`admin prices ${sku} at ${PRICE}`, r.data?.ok === true, JSON.stringify(r.data));
const held = (await api("GET", "/api/admin/inventory?low=100000")).data?.items?.find((i) => i.id === sku)?.reserved ?? 0;
r = await api("POST", "/api/admin/inventory/adjust", { sku, set: held + 2, reason: "restock" });
ok("admin stocks it (2 for sale)", r.data?.ok === true, JSON.stringify(r.data));

const EDGE_EXE = process.env.EDGE ?? (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : "");
const browser = await chromium.launch({ headless: true, ...(EDGE_EXE && (await import("node:fs")).existsSync(EDGE_EXE) ? { executablePath: EDGE_EXE } : {}) });
const errors = [];
for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  // a fresh client IP per run, as the order API rate-limits 5 orders / IP / 10 min
  const ctx = await browser.newContext({ viewport, extraHTTPHeaders: { "CF-Connecting-IP": `203.0.113.${(Date.now() % 200) + (label === "phone" ? 50 : 1)}` } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  await page.route("https://challenges.cloudflare.com/**", (rt) => rt.fulfill({ contentType: "text/javascript", body: TURNSTILE }));

  await page.goto(`${BASE}/delguur/${id}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".atc") && !document.querySelector(".atc .live-ph"), null, { timeout: 15000 });
  const chip = await page.locator(".atc__chip .atc__price").first().textContent();
  ok(`${label}: product page shows the server price`, (chip ?? "").includes(fmt(PRICE)), chip);
  ok(`${label}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator(".atc__btn").click();
  await page.waitForSelector(".cd[data-open] .cd__item", { timeout: 10000 });

  await page.goto(`${BASE}/zahialga/`, { waitUntil: "domcontentloaded" });
  await page.fill("#co-name", "Browser E2E");
  await page.fill("#co-phone", label === "desktop" ? "99001122" : "99001133");
  await page.selectOption("#co-district", { index: 1 });
  await page.fill("#co-address", "1-р хороо, 5-р байр, 12 тоот");
  await page.locator('input[name="payment"][value="bank"]').check({ force: true });
  await page.waitForFunction(() => !document.querySelector(".co__submit").disabled, null, { timeout: 10000 });
  await page.locator(".co__submit").click();
  await page.waitForURL(/amjilttai/, { timeout: 20000 }).catch(() => {});
  const alert = /amjilttai/.test(page.url()) ? "" : ((await page.locator(".co__alert").textContent().catch(() => "")) ?? "");
  ok(`${label}: order placed -> success page`, /amjilttai/.test(page.url()), `${page.url()} ${alert}`);
  await page.waitForFunction(() => /GZ-\d{6}-[A-Z2-9]{4}/.test(document.querySelector("main")?.innerText ?? ""), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const body = await page.locator("main").innerText();
  const no = (body.match(/GZ-\d{6}-[A-Z2-9]{4}/) ?? [])[0];
  ok(`${label}: success page shows the order number`, !!no, body.slice(0, 200));
  ok(`${label}: success page shows the total`, body.includes(fmt(PRICE)), body.slice(0, 300));
  if (no) {
    const od = (await api("GET", `/api/admin/orders/${no}`)).data?.order;
    ok(`${label}: order in D1 with server price + reservation`, od?.subtotal === PRICE && od?.reservations?.[0]?.skuId === sku && od?.reservations?.[0]?.status === "held", JSON.stringify(od)?.slice(0, 300));
  }
  await ctx.close();
}

// both units are now reserved: the product page must say sold out
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/delguur/${id}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".atc") && !document.querySelector(".atc .live-ph"), null, { timeout: 15000 });
  const txt = (await page.locator(".atc").textContent()) ?? "";
  ok("after 2 orders: sold out shown", /Дууссан/.test(txt), txt.slice(0, 200));
  await page.close();
}
// admin page renders with the real API
{
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`admin: ${e.message}`));
  await page.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
  await page.click('[data-testid="mode-token"]');
  await page.locator('input[type="password"]').first().fill(ADMIN);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const txt = (await page.locator("body").textContent()) ?? "";
  ok("admin: logs in with the real API and shows the dashboard", (await page.locator('[data-testid="dashboard"]').count()) === 1 && /Захиалга/.test(txt), txt.slice(0, 200));
  await page.close();
}
ok("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
