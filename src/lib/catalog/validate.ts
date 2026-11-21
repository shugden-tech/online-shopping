// A1 catalog: request validation (astro/zod, server-only — never import from an island).
import { z } from "astro/zod";
import { GENDERS, PRODUCT_ID_RE, PRODUCT_STATUSES, SKU_KINDS, STOCK_REASONS } from "../contracts";

export const CONCENTRATIONS = ["EDP", "EDT", "Parfum", "Extrait", "Cologne"] as const;
export const MAX_PRICE = 50_000_000;
export const MAX_STOCK = 100_000;

/**
 * An image reference the storefront may load: an https URL on the host of PUBLIC_MEDIA_BASE, or a site
 * path that starts with exactly one "/" (never "//", which is protocol-relative).
 */
export function isAllowedImage(value: string, mediaBase: string | undefined): boolean {
  if (value.length > 500 || /[\s\\<>"']/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  if (!mediaBase) return false;
  try {
    const u = new URL(value);
    const base = new URL(mediaBase);
    return u.protocol === "https:" && u.host === base.host && !u.username && !u.password;
  } catch {
    return false;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const noteList = z.array(z.string().trim().min(1).max(60)).max(30);

function productFields(mediaBase: string | undefined) {
  const image = z
    .string()
    .trim()
    .refine((v) => isAllowedImage(v, mediaBase), { message: "host" })
    .nullable();
  return {
    brand: text(120),
    name: text(200),
    concentration: z.enum(CONCENTRATIONS).nullable(),
    gender: z.enum(GENDERS).nullable(),
    family: z.string().regex(/^[a-z][a-z-]{0,39}$/).nullable(),
    releaseYear: z.number().int().min(1700).max(2100).nullable(),
    notes: z.object({ top: noteList, heart: noteList, base: noteList }).strict(),
    descriptionMn: z.string().trim().max(5000).nullable(),
    descriptionEn: z.string().trim().max(5000).nullable(),
    imageFront: image,
    imageBack: image,
    status: z.enum(PRODUCT_STATUSES),
    saleLocked: z.boolean(),
    sort: z.number().int().min(-1_000_000).max(1_000_000),
  };
}

export function productCreateSchema(mediaBase: string | undefined) {
  const f = productFields(mediaBase);
  return z
    .object({
      id: z.string().regex(PRODUCT_ID_RE),
      brand: f.brand,
      name: f.name,
      concentration: f.concentration.optional(),
      gender: f.gender.optional(),
      family: f.family.optional(),
      releaseYear: f.releaseYear.optional(),
      notes: f.notes.optional(),
      descriptionMn: f.descriptionMn.optional(),
      descriptionEn: f.descriptionEn.optional(),
      imageFront: f.imageFront.optional(),
      imageBack: f.imageBack.optional(),
      status: f.status.optional(),
      saleLocked: f.saleLocked.optional(),
      sort: f.sort.optional(),
    })
    .strict();
}
export type ProductCreate = z.infer<ReturnType<typeof productCreateSchema>>;

export function productPatchSchema(mediaBase: string | undefined) {
  const f = productFields(mediaBase);
  return z
    .object({
      brand: f.brand,
      name: f.name,
      concentration: f.concentration,
      gender: f.gender,
      family: f.family,
      releaseYear: f.releaseYear,
      notes: f.notes,
      descriptionMn: f.descriptionMn,
      descriptionEn: f.descriptionEn,
      imageFront: f.imageFront,
      imageBack: f.imageBack,
      status: f.status,
      saleLocked: f.saleLocked,
      sort: f.sort,
    })
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: "empty" });
}
export type ProductPatch = z.infer<ReturnType<typeof productPatchSchema>>;

const money = z.number().int().min(1).max(MAX_PRICE);
export const skuUpsertSchema = z
  .object({
    kind: z.enum(SKU_KINDS),
    price: money.nullable(),
    compareAt: money.nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();
export type SkuUpsert = z.infer<typeof skuUpsertSchema>;

export const ADJUST_REASONS = ["restock", "correction"] as const satisfies readonly (typeof STOCK_REASONS)[number][];
export const adjustSchema = z
  .object({
    sku: z.string().min(3).max(140),
    set: z.number().int().min(0).max(MAX_STOCK).optional(),
    delta: z.number().int().min(-MAX_STOCK).max(MAX_STOCK).refine((d) => d !== 0, { message: "zero" }).optional(),
    reason: z.enum(ADJUST_REASONS),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type AdjustInput = z.infer<typeof adjustSchema>;

/** zod issues -> `{ field: code }` (first issue per top-level field). */
export function issuesToErrors(issues: z.ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.length ? String(i.path[0]) : "form";
    if (out[key]) continue;
    if (i.code === "unrecognized_keys") {
      for (const k of i.keys) out[k] ??= "unknown";
      continue;
    }
    if (i.code === "invalid_type" && i.received === "undefined") out[key] = "required";
    else if (i.code === "custom" && i.message === "host") out[key] = "host";
    else if (i.code === "custom" && i.message === "empty") out[key] = "empty";
    else out[key] = "invalid";
  }
  return Object.keys(out).length ? out : { form: "invalid" };
}
