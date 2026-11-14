import { useState } from "preact/hooks";
import { addItem, MAX_QTY, type CartItem } from "../lib/cart";
import { formatPrice } from "../lib/price";
import type { Locale } from "../i18n/lite";

interface Size { ml: number; price: number; inStock: boolean }
interface Props {
  locale: Locale;
  base: Omit<CartItem, "qty" | "ml" | "price">;
  sizes: Size[];
  labels: {
    chooseSize: string; ml: string; qty: string; add: string; soldOut: string; allSoldOut: string;
    decrease: string; increase: string; total: string;
  };
}

/** Product-page purchase block: size radio chips (with each price), quantity, add to cart. */
export default function AddToCart({ locale, base, sizes, labels }: Props) {
  const first = sizes.find((s) => s.inStock);
  const [ml, setMl] = useState(first?.ml ?? sizes[0]?.ml ?? 0);
  const [qty, setQty] = useState(1);
  const current = sizes.find((s) => s.ml === ml);
  const soldOut = !first;
  const money = (n: number) => formatPrice(n, locale);

  return (
    <form
      class="atc"
      data-warm-cart
      onSubmit={(e) => {
        e.preventDefault();
        if (current?.inStock) addItem({ ...base, ml: current.ml, price: current.price }, qty);
      }}
    >
      <fieldset class="atc__sizes">
        <legend>{labels.chooseSize}</legend>
        <div class="atc__chips">
          {sizes.map((s) => (
            <label class="atc__chip" data-out={s.inStock ? undefined : ""}>
              <input type="radio" name="size" value={s.ml} checked={s.ml === ml} disabled={!s.inStock} onChange={() => setMl(s.ml)} />
              <span class="atc__chip-box">
                <span class="atc__ml">
                  {s.ml}
                  <small>{labels.ml}</small>
                </span>
                <span class="atc__price">{s.inStock ? money(s.price) : labels.soldOut}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div class="atc__row">
        <div class="stepper" role="group" aria-label={labels.qty}>
          <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1 || soldOut} aria-label={labels.decrease}>
            <span aria-hidden="true">−</span>
          </button>
          <output aria-live="polite">{qty}</output>
          <button type="button" onClick={() => setQty((q) => Math.min(MAX_QTY, q + 1))} disabled={qty >= MAX_QTY || soldOut} aria-label={labels.increase}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <button type="submit" class="btn btn--gold atc__btn" disabled={soldOut}>
          {soldOut ? (
            labels.allSoldOut
          ) : (
            <>
              <span>{labels.add}</span>
              <span class="atc__sum" aria-label={`${labels.total}: ${money((current?.price ?? 0) * qty)}`}>
                {money((current?.price ?? 0) * qty)}
              </span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
