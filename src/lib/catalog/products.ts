// A1 catalog: product list / search / get / create / patch. Every write goes in one D1 batch with its audit row.
import type { Actor, AdminProduct, Page, ProductStatus } from "../contracts";
import { PRODUCT_STATUSES } from "../contracts";
import { auditStatement } from "../audit";
import { PRODUCT_COLS, isConstraint, skusFor, toAdminProduct, type D1, type ProductRow } from "./map";
import type { ProductCreate, ProductPatch } from "./validate";

export interface ProductQuery {
  q?: string;
  status?: ProductStatus;
  brand?: string;
  page: number;
  limit: number;
}

/** Parses ?q=&status=&brand=&page=&limit= . Returns field errors for bad values. */
export function parseProductQuery(sp: URLSearchParams): ProductQuery | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const status = sp.get("status") || undefined;
  if (status && !(PRODUCT_STATUSES as readonly string[]).includes(status)) errors.status = "invalid";
  const brand = (sp.get("brand") ?? "").trim().slice(0, 120);
  const page = sp.has("page") ? Number(sp.get("page")) : 1;
  const limit = sp.has("limit") ? Number(sp.get("limit")) : 50;
  if (!Number.isInteger(page) || page < 1 || page > 10_000) errors.page = "invalid";
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.limit = "invalid";
  if (Object.keys(errors).length) return { errors };
  return { q: q || undefined, status: status as ProductStatus | undefined, brand: brand || undefined, page, limit };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

export async function listProducts(db: D1, query: ProductQuery): Promise<Page<AdminProduct>> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `?${args.length}`;
  };
  if (query.q) {
    const p = arg(`%${likeEscape(query.q)}%`);
    where.push(`(brand LIKE ${p} ESCAPE '\\' OR name LIKE ${p} ESCAPE '\\' OR id LIKE ${p} ESCAPE '\\')`);
  }
  if (query.status) where.push(`status = ${arg(query.status)}`);
  if (query.brand) where.push(`brand = ${arg(query.brand)} COLLATE NOCASE`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (query.page - 1) * query.limit;
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM products ${w}`).bind(...args),
    db
      .prepare(
        `SELECT ${PRODUCT_COLS} FROM products ${w}
         ORDER BY sort, brand COLLATE NOCASE, name COLLATE NOCASE, id LIMIT ${arg(query.limit)} OFFSET ${arg(offset)}`,
      )
      .bind(...args),
  ]);
  const total = (count!.results as { n: number }[])[0]?.n ?? 0;
  const items = (rows!.results ?? []) as ProductRow[];
  const skus = await skusFor(db, items.map((r) => r.id));
  return { items: items.map((r) => toAdminProduct(r, skus)), page: query.page, limit: query.limit, total };
}

export async function getProductRow(db: D1, id: string): Promise<ProductRow | null> {
  return db.prepare(`SELECT ${PRODUCT_COLS} FROM products WHERE id = ?1`).bind(id).first<ProductRow>();
}

export async function getAdminProduct(db: D1, id: string): Promise<AdminProduct | null> {
  const row = await getProductRow(db, id);
  if (!row) return null;
  return toAdminProduct(row, await skusFor(db, [id]));
}

/** Creates an admin product. Returns null when the id is already taken. */
export async function createProduct(db: D1, actor: Actor, input: ProductCreate): Promise<AdminProduct | null> {
  const notes = input.notes ?? { top: [], heart: [], base: [] };
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO products (id, brand, name, concentration, gender, family, release_year, notes_json, description_mn,
             description_en, image_front, image_back, status, sale_locked, sort, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'admin')`,
        )
        .bind(
          input.id, input.brand, input.name, input.concentration ?? null, input.gender ?? null, input.family ?? null,
          input.releaseYear ?? null, JSON.stringify(notes), input.descriptionMn ?? null, input.descriptionEn ?? null,
          input.imageFront ?? null, input.imageBack ?? null, input.status ?? "draft", input.saleLocked ? 1 : 0, input.sort ?? 0,
        ),
      auditStatement(db, actor, "product.create", "product", input.id, { ...input, id: undefined }),
    ]);
  } catch (err) {
    if (isConstraint(err, "UNIQUE")) return null;
    throw err;
  }
  return getAdminProduct(db, input.id);
}

const PATCH_COLUMNS: Record<keyof ProductPatch, string> = {
  brand: "brand",
  name: "name",
  concentration: "concentration",
  gender: "gender",
  family: "family",
  releaseYear: "release_year",
  notes: "notes_json",
  descriptionMn: "description_mn",
  descriptionEn: "description_en",
  imageFront: "image_front",
  imageBack: "image_back",
  status: "status",
  saleLocked: "sale_locked",
  sort: "sort",
};

/** Applies a validated patch. Returns null when the product does not exist. */
export async function patchProduct(db: D1, actor: Actor, id: string, patch: ProductPatch): Promise<AdminProduct | null> {
  const before = await getProductRow(db, id);
  if (!before) return null;
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof ProductPatch, unknown][]) {
    if (v === undefined) continue;
    args.push(k === "notes" ? JSON.stringify(v) : k === "saleLocked" ? (v ? 1 : 0) : v);
    sets.push(`${PATCH_COLUMNS[k]} = ?${args.length}`);
  }
  args.push(id);
  const data: Record<string, unknown> = { ...patch };
  if (patch.status !== undefined && patch.status !== before.status) data.fromStatus = before.status;
  const results = await db.batch([
    db.prepare(`UPDATE products SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${args.length}`).bind(...args),
    auditStatement(db, actor, "product.update", "product", id, data),
  ]);
  if (!results[0]?.meta.changes) return null;
  return getAdminProduct(db, id);
}
