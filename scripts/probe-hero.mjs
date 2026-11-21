// Hero visibility probe: first paint, after scroll, JS disabled, reduced motion.
//   BASE=http://localhost:8788 node scripts/probe-hero.mjs [outdir]
import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://localhost:8788";
const out = process.argv[2] ?? "docs/screens";
const edge = process.env.CHROME_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ executablePath: edge, headless: true });
const cases = [
  ["js", { viewport: { width: 1440, height: 900 } }],
  ["nojs", { viewport: { width: 1440, height: 900 }, javaScriptEnabled: false }],
  ["reduced", { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }],
  ["mobile", { viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
const vis = () => ["#hero-title", ".hero__cta .btn"].map((s) => {
  const e = document.querySelector(s); const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
  let o = 1; for (let n = e; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
  return `${s}: opacity=${o.toFixed(2)} vis=${cs.visibility} top=${Math.round(r.top)}`;
}).join(" | ");
for (const [name, opts] of cases) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(150);
  console.log(name, "t=150ms", await page.evaluate(vis));
  await page.waitForTimeout(2200);
  console.log(name, "t=2.3s ", await page.evaluate(vis));
  await page.screenshot({ path: `${out}/hero-${name}-0.png` });
  if (name !== "nojs") {
    await page.mouse.wheel(0, 450); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/hero-${name}-450.png` });
    await page.mouse.wheel(0, 600); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/hero-${name}-1050.png` });
    console.log(name, "scrollY", await page.evaluate(() => scrollY), "docH", await page.evaluate(() => document.documentElement.scrollHeight), "famTop", await page.evaluate(() => Math.round(document.querySelector(".fam").getBoundingClientRect().top + scrollY)));
  }
  if (errs.length) console.log(name, "errors", errs);
  await ctx.close();
}
await browser.close();
