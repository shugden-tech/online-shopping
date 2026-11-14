// Scent Finder: answers, URL-hash state and scoring (pure functions, no DOM).

export const MOODS = ["amber", "woody", "citrus", "chypre", "fresh"] as const;
export type Mood = (typeof MOODS)[number];

/** Each mood band stands for a main family (3 points) and a neighbouring one (2 points). */
export const MOOD_FAMILIES: Record<Mood, { main: string; near: string }> = {
  amber: { main: "amber", near: "gourmand" },
  woody: { main: "woody", near: "aromatic" },
  citrus: { main: "citrus", near: "fresh" },
  chypre: { main: "chypre", near: "floral" },
  fresh: { main: "fresh", near: "aromatic" },
};

export const WHO = ["women", "men", "any"] as const;
export const WHEN = ["day", "night", "office", "date"] as const;
export const MAX_NOTES = 3;
export const STEPS = 5; // questions; step 0 = intro, step 6 = result
export const RESULT_STEP = STEPS + 1;

export interface Answers {
  who: (typeof WHO)[number] | null;
  when: (typeof WHEN)[number] | null;
  mood: Mood | null;
  notes: string[];
  intensity: number; // 1..5
}

export const EMPTY_ANSWERS: Answers = { who: null, when: null, mood: null, notes: [], intensity: 3 };

export interface QuizProduct {
  slug: string;
  brand: string;
  name: string;
  family: string;
  gender: string;
  groups: string[]; // note accords
  occasion: string[];
  intensity: number;
  shape: string;
  img?: string;
  featured: boolean;
  addMl: number;
  addPrice: number;
  soldOut: boolean;
  from: string; // formatted "from" price
}

export interface Match {
  product: QuizProduct;
  score: number;
  percent: number;
  family: "main" | "near" | null;
  notes: string[];
  occasion: boolean;
  intensityExact: boolean;
}

/** Is step `n` (1..5) answered well enough to move on? Notes are optional. */
export function answered(step: number, a: Answers): boolean {
  if (step === 1) return a.who !== null;
  if (step === 2) return a.when !== null;
  if (step === 3) return a.mood !== null;
  return true;
}

/** The furthest step the answers allow (guards hand-edited hashes). */
export function maxStep(a: Answers): number {
  for (let s = 1; s <= 3; s++) if (!answered(s, a)) return s;
  return RESULT_STEP;
}

export function parseHash(hash: string): { step: number; answers: Answers } {
  const sp = new URLSearchParams(hash.replace(/^#/, ""));
  const pickOne = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const v = sp.get(key) as T | null;
    return v && allowed.includes(v) ? v : null;
  };
  const answers: Answers = {
    who: pickOne("g", WHO),
    when: pickOne("o", WHEN),
    mood: pickOne("m", MOODS),
    notes: (sp.get("n") ?? "").split(",").filter(Boolean).slice(0, MAX_NOTES),
    intensity: Math.min(5, Math.max(1, Math.round(Number(sp.get("i")) || 3))),
  };
  const raw = Math.round(Number(sp.get("q")) || 0);
  const step = Math.min(Math.max(0, raw), maxStep(answers));
  return { step, answers };
}

export function toHash(step: number, a: Answers): string {
  if (step === 0) return "";
  const sp = new URLSearchParams();
  sp.set("q", String(step));
  if (a.who) sp.set("g", a.who);
  if (a.when) sp.set("o", a.when);
  if (a.mood) sp.set("m", a.mood);
  if (a.notes.length) sp.set("n", a.notes.join(","));
  sp.set("i", String(a.intensity));
  return "#" + sp.toString().replace(/%2C/g, ",");
}

/**
 * Weighted overlap: family 3 (neighbouring family 2), each loved note 2, occasion 1,
 * minus 1 per step of intensity distance. Returns the best `count` matches.
 */
export function recommend(products: QuizProduct[], a: Answers, count = 3): Match[] {
  const pool = products.filter((p) => {
    if (p.soldOut) return false;
    if (a.who === "women") return p.gender !== "men";
    if (a.who === "men") return p.gender !== "women";
    return true;
  });
  const fam = a.mood ? MOOD_FAMILIES[a.mood] : null;
  const best = 3 + a.notes.length * 2 + 1;
  const worst = -4;

  return pool
    .map((p): Match => {
      const family = fam ? (p.family === fam.main ? "main" : p.family === fam.near ? "near" : null) : null;
      const notes = a.notes.filter((n) => p.groups.includes(n));
      const occasion = a.when !== null && p.occasion.includes(a.when);
      const distance = Math.abs(p.intensity - a.intensity);
      const score = (family === "main" ? 3 : family === "near" ? 2 : 0) + notes.length * 2 + (occasion ? 1 : 0) - distance;
      const percent = Math.round(Math.min(1, Math.max(0, (score - worst) / (best - worst))) * 100);
      return { product: p, score, percent, family, notes, occasion, intensityExact: distance === 0 };
    })
    .sort(
      (x, y) =>
        y.score - x.score ||
        Number(y.product.featured) - Number(x.product.featured) ||
        x.product.name.localeCompare(y.product.name),
    )
    .slice(0, count);
}
