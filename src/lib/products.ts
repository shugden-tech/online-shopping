// Server-side (build-time) access to the product collection.
import { getCollection, type CollectionEntry } from "astro:content";
import { getImage } from "astro:assets";
import notesJson from "../data/notes.json";
import type { Locale } from "../i18n";

export type Product = CollectionEntry<"products">["data"];
export type Family = Product["family"];
export type NoteInfo = { mn: string; en: string; image?: string };

export const NOTES = notesJson as Record<string, NoteInfo>;

/** The 11 photographed accords, in display order. Ids match files in src/assets/notes. */
export const NOTE_GROUPS = [
  "amber", "woods", "white-flowers", "vanilla", "oud", "musk",
  "saffron", "leather", "aromatic-notes", "green-notes", "incense-minerals",
] as const;
export type NoteGroup = (typeof NOTE_GROUPS)[number];

let cache: Product[] | null = null;

export async function getProducts(): Promise<Product[]> {
  if (cache) return cache;
  const entries = await getCollection("products");
  for (const e of entries) {
    if (e.data.slug !== e.id) {
      throw new Error(`Product file "${e.id}.json" has slug "${e.data.slug}". The slug must equal the file name.`);
    }
  }
  cache = entries.map((e) => e.data).sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  return cache;
}

export async function getProduct(slug: string): Promise<Product | undefined> {
  return (await getProducts()).find((p) => p.slug === slug);
}

export const allNotes = (p: Product): string[] => [...p.notes.top, ...p.notes.heart, ...p.notes.base];

/** Photo accords a product belongs to (via each note's `image` in notes.json). */
export function noteGroups(p: Product): string[] {
  const out = new Set<string>();
  for (const id of allNotes(p)) {
    const g = NOTES[id]?.image;
    if (g) out.add(g);
  }
  return [...out];
}

export const noteLabel = (id: string, locale: Locale): string => NOTES[id]?.[locale] ?? id;

export const sortedSizes = (p: Product) => [...p.sizes].sort((a, b) => a.ml - b.ml);

/** The size a card starts on: the smallest one in stock (or simply the smallest). */
export function defaultSize(p: Product) {
  const s = sortedSizes(p);
  return s.find((x) => x.inStock) ?? s[0]!;
}

/** Lowest price among in-stock sizes (falls back to the lowest price overall). */
export function fromPrice(p: Product): number {
  const inStock = p.sizes.filter((s) => s.inStock);
  return Math.min(...(inStock.length ? inStock : p.sizes).map((s) => s.price));
}

export const isSoldOut = (p: Product): boolean => p.sizes.every((s) => !s.inStock);

export const initialOf = (p: Product): string => p.brand.trim().charAt(0).toUpperCase();

/** Optimised thumbnail URL for islands when the owner has set a real photo. */
export async function thumbOf(p: Product, width = 480): Promise<string | undefined> {
  if (!p.image) return undefined;
  const img = await getImage({ src: p.image, width, format: "webp" });
  return img.src;
}

/** The snapshot stored in the cart for a product (without size/price/qty). */
export async function cartBase(p: Product) {
  const img = await thumbOf(p, 240);
  return {
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    family: p.family,
    shape: p.bottleShape,
    ...(img ? { img } : {}),
  };
}

/** "Similar scents": same family first, then shared notes, then shared accords. */
export function similarTo(p: Product, all: Product[], count = 4): Product[] {
  const notes = new Set(allNotes(p));
  const groups = new Set(noteGroups(p));
  return all
    .filter((o) => o.slug !== p.slug)
    .map((o) => {
      let score = o.family === p.family ? 6 : 0;
      for (const n of allNotes(o)) if (notes.has(n)) score += 2;
      for (const g of noteGroups(o)) if (groups.has(g)) score += 1;
      if (o.gender === p.gender) score += 1;
      score -= Math.abs(o.intensity - p.intensity) * 0.5;
      return { o, score };
    })
    .sort((a, b) => b.score - a.score || a.o.name.localeCompare(b.o.name))
    .slice(0, count)
    .map((x) => x.o);
}
