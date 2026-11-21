// Screenshots of the admin against a LOCAL server (real backend + local D1) at 1440 and 360 px, plus a
// page-error check. Logs in with ADMIN_USERNAME / ADMIN_PASSWORD from .dev.vars.
//   BASE=http://localhost:8788 node scripts/shot-admin.mjs          -> docs/screens/admin-*.png
// EDGE=path/to/msedge.exe to use an installed Edge (default on Windows).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://localhost:8788").replace(/\/$/, "");
const OUT = resolve(root, process.env.OUT ?? "docs/screens");
mkdirSync(OUT, { recursive: true });
const devVars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const envVar = (k) => process.env[k] ?? new RegExp(`^${k}=(.*)$`, "m").exec(devVars)?.[1]?.trim() ?? "";
const EDGE = process.env.EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browser = await chromium.launch({ executablePath: existsSync(EDGE) ? EDGE : undefined });
const errors = [];
let shots = 0;

async function run(width, height, tag) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_NAME_NOT_RESOLVED/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); });
  const shot = async (name, full = true) => { await page.waitForTimeout(400); await page.screenshot({ path: join(OUT, `admin-${name}-${tag}.png`), fullPage: full }); shots++; };

  await page.goto(`${BASE}/admin/`);
  await page.waitForSelector('[data-testid="login"]');
  await page.fill('input[name="username"]', envVar("ADMIN_USERNAME"));
  await page.fill('input[name="token"]', "wrong-password-000");
  await page.click('[data-testid="login"] button[type="submit"]');
  await page.waitForSelector(".a-msg--err");
  await shot("login-error", false);
  await page.fill('input[name="token"]', envVar("ADMIN_PASSWORD"));
  await page.click('[data-testid="login"] button[type="submit"]');
  await page.waitForSelector('[data-testid="dashboard"]');
  await page.waitForFunction(() => !document.querySelector('[data-card="orders"] .a-card__n')?.textContent?.includes("…"));
  await shot("dashboard");

  const views = [
    ["orders", "#/orders", ".a-table"],
    ["products", "#/products", "[data-product]"],
    ["inventory", "#/inventory?low=1", ".a-table"],
    ["payments", "#/payments", ".a-table"],
    ["shipments", "#/shipments", ".a-table"],
    ["webhooks-in", "#/webhooks?tab=in", ".a-table"],
    ["webhooks-out", "#/webhooks?tab=out", "[data-testid=hook-form]"],
    ["settings", "#/settings", "[data-testid=settings-form]"],
    ["audit", "#/audit", ".a-table"],
    ["product-new", "#/products/new", "[data-testid=product-form]"],
  ];
  for (const [name, hash, sel] of views) {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForSelector(sel, { timeout: 15000 }).catch(() => errors.push(`${tag}: ${name} did not show ${sel}`));
    await shot(name);
  }
  // the newest order and an active product with photos/SKUs
  await page.evaluate(() => (location.hash = "#/orders"));
  await page.waitForSelector("[data-order] a");
  await page.click("[data-order] a");
  await page.waitForSelector('[data-testid="order-actions"]');
  await shot("order-detail");
  await page.evaluate(() => (location.hash = "#/products?status=active&hasPrice=1"));
  await page.waitForSelector("[data-product] a");
  await page.click("[data-product] a");
  await page.waitForSelector('[data-testid="product-form"]');
  await shot("product-edit");
  // horizontal overflow check (the page must not scroll sideways)
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) errors.push(`${tag}: page scrolls sideways by ${over}px on the product editor`);
  await ctx.close();
}

await run(1440, 900, "1440");
await run(360, 780, "360");
await browser.close();
console.log(`${shots} screenshots in ${OUT}`);
if (errors.length) { console.log(errors.join("\n")); process.exit(1); }
console.log("no page errors");
