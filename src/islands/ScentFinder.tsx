import { useEffect, useRef, useState } from "preact/hooks";
import { addItem } from "../lib/cart";
import { formatPrice } from "../lib/price";
import type { SkuView } from "../lib/store-state";
import {
  EMPTY_ANSWERS, MOODS, RESULT_STEP, STEPS, WHEN, WHO, parseHash, recommend, toHash,
  type Answers, type Match, type Mood, type QuizProduct,
} from "../lib/quiz";
import { fill, type Dict } from "../i18n/lite";
import { Bottle, initialOf } from "./Bottle";

interface Props {
  tr: Dict["finder"];
  families: Dict["families"];
  familyLines: Dict["familyLines"];
  intensityLevels: string[];
  viewLabel: string;
  /** "{price}-с" — the result cards show the lowest live price. */
  fromLabel: string;
  productBase: string;
  moods: { id: Mood; strip: string; w: number; h: number }[];
  notes: { id: string; label: string; img: string }[];
  products: QuizProduct[];
}

const Arrow = ({ back = false }: { back?: boolean }) => (
  <svg viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1.200" aria-hidden="true">
    <path d={back ? "M22 5H1M5 1L1 5l4 4" : "M0 5h21M17 1l4 4-4 4"} />
  </svg>
);

const WHEN_ICON: Record<(typeof WHEN)[number], string> = {
  day: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2.500v2.500M12 19v2.500M2.500 12H5M19 12h2.500M5.300 5.300l1.800 1.800M16.900 16.900l1.800 1.800M5.300 18.700l1.800-1.800M16.900 7.100l1.800-1.800",
  night: "M20 14.500A8 8 0 019.500 4a8 8 0 1010.500 10.500z",
  office: "M4.500 7.500h15a1.500 1.500 0 011.500 1.500v9a1.500 1.500 0 01-1.500 1.500h-15A1.500 1.500 0 013 18V9a1.500 1.500 0 011.500-1.500zM9 7.500V5.500h6v2M3 13h18",
  date: "M12 20s-7.500-4.600-7.500-10A4.200 4.200 0 0112 7.600 4.200 4.200 0 0119.500 10c0 5.400-7.500 10-7.500 10z",
};

/** The Scent Finder: intro → 5 questions → top-3 result. State lives in the URL hash. */
export default function ScentFinder({ tr, families, familyLines, intensityLevels, viewLabel, fromLabel, productBase, moods, notes, products }: Props) {
  const [live, setLive] = useState<typeof import("../lib/store-state") | null>(null);
  const [, setTick] = useState(0);
  const [step, setStep] = useState(0);
  const [a, setA] = useState<Answers>(EMPTY_ANSWERS);
  const [ready, setReady] = useState(false);
  const [added, setAdded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  /** True while the intensity slider is being dragged; keyboard changes stay manual. */
  const sliderPointer = useRef(false);

  // restore from the hash (refresh keeps the step), and follow manual hash edits
  useEffect(() => {
    const sync = () => {
      const s = parseHash(location.hash);
      setStep(s.step);
      setA(s.answers);
    };
    sync();
    setReady(true);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // keep the hash in step with the state; replaceState so the quiz is one history entry
  useEffect(() => {
    if (!ready) return;
    const hash = toHash(step, a);
    if (hash !== location.hash) history.replaceState(history.state, "", location.pathname + location.search + hash);
  }, [step, a, ready]);

  // move focus to the new step's heading (not on first paint)
  useEffect(() => {
    if (!moved.current) return;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [step]);

  const go = (n: number) => {
    moved.current = true;
    setAdded(false);
    setStep(Math.max(0, Math.min(RESULT_STEP, n)));
  };
  const set = (patch: Partial<Answers>) => setA((prev) => ({ ...prev, ...patch }));
  /** Single-choice answers advance straight to the next question. */
  const choose = (patch: Partial<Answers>) => {
    set(patch);
    go(step + 1);
  };

  const results: Match[] = step === RESULT_STEP ? recommend(products, a) : [];
  const noteLabel = (id: string) => notes.find((n) => n.id === id)?.label ?? id;
  const why = (m: Match): string => {
    const parts: string[] = [];
    if (m.family && a.mood) parts.push(fill(m.family === "main" ? tr.whyFamily : tr.whyFamilyNear, { family: families[a.mood] }));
    if (m.notes.length) parts.push(fill(tr.whyNotes, { notes: m.notes.map(noteLabel).join(", ") }));
    if (m.occasion && a.when) parts.push(fill(tr.whyOccasion, { occasion: tr.occasionWhen[a.when] }));
    if (m.intensityExact) parts.push(tr.whyIntensity);
    return `${tr.whyLead} ${(parts.length ? parts : [tr.whyFallback]).join(", ")}.`;
  };
  // live prices for the result cards (loaded only when the results show)
  const slugs = results.map((m) => m.product.slug).join();
  useEffect(() => {
    if (!slugs) return;
    let off = () => {};
    void import("../lib/store-state").then((m) => {
      setLive(m);
      off = m.subscribe(() => setTick((n) => n + 1));
      void m.load(slugs.split(",")).then(() => setTick((n) => n + 1));
    });
    return () => off();
  }, [slugs]);
  /** Sizes that can be bought now, cheapest first. */
  const buyable = (slug: string): SkuView[] => live?.buyable(slug) ?? [];
  const fromText = (slug: string) => {
    if (!live || live.productState(slug) === undefined) return live?.loadFailed(slug) ? "" : <i class="live-ph live-ph--sm" aria-hidden="true" />;
    const v = buyable(slug)[0];
    return v ? fill(fromLabel, { price: formatPrice(v.price!, document.documentElement.lang === "en" ? "en" : "mn") }) : "";
  };
  const addAll = () => {
    const picks = results.map((m) => ({ p: m.product, v: buyable(m.product.slug).find((x) => x.sku.endsWith(`:${m.product.addMl}`)) ?? buyable(m.product.slug)[0] }));
    picks.forEach(({ p, v }, i) => {
      if (!v) return;
      const ml = Number(v.sku.slice(v.sku.lastIndexOf(":") + 1));
      addItem({ slug: p.slug, sku: v.sku, name: p.name, brand: p.brand, family: p.family, shape: p.shape, ml, price: v.price!, ...(v.available !== null ? { stock: v.available } : {}), ...(p.img ? { img: p.img } : {}) }, 1, i === picks.length - 1);
    });
    setAdded(true);
  };

  // each step has its own colour wash; the mood step takes the colour of the chosen family
  const wash =
    step === 0 ? "#CC9E48"
    : step === 1 ? "#8d6a8c"
    : step === 2 ? "#4c6a8a"
    : step === 3 || step === RESULT_STEP ? `var(--fam-${a.mood ?? "chypre"})`
    : step === 4 ? "#a05a3c"
    : "#CC9E48";
  const washes = [0, 1, 2, 3, 4, 5, 6];

  const title = (text: string, sub?: string) => (
    <header class="sf__q">
      <h1 class="t-h2 sf__title" ref={heading} tabIndex={-1}>
        {text}
      </h1>
      {sub && <p class="t-dim">{sub}</p>}
    </header>
  );

  return (
    <div class="sf" data-step={step} style={`--wash:${wash}`}>
      <div class="sf__bg" aria-hidden="true">
        {washes.map((n) => (
          <i class={n === step ? "on" : ""} data-n={n} style={n === 3 || n === 6 ? `--c:var(--fam-${a.mood ?? "chypre"})` : undefined} />
        ))}
        <b />
        <b />
      </div>

      {step >= 1 && step <= STEPS && (
        <div class="sf__progress" role="progressbar" aria-label={tr.progress} aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step}>
          <i style={`transform:scaleX(${step / STEPS})`} />
        </div>
      )}

      <div class="sf__stage" key={step}>
        {step === 0 && (
          <section class="sf__intro">
            <p class="t-title t-gold">{tr.introEyebrow}</p>
            <h1 class="t-head sf__title" ref={heading} tabIndex={-1}>
              {tr.introTitle.split("\n").map((line, i) => (
                <>
                  {i > 0 && <br />}
                  {line}
                </>
              ))}
            </h1>
            <p class="t-body t-dim">{tr.introText}</p>
            <button type="button" class="btn btn--gold" onClick={() => go(1)}>
              {tr.start}
            </button>
          </section>
        )}

        {step === 1 && (
          <section>
            {title(tr.q1, tr.q1Sub)}
            <div class="sf__menu" role="radiogroup" aria-label={tr.q1}>
              {WHO.map((id, i) => {
                const label = id === "women" ? tr.q1Women : id === "men" ? tr.q1Men : tr.q1Any;
                return (
                  <label class="sf__opt sf__opt--row">
                    <input type="radio" name="who" checked={a.who === id} onChange={() => choose({ who: id })} />
                    <span class="sf__opt-box">
                      <span class="sf__opt-label">{label}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            {title(tr.q2, tr.q2Sub)}
            <div class="sf__tiles" role="radiogroup" aria-label={tr.q2}>
              {WHEN.map((id) => {
                const label = id === "day" ? tr.q2Day : id === "night" ? tr.q2Night : id === "office" ? tr.q2Office : tr.q2Date;
                return (
                  <label class="sf__opt sf__opt--tile">
                    <input type="radio" name="when" checked={a.when === id} onChange={() => choose({ when: id })} />
                    <span class="sf__opt-box">
                      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d={WHEN_ICON[id]} />
                      </svg>
                      <span class="sf__opt-label">{label}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            {title(tr.q3, tr.q3Sub)}
            <div class="sf__bands" role="radiogroup" aria-label={tr.q3}>
              {MOODS.map((id) => {
                const m = moods.find((x) => x.id === id)!;
                return (
                  <label class="sf__opt sf__opt--band" style={`--tint:var(--fam-${id})`}>
                    <input type="radio" name="mood" checked={a.mood === id} onChange={() => choose({ mood: id })} />
                    <span class="sf__opt-box">
                      <span class="sf__band-text">
                        <span class="sf__opt-label">{families[id]}</span>
                        <span class="sf__opt-hint">{familyLines[id]}</span>
                      </span>
                      <span class="sf__band-strip" aria-hidden="true">
                        <img src={m.strip} alt="" width={m.w} height={m.h} loading="lazy" decoding="async" />
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            {title(tr.q4, tr.q4Sub)}
            <p class="sf__count t-title" aria-live="polite">
              {fill(tr.q4Count, { n: a.notes.length })}
            </p>
                        <div class="sf__notes" role="group" aria-label={tr.q4}>
              {notes.map((n) => {
                const on = a.notes.includes(n.id);
                return (
                  <label class="sf__opt sf__opt--note">
                    <input type="checkbox" checked={on} onChange={() => choose({ notes: [n.id] })} />
                    <span class="sf__opt-box">
                      <img src={n.img} alt="" width="240" height="300" loading="lazy" decoding="async" />
                      <span class="sf__opt-label">{n.label}</span>
                      <span class="sf__check" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                          <path d="M4 12.500l5 5L20 6.500" />
                        </svg>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}

        {step === 5 && (
          <section>
            {title(tr.q5, tr.q5Sub)}
            <div class="sf__slider">
              <span class={`sf__pole${a.intensity >= 4 ? " on" : ""}`} aria-hidden="true">{tr.strong}</span>
              <div class="sf__range" style={`--v:${(a.intensity - 1) / 4}`}>
                <div class="sf__ticks" aria-hidden="true">
                  {[5, 4, 3, 2, 1].map((n) => (
                    <i class={n === a.intensity ? "on" : ""} />
                  ))}
                </div>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={a.intensity}
                  aria-label={tr.intensityLabel}
                  aria-valuetext={intensityLevels[a.intensity - 1]}
                  aria-orientation="vertical"
                  onPointerDown={() => { sliderPointer.current = true; }}
                  onInput={(e) => set({ intensity: Number((e.currentTarget as HTMLInputElement).value) })}
                  onChange={() => {
                    if (!sliderPointer.current) return;
                    sliderPointer.current = false;
                    go(step + 1);
                  }}
                />
              </div>
              <span class={`sf__pole${a.intensity <= 2 ? " on" : ""}`} aria-hidden="true">{tr.soft}</span>
              <output class="sf__level" aria-live="polite">
                <b>{a.intensity}</b>
                <span>{intensityLevels[a.intensity - 1]}</span>
              </output>
            </div>
          </section>
        )}

        {step === RESULT_STEP && (
          <section class="sf__result">
            <header class="sf__q">
              <p class="t-title t-gold">{tr.resultEyebrow}</p>
              <h1 class="t-h2 sf__title" ref={heading} tabIndex={-1}>
                {tr.resultTitle}
              </h1>
            </header>
            <ol class="sf__cards">
              {results.map((m, i) => (
                <li class="sf__card" style={`--tint:var(--fam-${m.product.family});--delay:${i * 120}ms`}>
                  <span class="sf__rank" aria-hidden="true">0{i + 1}</span>
                  <a class="sf__card-art" href={`${productBase}${m.product.slug}/`} tabIndex={-1} aria-hidden="true">
                    <Bottle shape={m.product.shape} family={m.product.family} initial={initialOf(m.product.brand)} img={m.product.img} />
                  </a>
                  <p class="sf__match">{fill(tr.match, { n: m.percent })}</p>
                  <p class="sf__brand">{m.product.brand}</p>
                  <h2 class="sf__name">
                    <a href={`${productBase}${m.product.slug}/`}>{m.product.name}</a>
                  </h2>
                  <p class="sf__meta">
                    <span class="chip chip--fam">{families[m.product.family as keyof typeof families]}</span>
                    <span>{fromText(m.product.slug)}</span>
                  </p>
                  <p class="sf__why">{why(m)}</p>
                  <a class="link-arrow" href={`${productBase}${m.product.slug}/`} aria-label={`${viewLabel}: ${m.product.name}`}>
                    {viewLabel}
                    <Arrow />
                  </a>
                </li>
              ))}
            </ol>
            <div class="sf__result-actions">
              <button type="button" class="btn btn--gold" data-warm-cart onClick={addAll} disabled={added || !results.some((m) => buyable(m.product.slug).length)}>
                {added ? tr.addedAll : tr.addAll}
              </button>
              <button type="button" class="btn" onClick={() => go(STEPS)}>
                {tr.edit}
              </button>
              <button
                type="button"
                class="btn btn--ghost"
                onClick={() => {
                  setA(EMPTY_ANSWERS);
                  go(0);
                }}
              >
                {tr.restart}
              </button>
            </div>
          </section>
        )}
      </div>

      {step >= 1 && step <= STEPS && (
        <nav class="sf__nav" aria-label={tr.progress}>
          <button type="button" class="sf__navbtn" onClick={() => go(step - 1)}>
            <span class="sf__navlabel">{tr.back}</span>
          </button>
          <p class="sf__step" aria-hidden="true">
            {fill(tr.step, { n: `0${step}`, total: `0${STEPS}` })}
          </p>
        </nav>
      )}
    </div>
  );
}
