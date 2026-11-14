// Build-time lookups for the note photos and family ingredient strips in src/assets.
import type { ImageMetadata } from "astro";

const noteFiles = import.meta.glob<{ default: ImageMetadata }>("../assets/notes/*.{jpeg,jpg,png}", { eager: true });
const familyFiles = import.meta.glob<{ default: ImageMetadata }>("../assets/families/*.avif", { eager: true });

const byName = (files: Record<string, { default: ImageMetadata }>) => {
  const out: Record<string, ImageMetadata> = {};
  for (const [path, mod] of Object.entries(files)) {
    const name = path.split("/").pop()!.replace(/\.\w+$/, "");
    out[name] = mod.default;
  }
  return out;
};

/** Note photo by accord id, e.g. noteImages["white-flowers"]. */
export const noteImages = byName(noteFiles);

/** Ingredient strip by family id. The "medley" strip stands for the Fresh family. */
const strips = byName(familyFiles);
export const familyStrips: Record<string, ImageMetadata> = {
  amber: strips.amber!,
  chypre: strips.chypre!,
  citrus: strips.citrus!,
  fresh: strips.medley!,
  woody: strips.woody!,
};

/** The five families that have an ingredient strip (home bands, quiz moods), in display order. */
export const BAND_FAMILIES = ["amber", "woody", "citrus", "chypre", "fresh"] as const;
export type BandFamily = (typeof BAND_FAMILIES)[number];
