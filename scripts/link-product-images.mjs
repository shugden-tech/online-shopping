// Link front/back product photos from decantx/merged.json into src/content/products/*.json.
//   node scripts/link-product-images.mjs            -> dry run: prints the report, writes nothing
//   node scripts/link-product-images.mjs --write    -> also writes `photos` into the matched product files
//
// Only the `photos` field is added/updated. Slug, price, sizes, stock, descriptions and every other
// field are left exactly as they are. merged.json is read here at authoring time only; the site never
// imports it, so it is never sent to the browser.
//
// Matching is deliberately strict. A product is linked automatically only when exactly one
// merged.json entry has the same brand, the same perfume name with nothing extra (no flanker such as
// "Intense", "Elixir", "Absolu"), the same concentration and the same gender. Anything less certain is
// reported as "doubtful" and is NOT linked.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS_DIR = path.join(ROOT, "src/content/products");
const MERGED = path.join(ROOT, "decantx/merged.json");
const WRITE = process.argv.includes("--write");

/** Lowercase, strip accents/diacritics, unify & and apostrophes, drop punctuation, collapse spaces. */
export function norm(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Brand spellings that refer to the same house. Keys and values are normalised.
const BRAND_ALIASES = {
  "kilian paris": ["by kilian", "kilian"],
  "giorgio armani": ["armani"],
  "jo malone london": ["jo malone"],
  "maison margiela": ["maison martin margiela"],
  "dior": ["christian dior"],
  "yves saint laurent": ["ysl"],
};
const brandForms = (brand) => {
  const b = norm(brand);
  const forms = new Set([b, ...(BRAND_ALIASES[b] ?? [])]);
  for (const [k, vs] of Object.entries(BRAND_ALIASES)) if (vs.includes(b)) { forms.add(k); vs.forEach((v) => forms.add(v)); }
  return [...forms].sort((a, c) => c.length - a.length); // longest first, for prefix stripping
};

// Concentration phrases as they appear at the end of merged.json names (normalised).
const CONC_PHRASES = {
  EDT: ["eau de toilette"],
  EDP: ["eau de parfum"],
  Parfum: ["parfum", "le parfum"],
  Extrait: ["extrait de parfum", "extrait"],
  Cologne: ["eau de cologne", "cologne"],
};
const GENDER_PHRASES = { men: ["for men", "pour homme"], women: ["for women", "pour femme"], unisex: ["unisex"] };
const allConc = Object.entries(CONC_PHRASES).flatMap(([k, ps]) => ps.map((p) => [k, p])).sort((a, b) => b[1].length - a[1].length);
const allGender = Object.entries(GENDER_PHRASES).flatMap(([k, ps]) => ps.map((p) => [k, p]));

/**
 * Split a merged.json name into { core, conc, gender } after removing the brand prefix.
 * "Giorgio Armani Acqua di Gio Eau de Toilette for Men" -> { core: "acqua di gio", conc: "EDT", gender: "men" }
 */
function parseMergedName(m, forms) {
  let s = norm(m.name);
  const brandHit = forms.find((f) => s === f || s.startsWith(f + " "));
  if (!brandHit) return null;
  s = s.slice(brandHit.length).trim();
  let gender = null;
  for (const [g, p] of allGender) if (s.endsWith(" " + p) || s === p) { gender = g; s = s.slice(0, -p.length).trim(); break; }
  let conc = null;
  for (const [c, p] of allConc) if (s.endsWith(" " + p) || s === p) { conc = c; s = s.slice(0, -p.length).trim(); break; }
  return { core: s, conc, gender };
}

const isUrl = (v) => typeof v === "string" && /^https:\/\/[^\s]+$/i.test(v);

async function main() {
  const merged = JSON.parse(await readFile(MERGED, "utf8"));
  const files = (await readdir(PRODUCTS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const report = { linked: [], unmatched: [], doubtful: [] };

  for (const file of files) {
    const full = path.join(PRODUCTS_DIR, file);
    const raw = await readFile(full, "utf8");
    const p = JSON.parse(raw);
    const forms = brandForms(p.brand);
    const want = norm(p.name);

    // Every merged entry from the same brand whose core name is exactly this perfume.
    const sameName = [];
    for (const m of merged) {
      const brandOk = forms.includes(norm(m.brand)) || forms.some((f) => norm(m.name).startsWith(f + " "));
      if (!brandOk) continue;
      const parsed = parseMergedName(m, forms);
      if (parsed && parsed.core === want) sameName.push({ m, ...parsed });
    }

    const exact = sameName.filter((c) => c.conc === p.concentration && c.gender === p.gender);
    const tag = `${p.slug} (${p.brand} ${p.name}, ${p.concentration}, ${p.gender})`;
    const describe = (c) => `"${c.m.name}" [${c.conc ?? "?"} / ${c.gender ?? "?"}]`;

    if (exact.length === 1) {
      const m = exact[0].m;
      const front = isUrl(m.front_image) ? m.front_image : null;
      const back = isUrl(m.back_image) ? m.back_image : null;
      if (!front && !back) {
        report.unmatched.push({ slug: p.slug, why: `${describe(exact[0])} matched but has no usable front_image or back_image` });
        continue;
      }
      report.linked.push({ slug: p.slug, source: m.name, front: !!front, back: !!back });
      if (WRITE) {
        const photos = { ...(front ? { front } : {}), ...(back ? { back } : {}) };
        const next = { ...p, photos };
        const out = JSON.stringify(next, null, 2) + (raw.endsWith("\n") ? "\n" : "");
        if (out !== raw) await writeFile(full, out);
      }
    } else if (exact.length > 1) {
      report.doubtful.push({ slug: p.slug, why: `several exact matches: ${exact.map(describe).join("; ")}` });
    } else if (sameName.length) {
      const sameConc = sameName.filter((c) => c.conc === p.concentration);
      const why = sameConc.length
        ? `same name and concentration but different gender: ${sameConc.map(describe).join("; ")}`
        : `same name, other concentration only: ${sameName.map(describe).join("; ")}`;
      (sameConc.length ? report.doubtful : report.unmatched).push({ slug: p.slug, why });
    } else {
      report.unmatched.push({ slug: p.slug, why: `no entry for ${tag} in merged.json` });
    }
  }

  console.log(`Linked:   ${report.linked.length}`);
  for (const l of report.linked) console.log(`  ✓ ${l.slug.padEnd(20)} front:${l.front ? "yes" : "NULL"} back:${l.back ? "yes" : "NULL"}  ← ${l.source}`);
  console.log(`Doubtful: ${report.doubtful.length} (not linked)`);
  for (const d of report.doubtful) console.log(`  ? ${d.slug.padEnd(20)} ${d.why}`);
  console.log(`Unmatched: ${report.unmatched.length}`);
  for (const u of report.unmatched) console.log(`  ✗ ${u.slug.padEnd(20)} ${u.why}`);
  if (!WRITE) console.log("\nDry run. Re-run with --write to update the product files.");
}

main().catch((e) => { console.error(e); process.exit(1); });
