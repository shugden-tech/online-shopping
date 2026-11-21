// Phase 6 checks: keyboard-only run, refresh keeps the step, sensible results per answer path.
//   BASE=http://localhost:4321 node scripts/e2e-finder.mjs
import { chromium } from "playwright-core";
const base = process.env.BASE ?? "http://localhost:4321";
const edge = process.env.CHROME_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({ executablePath: edge, headless: true });
let fails = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${cond ? "" : extra}`);
  if (!cond) fails++;
};
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const url = base + "/unertei-tanilts/";
const step = () => page.$eval(".sf", (e) => Number(e.dataset.step));
const names = () => page.$$eval(".sf__name", (els) => els.map((e) => e.innerText.trim()));

/* ---- keyboard only ---- */
await page.goto(url, { waitUntil: "networkidle" });
const tabTo = async (selector, max = 40) => {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return true;
    await page.keyboard.press("Tab");
  }
  return page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector);
};
ok("kbd: reach Begin", await tabTo(".sf__intro .btn"));
await page.keyboard.press("Enter");
ok("kbd: step 1", (await step()) === 1);
ok("kbd: focus moved to the question", await page.evaluate(() => document.activeElement?.classList.contains("sf__title")));
ok("kbd: Next disabled until answered", await page.locator(".sf__navbtn--next").isDisabled());
await tabTo('input[name="who"]');
await page.keyboard.press("ArrowDown"); // radio group: arrow moves to "men" and auto-advances
ok("kbd: who auto-advances", (await step()) === 2);
ok("kbd: men chosen", (await page.evaluate(() => location.hash)).includes("g=men"));
await tabTo('input[name="when"]');
await page.keyboard.press("ArrowRight"); // night
ok("kbd: when auto-advances", (await step()) === 3);
ok("kbd: night chosen", (await page.evaluate(() => location.hash)).includes("o=night"));
await tabTo('input[name="mood"]');
await page.keyboard.press("Space"); // amber
ok("kbd: mood auto-advances", (await step()) === 4);
await tabTo('.sf__notes input[type="checkbox"]');
await page.keyboard.press("Space"); // amber accord
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
await page.keyboard.press("Space"); // vanilla
ok("kbd: 2 notes checked", (await page.locator(".sf__notes input:checked").count()) === 2);
await tabTo(".sf__navbtn--next");
await page.keyboard.press("Enter");
ok("kbd: step 5", (await step()) === 5);
await tabTo('.sf__range input[type="range"]');
const before = await page.$eval(".sf__range input", (e) => e.value);
await page.keyboard.press("ArrowUp");
const after = await page.$eval(".sf__range input", (e) => e.value);
ok("kbd: range responds to arrow keys", before === "3" && after === "4", `${before} -> ${after}`);
ok("kbd: keyboard slider stays on the step", (await step()) === 5);
ok("range has aria-valuetext", (await page.$eval(".sf__range input", (e) => e.getAttribute("aria-valuetext"))) === "Хүчтэй");
await page.screenshot({ path: "docs/screens/p6-finder-slider-1440.png" });

/* ---- refresh keeps the step ---- */
const hashBefore = new URL(page.url()).hash;
await page.reload({ waitUntil: "networkidle" });
ok("refresh keeps step 5 and answers", (await step()) === 5 && (await page.$eval(".sf__range input", (e) => e.value)) === "4", hashBefore);
await page.locator(".sf__navbtn--next").focus();
await page.keyboard.press("Enter");
ok("result step", (await step()) === 6);
const r1 = await names();
console.log("   men / night / amber / amber+vanilla / 4 ->", r1.join(" | "));
console.log("   why:", (await page.locator(".sf__why").first().innerText()));
ok("3 results", r1.length === 3);
ok("men path excludes women-only scents", !r1.some((n) => ["Black Opium", "Libre", "J'adore", "Coco Mademoiselle", "Light Blue", "Chance Eau Tendre"].includes(n)));
await page.screenshot({ path: "docs/screens/p6-finder-result-1440.png", fullPage: true });
await page.reload({ waitUntil: "networkidle" });
ok("refresh keeps the result", (await step()) === 6 && (await names()).join() === r1.join());
await page.locator(".sf__result-actions .btn--gold").click();
await page.waitForSelector(".cd[data-open]");
ok("add all -> 3 cart lines", (await page.locator(".cd__item").count()) === 3);

/* ---- answer paths ---- */
const paths = [
  ["women / day / citrus / white-flowers / 2", "#q=6&g=women&o=day&m=citrus&n=white-flowers&i=2", (n) => n.includes("Light Blue") || n.includes("Neroli Portofino")],
  ["men / office / woody / woods,incense / 3", "#q=6&g=men&o=office&m=woody&n=woods,incense-minerals&i=3", (n) => n.includes("Bleu de Chanel")],
  ["any / date / amber / vanilla,amber / 5", "#q=6&g=any&o=date&m=amber&n=vanilla,amber&i=5", (n) => n.includes("Tobacco Vanille") || n.includes("Grand Soir")],
  ["any / day / fresh / green-notes / 2", "#q=6&g=any&o=day&m=fresh&n=green-notes&i=2", (n) => n.includes("Philosykos")],
  ["women / night / chypre / none / 4", "#q=6&g=women&o=night&m=chypre&i=4", (n) => n.includes("Coco Mademoiselle")],
  ["men / day / citrus / none / 1", "#q=6&g=men&o=day&m=citrus&i=1", (n) => n.includes("Colonia")],
];
for (const [label, hash, check] of paths) {
  await page.goto("about:blank");
  await page.goto(url + hash, { waitUntil: "networkidle" });
  const n = await names();
  console.log(`   ${label} -> ${n.join(" | ")}`);
  ok(`path: ${label}`, n.length === 3 && check(n), n.join(" | "));
}
await page.goto("about:blank");
await page.goto(url + "#q=6&g=women", { waitUntil: "networkidle" });
ok("tampered hash falls back to the first unanswered step", (await step()) === 2);

/* ---- mobile screenshots ---- */
const m = await (await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 })).newPage();
for (const [n, h] of [[0, ""], [1, "#q=1"], [3, "#q=3&g=any&o=day&m=woody"], [4, "#q=4&g=any&o=day&m=woody&n=oud"], [5, "#q=5&g=any&o=day&m=woody&i=2"], [6, "#q=6&g=any&o=day&m=woody&n=oud&i=3"]]) {
  await m.goto("about:blank");
  await m.goto(url + h, { waitUntil: "networkidle" });
  await m.waitForTimeout(1300);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`mobile step ${n}: no horizontal overflow`, overflow === 0, String(overflow));
  await m.screenshot({ path: `docs/screens/p6-finder-step${n}-360.png`, fullPage: n === 6 });
}
console.log("console errors:", errors.length ? errors : "none");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await browser.close();
process.exit(fails ? 1 : 0);
