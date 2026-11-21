import { useEffect, useRef, useState } from "preact/hooks";
import { addItem, type CartItem } from "../lib/cart";
import { clamp01, prefersReducedMotion, ramp, trackScrollProgress } from "../lib/scroll-progress";
import { Bottle, initialOf } from "./Bottle";

export interface Slide {
  href: string;
  base: Omit<CartItem, "qty" | "ml" | "price">;
  familyLabel: string;
  fromLabel: string; // "15,000₮-с" / "from ₮15,000"
  addMl: number;
  addPrice: number;
  addLabel: string; // "2 мл сагслах"
  soldOut: boolean;
}

interface Props {
  slides: Slide[];
  labels: { region: string; prev: string; next: string; view: string; hint: string; soldOut: string };
}

const DESKTOP = "(min-width: 900px)";
const DURATION = 700; // animation1.md §C: slow, eased transitions
const pad = (n: number) => String(n).padStart(2, "0");
const sine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

/** 0–1 scroll progress of a vertical scroller, written to the mask custom properties in rAF. */
function useScrollProgress(ref: { current: HTMLElement | null }, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    return trackScrollProgress(el, (p) => {
      // animation1.md §B: the top edge dissolves as progress goes 0.015 → 0.05,
      // the bottom edge becomes solid again as progress goes 0.8 → 1.0
      el.style.setProperty("--mask-top", (1 - ramp(p, 0.015, 0.05)).toFixed(3));
      el.style.setProperty("--mask-bottom", ramp(p, 0.8, 1).toFixed(3));
    });
  }, [enabled]);
}

/**
 * The "Layering Slider" (animation1.md).
 *  - mobile: `.slider-list` scrolls vertically with scroll-snap and a scroll-driven mask
 *  - desktop: a horizontal scroll-snap track (no library). Each slide's distance from the centre drives
 *    its translate (±7.5%) and opacity, so neighbours sit faded at the edges; arrows / keys glide 700 ms.
 *  - cards fade in one after another via `--delay`
 */
export default function LayeringSlider({ slides, labels }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const go = useRef<(to: number) => void>(() => {});
  const [index, setIndex] = useState(0);
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [shown, setShown] = useState(false);
  const count = slides.length;

  // staggered entrance once the slider scrolls into view
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) return setShown(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const mq = matchMedia(DESKTOP);
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useScrollProgress(list, desktop === false);

  // desktop: transforms follow the track's scroll position (read once per frame)
  useEffect(() => {
    const el = list.current;
    if (!desktop || !el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(".ls__slide"));
    const reduced = prefersReducedMotion();
    let frame = 0;
    let anim = 0;
    let active = -1;

    const paint = () => {
      frame = 0;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestD = Infinity;
      items.forEach((s, i) => {
        const d = (s.offsetLeft + s.offsetWidth / 2 - mid) / s.offsetWidth; // -1 = one slide to the left
        const a = Math.abs(d);
        if (a < bestD) [best, bestD] = [i, a];
        // neighbours ease 7.5% towards the centre and fade with distance (0.22 at one slide, 0 at two)
        s.style.translate = `${(-Math.sign(d) * Math.min(a, 1) * 7.5).toFixed(2)}% 0`;
        s.style.opacity = clamp01(1 - a * 0.78 - Math.max(0, a - 1) * 0.5).toFixed(3);
      });
      if (best !== active) {
        active = best;
        setIndex(best);
        // only the centred slide is reachable by Tab / screen readers; a click on a neighbour moves to it
        items.forEach((s, i) => s.toggleAttribute("inert", i !== best));
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    go.current = (to: number) => {
      const i = (to + count) % count; // rewind at both ends, like before
      const s = items[i];
      if (!s) return;
      const from = el.scrollLeft;
      const target = s.offsetLeft + s.offsetWidth / 2 - el.clientWidth / 2;
      cancelAnimationFrame(anim);
      if (reduced) {
        el.scrollLeft = target;
        return;
      }
      el.style.scrollSnapType = "none"; // snapping would fight the glide
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / DURATION);
        el.scrollLeft = from + (target - from) * sine(t);
        if (t < 1) anim = requestAnimationFrame(step);
        else el.style.scrollSnapType = "";
      };
      anim = requestAnimationFrame(step);
    };

    const onClick = (e: MouseEvent) => {
      // clicks on an inert neighbour land on the track itself
      if (e.target !== el && !(e.target as HTMLElement).classList.contains("ls__track")) return;
      const r = el.getBoundingClientRect();
      go.current(active + (e.clientX < r.left + r.width / 2 ? -1 : 1));
    };

    el.addEventListener("scroll", schedule, { passive: true });
    el.addEventListener("click", onClick);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    paint();
    return () => {
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("click", onClick);
      ro.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(anim);
      go.current = () => {};
      el.style.scrollSnapType = "";
      items.forEach((s) => {
        s.removeAttribute("inert");
        s.style.translate = "";
        s.style.opacity = "";
      });
    };
  }, [desktop, count]);

  // mobile: the counter follows whichever card is closest to the middle of the list
  useEffect(() => {
    const el = list.current;
    if (desktop !== false || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setIndex(Number((e.target as HTMLElement).dataset.i));
        }
      },
      { root: el, rootMargin: "-45% 0px -45% 0px" },
    );
    el.querySelectorAll(".ls__slide").forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [desktop]);

  const onKey = (e: KeyboardEvent) => {
    if (!desktop || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const t = e.target as HTMLElement;
    if (t.matches("input, textarea, select")) return;
    e.preventDefault();
    go.current(index + (e.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <div class={`ls${shown ? " is-in" : ""}`} ref={root} role="region" aria-roledescription="carousel" aria-label={labels.region} onKeyDown={onKey}>
      <div class="ls__list slider-list" ref={list} tabIndex={desktop === false ? 0 : undefined}>
        <ul class="ls__track">
          {slides.map((s, i) => (
            <li
              class={`ls__slide${i === index ? " is-active" : ""}`}
              data-i={i}
              style={`--delay:${i * 80}ms;--tint:var(--fam-${s.base.family})`}
              aria-label={`${i + 1} / ${count}`}
            >
              <article class="ls__card">
                <a class="ls__art" href={s.href} tabIndex={-1} aria-hidden="true">
                  <Bottle shape={s.base.shape} family={s.base.family} initial={initialOf(s.base.brand)} img={s.base.img} />
                </a>
                <div class="ls__text">
                  <p class="ls__num" aria-hidden="true">
                    {pad(i + 1)}
                  </p>
                  <p class="ls__brand">{s.base.brand}</p>
                  <h3 class="ls__name">
                    <a href={s.href}>{s.base.name}</a>
                  </h3>
                  <p class="ls__meta">
                    <span class="chip chip--fam">{s.familyLabel}</span>
                    <span class="ls__from">{s.fromLabel}</span>
                  </p>
                  <div class="ls__actions">
                    <button
                      type="button"
                      class="btn btn--gold btn--sm"
                      data-warm-cart
                      disabled={s.soldOut}
                      onClick={() => addItem({ ...s.base, ml: s.addMl, price: s.addPrice })}
                    >
                      {s.soldOut ? labels.soldOut : s.addLabel}
                    </button>
                    <a class="link-arrow" href={s.href}>
                      {labels.view}
                      <span class="sr-only">: {s.base.name}</span>
                      <svg viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
                        <path d="M0 5h21M17 1l4 4-4 4" />
                      </svg>
                    </a>
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      </div>

      <div class="ls__nav">
        <button type="button" class="ls__arrow" aria-label={labels.prev} onClick={() => go.current(index - 1)}>
          <svg viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
            <path d="M22 5H1M5 1L1 5l4 4" />
          </svg>
        </button>
        <p class="ls__counter" aria-live="polite">
          <b>{pad(index + 1)}</b>
          <span class="ls__sep">/</span>
          <span>{pad(count)}</span>
          <i aria-hidden="true" style={`--p:${(index + 1) / count}`} />
        </p>
        <button type="button" class="ls__arrow" aria-label={labels.next} onClick={() => go.current(index + 1)}>
          <svg viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
            <path d="M0 5h21M17 1l4 4-4 4" />
          </svg>
        </button>
        <p class="ls__hint">{labels.hint}</p>
      </div>
    </div>
  );
}
