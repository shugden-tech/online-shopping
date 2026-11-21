import { useEffect, useState } from "preact/hooks";
import { addItem, MAX_QTY, type CartItem } from "../lib/cart";
import { formatPrice } from "../lib/price";
import type { Locale } from "../i18n/lite";
import type { SkuView } from "../lib/store-state";

interface Size { ml: number; full?: boolean }
interface Props {
  locale: Locale;
  /** Product id (= slug); sizes become SKUs `${pid}:${ml}`. */
  pid: string;
  base: Omit<CartItem, "qty" | "ml" | "price" | "sku">;
  sizes: Size[];
  labels: {
    chooseSize: string; ml: string; qty: string; add: string; soldOut: string; allSoldOut: string; fullBottle: string;
    decrease: string; increase: string; total: string;
    order?: string; loading: string; failed: string; soon: string; soonShort: string; locked: string; off: string; notSold: string; was: string; left: string;
  };
}

type Store = typeof import("../lib/store-state");

/**
 * Product-page purchase block: size chips (with the live price of each), quantity, add to cart.
 * Prices and stock come from the live store state (loaded lazily); nothing can be added before it loads.
 */
export default function AddToCart({ locale, pid, base, sizes, labels }: Props) {
  const [store, setStore] = useState<Store | null>(null);
  const [, setTick] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const money = (n: number) => formatPrice(n, locale);

  useEffect(() => {
    let off = () => {};
    let alive = true;
    void import("../lib/store-state").then((m) => {
      if (!alive) return;
      setStore(m);
      off = m.subscribe(() => setTick((n) => n + 1));
      void m.load([pid]).then(() => setTick((n) => n + 1));
    });
    return () => {
      alive = false;
      off();
    };
  }, [pid]);

  const views: SkuView[] = sizes.map((s) => (store ? store.skuView(pid, s.ml) : { sku: `${pid}:${s.ml}`, status: "loading", price: null, compareAt: null, available: null }));
  const status = views[0]?.status ?? "loading";
  const product = store?.productState(pid);
  // The full bottle is the default; decant chips are bought only when the customer picks one.
  const fullIdx = sizes.findIndex((s, i) => s.full && views[i]!.status === "ok");
  const firstOk = fullIdx >= 0 ? fullIdx : sizes.findIndex((_, k) => views[k]!.status === "ok");
  const k = picked !== null && views[picked]?.status === "ok" ? picked : firstOk;
  const current = k >= 0 ? views[k]! : null;
  const limit = current ? Math.min(MAX_QTY, current.available ?? MAX_QTY) : 0;
  const selectedQty = Math.max(1, Math.min(qty, limit || 1));
  const canBuy = current !== null;
  const waiting = status === "loading";
  const hidden = product?.visible === false;
  const locked = product?.saleLocked === true;

  const chipText = (v: SkuView) =>
    v.status === "loading" ? <i class="live-ph live-ph--sm" aria-hidden="true" />
    : v.status === "error" ? "—"
    : v.status === "ok" || (v.price !== null && (v.status === "closed" || v.status === "locked")) ? (
      <>
        {v.compareAt && <s class="live-was">{money(v.compareAt)}</s>}
        {money(v.price!)}
      </>
    )
    : v.status === "out" ? labels.soldOut
    : v.status === "soon" ? (ordering ? labels.order : labels.soonShort)
    : labels.off;

  // why the button cannot add (when it cannot)
  const blocked =
    waiting ? labels.add
    : status === "error" ? labels.failed
    : locked || views.some((v) => v.status === "closed") ? labels.locked
    : views.every((v) => v.status === "out") ? labels.allSoldOut
    : views.every((v) => v.status === "soon" || v.status === "out") ? labels.soon
    : labels.off;

  // «Захиалгаар»: the product is shown but no size has a price. The button opens the order popover, never the cart.
  const ordering =
    !waiting && status !== "error" && !locked && !canBuy && Boolean(product) && Boolean(labels.order) &&
    views.some((v) => v.status === "soon") && views.every((v) => v.status === "soon" || v.status === "out");

  if (hidden) {
    return (
      <div class="atc atc--off" data-pid={pid} role="status">
        <p class="atc__state">{labels.notSold}</p>
      </div>
    );
  }

  return (
    <form
      class="atc"
      data-warm-cart
      data-pid={pid}
      aria-busy={waiting ? "true" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (ordering || !current || current.price === null) return;
        const size = sizes[k]!;
        addItem(
          { ...base, ml: size.ml, sku: current.sku, price: current.price, ...(current.available !== null ? { stock: current.available } : {}) },
          selectedQty,
        );
      }}
    >
      <fieldset class="atc__sizes">
        <legend>{labels.chooseSize}</legend>
        <div class="atc__chips">
          {sizes.map((s, i) => {
            const v = views[i]!;
            return (
              <label class="atc__chip" data-out={v.status === "ok" || v.status === "loading" ? undefined : ""} data-sku={v.sku}>
                <input type="radio" name="size" value={s.ml} checked={i === k} disabled={v.status !== "ok"} onChange={() => setPicked(i)} />
                <span class="atc__chip-box">
                  <span class="atc__ml">
                    {s.ml}
                    <small>{labels.ml}</small>
                  </span>
                  {s.full && <span class="atc__full">{labels.fullBottle}</span>}
                  <span class="atc__price">{chipText(v)}</span>
                </span>
              </label>
            );
          })}
        </div>
        {status === "error" && <p class="atc__state live-note" role="status">{labels.failed}</p>}
        {waiting && <span class="sr-only" role="status">{labels.loading}</span>}
      </fieldset>

      <div class="atc__row">
        <div class="stepper" role="group" aria-label={labels.qty}>
          <button type="button" onClick={() => setQty(Math.max(1, selectedQty - 1))} disabled={selectedQty <= 1 || !canBuy} aria-label={labels.decrease}>
            <span aria-hidden="true">−</span>
          </button>
          <output aria-live="polite">{selectedQty}</output>
          <button type="button" onClick={() => setQty(Math.min(limit, selectedQty + 1))} disabled={selectedQty >= limit || !canBuy} aria-label={labels.increase}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <button
          type={ordering ? "button" : "submit"}
          class="btn btn--gold atc__btn"
          disabled={!canBuy && !ordering}
          data-wait={waiting ? "" : undefined}
          data-order={ordering ? "" : undefined}
          aria-haspopup={ordering ? "dialog" : undefined}
          // the click is handled by shell.ts ([data-order] → src/scripts/order-pop.ts)
        >
          {canBuy && current.price !== null ? (
            <>
              <span>{labels.add}</span>
              <span class="atc__sum" aria-label={`${labels.total}: ${money(current.price * selectedQty)}`}>
                {money(current.price * selectedQty)}
              </span>
            </>
          ) : ordering ? (
            labels.order
          ) : (
            blocked
          )}
        </button>
      </div>
      {canBuy && current.available !== null && current.available <= 5 && (
        <p class="atc__left t-small t-dim">{labels.left.replace("{n}", String(current.available))}</p>
      )}
    </form>
  );
}
