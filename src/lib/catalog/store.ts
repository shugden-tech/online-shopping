// A1 catalog: public runtime state for the storefront (GET /api/store/catalog-state).
// Sellability is decided here with isSellable() from contracts.ts; the storefront only displays it.
import { PRODUCT_ID_RE, isSellable, type ProductStatus, type Settings, type StoreState } from "../contracts";
import { available, skusFor, type D1 } from "./map";

export const MAX_STATE_IDS = 60;

/** `?ids=a,b,c` -> unique ids in request order, or an error code. Malformed ids are dropped (treated as unknown). */
export function parseIds(raw: string | null): string[] | { error: "required" | "too_many" } {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { error: "required" };
  const ids = [...new Set(parts)];
  if (ids.length > MAX_STATE_IDS) return { error: "too_many" };
  return ids.filter((id) => PRODUCT_ID_RE.test(id));
}

/** QPay counts as on only when its setting is on AND the merchant secrets are configured (CONTRACTS §5). */
export const qpayConfigured = (env: Partial<Pick<Env, "QPAY_USERNAME" | "QPAY_PASSWORD" | "QPAY_INVOICE_CODE" | "QPAY_CALLBACK_SECRET">>) =>
  Boolean(env.QPAY_USERNAME && env.QPAY_PASSWORD && env.QPAY_INVOICE_CODE && env.QPAY_CALLBACK_SECRET);

export async function getStoreState(
  db: D1,
  ids: string[],
  settings: Settings,
  opts: { qpayConfigured?: boolean } = {},
): Promise<StoreState> {
  const checkoutOpen = settings["checkout.open"] === true;
  const state: StoreState = {
    checkoutOpen,
    payments: {
      qpay: settings["payments.qpay.enabled"] === true && (opts.qpayConfigured ?? true),
      bank: settings["payments.bank.enabled"] === true,
    },
    products: [],
  };
  if (!ids.length) return state;
  const [prodRes, skus] = await Promise.all([
    db
      .prepare("SELECT id, status, sale_locked FROM products WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(ids))
      .all<{ id: string; status: ProductStatus; sale_locked: number }>(),
    skusFor(db, ids),
  ]);
  const byId = new Map((prodRes.results ?? []).map((r) => [r.id, r]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const prod = { status: p.status, saleLocked: p.sale_locked === 1 };
    state.products.push({
      id,
      visible: p.status === "active",
      saleLocked: prod.saleLocked,
      skus: skus
        .filter((s) => s.product_id === id)
        .sort((a, b) => a.ml - b.ml)
        .map((s) => {
          const avail = available(s.stock, s.reserved);
          return {
            sku: s.id,
            ml: s.ml,
            kind: s.kind as "decant" | "full",
            price: s.price,
            compareAt: s.compare_at,
            available: avail,
            sellable: isSellable(prod, { price: s.price, active: s.active === 1, available: avail }, checkoutOpen),
          };
        }),
    });
  }
  return state;
}
