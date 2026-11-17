#!/usr/bin/env node
// A1 catalog importer: owner's R2 catalog (1000 items) + src/content/products/*.json -> SQL for D1.
//
//   node scripts/import-catalog.mjs                       # writes data/catalog/import.sql
//   node scripts/import-catalog.mjs --refresh             # writes data/catalog/import-refresh.sql (descriptive fields only)
//   node scripts/import-catalog.mjs --fetch               # re-download the catalog snapshot first
//   node scripts/import-catalog.mjs --demo-prices         # ALSO writes data/catalog/demo-prices.local.sql (LOCAL ONLY)
//   node scripts/import-catalog.mjs --apply local [--persist-to .wrangler/state-a1]
//   node scripts/import-catalog.mjs --apply remote        # (refused together with --demo-prices)
//
// Rules (docs/CONTRACTS.md §1): never invents prices or stock. Every SKU is written with price NULL and
// stock NULL. Products are `ON CONFLICT(id) DO NOTHING` (re-running is a no-op); `--refresh` updates only
// brand, name, concentration, release_year, notes, descriptions, images (and gender/family when NULL) —
// never status, sale_locked, sort, prices or stock — and never touches products created in the admin.
// `--demo-prices` copies the build-time JSON prices into a SEPARATE file for a local dev database only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_URL = "https://pub-83d529150bc84a489ddcb74b42624830.r2.dev/catalog.json";
const OUT_DIR = join(ROOT, "data/catalog");
const SNAPSHOT = join(OUT_DIR, "catalog.json");
const CONTENT_DIR = join(ROOT, "src/content/products");
const NOTES_FILE = join(ROOT, "src/data/notes.json");
const ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const CONCENTRATIONS = new Set(["EDP", "EDT", "Parfum", "Extrait", "Cologne"]);

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = {
  refresh: flag("--refresh"),
  fetch: flag("--fetch"),
  demoPrices: flag("--demo-prices"),
  apply: flag("--remote") ? "remote" : opt("--apply"),
  persistTo: opt("--persist-to"),
  db: opt("--db") ?? "genzst",
  quiet: flag("--quiet"),
};
if (flag("--help") || flag("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).join("\n"));
  process.exit(0);
}
if (args.apply && !["local", "remote"].includes(args.apply)) die(`--apply must be "local" or "remote" (got ${args.apply})`);
if (args.demoPrices && args.apply === "remote") die("--demo-prices is for a LOCAL development database only; refusing --remote.");
if (args.persistTo && args.apply !== "local") die("--persist-to only makes sense with --apply local");

function die(msg) {
  console.error(`import-catalog: ${msg}`);
  process.exit(2);
}
const log = (...a) => {
  if (!args.quiet) console.log(...a);
};

/* ---------- inputs ---------- */
async function loadCatalog() {
  if (args.fetch || !existsSync(SNAPSHOT)) {
    log(`downloading ${CATALOG_URL}`);
    const res = await fetch(CATALOG_URL);
    if (!res.ok) die(`catalog download failed: HTTP ${res.status}`);
    const text = await res.text();
    JSON.parse(text); // validate before overwriting the snapshot
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(SNAPSHOT, text);
  }
  const data = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  if (!Array.isArray(data)) die("catalog.json is not an array");
  return data;
}

function loadContent() {
  return readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const p = JSON.parse(readFileSync(join(CONTENT_DIR, f), "utf8"));
      if (p.slug !== f.slice(0, -5)) die(`${f}: slug "${p.slug}" does not match the file name`);
      return p;
    });
}

/* ---------- helpers ---------- */
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`bad number ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
const intOr = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
/** Remote https URL or a site path; anything else (e.g. astro-relative "./photos/x.jpg") is dropped. */
const imageUrl = (v) => (typeof v === "string" && (/^https:\/\/[^\s"'<>\\]+$/.test(v) || /^\/[^/\s"'<>\\][^\s"'<>\\]*$/.test(v)) ? v : null);

/* ---------- merge ---------- */
function build(catalog, content, noteLabels) {
  const label = (id) => noteLabels[id]?.en ?? id;
  const contentById = new Map(content.map((p) => [p.slug, p]));
  const catalogById = new Map();
  const warnings = [];
  for (const c of catalog) {
    if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) {
      warnings.push(`catalog item with bad id skipped: ${JSON.stringify(c?.id)}`);
      continue;
    }
    if (catalogById.has(c.id)) warnings.push(`duplicate catalog id ${c.id} (first one kept)`);
    else catalogById.set(c.id, c);
  }
  const ids = [...new Set([...catalogById.keys(), ...contentById.keys()])].sort();
  const products = [];
  const skus = [];
  const demo = [];
  let collisions = 0;
  for (const id of ids) {
    const c = catalogById.get(id);
    const k = contentById.get(id);
    const cNotes = c?.notes ?? {};
    const kNotes = k?.notes ?? {};
    const notes = c
      ? { top: strList(cNotes.top), heart: strList(cNotes.heart), base: strList(cNotes.base) }
      : { top: strList(kNotes.top).map(label), heart: strList(kNotes.heart).map(label), base: strList(kNotes.base).map(label) };
    // content files may list a flat, tier-less note list; keep it (not assigned to a tier) for the admin.
    if (!c && strList(kNotes.key).length) notes.key = strList(kNotes.key).map(label);
    const conc = CONCENTRATIONS.has(c?.concentration) ? c.concentration : CONCENTRATIONS.has(k?.concentration) ? k.concentration : null;
    const front = imageUrl(c?.images?.front) ?? imageUrl(k?.photos?.front);
    const back = imageUrl(c?.images?.back) ?? imageUrl(k?.photos?.back);
    products.push({
      id,
      brand: String(c?.brand ?? k?.brand ?? "").trim(),
      name: String(c?.name ?? k?.name ?? "").trim(),
      concentration: conc,
      gender: k && ["women", "men", "unisex"].includes(k.gender) ? k.gender : null,
      family: k && typeof k.family === "string" ? k.family : null,
      release_year: intOr(c?.release_year, 1700, 2100),
      notes_json: JSON.stringify(notes),
      description_mn: k?.description?.mn ?? null,
      description_en: k?.description?.en ?? null,
      image_front: front,
      image_back: back,
      status: k ? "active" : "draft",
      source: c ? "r2-catalog" : "content",
    });
    if (!products.at(-1).brand || !products.at(-1).name) die(`product ${id} has no brand or name`);

    // SKUs: content sizes win over catalog bottle sizes with the same ml (the storefront sells those).
    const byMl = new Map();
    for (const s of Array.isArray(k?.sizes) ? k.sizes : []) {
      const ml = intOr(s.ml, 1, 1000);
      if (!ml || byMl.has(ml)) continue;
      byMl.set(ml, { kind: s.full ? "full" : "decant", from: "content" });
      if (Number.isInteger(s.price) && s.price > 0) demo.push({ id: `${id}:${ml}`, price: s.price });
    }
    for (const raw of Array.isArray(c?.bottle_sizes_ml) ? c.bottle_sizes_ml : []) {
      const ml = intOr(raw, 1, 1000);
      if (!ml) continue;
      if (byMl.has(ml)) {
        if (byMl.get(ml).kind !== "full") collisions++;
        continue;
      }
      byMl.set(ml, { kind: "full", from: "catalog" });
    }
    for (const [ml, s] of [...byMl].sort((a, b) => a[0] - b[0])) skus.push({ id: `${id}:${ml}`, product_id: id, ml, kind: s.kind });
  }
  return { products, skus, demo, warnings, collisions, inCatalog: catalogById.size, inContent: contentById.size };
}

/* ---------- SQL ---------- */
const PRODUCT_COLS = ["id", "brand", "name", "concentration", "gender", "family", "release_year", "notes_json", "description_mn", "description_en", "image_front", "image_back", "status", "source"];

function productSql(p, refresh) {
  const head = `INSERT INTO products (${PRODUCT_COLS.join(", ")}) VALUES (${PRODUCT_COLS.map((c) => q(p[c])).join(", ")})`;
  if (!refresh) return `${head} ON CONFLICT(id) DO NOTHING;`;
  return (
    `${head} ON CONFLICT(id) DO UPDATE SET brand = excluded.brand, name = excluded.name, ` +
    `concentration = COALESCE(excluded.concentration, products.concentration), ` +
    `release_year = COALESCE(excluded.release_year, products.release_year), notes_json = excluded.notes_json, ` +
    `description_mn = COALESCE(excluded.description_mn, products.description_mn), ` +
    `description_en = COALESCE(excluded.description_en, products.description_en), ` +
    `image_front = COALESCE(excluded.image_front, products.image_front), ` +
    `image_back = COALESCE(excluded.image_back, products.image_back), ` +
    `gender = COALESCE(products.gender, excluded.gender), family = COALESCE(products.family, excluded.family), ` +
    `updated_at = datetime('now') WHERE products.source <> 'admin';`
  );
}

const skuSql = (s) =>
  `INSERT INTO skus (id, product_id, ml, kind, price, compare_at, stock, reserved, active) VALUES (${q(s.id)}, ${q(s.product_id)}, ${s.ml}, ${q(s.kind)}, NULL, NULL, NULL, 0, 1) ON CONFLICT(id) DO NOTHING;`;

function writeSql(file, header, lines) {
  const text = [...header.map((h) => `-- ${h}`), "", ...lines, ""].join("\n");
  writeFileSync(file, text);
  return Buffer.byteLength(text);
}

function wrangler(file) {
  const cmd = ["wrangler", "d1", "execute", args.db, args.apply === "remote" ? "--remote" : "--local", "--file", file];
  if (args.persistTo) cmd.push("--persist-to", args.persistTo);
  log(`> npx ${cmd.join(" ")}`);
  execFileSync("npx", cmd, { cwd: ROOT, stdio: args.quiet ? ["ignore", "ignore", "inherit"] : "inherit" });
}

/* ---------- main ---------- */
const catalog = await loadCatalog();
const content = loadContent();
const noteLabels = JSON.parse(readFileSync(NOTES_FILE, "utf8"));
const r = build(catalog, content, noteLabels);
for (const w of r.warnings) console.warn(`warning: ${w}`);

const stamp = new Date().toISOString();
mkdirSync(OUT_DIR, { recursive: true });
const mainFile = join(OUT_DIR, args.refresh ? "import-refresh.sql" : "import.sql");
const mainBytes = writeSql(
  mainFile,
  [
    `GenZst catalog import (${args.refresh ? "REFRESH: descriptive fields only" : "insert-only"}) — generated by scripts/import-catalog.mjs`,
    `Sources: ${CATALOG_URL} (snapshot data/catalog/catalog.json, ${r.inCatalog} items) + src/content/products (${r.inContent} files)`,
    `Generated ${stamp}. Prices and stock are NULL on every SKU: nothing here is for sale until the owner sets a price.`,
    `Idempotent: safe to apply more than once. Apply: npx wrangler d1 execute genzst --local|--remote --file ${mainFile.slice(ROOT.length + 1)}`,
  ],
  [...r.products.map((p) => productSql(p, args.refresh)), ...r.skus.map(skuSql)],
);

let demoFile = null;
if (args.demoPrices) {
  demoFile = join(OUT_DIR, "demo-prices.local.sql");
  writeSql(
    demoFile,
    [
      "=====================================================================",
      "LOCAL DEMO PRICES — never apply to production",
      "=====================================================================",
      "Copies the build-time demo prices from src/content/products/*.json into skus.price for a LOCAL",
      "development database. These are placeholder figures, NOT the owner's prices. Stock stays NULL.",
      "Only fills SKUs whose price is still NULL. Apply after import.sql with --local only.",
    ],
    r.demo.map((d) => `UPDATE skus SET price = ${d.price}, updated_at = datetime('now') WHERE id = ${q(d.id)} AND price IS NULL;`),
  );
}

/* ---------- report ---------- */
const count = (arr, key) => arr.reduce((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
const bySourceStatus = count(r.products.map((p) => ({ k: `${p.source}/${p.status}` })), "k");
log(`products: ${r.products.length}  (by source/status: ${JSON.stringify(bySourceStatus)})`);
log(`skus: ${r.skus.length}  (by kind: ${JSON.stringify(count(r.skus, "kind"))}; content decant over catalog bottle size collisions: ${r.collisions})`);
log(`missing front image: ${r.products.filter((p) => !p.image_front).length}; missing back image: ${r.products.filter((p) => !p.image_back).length}`);
log(`wrote ${mainFile.slice(ROOT.length + 1)} (${(mainBytes / 1024).toFixed(0)} KB)${mainBytes > 2 * 1024 * 1024 ? " — over 2 MB: keep it out of git" : ""}`);
if (demoFile) log(`wrote ${demoFile.slice(ROOT.length + 1)} (${r.demo.length} LOCAL DEMO price updates — never apply to production)`);

if (args.apply) {
  wrangler(mainFile);
  if (demoFile) wrangler(demoFile);
  log(`applied to ${args.apply} database "${args.db}"`);
}
