// Build-time lookups for the note photos and family ingredient strips in src/assets.
import type { ImageMetadata } from "astro";

// Owner-supplied logos, imported directly from their source folder.
const brandLogoFiles = import.meta.glob<string>("../../assets/logos/brand logo/*.svg", { eager: true, query: "?url", import: "default" });
const brandNames: Record<string, string> = { hermes: "Hermès", "victoria-s-secret": "Victoria's Secret", "viktor-rolf": "Viktor & Rolf" };
export const brandLogos = Object.entries(brandLogoFiles).sort(([a], [b]) => a.localeCompare(b)).map(([path, src]) => {
  const id = path.split("/").pop()!.replace(/\.svg$/, "");
  return { src, name: brandNames[id] ?? id.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ") };
});

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

/**
 * Home banner pictures: every image in src/assets/thumbnail/, in file-name order (name them 01-…, 02-… to
 * choose the order). When the folder is empty the home page falls back to the illustrated slides.
 */
const bannerFiles = import.meta.glob<{ default: ImageMetadata }>("../assets/thumbnail/*.{jpg,jpeg,png,webp,avif}", { eager: true });
export const bannerImages: Array<{ name: string; image: ImageMetadata }> = Object.entries(bannerFiles)
  .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
  .map(([path, mod]) => ({ name: path.split("/").pop()!.replace(/\.\w+$/, ""), image: mod.default }));

// Keep uploaded originals intact; Astro generates responsive derivatives at build time.
const heroFiles = import.meta.glob<{ default: ImageMetadata }>("../../pic_chat/*.{jpg,jpeg,png,webp,avif}", { eager: true });
export const perfumeHeroImages = Object.fromEntries(
  Object.entries(heroFiles).map(([path, mod]) => [path.split("/").pop()!, mod.default]),
);

/** Owner-approved gender tile images (home page). */
const genderFiles = import.meta.glob<{ default: ImageMetadata }>("../assets/gender/*.{jpg,jpeg,png,webp,avif}", { eager: true });
export const genderImages = byName(genderFiles);

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
