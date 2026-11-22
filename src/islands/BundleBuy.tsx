import { useEffect, useState } from "preact/hooks";
import { addItem, MAX_QTY } from "../lib/cart";
import { formatPrice } from "../lib/price";
import type { Locale } from "../i18n/lite";
import type { BundleState } from "../lib/bundles/types";

interface Props {
  locale: Locale;
  id: string;
  /** Server-rendered state (the page is cached briefly); refreshed from /api/store/bundles on mount. */
  initial: BundleState;
  line: { name: string; brand: string; ml: number; img?: string; parts: string[] };
  checkoutHref: string;
  labels: {
    add: string; buyNow: string; soldOut: string; soon: string; closed: string; unavailable: string; failed: string;
    qty: string; decrease: string; increase: string; left: string; addedToCart: string;
  };
}

/** Bundle page purchase block: quantity, "add to cart" and "buy now" (adds, then goes to the checkout). */
export default function BundleBuy({ locale, id, initial, line, checkoutHref, labels }: Props) {
  const [state, setState] = useState<BundleState>(initial);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/store/bundles?ids=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, cache: "no-cache" })
      .then((r) => r.json() as Promise<{ ok?: boolean; bundles?: BundleState[] }>)
      .then((d) => {
        const b = d.ok ? d.bundles?.find((x) => x.id === id) : undefined;
        if (alive && b) setState(b);
      })
      .catch(() => { /* keep the server-rendered state */ });
    return () => { alive = false; };
  }, [id]);

  const limit = Math.min(MAX_QTY, state.available ?? MAX_QTY);
  const n = Math.max(1, Math.min(qty, limit || 1));
  const canBuy = state.sellable && state.price !== null && limit > 0;
  const reason =
    state.block === "out" ? labels.soldOut
    : state.block === "soon" ? labels.soon
    : state.block === "closed" ? labels.closed
    : state.block === "off" ? labels.soldOut
    : labels.unavailable;

  const add = (open: boolean) => {
    if (!canBuy || state.price === null) return;
    addItem(
      {
        sku: `bundle:${id}`, slug: id, bundle: id, parts: line.parts, ml: line.ml, price: state.price,
        name: line.name, brand: line.brand, family: "woody", shape: "classic",
        ...(line.img ? { img: line.img } : {}),
        ...(state.available !== null ? { stock: state.available } : {}),
      },
      n,
      open,
    );
    setAdded(true);
  };

  return (
    <form
      class="bb"
      data-bundle={id}
      data-state={canBuy ? "ok" : state.block ?? "off"}
      onSubmit={(e) => {
        e.preventDefault();
        add(true);
      }}
    >
      {canBuy ? (
        <>
          <div class="bb__row">
            <div class="stepper" role="group" aria-label={labels.qty}>
              <button type="button" onClick={() => setQty(Math.max(1, n - 1))} disabled={n <= 1} aria-label={labels.decrease}>
                <span aria-hidden="true">−</span>
              </button>
              <output aria-live="polite">{n}</output>
              <button type="button" onClick={() => setQty(Math.min(limit, n + 1))} disabled={n >= limit} aria-label={labels.increase}>
                <span aria-hidden="true">+</span>
              </button>
            </div>
            <button type="submit" class="btn btn--gold bb__add">
              <span>{labels.add}</span>
              <span class="bb__sum">{formatPrice(state.price! * n, locale)}</span>
            </button>
          </div>
          <button
            type="button"
            class="btn btn--block bb__now"
            onClick={() => {
              add(false);
              location.href = checkoutHref;
            }}
          >
            {labels.buyNow}
          </button>
          {state.available !== null && state.available <= 5 && <p class="bb__left t-small t-dim">{labels.left.replace("{n}", String(state.available))}</p>}
          <p class="sr-only" role="status">{added ? labels.addedToCart : ""}</p>
        </>
      ) : (
        <p class="bb__state" role="status">{reason}</p>
      )}
    </form>
  );
}
