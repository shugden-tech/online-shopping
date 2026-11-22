// Screenshot helper used during verification.
//   node scripts/shot.mjs <url-path> <name> [widths=360,768,1440] [--full] [--base=http://localhost:4321]
// Writes docs/screens/<name>-<width>.png and prints console errors.
import { chromium } from "playwright-core";
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [path = "/", name = "page", widthsArg = "360,768,1440"] = args.filter((a) => !a.startsWith("--"));
const base = flags.find((f) => f.startsWith("--base="))?.slice(7) ?? "http://localhost:4321";
const full = flags.includes("--full");
const scrollY = Number(flags.find((f) => f.startsWith("--y="))?.slice(4) ?? 0);
const edge = process.env.CHROME_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ executablePath: edge, headless: true });
for (const w of widthsArg.split(",").map(Number)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 500 ? 780 : 900 }, deviceScaleFactor: w < 500 ? 2 : 1, reducedMotion: flags.includes("--reduced") ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (full) {
    // a full-page capture can't show a scroll sequence: drop the home hero's pin length (it would be 100vh of
    // empty stage below the hero) so the capture shows the hero at its first-paint state, then the sections
    await page.addStyleTag({ content: ".hero--live{height:auto!important;min-height:0!important}.hero--live .hero__pin{position:relative!important}" });
    // walk the page so lazy images and scroll reveals are triggered
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 500) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(120); }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  if (scrollY) await page.evaluate((yy) => window.scrollTo(0, yy), scrollY);
  await page.waitForTimeout(900);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: `docs/screens/${name}-${w}.png`, fullPage: full });
  console.log(`${name}-${w}.png  h-overflow=${overflow}px  errors=${errors.length ? JSON.stringify(errors) : "none"}`);
  await ctx.close();
}
await browser.close();
