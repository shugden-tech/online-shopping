import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import notes from "./data/notes.json";

import { FAMILIES, GENDERS, SEASONS, OCCASIONS, SHAPES } from "./lib/taxonomy";

const noteId = z.string().refine((id) => id in notes, (id) => ({
  message: `Unknown note id "${id}". Add it to src/data/notes.json first.`,
}));
const noteList = z.array(noteId).min(1).max(8);

const size = z.object({
  ml: z.union([z.literal(2), z.literal(5), z.literal(10), z.literal(30)]),
  price: z.number().int().positive().max(5_000_000), // MNT
  inStock: z.boolean(),
});

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
        notes: z.object({ top: noteList, heart: noteList, base: noteList }),
        description: z.object({ mn: z.string().min(10), en: z.string().min(10) }),
        sizes: z
          .array(size)
          .min(1)
          .refine((s) => new Set(s.map((x) => x.ml)).size === s.length, "each size (ml) may appear only once"),
        bottleShape: z.enum(SHAPES),
        image: image().optional(), // e.g. "./photos/baccarat-rouge-540.jpg" (relative to the JSON file)
        featured: z.boolean().optional(),
        isNew: z.boolean().optional(),
        intensity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        season: z.array(z.enum(SEASONS)).min(1),
        occasion: z.array(z.enum(OCCASIONS)).min(1),
      })
      .strict(),
});

export const collections = { products };
