// Places the order for the checkout island (loaded lazily on submit, so it stays out of the page's initial JS).
// 1. re-checks the cart against the live store state, skipping caches; any change stops the order so the
//    customer sees the new prices / quantities first
// 2. POST /api/orders with items { sku, qty } and the per-attempt Idempotency-Key (checkout-key.ts)
// 3. maps the contract's errors (409 stock/unavailable + sku, 423 closed, 422 payment disabled, …)
// 4. on success keeps the payment instructions for the success page (sessionStorage `gz-last-pay`)
import { cartItems } from "./cart";
import { revalidateCart, storeMeta } from "./cart-sync";
import { checkoutKey, orderPlaced } from "./checkout-key";
import type { PaymentInstructions } from "./contracts";
// types only, so order-validate is not split out of the checkout island's chunk (the field order is passed in)
import type { FieldErrorKey, FormErrors, OrderField, OrderFormValues } from "./order-validate";
import type { StoreMeta } from "./store-state";

export const LAST_PAY_SLOT = "gz-last-pay";

/** What the success page reads back (written only after a successful POST /api/orders). */
export interface LastPayment {
  no: string;
  total: number | null;
  holdExpiresAt: string | null;
  payment: PaymentInstructions | null;
  paymentError: string | null;
}

export type PlaceResult =
  | { ok: true; orderNo: string }
  /** `name` = the refused line ("Brand Name 5 мл"), `meta` = the latest live switches. */
  | { ok: false; form: string; fields?: FormErrors; sku?: string; name?: string; meta: StoreMeta | null };

type Fail = { form: string; fields?: Record<string, string>; sku?: string };

interface OrderResponse {
  ok?: boolean;
  orderNo?: string;
  total?: number;
  holdExpiresAt?: string | null;
  payment?: PaymentInstructions | null;
  paymentError?: string | null;
  sku?: string;
  errors?: Record<string, string>;
}

export async function placeOrder(
  v: OrderFormValues,
  extra: { locale: string; turnstileToken: string; website: string; ml: string; fields: readonly (OrderField | "turnstile")[] },
): Promise<PlaceResult> {
  const r = await place(v, extra);
  if ("orderNo" in r) return r;
  const fields: FormErrors = {};
  for (const f of extra.fields) if (r.fields?.[f]) fields[f] = r.fields[f] as FieldErrorKey;
  const line = r.sku ? cartItems.value.find((i) => i.sku === r.sku) : undefined;
  return {
    ok: false, form: r.form, fields, meta: storeMeta(),
    ...(r.sku ? { sku: r.sku } : {}),
    ...(line ? { name: `${line.brand} ${line.name} ${line.ml} ${extra.ml}` } : {}),
  };
}

async function place(
  v: OrderFormValues,
  extra: { locale: string; turnstileToken: string; website: string; ml: string },
): Promise<{ ok: true; orderNo: string } | Fail> {
  const check = await revalidateCart(extra.ml, true);
  if (check === "error") return { form: "state" };
  if (check === "changed") return { form: "changed" };
  if (!cartItems.value.length) return { form: "empty" };
  const meta = storeMeta();
  if (meta && !meta.checkoutOpen) return { form: "closed" };
  if (meta && !meta.payments[v.payment as "qpay" | "bank"]) return { form: "paymentDisabled", fields: { payment: "paymentDisabled" } };

  const lines = cartItems.value;
  let res: Response;
  try {
    res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": checkoutKey() },
      body: JSON.stringify({
        ...v,
        locale: extra.locale,
        items: lines.map((i) => (i.bundle ? { bundle: i.bundle, qty: i.qty } : { sku: i.sku, qty: i.qty })),
        turnstileToken: extra.turnstileToken,
        website: extra.website,
      }),
    });
  } catch {
    return { form: "network" };
  }
  let data: OrderResponse = {};
  try {
    data = (await res.json()) as OrderResponse;
  } catch {
    /* non-JSON error page */
  }

  if (res.ok && data.ok && data.orderNo) {
    const no = data.orderNo;
    orderPlaced(no, v.phone.trim());
    const last: LastPayment = {
      no,
      total: typeof data.total === "number" ? data.total : null,
      holdExpiresAt: data.holdExpiresAt ?? null,
      payment: data.payment ?? null,
      paymentError: data.paymentError ?? null,
    };
    try {
      sessionStorage.setItem(LAST_PAY_SLOT, JSON.stringify(last));
    } catch {
      /* storage blocked: the success page falls back to the order lookup */
    }
    return { ok: true, orderNo: no };
  }

  const se = data.errors ?? {};
  const sku = se.sku ?? data.sku;
  if (res.status === 429 || se.form === "rate") return { form: "rate" };
  if (res.status === 423 || se.form === "closed") {
    void revalidateCart(extra.ml, true);
    return { form: "closed" };
  }
  if (se.payment === "disabled") {
    void revalidateCart(extra.ml, true); // refresh which payment methods are on
    return { form: "paymentDisabled", fields: { payment: "paymentDisabled" } };
  }
  if (se.form === "stock" || se.form === "unavailable") {
    const known = sku && lines.some((i) => i.sku === sku);
    return known
      ? { form: se.form === "stock" ? "stockLine" : "unavailable", sku }
      : { form: se.form === "stock" ? "stock" : "items" };
  }
  if (se.form === "items") return { form: "items" };
  if (res.status === 409) return { form: "stock" };
  const { form: _f, ...fields } = se;
  return { form: Object.keys(fields).length ? "fix" : "server", fields };
}
