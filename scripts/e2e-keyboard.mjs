// Keyboard pass: Tab 40 times on key pages and check focus order and focus visibility.
//   BASE=http://localhost:8788 node scripts/e2e-keyboard.mjs
// Checks: (a) first Tab focuses .skip-link, (b) every focused element is visible and has
// a non-none outline or box-shadow, (c) focus does not land on <body> in the middle of the sequence
// (a body stop counts as the normal document-end wrap only when the stop before it is the last tabbable element
// in DOM order and the stop after it is the skip link again; any other body stop is focus loss).
import { chromium } from "playwright-core";

const base = process.env.BASE ?? "http://localhost:4321";
const edge = process.env.CHROME_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const pages = ["/", "/delguur/", "/delguur/baccarat-rouge-540/", "/zahialga/", "/tuslamj/"];
const TABS = 40;

const browser = await chromium.launch({ executablePath: edge, headless: true });
let failures = 0;

for (const path of pages) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" });

  const seq = [];
  for (let i = 0; i < TABS; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { body: true, tag: "BODY", cls: "", skip: false, visible: false, outline: "", shadow: "" };
      }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
      return {
        body: false,
        tag: el.tagName.toLowerCase(),
        cls,
        skip: el.matches(".skip-link"),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
        outline: cs.outlineStyle,
        shadow: cs.boxShadow,
        text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40),
        last: (() => {
          const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), iframe, summary';
          const all = [...document.querySelectorAll(sel)].filter((n) => {
            if (n.closest("[inert]") || n.tabIndex < 0) return false;
            const rr = n.getBoundingClientRect(); const st = getComputedStyle(n);
            return rr.width > 0 && rr.height > 0 && st.visibility !== "hidden";
          });
          return all[all.length - 1] === el;
        })(),
      };
    });
    seq.push({ i: i + 1, ...info });
  }

  const pageFails = [];
  if (!seq[0].skip) pageFails.push(`(a) first Tab is not .skip-link: got ${seq[0].tag}.${seq[0].cls}`);
  seq.forEach((s, idx) => {
    if (s.body) {
      const prev = seq[idx - 1];
      const next = seq[idx + 1];
      const wrap = prev && prev.last && (!next || next.skip);
      if (!wrap) pageFails.push(`(c) Tab ${s.i}: focus on <body> mid-sequence (previous stop ${prev ? prev.tag + "." + prev.cls : "none"})`);
      return;
    }
    if (!s.visible) pageFails.push(`(b) Tab ${s.i}: focused element not visible: ${s.tag}.${s.cls}`);
    if (s.outline === "none" && s.shadow === "none") {
      pageFails.push(`(b) Tab ${s.i}: no focus indicator (outline-style none, box-shadow none): ${s.tag}.${s.cls} "${s.text}"`);
    }
  });

  const bodyStops = seq.filter((s) => s.body).map((s) => s.i);
  const focusables = seq.filter((s) => !s.body).length;
  console.log(`\n${path}  focused stops=${focusables}/${TABS}  body stops at Tab ${bodyStops.length ? bodyStops.join(", ") : "none"}`);
  console.log("  sequence: " + seq.map((s) => `${s.i}:${s.body ? "BODY" : s.tag + (s.cls ? "." + s.cls.split(" ")[0] : "")}`).join(" | "));
  if (pageFails.length) {
    for (const f of pageFails) console.log("  FAIL " + f);
    failures += pageFails.length;
  } else {
    console.log("  PASS");
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${failures ? "FAILED" : "ALL PASSED"} (${failures} failure(s))`);
process.exitCode = failures ? 1 : 0;
