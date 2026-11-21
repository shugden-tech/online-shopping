// Pure shop filtering / sorting / URL-state helpers (no DOM, easy to test).

/** Compact per-product record embedded in the shop page as a JSON island. */
export interface ShopItem {
  s: string; // slug
  nm: string; // name (for A–Z)
  h: string; // normalised search haystack: brand, name, family and note names in mn + en
  f: string; // family
  b: string; // brand id (see brandId)
  g: string; // gender
  n: string[]; // note accords (photo groups)
  z: number[]; // sizes in stock (ml)
  se: string[]; // seasons
  o: string[]; // occasions
  p: number; // "from" price
  ft: 0 | 1; // featured
  nw: 0 | 1; // new
}

export const SORTS = ["featured", "newest", "price-asc", "price-desc", "az"] as const;
export type SortKey = (typeof SORTS)[number];

export interface FilterState {
  q: string;
  family: string[];
  brand: string[];
  gender: string[];
  notes: string[];
  size: number[];
  season: string[];
  occasion: string[];
  min: number | null;
  max: number | null;
  sort: SortKey;
}

export const EMPTY_FILTERS: FilterState = {
  q: "", family: [], brand: [], gender: [], notes: [], size: [], season: [], occasion: [], min: null, max: null, sort: "featured",
};

const LIST_KEYS = ["family", "brand", "gender", "notes", "season", "occasion"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

/** Lowercase, strip Latin diacritics (Giò → gio) and fold Mongolian ү/ө so "унэр" finds "үнэр". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ү/g, "у")
    .replace(/ө/g, "о")
    .replace(/[^a-z0-9а-я]+/g, " ")
    .trim();
}

/** URL-safe brand id: "Yves Saint Laurent" → "yves-saint-laurent", "Abercrombie & Fitch" → "abercrombie-fitch". */
export function brandId(brand: string): string {
  return normalize(brand).replace(/\s+/g, "-");
}

export function parseQuery(search: string): FilterState {
  const sp = new URLSearchParams(search);
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((v) => v.trim()).filter(Boolean).slice(0, 20);
  const num = (k: string) => {
    const raw = sp.get(k);
    if (raw === null || raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  };
  const sort = sp.get("sort") as SortKey | null;
  return {
    q: (sp.get("q") ?? "").slice(0, 80),
    family: list("family"),
    brand: list("brand"),
    gender: list("gender"),
    notes: list("notes"),
    size: list("size").map(Number).filter((n) => Number.isFinite(n) && n > 0),
    season: list("season"),
    occasion: list("occasion"),
    min: num("min"),
    max: num("max"),
    sort: sort && (SORTS as readonly string[]).includes(sort) ? sort : "featured",
  };
}

export function toQuery(state: FilterState): string {
  const sp = new URLSearchParams();
  if (state.q.trim()) sp.set("q", state.q.trim());
  for (const k of LIST_KEYS) if (state[k].length) sp.set(k, state[k].join(","));
  if (state.size.length) sp.set("size", state.size.join(","));
  if (state.min !== null) sp.set("min", String(state.min));
  if (state.max !== null) sp.set("max", String(state.max));
  if (state.sort !== "featured") sp.set("sort", state.sort);
  const s = sp.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

export function activeCount(state: FilterState): number {
  return (
    (state.q.trim() ? 1 : 0) + state.family.length + state.brand.length + state.gender.length + state.notes.length + state.size.length +
    state.season.length + state.occasion.length + (state.min !== null ? 1 : 0) + (state.max !== null ? 1 : 0)
  );
}

/** Groups are AND-ed together. Inside a group any value may match — except notes, which narrow (all must match). */
export function matches(item: ShopItem, state: FilterState, tokens = normalize(state.q).split(" ").filter(Boolean)): boolean {
  if (state.family.length && !state.family.includes(item.f)) return false;
  if (state.brand.length && !state.brand.includes(item.b)) return false;
  if (state.gender.length && !state.gender.includes(item.g)) return false;
  if (state.notes.length && !state.notes.every((n) => item.n.includes(n))) return false;
  if (state.size.length && !state.size.some((z) => item.z.includes(z))) return false;
  if (state.season.length && !state.season.some((v) => item.se.includes(v))) return false;
  if (state.occasion.length && !state.occasion.some((v) => item.o.includes(v))) return false;
  if (state.min !== null && item.p < state.min) return false;
  if (state.max !== null && item.p > state.max) return false;
  for (const t of tokens) if (!item.h.includes(t)) return false;
  return true;
}

const byName = (a: ShopItem, b: ShopItem) => a.nm.localeCompare(b.nm);
const SORTERS: Record<SortKey, (a: ShopItem, b: ShopItem) => number> = {
  featured: (a, b) => b.ft - a.ft || b.nw - a.nw || byName(a, b),
  newest: (a, b) => b.nw - a.nw || b.ft - a.ft || byName(a, b),
  "price-asc": (a, b) => a.p - b.p || byName(a, b),
  "price-desc": (a, b) => b.p - a.p || byName(a, b),
  az: byName,
};

/** Slugs of the matching products, in display order. */
export function runFilters(items: ShopItem[], state: FilterState): string[] {
  const tokens = normalize(state.q).split(" ").filter(Boolean);
  return items
    .filter((i) => matches(i, state, tokens))
    .sort(SORTERS[state.sort])
    .map((i) => i.s);
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
