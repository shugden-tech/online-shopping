// Replace the product catalog with the first N perfumes from decantx/merged.json that have a photo.
//   node scripts/import-merged-products.mjs           -> dry run: prints the report, writes nothing
//   node scripts/import-merged-products.mjs --write   -> deletes src/content/products/*.json and writes the new ones,
//                                                        and adds any new notes to src/data/notes.json
//
// Everything comes from merged.json: brand, name, concentration, gender, notes, description, sizes, prices,
// stock, season, occasion, release year and the front/back photos. merged.json is read here only;
// the site never imports it.
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTS_DIR = path.join(ROOT, "src/content/products");
const NOTES_FILE = path.join(ROOT, "src/data/notes.json");
const MERGED = path.join(ROOT, "decantx/merged.json");
const WRITE = process.argv.includes("--write");
const COUNT = 100;

// Prices in merged.json are USD. [[owner]] set the real rate / margin here and re-run.
const USD_TO_MNT = 3500;
const ROUND_TO = 500; // round prices up to the nearest 500₮
const ALLOWED_ML = [2, 5, 10, 30];
const NEW_FROM_YEAR = 2025;

// ---------- helpers ----------
const norm = (s) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[’'`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const slugify = (s) => norm(s).replace(/ /g, "-");
const uniq = (a) => [...new Set(a)];

// ---------- concentration / gender ----------
const CONC = [
  ["Extrait", /\bextrait\b/],
  ["EDP", /\beau (de|the) parfum\b/],
  ["EDT", /\beau de toilette\b/],
  ["Cologne", /\b(eau de cologne|cologne)\b/],
  ["Parfum", /\b(le parfum|parfum|esprit de parfum|essence de parfum|pure perfume|perfume)\b/],
];
const CONC_TAGS = { "Extrait De Parfum": "Extrait", "Eau de Parfum": "EDP", EDP: "EDP", "Eau de Toilette": "EDT", EDT: "EDT", "Eau de Cologne": "Cologne", "Eau De Cologne": "Cologne", EDC: "Cologne", Cologne: "Cologne", Parfum: "Parfum" };
function concentrationOf(m) {
  const n = norm(m.name);
  for (const [c, re] of CONC) if (re.test(n)) return c;
  for (const t of m.tags) if (CONC_TAGS[t]) return CONC_TAGS[t];
  return null;
}
function genderOf(m) {
  const n = norm(m.name);
  if (/\b(for men|for man|pour homme)\b/.test(n)) return "men";
  if (/\b(for women|for woman|pour femme)\b/.test(n)) return "women";
  if (/\bunisex\b/.test(n)) return "unisex";
  if (m.tags.includes("Unisex")) return "unisex";
  if (m.tags.includes("Men's") || m.tags.includes("For Men")) return "men";
  if (m.tags.includes("Women's")) return "women";
  return null;
}

/** Name as printed on the bottle: brand prefix and the concentration/gender tail removed. */
function displayName(m) {
  let s = m.name.trim();
  const brands = uniq([m.brand, m.brand.replace(/ Perfumes?$/i, ""), "Giorgio Armani", "Christian Dior"]);
  for (const b of brands) if (s.toLowerCase().startsWith(b.toLowerCase() + " ")) { s = s.slice(b.length).trim(); break; }
  s = s.replace(/\s+(for men|for man|for women|for woman|unisex|pour homme|pour femme)\s*$/i, "");
  s = s.replace(/\s+(extrait de parfum|extrait|eau de parfum|eau the parfum|pure perfume|eau de toilette|eau de cologne|cologne|le parfum|parfum)(\s+(intense|concentree|concentrée))?\s*$/i, (all, _c, mod) => (mod ? " " + mod.trim() : ""));
  return s.trim() || m.name.trim();
}

// ---------- family ----------
const FAMILY_WORDS = {
  amber: "amber", oriental: "amber", fougère: "aromatic", "warm spicy": "amber", woody: "woody", leather: "woody", floral: "floral",
  "white floral": "floral", "yellow floral": "floral", citrus: "citrus", chypre: "chypre", fresh: "fresh",
  aquatic: "fresh", green: "fresh", "fresh spicy": "fresh", fruity: "fresh", gourmand: "gourmand", sweet: "gourmand",
  aromatic: "aromatic", fougere: "aromatic", herbal: "aromatic",
};
const FAMILY_TAG_ORDER = ["Chypre", "Gourmand", "Amber", "Oriental", "Woody", "Citrus", "Floral", "White Floral", "Aromatic", "Fresh", "Aquatic", "Green", "Sweet", "Fruity", "Leather"];
function familyOf(m) {
  const t = m.notes?.source_text ?? "";
  const hit = t.match(/\bis an? ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*) fragrance/);
  if (hit) {
    const words = hit[1].toLowerCase().split(" ");
    for (let i = 0; i < words.length; i++) {
      const two = words.slice(i, i + 2).join(" ");
      if (FAMILY_WORDS[two]) return FAMILY_WORDS[two];
      if (FAMILY_WORDS[words[i]]) return FAMILY_WORDS[words[i]];
    }
  }
  for (const tag of FAMILY_TAG_ORDER) if (m.tags.includes(tag)) return FAMILY_WORDS[tag.toLowerCase()];
  // Any capitalised family word in the description ("a unisex Citrus scent", "the Woody Floral Musk family").
  const cap = t.match(/\b(Chypre|Gourmand|Oriental|Amber|Woody|Citrus|Floral|Fougere|Fougère|Aromatic|Aquatic|Leather)\b/);
  if (cap) return FAMILY_WORDS[norm(cap[1])];
  return familyFromNotes(m);
}

// Last resort: the family most of the listed notes belong to.
const NOTE_FAMILY = {
  woody: /cedar|sandal|vetiver|patchouli|oud|agarwood|guaiac|cypress|wood|birch|oak|pine|fir|spruce|moss/,
  amber: /amber|labdanum|benzoin|incense|olibanum|myrrh|resin|musk|saffron|opoponax|balsam/,
  gourmand: /vanilla|tonka|praline|caramel|chocolate|cacao|coffee|honey|almond|toffee|sugar|rum|cognac|whisk/,
  floral: /rose|jasmine|iris|orris|violet|tuberose|peony|lily|magnolia|ylang|orange blossom|neroli|heliotrope|freesia|osmanthus/,
  citrus: /bergamot|lemon|orange|mandarin|grapefruit|lime|yuzu|citron|petitgrain|chinotto|tangerine/,
  aromatic: /lavender|sage|rosemary|basil|thyme|mint|artemisia|geranium|juniper|cardamom|herb/,
  fresh: /marine|sea|aquatic|ozonic|water|green|tea|apple|melon|cucumber/,
};
function familyFromNotes(m) {
  const all = ["top", "middle", "base", "key"].flatMap((k) => m.notes?.[k] ?? []).map((n) => n.toLowerCase());
  const score = {};
  for (const n of all) for (const [fam, re] of Object.entries(NOTE_FAMILY)) if (re.test(n)) score[fam] = (score[fam] ?? 0) + 1;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

// ---------- notes ----------
// New note ids (en / mn, optional photo group from src/assets/notes).
const NEW_NOTES = {
  amberwood: ["Amberwood", "Хув мод", "woods"], apple: ["Apple", "Алим"], amyris: ["Amyris", "Амирис", "woods"],
  artemisia: ["Artemisia", "Шарилж", "aromatic-notes"], basil: ["Basil", "Базилик", "aromatic-notes"],
  "bitter-orange": ["Bitter orange", "Гашуун жүрж"], raspberry: ["Raspberry", "Бөөрөлзгөнө"],
  rosewood: ["Rosewood", "Сарнай мод", "woods"], "cashmere-wood": ["Cashmere wood", "Кашмир мод", "woods"],
  chinotto: ["Chinotto", "Чинотто"], citron: ["Citron", "Цитрон"], citrus: ["Citrus notes", "Цитрусын ноот"],
  "clary-sage": ["Clary sage", "Мускат хашхираа", "aromatic-notes"], clearwood: ["Clearwood", "Клиэрвүүд", "woods"],
  clove: ["Clove", "Гвоздик"], "coconut-water": ["Coconut water", "Кокосын ус"], coriander: ["Coriander", "Кориандр"],
  cumin: ["Cumin", "Зира"], cypress: ["Cypress", "Кипарис", "woods"], ebony: ["Ebony", "Хар мод", "woods"],
  elemi: ["Elemi", "Элеми давирхай", "incense-minerals"], fir: ["Fir", "Жодоо", "woods"],
  "fruity-notes": ["Fruity notes", "Жимсний ноот"], galbanum: ["Galbanum", "Гальбанум", "green-notes"],
  gin: ["Gin", "Жин"], "green-tea": ["Green tea", "Ногоон цай", "green-notes"],
  "guaiac-wood": ["Guaiac wood", "Гваяк мод", "woods"], heliotrope: ["Heliotrope", "Гелиотроп"],
  honey: ["Honey", "Зөгийн бал"], honeysuckle: ["Honeysuckle", "Далан хальс"], kiwano: ["Kiwano melon", "Кивано"],
  laurel: ["Laurel", "Лаврын навч", "aromatic-notes"], licorice: ["Licorice", "Чихэр өвс"],
  "lily-of-the-valley": ["Lily-of-the-valley", "Хонхон цэцэг", "white-flowers"], lotus: ["Lotus", "Бадамлянхуа"],
  lychee: ["Lychee", "Личи"], magnolia: ["Magnolia", "Магнолия", "white-flowers"], mimosa: ["Mimosa", "Мимоза"],
  moss: ["Moss", "Хөвд", "green-notes"], myrrh: ["Myrrh", "Мирра", "incense-minerals"],
  myrtle: ["Myrtle", "Мирт", "aromatic-notes"], nagarmotha: ["Nagarmotha", "Нагармота", "woods"],
  narcissus: ["Narcissus", "Нарцисс"], nutmeg: ["Nutmeg", "Задийн самар"],
  opoponax: ["Opoponax", "Опопонакс", "incense-minerals"], oregano: ["Oregano", "Орегано", "aromatic-notes"],
  osmanthus: ["Osmanthus", "Османтус"], "peach-blossom": ["Peach blossom", "Тоорын цэцэг"], peony: ["Peony", "Цээнэ цэцэг"],
  petitgrain: ["Petitgrain", "Петигрейн", "green-notes"], "pineapple-leaf": ["Pineapple leaf", "Хан боргоцойн навч"],
  powdery: ["Powdery notes", "Пудрын ноот"], "red-currant": ["Red currant", "Улаан үхрийн нүд"],
  "red-pepper": ["Red pepper", "Улаан чинжүү"], thyme: ["Thyme", "Ганга", "aromatic-notes"],
  resins: ["Resins", "Давирхай", "incense-minerals"], rhubarb: ["Rhubarb", "Гишүүнэ"],
  "sichuan-pepper": ["Sichuan pepper", "Сычуань чинжүү"], spruce: ["Spruce", "Гацуур", "woods"],
  "star-anise": ["Star anise", "Одон анис"], suede: ["Suede", "Илгэ", "leather"], "sweet-notes": ["Sweet notes", "Чихэрлэг ноот"],
  tonic: ["Tonic", "Тоник"], tropical: ["Tropical fruits", "Халуун орны жимс"],
  tuberose: ["Tuberose", "Тубероз", "white-flowers"], verbena: ["Verbena", "Вербена", "green-notes"],
  "violet-leaf": ["Violet leaf", "Нил цэцгийн навч", "green-notes"], "ylang-ylang": ["Ylang-ylang", "Иланг-иланг", "white-flowers"],
  yuzu: ["Yuzu", "Юзу"], camellia: ["Camellia", "Камелия"], smoky: ["Smoky notes", "Утаат ноот", "incense-minerals"],
  pimento: ["Pimento", "Пимент"], melon: ["Melon", "Амтат гуа"], freesia: ["Freesia", "Фрезия"],
  cyclamen: ["Cyclamen", "Цикламен"], plum: ["Plum", "Чавга"], "cherry-blossom": ["Cherry blossom", "Интоорын цэцэг"],
  almond: ["Almond", "Бүйлс"], solar: ["Solar notes", "Нарны ноот"], peach: ["Peach", "Тоор"], toffee: ["Toffee", "Ирис чихэр"],
  whisky: ["Whisky", "Виски"],
};
// Raw merged.json note text (lowercased, trimmed) -> note ids. [] = parsing junk, dropped.
const NOTE_ALIASES = {
  "agarwood (oud)": ["oud"], "ambrette (musk mallow)": ["ambrette"], "black currant": ["blackcurrant"],
  "brazilian orange": ["orange"], "italian orange": ["orange"], "brazilian rosewood": ["rosewood"],
  "calabrian bergamot": ["bergamot"], "zesty calabrian bergamot": ["bergamot"], "top notes: bergamot": ["bergamot"],
  "- top notes: bergamot": ["bergamot"], "cashmere woods": ["cashmere-wood"], "cedar wood": ["cedar"], cedarwood: ["cedar"],
  "cistus labdanum": ["labdanum"], citruses: ["citrus"], "citrus notes": ["citrus"], cloves: ["clove"],
  "crisp lavender": ["lavender"], "damask rose": ["rose"], "turkish rose": ["rose"], "dry amber": ["amber"],
  "extreme amber": ["amber"], "sleek amber": ["amber"], "addictive amber": ["amber"], "fig wood": ["fig"],
  fruits: ["fruity-notes"], "fruity notes": ["fruity-notes"], "geranium blossom": ["geranium"],
  "granny smith apple": ["apple"], "luscious apple": ["apple"], "green mandarin": ["mandarin"],
  "yellow mandarin": ["mandarin"], "vibrant yellow mandarin": ["mandarin"], "mandarin orange": ["mandarin"],
  "jasmine sambac": ["jasmine"], "moroccan jasmine": ["jasmine"], "juniper berries": ["juniper"],
  "kiwano melon": ["kiwano"], laurels: ["laurel"], "lily of the valley": ["lily-of-the-valley"], muguet: ["lily-of-the-valley"],
  myrhh: ["myrrh"], olibanum: ["incense"], "ozonic notes": ["marine"], "sea notes": ["marine"],
  "pine tree": ["pine"], "silver pine": ["pine"], "pink peppercorn": ["pink-pepper"], "pink pepper and": ["pink-pepper"],
  "a hint of spicy pink pepper": ["pink-pepper"], "powdery notes": ["powdery"], rubarbar: ["rhubarb"],
  "red thyme": ["thyme"], "saffron powder warm cardamom": ["saffron", "cardamom"], "sensual leather": ["leather"],
  "leave an irresistible trail of sensual leather": ["leather"], "szechuan pepper": ["sichuan-pepper"],
  "sicilian lemon": ["lemon"], "spicy pepper": ["pepper"], "sueded musk": ["musk"], "white musk": ["musk"],
  "base notes of musk": ["musk"], "middle notes of musk": ["musk"], sweet: ["sweet-notes"], "sweet notes": ["sweet-notes"],
  "tonka beans": ["tonka"], "tonka bean": ["tonka"], "violet leaves": ["violet-leaf"], "woody notes": ["woods"],
  "consist of woody notes": ["woods"], "a base of amberwood": ["amberwood"], "a combination of orris root": ["iris"],
  "orris root": ["iris"], orris: ["iris"], "blend raspberry": ["raspberry"], "while the middle notes blend raspberry": ["raspberry"],
  "complemented by neroli as its middle note": ["neroli"], "composed of vetiver": ["vetiver"], "vetiver and": ["vetiver"],
  "create a rich foundation with moss": ["moss"], "feature vibrant orange": ["orange"],
  "followed by a heart of lily-of-the-valley": ["lily-of-the-valley"], "heart notes green tea": ["green-tea"],
  "leading into a heart of agarwood (oud)": ["oud"], "leading into a heart of exquisite jasmine": ["jasmine"],
  "leading into a heart of lavender": ["lavender"], "leading into a heart that features pimento": ["pimento"],
  "petitgrain and": ["petitgrain"], "sandalwood middle": ["sandalwood"], "the depths are filled with geranium": ["geranium"],
  "with floral touches of geranium": ["geranium"], "touches of patchouli": ["patchouli"],
  "while the heart of the fragrance blooms with verbena": ["verbena"], "camelia": ["camellia"], "coconut water": ["coconut-water"],
  "bitter orange": ["bitter-orange"], "clary sage": ["clary-sage"], "green tea": ["green-tea"], "guaiac wood": ["guaiac-wood"],
  "peach blossom": ["peach-blossom"], "pineapple leaf": ["pineapple-leaf"], "red currant": ["red-currant"],
  "red pepper": ["red-pepper"], "sichuan pepper": ["sichuan-pepper"], "star anise": ["star-anise"], "violet leaf": ["violet-leaf"],
  "ylang-ylang": ["ylang-ylang"], "cashmere wood": ["cashmere-wood"], "lily-of-the-valley": ["lily-of-the-valley"],
  "tropical": ["tropical"], smoky: ["smoky"], "black pepper": ["pepper"], "orange blossom": ["orange-blossom"],
  "agarwood": ["oud"], "oud": ["oud"], "tonka": ["tonka"], "mandarin": ["mandarin"], "fig leaf": ["fig-leaf"],
  "sea salt": ["sea-salt"], "green apple": ["green-apple"], "fir resin": ["fir-resin"], "pink pepper": ["pink-pepper"],
  spices: ["pepper"], "white cedar extract": ["cedar"], "atlas cedar": ["cedar"], "virginia cedar": ["cedar"],
  "woodsy notes": ["woods"], "white wood": ["woods"], "white woods": ["woods"], "dry wood": ["woods"],
  "italian jasmine": ["jasmine"], "bulgarian rose": ["rose"], "ylang-ylang and": ["ylang-ylang"], "lemon verbena": ["verbena"],
  tangerine: ["mandarin"], lily: ["lily-of-the-valley"], "jasmine tea": ["green-tea", "jasmine"], tea: ["green-tea"],
  melon: ["melon"], freesia: ["freesia"], cyclamen: ["cyclamen"], plum: ["plum"], "cherry blossom": ["cherry-blossom"],
  amaretto: ["almond"], almond: ["almond"], "solar notes": ["solar"], peach: ["peach"], toffee: ["toffee"], anise: ["star-anise"],
  whiskey: ["whisky"], whisky: ["whisky"],
  // parsing junk from prose
  a: [], s: [], "base notes": [], fresh: [], "fresh spicy": [], "bring us juicy": [], "captivating aroma": [],
  "creating a well-rounded": [], "fer a softer experience": [],
};

function noteIds(raw, known, unknown) {
  const key = raw.trim().toLowerCase();
  if (!key) return [];
  if (key in NOTE_ALIASES) return NOTE_ALIASES[key];
  const id = slugify(key);
  if (known[id]) return [id];
  const byEn = Object.entries(known).find(([, v]) => v.en.toLowerCase() === key);
  if (byEn) return [byEn[0]];
  unknown.add(raw.trim());
  return [];
}

// ---------- description ----------
function englishDescription(m, p) {
  let t = (m.notes?.source_text ?? "").replace(/\r/g, "");
  t = t.split(/\n?\s*(?:-\s*)?top notes?\s*[:\-]/i)[0]; // keep the prose, drop the note list
  t = t.replace(/\s+/g, " ").trim();
  if (t.length >= 10) return t;
  return `${p.brand} ${p.name} is a ${p.family} ${p.concentration} for ${p.gender === "unisex" ? "everyone" : p.gender}.`;
}
function mongolianDescription(p, notesDict, mnDict) {
  const gender = { men: "Эрэгтэйчүүдэд зориулсан", women: "Эмэгтэйчүүдэд зориулсан", unisex: "Хүйс харгалзахгүй" }[p.gender];
  const fam = mnDict.families[p.family].toLowerCase();
  let s = `${p.brand} ${p.name}: ${gender} ${fam} үнэр (${p.concentration}).`;
  const label = (ids) => ids.map((id) => notesDict[id].mn.toLowerCase()).join(", ");
  const parts = [];
  if (p.notes.top.length) parts.push(`эхний ноот: ${label(p.notes.top)}`);
  if (p.notes.heart.length) parts.push(`зүрхний ноот: ${label(p.notes.heart)}`);
  if (p.notes.base.length) parts.push(`суурь ноот: ${label(p.notes.base)}`);
  if (parts.length) s += " " + parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + ".";
  return s;
}

// ---------- sizes ----------
function sizesOf(m) {
  const out = [];
  for (const ml of ALLOWED_ML) {
    const vs = m.variants.filter((v) => v.size_ml === ml && v.bottle_type === "decant" && !/atomizer/i.test(v.variant) && +v.price > 0);
    if (!vs.length) continue;
    const usd = Math.min(...vs.map((v) => +v.price));
    const price = Math.ceil((usd * USD_TO_MNT) / ROUND_TO) * ROUND_TO;
    out.push({ ml, price, inStock: vs.some((v) => v.available) });
  }
  return out;
}

const INTENSITY = { Cologne: 1, EDT: 2, EDP: 3, Parfum: 4, Extrait: 5 };
const SEASON_TAGS = { Spring: "spring", Summer: "summer", Fall: "autumn", Autumn: "autumn", Winter: "winter" };
const OCCASION_TAGS = { Day: "day", Night: "night", Office: "office", "Date Night": "date" };
const isHttps = (v) => typeof v === "string" && /^https:\/\/\S+$/.test(v);

async function main() {
  const merged = JSON.parse(await readFile(MERGED, "utf8"));
  const notesDict = JSON.parse(await readFile(NOTES_FILE, "utf8"));
  const mnDict = JSON.parse(await readFile(path.join(ROOT, "src/i18n/mn.json"), "utf8"));
  for (const [id, [en, mn, image]] of Object.entries(NEW_NOTES)) {
    if (!notesDict[id]) notesDict[id] = { mn, en, ...(image ? { image } : {}) };
  }

  const products = [], skipped = [], unknownNotes = new Set(), slugs = new Set();
  for (const m of merged) {
    if (products.length >= COUNT) break;
    if (!isHttps(m.front_image)) continue; // "with a photo": the card's main image must exist
    if (!m.categories?.includes("Fragrance Decant")) continue;
    const why = [];
    const concentration = concentrationOf(m); if (!concentration) why.push("concentration");
    const gender = genderOf(m); if (!gender) why.push("gender");
    const family = familyOf(m); if (!family) why.push("family");
    const sizes = sizesOf(m); if (!sizes.length) why.push("no 2/5/10/30 ml decant price");
    const name = displayName(m);
    let slug = slugify(`${m.brand} ${name} ${concentration ?? ""}`);
    if (slugs.has(slug)) slug = slugify(`${m.brand} ${name} ${concentration ?? ""} ${gender ?? ""}`);
    if (slugs.has(slug)) why.push("duplicate of an earlier product");
    if (why.length) { skipped.push({ name: m.name, why: why.join(", ") }); continue; }
    slugs.add(slug);

    const tier = (k) => uniq((m.notes?.[k] ?? []).flatMap((n) => noteIds(n, notesDict, unknownNotes))).slice(0, 8);
    let top = tier("top"), heart = tier("middle"), base = tier("base");
    const key = tier("key");
    if (!top.length && !heart.length && !base.length && key.length) heart = key;

    const years = m.tags.filter((t) => /^(19|20)\d\d$/.test(t)).map(Number);
    const year = years.length ? Math.max(...years) : null;
    const season = uniq(m.tags.map((t) => SEASON_TAGS[t]).filter(Boolean));
    const occasion = uniq(m.tags.map((t) => OCCASION_TAGS[t]).filter(Boolean));

    const p = {
      slug, brand: m.brand.trim(), name, concentration, gender, family,
      notes: { top, heart, base },
      description: { mn: "", en: "" },
      sizes,
      bottleShape: "classic",
      ...(products.length < 8 ? { featured: true } : {}),
      ...(year && year >= NEW_FROM_YEAR ? { isNew: true } : {}),
      intensity: INTENSITY[concentration],
      season: season.length ? season : ["spring", "summer", "autumn", "winter"],
      occasion: occasion.length ? occasion : ["day"],
      photos: { front: m.front_image, ...(isHttps(m.back_image) && m.back_image !== m.front_image ? { back: m.back_image } : {}) },
    };
    p.description.en = englishDescription(m, p);
    p.description.mn = mongolianDescription(p, notesDict, mnDict);
    products.push(p);
  }

  const noNotes = products.filter((p) => !p.notes.top.length && !p.notes.heart.length && !p.notes.base.length);
  console.log(`Products: ${products.length} (${products.filter((p) => p.photos.back).length} with a back photo, ${products.filter((p) => !p.photos.back).length} front only)`);
  console.log(`Brands: ${Object.entries(products.reduce((a, p) => ((a[p.brand] = (a[p.brand] ?? 0) + 1), a), {})).map(([b, n]) => `${b} ${n}`).join(", ")}`);
  console.log(`Without any notes in merged.json: ${noNotes.length}`);
  console.log(`Skipped (could not map): ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
  console.log(`Unknown notes dropped: ${unknownNotes.size}${unknownNotes.size ? " -> " + [...unknownNotes].join(" | ") : ""}`);

  if (!WRITE) { console.log("\nDry run. Re-run with --write to replace the catalog."); return; }
  for (const f of await readdir(PRODUCTS_DIR)) if (f.endsWith(".json")) await unlink(path.join(PRODUCTS_DIR, f));
  for (const p of products) await writeFile(path.join(PRODUCTS_DIR, `${p.slug}.json`), JSON.stringify(p, null, 2) + "\n");
  await writeFile(NOTES_FILE, JSON.stringify(notesDict, null, 2) + "\n");
  console.log(`\nWrote ${products.length} product files and updated notes.json.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
