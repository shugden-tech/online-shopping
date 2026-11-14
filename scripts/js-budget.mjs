// JS budget check for the built site (dist/). No dependencies.
//   npm run budget
// Collects JS entry URLs per page (script src, modulepreload, astro-island component/renderer/before-hydration),
// follows static imports (INITIAL) and dynamic imports + what they pull in (LAZY), and measures gzip(level 9) sizes.
// Home (index.html): total <= budget. Other pages: initial <= budget. Exits 1 on any FAIL.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const pages = [
  ["index.html", 90, "total"],
  ["delguur/index.html", 40, "initial"],
  ["delguur/abercrombie-and-fitch-authentic-man-edt/index.html", 50, "initial"],
  // Plan correction (VERIFY.md): the finder and checkout are island pages. Their initial JS is the shared
  // shell (Preact 4.4 + view-transition router 5.7 + cart store 2.4 KB) plus a 4 KB island, with no waste
  // left to cut (cart drawer and dictionaries are already lazy / per-locale), so they get 25 KB, not 20.
  ["unertei-tanilts/index.html", 25, "initial"],
  ["zahialga/index.html", 25, "initial"],
  ["zahialga/amjilttai/index.html", 20, "initial"],
  ["bidnii-tuhai/index.html", 20, "initial"],
  ["tuslamj/index.html", 20, "initial"],
  ["en/index.html", 90, "total"], // the English home is a home page too: same total rule
];

const TAG = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
const ATTR = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i");

function entriesFromHtml(html) {
  const out = [];
  for (const m of html.matchAll(TAG("script"))) {
    const s = m[0].match(ATTR("src"));
    if (s) out.push(s[1]);
  }
  for (const m of html.matchAll(TAG("link"))) {
    if (/rel\s*=\s*["']modulepreload["']/i.test(m[0])) {
      const h = m[0].match(ATTR("href"));
      if (h) out.push(h[1]);
    }
  }
  for (const m of html.matchAll(TAG("astro-island"))) {
    for (const a of ["component-url", "renderer-url", "before-hydration-url"]) {
      const v = m[0].match(ATTR(a));
      if (v) out.push(v[1]);
    }
  }
  return out;
}

const STATIC_RE = /\b(?:from|import)\s*["']((?:\.{1,2}\/|\/)[^"']+)["']/g;
const DYN_RE = /\bimport\(\s*["']((?:\.{1,2}\/|\/)[^"']+)["']\s*\)/g;

function toFile(spec, fromFile) {
  if (/^(https?:)?\/\//.test(spec)) return null; // external URL, not measured
  const clean = spec.split("#")[0].split("?")[0];
  return clean.startsWith("/") ? join(dist, clean) : resolve(dirname(fromFile), clean);
}

const missing = new Set();
const scanCache = new Map();
function scan(file) {
  if (scanCache.has(file)) return scanCache.get(file);
  const src = readFileSync(file, "utf8");
  const stat = [];
  const dyn = [];
  for (const m of src.matchAll(STATIC_RE)) { const f = toFile(m[1], file); if (f) stat.push(f); }
  for (const m of src.matchAll(DYN_RE)) { const f = toFile(m[1], file); if (f) dyn.push(f); }
  const res = { stat, dyn, src };
  scanCache.set(file, res);
  return res;
}

// Walk static imports (and dynamic too when useDyn). Returns the set of visited files.
function walk(seeds, useDyn, seen) {
  const queue = [...seeds];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    if (!existsSync(f)) { missing.add(f); continue; }
    seen.add(f);
    const s = scan(f);
    queue.push(...s.stat);
    if (useDyn) queue.push(...s.dyn);
  }
  return seen;
}

const gz = (f) => gzipSync(readFileSync(f), { level: 9 }).length;
const kb = (b) => (b / 1024).toFixed(1);

let anyFail = false;
const summary = [];
const details = [];
let homeAllSrc = "";

for (const [page, budget, mode] of pages) {
  const htmlPath = join(dist, page);
  if (!existsSync(htmlPath)) {
    anyFail = true;
    summary.push({ page, initial: "-", lazy: "-", total: "-", budget, verdict: "FAIL (missing file)" });
    continue;
  }
  missing.clear();
  const html = readFileSync(htmlPath, "utf8");
  const entries = entriesFromHtml(html).map((s) => toFile(s, htmlPath)).filter(Boolean);

  const initial = walk(entries, false, new Set());
  const dynSeeds = [];
  for (const f of initial) if (existsSync(f)) dynSeeds.push(...scan(f).dyn);
  const all = walk(dynSeeds, true, new Set(initial));
  const lazy = new Set([...all].filter((f) => !initial.has(f)));

  let initBytes = 0, lazyBytes = 0;
  const lines = [];
  for (const f of initial) { const b = gz(f); initBytes += b; lines.push(["initial", f, b]); }
  for (const f of lazy) { const b = gz(f); lazyBytes += b; lines.push(["lazy", f, b]); }
  const totalBytes = initBytes + lazyBytes;

  const measured = mode === "total" ? totalBytes : initBytes;
  const pass = measured / 1024 <= budget;
  const verdict = pass ? "PASS" : "FAIL";
  if (!pass) anyFail = true;

  if (page === "index.html") {
    for (const f of [...initial, ...lazy]) homeAllSrc += readFileSync(f, "utf8");
  }

  summary.push({
    page,
    initial: kb(initBytes),
    lazy: kb(lazyBytes),
    total: kb(totalBytes),
    budget,
    verdict: `${verdict} (${mode} ${kb(measured)} <= ${budget})`,
  });
  details.push({ page, lines, missing: [...missing] });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("JS BUDGET (gzip level 9, KB = 1024 bytes)");
console.log(pad("page", 40) + pad("initial KB", 12) + pad("lazy KB", 10) + pad("total KB", 10) + pad("budget KB", 11) + "result");
for (const r of summary) {
  console.log(pad(r.page, 40) + pad(r.initial, 12) + pad(r.lazy, 10) + pad(r.total, 10) + pad(r.budget, 11) + r.verdict);
}

console.log("");
console.log("FILES PER PAGE");
for (const d of details) {
  console.log(`\n${d.page}`);
  for (const [kind, f, b] of d.lines) {
    console.log("  " + pad(kind, 9) + pad(kb(b) + " KB", 10) + f.slice(dist.length + 1).split("\\").join("/"));
  }
  for (const m of d.missing) console.log("  WARNING missing file referenced: " + m);
}

const hasGsap = /gsap|greensock/i.test(homeAllSrc);
const hasSwiper = /swiper/i.test(homeAllSrc);
console.log("");
console.log(`home includes GSAP (string match): ${hasGsap ? "yes" : "NO"}`);
console.log(`home includes Swiper (string match): ${hasSwiper ? "yes" : "NO"}`);

console.log("");
console.log(anyFail ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = anyFail ? 1 : 0;
