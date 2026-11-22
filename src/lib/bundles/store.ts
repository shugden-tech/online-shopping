// Bundles (0005): D1 reads and the sellability rule. Server-only.
// A bundle can be bought when: checkout is open, the bundle is active and priced, it has at least one part,
// and every part SKU is sellable on its own (isSellable: product active + not locked, SKU active + priced)
// with enough stock for `qty` units per bundle. Untracked SKUs (stock NULL) do not limit it.
import { isSellable, parseSkuId, type ProductStatus } from "../contracts";
import { available as availOf, parseNotes, type D1 } from "../catalog/map";
import type { BundleBlock, BundlePart, BundleState, BundleView } from "./types";

export interface BundleRow {
  id: string;
  name_mn: string;
  name_en: string | null;
  description_mn: string | null;
  description_en: string | null;
  image: string | null;
  price: number | null;
  compare_at: number | null;
  status: ProductStatus;
  sort: number;
  created_at: string;
  updated_at: string;
}
interface ItemRow { bundle_id: string; sku: string; qty: number; label: string | null; sort: number }
interface PartRow {
  sku: string;
  product_id: string | null;
  brand: string | null;
  name: string | null;
  concentration: string | null;
  image_front: string | null;
  notes_json: string | null;
  status: ProductStatus | null;
  sale_locked: number | null;
  price: number | null;
  stock: number | null;
  reserved: number | null;
  active: number | null;
  has_sku: number;
}

const COLS = "id, name_mn, name_en, description_mn, description_en, image, price, compare_at, status, sort, created_at, updated_at";

async function partRows(db: D1, skus: string[]): Promise<Map<string, PartRow>> {
  const out = new Map<string, PartRow>();
  if (!skus.length) return out;
  // product id = the SKU id up to its last ":" (resolved here; SQLite has no last-index-of)
  const pids = [...new Set(skus.map((s) => parseSkuId(s)?.productId).filter((x): x is string => !!x))];
  const [prods, skuRes] = await Promise.all([
    db
      .prepare("SELECT id, brand, name, concentration, image_front, notes_json, status, sale_locked FROM products WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(pids))
      .all<{ id: string; brand: string; name: string; concentration: string | null; image_front: string | null; notes_json: string; status: ProductStatus; sale_locked: number }>(),
    db
      .prepare("SELECT id, price, stock, reserved, active FROM skus WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(skus))
      .all<{ id: string; price: number | null; stock: number | null; reserved: number; active: number }>(),
  ]);
  const pById = new Map((prods.results ?? []).map((p) => [p.id, p]));
  const sById = new Map((skuRes.results ?? []).map((s) => [s.id, s]));
  for (const sku of skus) {
    const pid = parseSkuId(sku)?.productId ?? "";
    const p = pById.get(pid);
    const s = sById.get(sku);
    out.set(sku, {
      sku,
      product_id: p?.id ?? null,
      brand: p?.brand ?? null,
      name: p?.name ?? null,
      concentration: p?.concentration ?? null,
      image_front: p?.image_front ?? null,
      notes_json: p?.notes_json ?? null,
      status: p?.status ?? null,
      sale_locked: p?.sale_locked ?? null,
      price: s?.price ?? null,
      stock: s?.stock ?? null,
      reserved: s?.reserved ?? null,
      active: s?.active ?? null,
      has_sku: s ? 1 : 0,
    });
  }
  return out;
}

function toPart(item: ItemRow, r: PartRow | undefined): BundlePart {
  const parsed = parseSkuId(item.sku);
  const notes = r?.notes_json ? parseNotes(r.notes_json) : { top: [], heart: [], base: [] };
  const exists = !!r?.product_id;
  const active = r?.status === "active";
  const avail = r && r.has_sku ? availOf(r.stock, r.reserved ?? 0) : null;
  const ok =
    !!r && exists && r.has_sku === 1 &&
    isSellable({ status: r.status!, saleLocked: r.sale_locked === 1 }, { price: r.price, active: r.active === 1, available: null }, true);
  return {
    sku: item.sku,
    productId: parsed?.productId ?? item.sku,
    ml: parsed?.ml ?? 0,
    qty: item.qty,
    label: item.label,
    brand: r?.brand ?? null,
    name: r?.name ?? null,
    concentration: r?.concentration ?? null,
    image: active ? (r?.image_front ?? null) : null,
    notes: [...notes.top, ...notes.heart, ...notes.base].slice(0, 6),
    productStatus: r?.status ?? null,
    price: ok ? r!.price : null,
    available: avail === null ? null : Math.max(0, Math.floor(avail / item.qty)),
    ok,
  };
}

/** Sellability of a bundle from its row and resolved parts. */
export function judge(row: Pick<BundleRow, "status" | "price">, parts: BundlePart[], checkoutOpen: boolean): { sellable: boolean; block: BundleBlock; available: number | null } {
  const limits = parts.map((p) => p.available).filter((n): n is number => n !== null);
  const available = limits.length ? Math.min(...limits) : null;
  let block: BundleBlock = null;
  if (row.status !== "active") block = "hidden";
  else if (row.price === null || row.price <= 0) block = "soon";
  else if (!parts.length || parts.some((p) => !p.ok)) block = "off";
  else if (available !== null && available < 1) block = "out";
  else if (!checkoutOpen) block = "closed";
  return { sellable: block === null, block, available };
}

function toView(row: BundleRow, items: ItemRow[], parts: Map<string, PartRow>, checkoutOpen: boolean): BundleView {
  const list = items.filter((i) => i.bundle_id === row.id).sort((a, b) => a.sort - b.sort || a.sku.localeCompare(b.sku)).map((i) => toPart(i, parts.get(i.sku)));
  const separateTotal = list.length && list.every((p) => p.price !== null) ? list.reduce((n, p) => n + p.price! * p.qty, 0) : null;
  return {
    id: row.id,
    nameMn: row.name_mn,
    nameEn: row.name_en,
    descriptionMn: row.description_mn,
    descriptionEn: row.description_en,
    image: row.image,
    price: row.price,
    compareAt: row.compare_at,
    status: row.status,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parts: list,
    separateTotal,
    ...judge(row, list, checkoutOpen),
  };
}

/** Bundles with their parts. `ids` = only these; `status` = only this status. Ordered by sort, id. */
export async function listBundles(db: D1, opts: { ids?: string[]; status?: ProductStatus; checkoutOpen?: boolean } = {}): Promise<BundleView[]> {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.ids) {
    if (!opts.ids.length) return [];
    args.push(JSON.stringify(opts.ids));
    where.push(`id IN (SELECT value FROM json_each(?${args.length}))`);
  }
  if (opts.status) {
    args.push(opts.status);
    where.push(`status = ?${args.length}`);
  }
  const rows = (
    await db
      .prepare(`SELECT ${COLS} FROM bundles ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY sort, id`)
      .bind(...args)
      .all<BundleRow>()
  ).results ?? [];
  if (!rows.length) return [];
  const items = (
    await db
      .prepare("SELECT bundle_id, sku, qty, label, sort FROM bundle_items WHERE bundle_id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(rows.map((r) => r.id)))
      .all<ItemRow>()
  ).results ?? [];
  const parts = await partRows(db, [...new Set(items.map((i) => i.sku))]);
  return rows.map((r) => toView(r, items, parts, opts.checkoutOpen ?? true));
}

export async function getBundle(db: D1, id: string, checkoutOpen = true): Promise<BundleView | null> {
  return (await listBundles(db, { ids: [id], checkoutOpen }))[0] ?? null;
}

export const toState = (b: BundleView): BundleState => ({
  id: b.id,
  price: b.status === "active" ? b.price : null,
  compareAt: b.status === "active" && b.price !== null && b.compareAt !== null && b.compareAt > b.price ? b.compareAt : null,
  available: b.available,
  sellable: b.sellable,
  block: b.block,
});
