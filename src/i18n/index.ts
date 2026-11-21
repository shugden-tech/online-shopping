import mn from "./mn.json";
import en from "./en.json";
import { ROUTES, route, productPath, bundlePath, alternatesFor } from "./routes.mjs";

export type Locale = "mn" | "en";
export type Dict = typeof mn;
export const LOCALES: Locale[] = ["mn", "en"];
export const DEFAULT_LOCALE: Locale = "mn";

// `en` must have exactly the same shape as `mn` — a missing key is a type error.
const dicts: Record<Locale, Dict> = { mn, en: en satisfies Dict };

const TODO = /\s*\[\[TODO owner\]\]\s*/g;

/** Placeholder copy is tagged `[[TODO owner]]` in the JSON; the tag itself is never shown on the page. */
function strip<T>(value: T): T {
  if (typeof value === "string") return value.replace(TODO, " ").trim() as T;
  if (Array.isArray(value)) return value.map(strip) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = strip(v);
    return out as T;
  }
  return value;
}

const clean: Record<Locale, Dict> = { mn: strip(dicts.mn), en: strip(dicts.en) };

/** The whole dictionary for a locale: `const tr = getDict("mn"); tr.nav.shop`. */
export function getDict(locale: Locale): Dict {
  return clean[locale];
}

type Leaves<T, P extends string = ""> = T extends string
  ? P
  : T extends readonly unknown[]
    ? never
    : { [K in keyof T & string]: Leaves<T[K], P extends "" ? K : `${P}.${K}`> }[keyof T & string];
export type TKey = Leaves<Dict>;

/** Typed lookup with `{name}` interpolation: `t("mn", "cart.freeHint", { amount: "5,000₮" })`. */
export function t(locale: Locale, key: TKey, vars?: Record<string, string | number>): string {
  let cur: unknown = clean[locale];
  for (const part of key.split(".")) cur = (cur as Record<string, unknown>)[part];
  return fill(String(cur), vars);
}

export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function localeFromPath(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "mn";
}

/** Pick the right language from a `{ mn, en }` pair (product descriptions, settings). */
export function pick<T>(pair: { mn: T; en: T }, locale: Locale): T {
  return pair[locale];
}

export { ROUTES, route, productPath, bundlePath, alternatesFor };
export type RouteKey = keyof typeof ROUTES;
