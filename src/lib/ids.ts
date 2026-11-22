// Tiny id helpers shared by the storefront and the server (lead-owned, part of the A0 contracts).
// Kept separate from ./contracts so storefront bundles do not pull in the admin's enums and state maps.

/** SKU id = `${productId}:${ml}` (one offer per product size). */
export const skuId = (productId: string, ml: number) => `${productId}:${ml}`;
export function parseSkuId(id: string): { productId: string; ml: number } | null {
  const i = id.lastIndexOf(":");
  if (i <= 0) return null;
  const ml = Number(id.slice(i + 1));
  return Number.isInteger(ml) && ml > 0 ? { productId: id.slice(0, i), ml } : null;
}
export const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
