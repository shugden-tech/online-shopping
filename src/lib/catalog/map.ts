// A1 catalog: D1 row types and row -> AdminProduct / AdminSku mapping. Server-only.
import type { AdminProduct, AdminSku, Gender, Notes, ProductStatus, SkuKind } from "../contracts";

export type D1 = import("@cloudflare/workers-types").D1Database;

export interface ProductRow {
  id: string;
  brand: string;
  name: string;
  concentration: string | null;
  gender: string | null;
  family: string | null;
  release_year: number | null;
  notes_json: string;
  description_mn: string | null;
  description_en: string | null;
  image_front: string | null;
  image_back: string | null;
  status: string;
  sale_locked: number;
  sort: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SkuRow {
  id: string;
  product_id: string;
  ml: number;
  kind: string;
  price: number | null;
  compare_at: number | null;
  stock: number | null;
  reserved: number;
  active: number;
  updated_at: string;
}

export const PRODUCT_COLS =
  "id, brand, name, concentration, gender, family, release_year, notes_json, description_mn, description_en, image_front, image_back, status, sale_locked, sort, source, created_at, updated_at";
export const SKU_COLS = "id, product_id, ml, kind, price, compare_at, stock, reserved, active, updated_at";

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseNotes(json: string | null): Notes {
  try {
    const n = JSON.parse(json ?? "") as Record<string, unknown>;
    return { top: strList(n?.top), heart: strList(n?.heart), base: strList(n?.base) };
  } catch {
    return { top: [], heart: [], base: [] };
  }
}

export const available = (stock: number | null, reserved: number): number | null => (stock === null ? null : stock - reserved);

export function toAdminSku(r: SkuRow): AdminSku {
  return {
    id: r.id,
    productId: r.product_id,
    ml: r.ml,
    kind: r.kind as SkuKind,
    price: r.price,
    compareAt: r.compare_at,
    stock: r.stock,
    reserved: r.reserved,
    available: available(r.stock, r.reserved),
    active: r.active === 1,
    updatedAt: r.updated_at,
  };
}

export function toAdminProduct(r: ProductRow, skus: SkuRow[]): AdminProduct {
  return {
    id: r.id,
    brand: r.brand,
    name: r.name,
    concentration: r.concentration,
    gender: r.gender as Gender | null,
    family: r.family,
    releaseYear: r.release_year,
    notes: parseNotes(r.notes_json),
    descriptionMn: r.description_mn,
    descriptionEn: r.description_en,
    imageFront: r.image_front,
    imageBack: r.image_back,
    status: r.status as ProductStatus,
    saleLocked: r.sale_locked === 1,
    sort: r.sort,
    source: r.source as AdminProduct["source"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    skus: skus.filter((s) => s.product_id === r.id).sort((a, b) => a.ml - b.ml).map(toAdminSku),
  };
}

/** SKU rows for many products in one query (json_each keeps us under D1's 100-parameter limit). */
export async function skusFor(db: D1, productIds: string[]): Promise<SkuRow[]> {
  if (!productIds.length) return [];
  const res = await db
    .prepare(`SELECT ${SKU_COLS} FROM skus WHERE product_id IN (SELECT value FROM json_each(?1)) ORDER BY product_id, ml`)
    .bind(JSON.stringify(productIds))
    .all<SkuRow>();
  return res.results ?? [];
}

/** True when a D1 error is a CHECK / UNIQUE / FOREIGN KEY constraint failure. */
export const isConstraint = (err: unknown, kind: "CHECK" | "UNIQUE" | "FOREIGN KEY" | "NOT NULL") =>
  String((err as Error)?.message ?? err).includes(`${kind} constraint failed`);
