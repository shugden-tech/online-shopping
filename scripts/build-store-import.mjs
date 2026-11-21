#!/usr/bin/env node
// Owner's own store (data/catalog/genzst-store.json, 33 products) -> sellable D1 rows + content files.
//
//   node scripts/build-store-import.mjs            # writes data/catalog/store-import.sql + store-import-report.json
//   node scripts/build-store-import.mjs --content  # ALSO writes/updates src/content/products/<id>.json
//
// Rules (docs/CONTRACTS.md §1): prices and stock come only from the store file. Store price 0 = no price
// (SKU price NULL, not for sale). Stock: full bottle = store `quantity`; decant = floor(decants.mlStock / ml);
// a missing or 0 value is stock 0 (sold out). Decant SKUs only when decants.enabled and the size has a price.
// The SQL is idempotent (upserts keyed by id) and touches only these products and their SKUs.
// Photos: public/product-photos/store/<id>.webp (made from data/catalog/genzst-store-images/).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const STORE = read("data/catalog/genzst-store.json");
const NOTES = read("src/data/notes.json");
const MASTER = new Map(read("data/catalog/catalog.json").map((c) => [c.id, c]));
const FULL = new Map(read("data/catalog/full-bottles.json").map((f) => [f.id, f]));
const WRITE_CONTENT = process.argv.includes("--content");

/* ---------- decisions that are not plain copies of the store file ---------- */
// The store's "Eros" is the Eau de Parfum (its description, notes and photo all say EDP), so it maps to
// versace-eros-edp, not versace-eros-edt.
const REMAP = { "versace-eros-edt": "versace-eros-edp" };
// The id encodes the concentration; where the store disagrees with an existing id the id wins (reported).
// Full-bottle size when the rule (mlHint -> researched flagship high/medium -> 100 ml EDP/EDT men's) does not
// apply or is wrong for the line. Each one is listed in the report.
const ML_OVERRIDE = {
  "jean-paul-gaultier-le-male-elixir-parfum": [125, "line is 75/125 ml (no 100 ml); 125 = researched flagship (low confidence) — owner to confirm"],
  "jean-paul-gaultier-le-male-edt": [125, "line is 40/75/125/200 ml (no 100 ml); 125 assumed — owner to confirm"],
  "ralph-lauren-polo-black-edt": [125, "store photo box reads 125 ml"],
  "r-my-latour-cigar-edt": [100, "store photo box reads 100 ml"],
  "lagerfeld-classic-edt": [100, "store photo box reads 100 ml"],
  "moncler-pour-homme-edp": [150, "store description: «Голдуу 150 мл-ийн савлагаатай»"],
  "yves-saint-laurent-y-le-parfum": [100, "Parfum (store says EDP); 100 ml assumed — owner to confirm"],
  "giorgio-armani-emporio-armani-stronger-with-you-parfum-parfum": [100, "Parfum; 100 ml assumed (line 50/100) — owner to confirm"],
};
// Scent family (for the content schema and NULL D1 rows), from the store's own classification / accords.
const FAMILY = {
  "versace-eros-najim-edp": "amber", "versace-eros-edp": "amber", "versace-pour-homme-edt": "aromatic",
  "armaf-club-de-nuit-intense-man-edt": "citrus", "jean-paul-gaultier-le-male-elixir-parfum": "gourmand",
  "mancera-intense-cedrat-boise-edp": "woody", "emporio-armani-stronger-with-you-intensely-edp": "amber",
  "jean-paul-gaultier-le-male-edt": "aromatic", "montblanc-legend-red-edp": "woody", "lagerfeld-classic-edt": "amber",
  "valentino-uomo-born-in-roma-edt": "woody", "french-avenue-liquid-brun-edp": "gourmand",
  "valentino-uomo-born-in-roma-coral-fantasy-edt": "aromatic", "chanel-allure-homme-sport-edt": "citrus",
  "maison-margiela-sailing-day-edt": "fresh", "dior-sauvage-edt": "aromatic",
  "valentino-uomo-born-in-roma-purple-melancholia-edt": "gourmand", "versace-eros-flame-edp": "woody",
  "yves-saint-laurent-y-le-parfum": "aromatic", "montblanc-explorer-edp": "woody", "maison-margiela-jazz-club-edt": "amber",
  "versace-eros-energy-edp": "citrus", "giorgio-armani-emporio-armani-stronger-with-you-powerfully": "amber",
  "dior-eau-sauvage-edt": "citrus", "valentino-uomo-born-in-roma-extradose-edp": "aromatic", "yves-saint-laurent-y-edp": "aromatic",
  "montblanc-legend-edt": "aromatic", "valentino-uomo-born-in-roma-intense-edp": "gourmand",
  "giorgio-armani-emporio-armani-stronger-with-you-parfum-parfum": "amber", "r-my-latour-cigar-edt": "woody",
  "ralph-lauren-polo-black-edt": "woody", "moncler-pour-homme-edp": "woody", "maison-margiela-by-the-fireplace-edt": "woody",
};
const NAME_FIX = { "moncler-pour-homme-edp": ["Moncler", "Pour Homme"], "giorgio-armani-emporio-armani-stronger-with-you-parfum-parfum": ["Emporio Armani", "Stronger With You Parfum"], "lagerfeld-classic-edt": ["Karl Lagerfeld", "Lagerfeld Classic"] };
const CONC_OK = new Set(["EDP", "EDT", "Parfum", "Extrait", "Cologne"]);

/* ---------- note mapping (store Mongolian text -> src/data/notes.json ids) ---------- */
const ALIAS = {
  "таримал батраш": "mint", "батраш": "mint", "чихэртэй алим": "apple", "улаан алим": "apple", "итали мандарин": "mandarin",
  "улаан мандарин": "mandarin", "хүж": "incense", "ветривер": "vetiver", "хаит ветивер": "vetiver", "ява ветиверийн тос": "vetiver",
  "ветивер өвс": "vetiver", "агар мод": "oud", "камбожийн уд": "oud", "хуш": "cedar", "атлас хуш": "cedar", "техас хуш": "cedar",
  "хуш модны": "cedar", "энэтхэгийн зандан мод": "sandalwood", "зандан мод": "sandalwood", "савхи": "leather", "савхийн ноот": "leather",
  "шимтэглээ цэцэг": "geranium", "бурбон шимтэглээ": "geranium", "клери сейж": "clary-sage", "мэргэн цэцэг": "clary-sage",
  "эмийн сэйж ургамлын": "clary-sage", "5 сарын сарнай": "rose", "цагаан заар": "musk", "хус": "birch", "мэлрэг": "jasmine",
  "мэлрэг цэцэг": "jasmine", "халимны бөөлжис": "ambergris", "амбергриз": "ambergris", "дүнсэн тамхи": "tobacco",
  "дүнсэн тамхины навч": "tobacco", "навчин тамхи": "tobacco", "бензоин": "benzoin", "ягаан перец": "pink-pepper",
  "грейпфрут": "grapefruit", "кашемир мод": "cashmere-wood", "үнэгэн илгэн": "suede", "шарсан каштан/туулайн самар": "chestnut",
  "сэлэнгэ өвс/sage": "sage", "сэйж амтлагч": "sage", "корица": "cinnamon", "тоффи": "toffee", "энэдбэл": "artemisia", "шанц": "cinnamon",
  "эгэл гоньд": "caraway", "махагони мод": "mahogany", "арцны жимс": "juniper", "арцны жимсгэнэ": "juniper", "цахилдагын үндэс": "iris",
  "ногоон ноотууд": "green-notes", "модлог ноот": "woods", "модлог": "woods", "эрдэслэг ноот": "mineral-notes", "давс": "sea-salt",
  "бурбон ваниль": "vanilla", "элеми": "elemi", "калабрийн бергамот": "bergamot", "сицилийн бергамот": "bergamot",
  "далайн ноотууд": "marine", "перец": "pepper", "мадагаскар перец": "pepper", "халуун чинжүү": "pepper", "сычуаны чинжүү": "sichuan-pepper",
  "задь": "nutmeg", "наргил модны самар": "coconut", "пеппервуд": "pepperwoodtm", "олибанум давирхай": "incense",
  "акигала мод": "akigalawood", "индонези пачулийн навч": "patchouli", "какаоны хонхорцог": "cacao", "ром дарс": "rum",
  "ванилийн хонхорцог": "vanilla", "улаан жүрж": "orange", "цагаан хув": "amber", "интоор буюу хар интоор": "black-cherry",
  "чихэрлэг болон утлагат хүрэн самр": "chestnut", "хувны дулаан": "amber", "уулын нарс": "pine", "лиш цэцэг": "carnation",
  "бэзил": "basil", "жимслэг": "fruity-notes", "зэрлэг лаванда": "wild-lavender", "нимбэгт вербена": "verbena",
  "сицилийн цитрус жимснүүд": "citrus", "хар үхрийн нүд": "blackcurrant", "ханборгоцой": "pineapple", "чавганы сэргэг": "plum",
  "мариголд": "african-marigold", "лаврын навч": "laurel", "туулайн бөөр": "chestnut", "хув мод": "amberwood",
  "перу бальзам": "peru-balsam", "утлагат хүрэн самр": "chestnut", "чихэрлэг": "sweet-notes", "кашмеран": "cashmeran", "гваяк мод": "guaiac-wood", "акигалавүүд": "akigalawood",
};
const DROP = new Set(["spice accord", "шороолог үнэрээр удаан тогтоно", "цэцэгслэг", "аромат мэдрэмж"]);
const byMn = new Map();
for (const [id, n] of Object.entries(NOTES)) if (!byMn.has(n.mn.toLowerCase())) byMn.set(n.mn.toLowerCase(), id);
byMn.set("зандан мод", "sandalwood"); // notes.json gives mahogany the same Mongolian label

const LATIN = { a: "а", o: "о", e: "е", c: "с", p: "р", x: "х", y: "у" };
// A Latin look-alike letter typed in front of Cyrillic ("aнхилуун") becomes Cyrillic.
const fixLatin = (s) => s.replace(/(^|[\s/])([aoecpxy])(?=[а-яөүё])/gi, (_, pre, m) => pre + (LATIN[m.toLowerCase()] ?? m));
function cleanTier(list) {
  // The source split some notes at the commas inside a parenthesis: "Лаванда (Лавандин - сэрүүн", "…)".
  // Drop the remark: up to the element that closes it, or only this element when nothing closes it.
  const items = [...(list ?? [])];
  const kept = [];
  for (let i = 0; i < items.length; i++) {
    let x = String(items[i]).replace(/\([^()]*\)/g, " ");
    if (x.includes("(")) {
      const close = items.findIndex((y, j) => j > i && String(y).includes(")"));
      x = x.slice(0, x.indexOf("("));
      if (close > i) i = close;
    }
    kept.push(x.replace(/[()•]/g, " "));
  }
  return kept
    .join(", ")
    .split(/,|;|\sба\s|\sболон\s/i)
    .map((x) => x.replace(/\s+/g, " ").trim().replace(/^суурь ноотууд нь\s*/i, "").replace(/[.\-–\s]+$/g, "").trim())
    .map(fixLatin)
    .filter((x) => x && !DROP.has(x.toLowerCase()));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function mapNotes(raw) {
  const tiers = { top: [], heart: [], base: [] };
  const unknown = [];
  const seen = new Set();
  for (const tier of ["base", "heart", "top"]) {
    for (const text of cleanTier(raw?.[tier])) {
      const key = text.toLowerCase();
      const id = ALIAS[key] ?? byMn.get(key) ?? (NOTES[key] ? key : null);
      const dedupe = id ?? key;
      if (seen.has(dedupe)) continue; // the store sometimes repeats base notes in the heart
      seen.add(dedupe);
      tiers[tier].unshift({ id, text: id ? NOTES[id].mn : cap(text) });
      if (!id) unknown.push(cap(text));
    }
  }
  for (const t of Object.keys(tiers)) tiers[t].reverse();
  return { tiers, unknown };
}
const cleanAccords = (acc) =>
  (acc ?? [])
    .map((a) => ({ name: cap(fixLatin(String(a.name).replace(/\d+/g, "").trim()).toLowerCase()), value: Math.round(Number(a.value) || 0) }))
    .filter((a) => a.name)
    .sort((x, y) => y.value - x.value);
const cleanText = (s) => String(s ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").replace(/\s+([.,])/g, "$1").trim()).filter(Boolean).join(" ");

/* ---------- build ---------- */
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const contentPath = (id) => join(ROOT, "src/content/products", `${id}.json`);
const rows = [];
const sql = [];
const moves = [];
for (const s of STORE) {
  const id = REMAP[s.d1Id] ?? s.d1Id;
  const master = MASTER.get(id);
  const content = existsSync(contentPath(id)) ? JSON.parse(readFileSync(contentPath(id), "utf8")) : null;
  const existing = s.action === "existing";
  const idConc = /-edt$/.test(id) ? "EDT" : /-edp$/.test(id) ? "EDP" : /-parfum$/.test(id) ? "Parfum" : null;
  const concentration = content?.concentration ?? master?.concentration ?? idConc ?? (CONC_OK.has(s.concentration) ? s.concentration : null);
  const concNote = CONC_OK.has(s.concentration) && concentration !== s.concentration ? `store says ${s.concentration}, kept ${concentration} (id)` : "";
  const [brand, name] = content ? [content.brand, content.name] : master ? [master.brand, master.name === "Y Le" ? "Y Le Parfum" : master.name] : NAME_FIX[id] ?? [s.brand, s.name ?? s.fsName];
  const gender = ["men", "women", "unisex"].includes(s.gender) ? s.gender : null;

  // full bottle size
  const fb = FULL.get(id);
  let ml;
  let mlSrc;
  if (ML_OVERRIDE[id]) [ml, mlSrc] = ML_OVERRIDE[id];
  else if (s.mlHint) [ml, mlSrc] = [s.mlHint, `store name «${s.fsName.trim()}» (6.8 oz)`];
  else if (fb?.flagshipMl && ["high", "medium"].includes(fb.confidence)) [ml, mlSrc] = [fb.flagshipMl, `full-bottles.json flagship (${fb.confidence})`];
  else [ml, mlSrc] = [100, `default 100 ml (${concentration} ${gender})${fb?.flagshipMl === 100 ? "; research also 100 (low)" : ""}`];

  const price = Number.isInteger(s.price) && s.price > 0 ? s.price : null;
  const qty = Number.isInteger(s.quantity) && s.quantity > 0 ? s.quantity : 0;
  const skus = [{ ml, kind: "full", price, stock: price ? qty : 0 }];
  const decOn = s.decants?.enabled === true;
  const mlStock = Number(s.decants?.mlStock) > 0 ? Number(s.decants.mlStock) : 0;
  if (decOn)
    for (const d of s.decants.sizes ?? []) {
      if (![2, 5, 10, 30].includes(d.ml) || !(Number.isInteger(d.price) && d.price > 0)) continue;
      skus.push({ ml: d.ml, kind: "decant", price: d.price, stock: Math.floor(mlStock / d.ml) });
    }
  skus.sort((a, b) => a.ml - b.ml);

  const { tiers, unknown } = mapNotes(s.notes);
  const accords = cleanAccords(s.accords);
  const notesJson = JSON.stringify({ top: tiers.top.map((n) => n.text), heart: tiers.heart.map((n) => n.text), base: tiers.base.map((n) => n.text), ...(accords.length ? { accords } : {}) });
  const descMn = cleanText(s.description) || null;
  const family = FAMILY[id];
  const image = `/product-photos/store/${id}.webp`;
  const imageOk = existsSync(join(ROOT, "public", image));
  const fam = family ?? null;
  const enLabel = (n) => (n.id ? NOTES[n.id].en.toLowerCase() : null);
  const enNotes = [...tiers.top, ...tiers.heart, ...tiers.base].map(enLabel).filter(Boolean).slice(0, 6);
  const genderEn = { men: "men", women: "women", unisex: "everyone" }[gender] ?? "everyone";
  const descEn = `${brand} ${name} is ${/^[aeiou]/i.test(fam ?? "") ? "an" : "a"} ${fam ?? "signature"} ${concentration ?? "fragrance"} for ${genderEn}.${enNotes.length ? ` Notes include ${enNotes.join(", ")}.` : ""}`;

  // product upsert: inserts a missing row; for an existing row changes only what the store owns
  sql.push(
    `INSERT INTO products (id, brand, name, concentration, gender, family, notes_json, description_mn, description_en, image_front, status, sale_locked, source) VALUES (${[
      id, brand, name, concentration, gender, fam, notesJson, descMn, content?.description?.en ?? descEn, imageOk ? image : null, "active", 0,
      content || !master ? "content" : "r2-catalog",
    ].map(q).join(", ")}) ON CONFLICT(id) DO UPDATE SET concentration = COALESCE(products.concentration, excluded.concentration), gender = excluded.gender, family = COALESCE(products.family, excluded.family), notes_json = excluded.notes_json, description_mn = excluded.description_mn, description_en = COALESCE(products.description_en, excluded.description_en), image_front = COALESCE(excluded.image_front, products.image_front), status = 'active', sale_locked = 0, updated_at = datetime('now');`,
  );
  // one multi-row upsert per product keeps the file small (D1 limits one query to 100 KB)
  sql.push(
    `INSERT INTO skus (id, product_id, ml, kind, price, compare_at, stock, reserved, active) VALUES ${skus
      .map((k) => `(${q(`${id}:${k.ml}`)}, ${q(id)}, ${k.ml}, ${q(k.kind)}, ${q(k.price)}, NULL, ${k.stock}, 0, 1)`)
      .join(", ")} ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, price = excluded.price, stock = CASE WHEN excluded.stock >= skus.reserved THEN excluded.stock ELSE skus.stock END, active = 1, updated_at = datetime('now');`,
  );
  for (const k of skus) if (k.stock > 0) moves.push(`(${q(`${id}:${k.ml}`)}, ${k.stock})`);

  rows.push({
    id, storeId: s.d1Id, action: existing ? "existing" : "new", brand, name, concentration, concNote, gender, family: fam,
    fullMl: ml, mlSource: mlSrc, price, quantity: s.quantity, decantsEnabled: decOn, mlStock,
    skus: skus.map((k) => ({ sku: `${id}:${k.ml}`, ml: k.ml, kind: k.kind, price: k.price, stock: k.stock })),
    image: imageOk ? image : null, unmappedNotes: unknown,
    noteIds: { top: tiers.top.filter((n) => n.id).map((n) => n.id), heart: tiers.heart.filter((n) => n.id).map((n) => n.id), base: tiers.base.filter((n) => n.id).map((n) => n.id) },
    contentFile: content ? "updated" : "created", descMn, descEn, longevity: s.longevity, sillage: s.sillage,
  });
}

// opening stock in the movement history, once (re-running adds nothing)
if (moves.length)
  sql.push(
    `INSERT INTO stock_movements (sku_id, delta, reason, actor, note) SELECT v.column1, v.column2, 'import', 'system', 'genzst-store.json' FROM (VALUES ${moves.join(", ")}) AS v WHERE NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.sku_id = v.column1 AND m.reason = 'import' AND m.note = 'genzst-store.json');`,
  );
writeFileSync(join(ROOT, "data/catalog/store-import.sql"), sql.join("\n") + "\n");
writeFileSync(join(ROOT, "data/catalog/store-import-report.json"), JSON.stringify(rows.map(({ descMn, descEn, noteIds, longevity, sillage, ...r }) => r), null, 2) + "\n");
console.log(`store-import.sql: ${sql.length} statements for ${rows.length} products, ${rows.reduce((n, r) => n + r.skus.length, 0)} SKUs`);

/* ---------- content files (static pages; live prices and stock come from D1) ---------- */
if (WRITE_CONTENT) {
  const WARM = new Set(["amber", "gourmand", "woody"]);
  for (const r of rows) {
    const file = contentPath(r.id);
    const sizes = r.skus.map((k) => ({ ml: k.ml, price: 0, inStock: false, ...(k.kind === "full" ? { full: true } : {}) }));
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf8"));
      const have = new Map(c.sizes.map((x) => [x.ml, x]));
      const full = sizes.find((x) => x.full);
      c.sizes = c.sizes.filter((x) => !x.full || x.ml === full.ml); // one full bottle: the store's size
      for (const x of sizes) if (!have.has(x.ml) || (x.full && !have.get(x.ml).full)) c.sizes = c.sizes.filter((y) => y.ml !== x.ml).concat(x);
      c.sizes.sort((a, b) => a.ml - b.ml);
      c.photos = { ...(c.photos ?? {}), front: r.image };
      writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
      continue;
    }
    const cap8 = (a) => [...new Set(a)].slice(0, 8);
    const intensity = Math.max(1, Math.min(5, Math.round(((r.longevity ?? 4) + (r.sillage ?? 3)) / 2) || 3));
    const c = {
      slug: r.id, brand: r.brand, name: r.name, concentration: r.concentration, gender: r.gender, family: r.family,
      notes: { top: cap8(r.noteIds.top), heart: cap8(r.noteIds.heart), base: cap8(r.noteIds.base) },
      description: { mn: r.descMn && r.descMn.length >= 10 ? r.descMn : `${r.brand} ${r.name}`, en: r.descEn },
      sizes, bottleShape: "classic", intensity,
      season: WARM.has(r.family) ? ["autumn", "winter"] : ["spring", "summer"],
      occasion: intensity >= 4 ? ["night", "date"] : ["day", "office"],
      photos: { front: r.image },
    };
    writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  }
  console.log(`content: ${rows.filter((r) => r.contentFile === "created").length} created, ${rows.filter((r) => r.contentFile === "updated").length} updated`);
}
