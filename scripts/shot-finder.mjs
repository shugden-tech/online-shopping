import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "docs", "screens");
mkdirSync(outDir, { recursive: true });

// BASE=http://localhost:8788 node scripts/shot-finder.mjs
const base = process.env.BASE ?? "http://localhost:4321";
const shots = [
  { name: "p9-finder-mood-360.png", hash: "#q=2&g=any&o=day", width: 360, height: 780, dpr: 2 },
  { name: "p9-finder-step3-360.png", hash: "#q=3&g=any&o=day&m=woody", width: 360, height: 780, dpr: 2 },
  { name: "p9-finder-step3-1440.png", hash: "#q=3&g=any&o=day&m=woody", width: 1440, height: 900, dpr: 1 },
];

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});

try {
  for (const s of shots) {
    const page = await browser.newPage({
      viewport: { width: s.width, height: s.height },
      deviceScaleFactor: s.dpr,
    });
    await page.goto(base + "/unertei-tanilts/" + s.hash, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${s.name}: scrollWidth - clientWidth = ${overflow}`);
    await page.screenshot({ path: resolve(outDir, s.name) });
    await page.close();
  }
} finally {
  await browser.close();
}
