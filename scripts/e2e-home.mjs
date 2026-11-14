// Phase 5 checks: layering slider (mask ramps, desktop scroll-snap track), sticky hero pin, reduced motion, scroll smoothness.
//   BASE=http://localhost:4321 node scripts/e2e-home.mjs
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
const open = async (opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/", { waitUntil: "networkidle" });
  return page;
};

/* ---- mobile: vertical list + scroll-driven mask ---- */
{
  const page = await open({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.locator(".ls").scrollIntoViewIfNeeded();
  await page.waitForSelector(".ls.is-in");
  const st = await page.$eval(".slider-list", (el) => {
    const cs = getComputedStyle(el);
    return { overflowY: cs.overflowY, snap: cs.scrollSnapType, mask: cs.maskImage || cs.webkitMaskImage, pos: getComputedStyle(el.closest(".ls")).position };
  });
  ok("container is position:relative", st.pos === "relative", st.pos);
  ok(".slider-list scrolls vertically with snap", st.overflowY === "scroll" && st.snap.includes("y"), JSON.stringify(st));
  ok("mask-image is a linear-gradient", st.mask.includes("linear-gradient"), st.mask);
  const card = await page.$eval(".ls__card", (el) => getComputedStyle(el).transition);
  ok("cards: opacity .65s sine", card.includes("opacity 0.65s cubic-bezier(0.445, 0.05, 0.55, 0.95)"), card);
  const delays = await page.$$eval(".ls__slide", (els) => els.slice(0, 3).map((e) => e.style.getPropertyValue("--delay")));
  ok("--delay = index x 80ms", delays.join() === "0ms,80ms,160ms", delays.join());

  const at = async (p) => {
    await page.$eval(".slider-list", (el, pp) => { el.style.scrollSnapType = "none"; el.scrollTop = (el.scrollHeight - el.clientHeight) * pp; }, p);
    await page.waitForTimeout(120);
    return page.$eval(".slider-list", (el) => [Number(el.style.getPropertyValue("--mask-top")), Number(el.style.getPropertyValue("--mask-bottom"))]);
  };
  const m0 = await at(0), m015 = await at(0.015), m03 = await at(0.0325), m05 = await at(0.05), m5 = await at(0.5), m8 = await at(0.8), m9 = await at(0.9), m1 = await at(1);
  console.log("   mask [top,bottom] alpha at p=0:", m0, "0.0325:", m03, "0.05:", m05, "0.5:", m5, "0.9:", m9, "1:", m1);
  ok("top alpha 1 until p=0.015", m0[0] === 1 && m015[0] > 0.97);
  ok("top alpha ramps across 0.015-0.05 (≈0.5 midway)", Math.abs(m03[0] - 0.5) < 0.06 && m05[0] < 0.03, String(m03[0]));
  ok("mid-list: both edges dissolved", m5[0] === 0 && m5[1] === 0);
  ok("bottom alpha ramps across 0.8-1.0", m8[1] < 0.03 && Math.abs(m9[1] - 0.5) < 0.06 && m1[1] === 1, `${m8[1]} ${m9[1]} ${m1[1]}`);
  const lib = await page.evaluate(() => performance.getEntriesByType("resource").some((r) => /swiper|gsap|ScrollTrigger/i.test(r.name)));
  ok("no slider/animation library downloaded", !lib);
  await at(0.2);
  await page.locator(".ls").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screens/p5-slider-mobile-390.png" });
  await page.context().close();
}

/* ---- desktop: scroll-snap track, neighbours ±7.5% and faded by distance, 700 ms glide ---- */
{
  const page = await open({ viewport: { width: 1440, height: 900 } });
  await page.locator(".ls").scrollIntoViewIfNeeded();
  await page.waitForSelector(".ls.is-in");
  await page.waitForTimeout(800);
  const name = () => page.locator(".ls__slide.is-active .ls__name").innerText();
  const slides = () => page.$$eval(".ls__slide", (els) => els.slice(0, 3).map((e) => ({ o: Number(e.style.opacity), t: e.style.translate, inert: e.inert })));
  const first = await name();
  const rest0 = await slides();
  console.log("   at rest:", JSON.stringify(rest0));
  ok("active slide opaque, neighbour faded but visible, ±7.5%", rest0[0].o === 1 && rest0[1].o > 0.1 && rest0[1].o < 0.4 && rest0[1].t.startsWith("-7.5") && rest0[2].o === 0, JSON.stringify(rest0));
  ok("only the active slide is focusable (others inert)", !rest0[0].inert && rest0[1].inert);
  const t0 = Date.now();
  await page.locator(".ls__arrow").nth(1).click();
  await page.waitForTimeout(350);
  const mid = await slides();
  console.log("   mid-transition slides:", JSON.stringify(mid));
  ok("mid-transition: both slides partly visible (crossfade)", mid.slice(0, 2).every((m) => m.o > 0.1 && m.o < 0.95), JSON.stringify(mid));
  await page.waitForFunction((n) => document.querySelector(".ls__slide.is-active .ls__name")?.textContent !== n, first);
  await page.waitForTimeout(500);
  const glide = await page.$eval(".ls__list", (el) => el.style.scrollSnapType);
  ok("700ms glide finished (snap restored)", glide === "" && Date.now() - t0 >= 650, `${glide} ${Date.now() - t0}ms`);
  const second = await name();
  ok("arrow advances the slide", first !== second, `${first} -> ${second}`);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(900);
  ok("keyboard arrow works", (await name()) !== second);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(900);
  ok("counter follows", (await page.locator(".ls__counter b").innerText()) === "02");
  await page.locator(".ls__slide.is-active .ls__actions button").click();
  await page.waitForSelector(".cd[data-open]");
  ok("quick-add opens the cart", (await page.locator(".cd__item").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await page.screenshot({ path: "docs/screens/p5-slider-desktop-1440.png" });

  // hero is pinned with position: sticky for ~100vh (no GSAP)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForSelector(".hero--live");
  const pin = await page.evaluate(() => ({ h: document.querySelector(".hero").getBoundingClientRect().height, pos: getComputedStyle(document.querySelector(".hero__pin")).position }));
  ok("hero pinned for ~100vh", Math.abs(pin.h - 1800) < 40 && pin.pos === "sticky", JSON.stringify(pin));
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(1200);
  const end = await page.evaluate(() => ({ top: Math.round(document.querySelector(".hero__pin").getBoundingClientRect().top), content: getComputedStyle(document.querySelector(".hero__content")).visibility, bottle: Number(getComputedStyle(document.querySelector(".hero__bottle--1")).opacity) }));
  ok("pin end: stage still in view, headline gone, bottles up", end.top === 0 && end.content === "hidden" && end.bottle > 0.95, JSON.stringify(end));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // scroll smoothness: frame times while scrolling the whole page, against the same loop on a blank tall page
  // (the machine's own frame cadence: headless Edge on battery / power-saver runs rAF at 30 Hz)
  const measure = (pg) => pg.evaluate(async () => {
    const times = [];
    let last = performance.now();
    let run = true;
    const tick = (t) => { times.push(t - last); last = t; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const max = document.documentElement.scrollHeight - innerHeight;
    for (let y = 0; y <= max; y += 40) { window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(r)); }
    run = false;
    times.shift();
    const sorted = [...times].sort((a, b) => a - b);
    return { frames: times.length, avg: times.reduce((a, b) => a + b, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], long: times.filter((t) => t > 50).length };
  });
  await measure(page); // warm-up pass: first-time lazy image fetch/decode is not animation jank
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  const stats = await measure(page);
  const blank = await page.context().newPage();
  await blank.setContent('<div style="height:9000px;background:linear-gradient(#111,#333)"></div>');
  const ref = await measure(blank);
  await blank.close();
  console.log("   scroll frame times (ms):", JSON.stringify(stats), " blank-page reference:", JSON.stringify(ref));
  const limit = Math.max(17, ref.p95 + 2);
  ok(`no jank while scrolling (p95 <= ${limit.toFixed(1)}ms, ≤2 frames > 50ms)`, stats.p95 <= limit && stats.long <= 2, JSON.stringify(stats));
  await page.context().close();
}

/* ---- reduced motion ---- */
{
  const page = await open({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.waitForTimeout(2500);
  ok("reduced: hero not pinned", (await page.locator(".hero--live").count()) === 0 && (await page.$eval(".hero__pin", (e) => getComputedStyle(e).position)) !== "sticky");
  const animJs = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => /gsap|ScrollTrigger|swiper/i.test(r.name)).length);
  ok("reduced: no animation library downloaded", animJs === 0);
  const blank = await page.$eval(".hero__dust", (c) => { const d = c.getContext("2d").getImageData(0, 0, c.width || 1, c.height || 1).data; return !d.some((v) => v !== 0); });
  ok("reduced: no particles drawn", blank);
  const reveal = await page.$$eval("[data-reveal]", (els) => els.every((e) => getComputedStyle(e).opacity === "1" && getComputedStyle(e).transform === "none"));
  ok("reduced: all content visible immediately (no fade)", reveal);
  const heroAnim = await page.$eval(".hero__title", (e) => getComputedStyle(e).opacity);
  ok("reduced: headline visible", heroAnim === "1");
  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.waitForTimeout(300);
  const x = await page.$eval("[data-band]", (e) => e.style.getPropertyValue("--x"));
  ok("reduced: no strip parallax", x === "", x);
  await page.context().close();
}

console.log("console errors:", errors.length ? errors : "none");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
await browser.close();
process.exit(fails ? 1 : 0);
