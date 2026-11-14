// Summarize Lighthouse JSON reports.
//   node scripts/lh-summary.mjs <name>
// Reads docs/lighthouse/<name>-r1.report.json and <name>-r2.report.json (any -rN found),
// keeps the run with the better performance score, and prints scores, metrics, failing audits, top opportunities.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/lh-summary.mjs <name>");
  process.exit(2);
}
const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "docs", "lighthouse");
const runs = readdirSync(dir)
  .filter((f) => new RegExp(`^${name}-r\\d+\\.report\\.json$`).test(f))
  .sort()
  .map((f) => {
    const lhr = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return { file: f, lhr, perf: Math.round((lhr.categories.performance.score ?? 0) * 100) };
  });
if (!runs.length) {
  console.error(`no runs for ${name} in ${dir}`);
  process.exit(1);
}

console.log(`== ${name}: ${runs.map((r) => `${r.file}=perf ${r.perf}`).join(", ")}`);
const best = runs.reduce((a, b) => (b.perf > a.perf ? b : a));
const { lhr } = best;
const score = (c) => Math.round((lhr.categories[c].score ?? 0) * 100);
const metric = (id) => lhr.audits[id]?.numericValue;
const display = (id) => lhr.audits[id]?.displayValue ?? "";

console.log(`selected run: ${best.file}`);
console.log(`URL: ${lhr.requestedUrl}  emulated: ${lhr.configSettings.formFactor} ${lhr.configSettings.emulatedUserAgent ? "(ua set)" : ""} throttling: ${lhr.configSettings.throttlingMethod}`);
console.log(`scores: performance=${score("performance")} accessibility=${score("accessibility")} best-practices=${score("best-practices")} seo=${score("seo")}`);
console.log(`metrics: FCP=${Math.round(metric("first-contentful-paint"))}ms LCP=${Math.round(metric("largest-contentful-paint"))}ms TBT=${Math.round(metric("total-blocking-time"))}ms CLS=${metric("cumulative-layout-shift").toFixed(3)} SpeedIndex=${Math.round(metric("speed-index"))}ms`);
console.log(`metric displays: FCP="${display("first-contentful-paint")}" LCP="${display("largest-contentful-paint")}" TBT="${display("total-blocking-time")}" CLS="${display("cumulative-layout-shift")}"`);

for (const cat of ["accessibility", "best-practices", "seo"]) {
  const failing = lhr.categories[cat].auditRefs
    .map((ref) => lhr.audits[ref.id])
    .filter((a) => a && a.score !== null && a.score < 0.9);
  console.log(`\nFailing audits (<0.9) in ${cat}: ${failing.length}`);
  for (const a of failing) console.log(`  - ${a.title} [score ${a.score}]${a.displayValue ? " " + a.displayValue : ""}`);
}

const perfRefs = lhr.categories.performance.auditRefs.map((ref) => ({ ref, a: lhr.audits[ref.id] }));
const opp = perfRefs
  .filter(({ ref, a }) => a && a.score !== null && a.score < 0.9 && (ref.group === "load-opportunities" || a.details?.type === "opportunity"))
  .sort((x, y) => (y.a.details?.overallSavingsMs ?? 0) - (x.a.details?.overallSavingsMs ?? 0));
const diag = perfRefs
  .filter(({ a }) => a && a.score !== null && a.score < 0.9 && a.details?.type !== "opportunity")
  .sort((x, y) => x.a.score - y.a.score);
const top = [...opp, ...diag].slice(0, 5);
console.log(`\nTop performance opportunities/diagnostics (up to 5):`);
if (!top.length) console.log("  none below 0.9");
for (const { a } of top) {
  const save = a.details?.overallSavingsMs ? ` savings=${Math.round(a.details.overallSavingsMs)}ms` : "";
  console.log(`  - ${a.title} [score ${a.score}]${save}${a.displayValue ? " :: " + a.displayValue : ""}`);
}
