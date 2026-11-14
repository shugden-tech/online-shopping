// Client-safe i18n bits for islands. Islands get their strings as props, so this file
// must NOT import the JSON dictionaries (that would ship both languages to the browser).
import type mn from "./mn.json";

export type Locale = "mn" | "en";
export type Dict = typeof mn;

export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
