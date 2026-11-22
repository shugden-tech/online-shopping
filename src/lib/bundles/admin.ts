// Bundles (0005): admin validation and writes. Server-only (zod). Every write is one D1 batch with its audit row.
import { z } from "astro/zod";
import { auditStatement } from "../audit";
import { PRODUCT_ID_RE, PRODUCT_STATUSES, parseSkuId, skuId, type Actor } from "../contracts";
import { isAllowedImage, MAX_PRICE } from "../catalog/validate";
import type { D1 } from "../catalog/map";
import { getBundle } from "./store";
import { BUNDLE_ID_RE, MAX_BUNDLE_PARTS } from "./types";

const optText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v ? v : null));

const part = z
  .object({
    sku: z.string().trim().min(3).max(130),
    qty: z.number().int().min(1).max(10).default(1),
    label: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .transform((v, ctx) => {
    const p = parseSkuId(v.sku);
    if (!p || !PRODUCT_ID_RE.test(p.productId) || p.ml > 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid" });
      return z.NEVER;
    }
    return { sku: skuId(p.productId, p.ml), qty: v.qty, label: v.label || null };
  });

function fields(mediaBase: string | undefined) {
  return {
    nameMn: z.string().trim().min(1).max(120),
    nameEn: optText(120),
    descriptionMn: optText(2000),
    descriptionEn: optText(2000),
    image: z
      .string()
      .trim()
      .refine((v) => isAllowedImage(v, mediaBase), { message: "host" })
      .nullable(),
    price: z.number().int().positive().max(MAX_PRICE).nullable(),
    compareAt: z.number().int().positive().max(MAX_PRICE).nullable(),
    status: z.enum(PRODUCT_STATUSES),
    sort: z.number().int().min(-1_000_000).max(1_000_000),
    items: z
      .array(part)
      .min(1)
      .max(MAX_BUNDLE_PARTS)
      .refine((list) => new Set(list.map((p) => p.sku)).size === list.length, { message: "duplicate" }),
  };
}

const compareOk = (v: { price?: number | null; compareAt?: number | null }) =>
  v.compareAt == null || v.price == null || v.compareAt > v.price;

export function bundleCreateSchema(mediaBase: string | undefined) {
  const f = fields(mediaBase);
  return z
    .object({
      id: z.string().trim().regex(BUNDLE_ID_RE),
      ...f,
      nameEn: f.nameEn.optional().default(null),
      descriptionMn: f.descriptionMn.optional().default(null),
      descriptionEn: f.descriptionEn.optional().default(null),
      image: f.image.optional().default(null),
      compareAt: f.compareAt.optional().default(null),
      status: f.status.optional().default("draft"),
      sort: f.sort.optional().default(0),
    })
    .strict()
    .refine(compareOk, { path: ["compareAt"], message: "compare" });
}
export type BundleCreate = z.infer<ReturnType<typeof bundleCreateSchema>>;

export function bundlePatchSchema(mediaBase: string | undefined) {
  return z
    .object(fields(mediaBase))
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: "empty" });
}
export type BundlePatch = z.infer<ReturnType<typeof bundlePatchSchema>>;

/** zod issues -> `{ field: code }`. */
export function bundleErrors(issues: z.ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.length ? String(i.path[0]) : "form";
    if (out[key]) continue;
    if (i.code === "unrecognized_keys") {
      for (const k of i.keys) out[k] ??= "unknown";
      continue;
    }
    if (i.code === "invalid_type" && i.received === "undefined") out[key] = "required";
    else if (i.code === "custom" && ["host", "empty", "duplicate", "compare"].includes(i.message)) out[key] = i.message;
    else if (i.code === "too_small" && key === "items") out[key] = "required";
    else out[key] = "invalid";
  }
  return Object.keys(out).length ? out : { form: "invalid" };
}

const itemStatements = (db: D1, id: string, items: BundleCreate["items"]) => [
  db.prepare("DELETE FROM bundle_items WHERE bundle_id = ?1").bind(id),
  ...items.map((p, i) =>
    db.prepare("INSERT INTO bundle_items (bundle_id, sku, qty, label, sort) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, p.sku, p.qty, p.label, i + 1),
  ),
];

export async function createBundle(db: D1, actor: Actor, b: BundleCreate) {
  const exists = await db.prepare("SELECT 1 FROM bundles WHERE id = ?1").bind(b.id).first();
  if (exists) return { conflict: true as const };
  await db.batch([
    db
      .prepare(
        `INSERT INTO bundles (id, name_mn, name_en, description_mn, description_en, image, price, compare_at, status, sort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(b.id, b.nameMn, b.nameEn, b.descriptionMn, b.descriptionEn, b.image, b.price, b.compareAt, b.status, b.sort),
    ...itemStatements(db, b.id, b.items).slice(1),
    auditStatement(db, actor, "bundle.create", "bundle", b.id, { price: b.price, status: b.status, items: b.items.map((p) => `${p.sku}×${p.qty}`) }),
  ]);
  return { bundle: await getBundle(db, b.id) };
}

const COLUMN: Record<string, string> = {
  nameMn: "name_mn", nameEn: "name_en", descriptionMn: "description_mn", descriptionEn: "description_en",
  image: "image", price: "price", compareAt: "compare_at", status: "status", sort: "sort",
};

export async function patchBundle(db: D1, actor: Actor, id: string, patch: BundlePatch) {
  const cur = await db.prepare("SELECT price, compare_at FROM bundles WHERE id = ?1").bind(id).first<{ price: number | null; compare_at: number | null }>();
  if (!cur) return { notFound: true as const };
  const price = patch.price !== undefined ? patch.price : cur.price;
  const compareAt = patch.compareAt !== undefined ? patch.compareAt : cur.compare_at;
  if (compareAt !== null && price !== null && compareAt <= price) return { errors: { compareAt: "compare" } as Record<string, string> };
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(COLUMN)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    args.push(v as string | number | null);
    sets.push(`${col} = ?${args.length + 1}`);
  }
  const { items, ...rest } = patch;
  await db.batch([
    db.prepare(`UPDATE bundles SET ${[...sets, "updated_at = datetime('now')"].join(", ")} WHERE id = ?1`).bind(id, ...args),
    ...(items ? itemStatements(db, id, items) : []),
    auditStatement(db, actor, "bundle.update", "bundle", id, { ...rest, ...(items ? { items: items.map((p) => `${p.sku}×${p.qty}`) } : {}) }),
  ]);
  return { bundle: await getBundle(db, id) };
}

export async function deleteBundle(db: D1, actor: Actor, id: string): Promise<boolean> {
  const cur = await db.prepare("SELECT name_mn FROM bundles WHERE id = ?1").bind(id).first<{ name_mn: string }>();
  if (!cur) return false;
  // past orders keep their own copy of the bundle (orders.items_json), so deleting is safe
  await db.batch([
    db.prepare("DELETE FROM bundle_items WHERE bundle_id = ?1").bind(id),
    db.prepare("DELETE FROM bundles WHERE id = ?1").bind(id),
    auditStatement(db, actor, "bundle.delete", "bundle", id, { name: cur.name_mn }),
  ]);
  return true;
}
