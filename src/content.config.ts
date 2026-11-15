import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import notes from "./data/notes.json";

import { FAMILIES, GENDERS, SEASONS, OCCASIONS, SHAPES } from "./lib/taxonomy";

const noteId = z.string().refine((id) => id in notes, (id) => ({
  message: `Unknown note id "${id}". Add it to src/data/notes.json first.`,
}));
// A tier may be empty: imported perfumes do not always list every tier (or any notes at all).
const noteList = z.array(noteId).max(8);

// A decant (2 / 5 / 10 / 30 ml), or the full retail bottle marked `"full": true` (15–500 ml).
const DECANT_ML = [2, 5, 10, 30];
const size = z
  .object({
    ml: z.number().int().min(1).max(500),
    price: z.number().int().min(0).max(5_000_000), // 0 means price not set; never purchasable
    inStock: z.boolean(),
    stock: z.number().int().min(0).max(100000).optional(),
    full: z.boolean().optional(),
  })
  .refine((s) => s.price > 0 || !s.inStock, "A size without a price cannot be in stock")
  .refine((s) => s.stock === undefined || s.inStock === (s.stock > 0), "inStock must match the stock quantity")
  .refine((s) => (s.full ? s.ml >= 15 : DECANT_ML.includes(s.ml)), (s) => ({
    message: s.full
      ? `A full bottle must be at least 15 ml (got ${s.ml}).`
      : `Decant size must be one of ${DECANT_ML.join(", ")} ml (got ${s.ml}). For a full bottle add "full": true.`,
  }));

const products = defineCollection({
  loader: glob({ pattern: "*.json", base: "./src/content/products" }),
  schema: ({ image }) =>
    z
      .object({
        slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase-with-dashes and equal the file name"),
        brand: z.string().min(1),
        name: z.string().min(1),
        concentration: z.enum(["EDT", "EDP", "Parfum", "Extrait", "Cologne"]),
        gender: z.enum(GENDERS),
        family: z.enum(FAMILIES),
        notes: z.object({ top: noteList, heart: noteList, base: noteList, key: noteList.optional() }),
        description: z.object({ mn: z.string().min(10), en: z.string().min(10) }),
        sizes: z
          .array(size)
          .min(1)
          .refine((s) => new Set(s.map((x) => x.ml)).size === s.length, "each size (ml) may appear only once")
          .refine((s) => s.filter((x) => x.full).length <= 1, "only one size may be the full bottle"),
        bottleShape: z.enum(SHAPES),
        image: image().optional(), // e.g. "./photos/baccarat-rouge-540.jpg" (relative to the JSON file)
        // Remote product photos, linked by scripts/link-product-images.mjs. `front` is the bottle,
        // `back` the bottle with its box. Either may be missing; never fill one with another product's photo.
        photos: z
          .object({
            front: z.union([z.string().url().startsWith("https://"), z.string().regex(/^\/product-photos\/[a-z0-9-]+\.webp$/)]).optional(),
            back: z.union([z.string().url().startsWith("https://"), z.string().regex(/^\/product-photos\/[a-z0-9-]+\.webp$/)]).optional(),
          })
          .strict()
          .optional(),
        featured: z.boolean().optional(),
        isNew: z.boolean().optional(),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        season: z.array(z.enum(SEASONS)).min(1),
        occasion: z.array(z.enum(OCCASIONS)).min(1),
      })
      .strict(),
});

export const collections = { products };
