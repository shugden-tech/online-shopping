import { useEffect, useRef, useState } from "preact/hooks";
import { useSig } from "../lib/use-signal";
import { cartItems, cartOpen, cartSubtotal, cartCount, setQty, removeItem, MAX_QTY } from "../lib/cart";
import { formatPrice } from "../lib/price";
import { fill, type Dict, type Locale } from "../i18n/lite";
import { Bottle, initialOf } from "./Bottle";
import "../styles/cart.css";

export interface CartDrawerProps {
  locale: Locale;
  tr: Dict["cart"];
  ml: string;
  closeLabel: string;
  shopHref: string;
  checkoutHref: string;
  productBase: string;
  freeThreshold: number;
}

export default function CartDrawer({ locale, tr, ml, closeLabel, shopHref, checkoutHref, productBase, freeThreshold }: CartDrawerProps) {
  // Mounted on demand by scripts/cart-mount.tsx (client only). `ready` flips two frames after
  // mount so the very first open still gets its slide-in transition.
  const [ready, setReady] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  const open = useSig(cartOpen) && ready;
  const items = useSig(cartItems);
  const subtotal = useSig(cartSubtotal);
  const count = useSig(cartCount);
  const money = (n: number) => formatPrice(n, locale);
  const close = () => (cartOpen.value = false);

  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      lastFocus.current = document.activeElement as HTMLElement | null;
      root.setAttribute("data-cart-open", "");
      requestAnimationFrame(() => closeBtn.current?.focus({ preventScroll: true }));
    } else {
      root.removeAttribute("data-cart-open");
      const el = lastFocus.current;
      lastFocus.current = null;
      if (el && document.contains(el) && panel.current?.contains(document.activeElement)) el.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cartOpen.value) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusables = panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.removeAttribute("data-cart-open");
    };
  }, []);

  const remaining = Math.max(0, freeThreshold - subtotal);
  const progress = Math.min(1, subtotal / freeThreshold);

  return (
    <div class="cd" data-open={open ? "" : undefined}>
      <div class="cd__scrim" onClick={close} aria-hidden="true" />
      <aside class="cd__panel" ref={panel} role="dialog" aria-modal="true" aria-label={tr.title} inert={!open}>
        <header class="cd__head">
          <div>
            <h2 class="cd__title">{tr.title}</h2>
            <p class="cd__count" aria-live="polite">
              {count > 0 ? fill(tr.items, { n: count }) : " "}
            </p>
          </div>
          <button type="button" class="cd__close" ref={closeBtn} onClick={close} aria-label={closeLabel}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </header>

        {items.length === 0 ? (
          <div class="cd__empty">
            <svg class="cd__empty-art" viewBox="0 0 200 280" aria-hidden="true" style="--tint:transparent">
              <use href="#gz-b-classic" />
            </svg>
            <p class="cd__empty-title">{tr.empty}</p>
            <p class="cd__empty-sub">{tr.emptySub}</p>
            <a class="btn" href={shopHref} onClick={close}>
              {tr.emptyCta}
            </a>
          </div>
        ) : (
          <>
            <ul class="cd__list">
              {items.map((i) => (
                <li class="cd__item" key={`${i.slug}-${i.ml}`}>
                  <a class="cd__thumb" href={`${productBase}${i.slug}/`} tabIndex={-1} aria-hidden="true" onClick={close}>
                    <Bottle shape={i.shape} family={i.family} initial={initialOf(i.brand)} img={i.img} />
                  </a>
                  <div class="cd__info">
                    <p class="cd__brand">{i.brand}</p>
                    <a class="cd__name" href={`${productBase}${i.slug}/`} onClick={close}>
                      {i.name}
                    </a>
                    <p class="cd__size">
                      {i.ml} {ml} · {money(i.price)}
                    </p>
                    <div class="cd__row">
                      <div class="stepper" role="group" aria-label={fill(tr.qtyOf, { name: i.name })}>
                        <button type="button" onClick={() => setQty(i.slug, i.ml, i.qty - 1)} aria-label={tr.decrease}>
                          <span aria-hidden="true">−</span>
                        </button>
                        <output aria-live="polite">{i.qty}</output>
                        <button type="button" onClick={() => setQty(i.slug, i.ml, i.qty + 1)} disabled={i.qty >= MAX_QTY} aria-label={tr.increase}>
                          <span aria-hidden="true">+</span>
                        </button>
                      </div>
                      <button type="button" class="cd__remove" onClick={() => removeItem(i.slug, i.ml)} aria-label={fill(tr.removeItem, { name: i.name, ml: i.ml })}>
                        {tr.remove}
                      </button>
                    </div>
                  </div>
                  <p class="cd__line">{money(i.price * i.qty)}</p>
                </li>
              ))}
            </ul>

            <footer class="cd__foot">
              <div class="cd__free" data-reached={remaining === 0 ? "" : undefined}>
                <p>{remaining === 0 ? tr.freeReached : fill(tr.freeHint, { amount: money(remaining) })}</p>
                <div class="cd__bar" aria-hidden="true">
                  <i style={`transform:scaleX(${progress})`} />
                </div>
              </div>
              <div class="cd__sum">
                <span>{tr.subtotal}</span>
                <strong>{money(subtotal)}</strong>
              </div>
              <p class="cd__note">{tr.deliveryNote}</p>
              <a class="btn btn--gold btn--block" href={checkoutHref} onClick={close}>
                {tr.checkout}
              </a>
              <button type="button" class="cd__continue" onClick={close}>
                {tr.continue}
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
