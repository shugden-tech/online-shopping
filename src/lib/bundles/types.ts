// Bundles (0005): shared types and ids. No runtime dependencies, so islands and the admin may import it.
// Server logic is in ./store.ts; the HTTP contract is docs/CONTRACTS.md §9.
import type { ProductStatus } from "../contracts";

export const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** Cart / order line key for a bundle. */
export const BUNDLE_SKU_PREFIX = "bundle:";
export const bundleLineSku = (id: string) => `${BUNDLE_SKU_PREFIX}${id}`;
export const isBundleSku = (sku: string) => sku.startsWith(BUNDLE_SKU_PREFIX);
export const MAX_BUNDLE_PARTS = 10;

/** Why a bundle cannot be bought (null = it can). */
export type BundleBlock = null | "hidden" | "soon" | "off" | "out" | "closed";

export interface BundlePart {
  sku: string;
  productId: string;
  ml: number;
  /** Units of this SKU in one bundle. */
  qty: number;
  /** Owner's name for the part; used when the product is not in the catalog. */
  label: string | null;
  /** null = no such product in the catalog. */
  brand: string | null;
  name: string | null;
  concentration: string | null;
  /** Only for active products (draft photos are not shown). */
  image: string | null;
  notes: string[];
  productStatus: ProductStatus | null;
  /** The SKU's own price (for "bought separately"), null when not set / not for sale. */
  price: number | null;
  /** Bundles this part allows (floor(available / qty)); null = not tracked. */
  available: number | null;
  /** Product active, not sale-locked, SKU exists, active and priced. */
  ok: boolean;
}

export interface BundleView {
  id: string;
  nameMn: string;
  nameEn: string | null;
  descriptionMn: string | null;
  descriptionEn: string | null;
  image: string | null;
  price: number | null;
  compareAt: number | null;
  status: ProductStatus;
  sort: number;
  createdAt: string;
  updatedAt: string;
  parts: BundlePart[];
  /** Sum of the parts' own prices × qty, when every part has one. */
  separateTotal: number | null;
  /** How many bundles can be ordered now; null = not limited by stock. */
  available: number | null;
  sellable: boolean;
  block: BundleBlock;
}

/** Public live state of a bundle (GET /api/store/bundles). */
export interface BundleState {
  id: string;
  price: number | null;
  compareAt: number | null;
  available: number | null;
  sellable: boolean;
  block: BundleBlock;
}
