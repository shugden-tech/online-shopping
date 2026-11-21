export interface MasterProduct {
  id: string;
  brand: string;
  name: string;
  concentration: "EDT" | "EDP" | "Parfum" | "Extrait" | "Cologne" | null;
  bottle_sizes_ml: number[] | null;
  release_year: number | null;
  notes: { top: string[]; heart: string[]; base: string[] };
  images: { front: string | null; back: string | null };
}
export function validateMasterCatalog(value: unknown, mediaBase: string): MasterProduct[];
export function catalogPhotos<T extends { slug: string; concentration: string; image?: unknown }>(product: T, catalogById: Map<string, MasterProduct>): T & { photos?: { front?: string; back?: string } };
