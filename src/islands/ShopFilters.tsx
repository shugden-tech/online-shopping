import { useEffect, useRef, useState } from "preact/hooks";
import {
  EMPTY_FILTERS, SORTS, activeCount, normalize, parseQuery, runFilters, toQuery, toggle,
  type FilterState, type ListKey, type ShopItem, type SortKey,
} from "../lib/filter";
import { fill, type Dict } from "../i18n/lite";

interface Option { id: string; label: string; img?: string }
interface Props {
  tr: Dict["shop"];
  closeLabel: string;
  ml: string;
  total: number;
  options: {
    family: Option[];
    brand: { id: string; label: string; count: number }[];
    gender: Option[];
    notes: Option[];
    size: number[];
    season: Option[];
    occasion: Option[];
  };
}

const BRAND_TOP = 10;   // tiles shown before "show all"
const BRAND_SEARCH_MIN = 20; // search box appears once the full list is open and longer than this

const SORT_LABEL: Record<SortKey, keyof Dict["shop"]> = {
  featured: "sortFeatured", newest: "sortNewest", "price-asc": "sortPriceAsc", "price-desc": "sortPriceDesc", az: "sortAz",
};

/** Write the filters to the URL. Entries carry Astro's history-state shape so Back/Forward
 *  are handled by the view-transition router, which re-renders the page from the URL. */
function writeUrl(state: FilterState, mode: "push" | "replace") {
  const url = location.pathname + toQuery(state);
  if (url === location.pathname + location.search) return;
  const cur = (history.state ?? {}) as { index?: number; scrollX?: number; scrollY?: number };
  if (mode === "push") {
    history.replaceState({ ...cur, scrollX: window.scrollX, scrollY: window.scrollY }, "");
    history.pushState({ ...cur, index: (cur.index ?? 0) + 1, scrollX: window.scrollX, scrollY: window.scrollY }, "", url);
  } else {
    history.replaceState(history.state, "", url);
  }
}

/** What src/scripts/live-prices.ts sends after each live update. */
interface LiveDetail { hidden: string[]; from: Record<string, number | null>; sizes: Record<string, number[]> }

export default function ShopFilters({ tr, closeLabel, ml, total, options }: Props) {
  const [state, setState] = useState<FilterState>(EMPTY_FILTERS);
  const stateRef = useRef<FilterState>(EMPTY_FILTERS);
  const [count, setCount] = useState(total);
  const [sheet, setSheet] = useState(false);
  const items = useRef<ShopItem[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const urlTimer = useRef<number>();
  const panelRef = useRef<HTMLElement>(null);
  const openBtn = useRef<HTMLButtonElement>(null);
  const [brandAll, setBrandAll] = useState(false);
  const [brandQuery, setBrandQuery] = useState("");

  /** Show / hide / reorder the server-rendered cards. */
  const apply = (next: FilterState) => {
    if (!items.current) return;
    const grid = document.getElementById("shop-grid");
    if (!grid) return;
    const order = runFilters(items.current, next);
    const cells = new Map<string, HTMLElement>();
    grid.querySelectorAll<HTMLElement>("[data-cell]").forEach((el) => cells.set(el.dataset.cell!, el));
    const frag = document.createDocumentFragment();
    for (const slug of order) {
      const el = cells.get(slug);
      if (el) {
        el.hidden = false;
        frag.appendChild(el);
        cells.delete(slug);
      }
    }
    cells.forEach((el) => {
      el.hidden = true;
      frag.appendChild(el);
    });
    grid.appendChild(frag);
    document.getElementById("shop-empty")?.toggleAttribute("hidden", order.length > 0);
    setCount(order.length);
  };

  const update = (next: FilterState, mode: "push" | "replace" = "push") => {
    stateRef.current = next;
    setState(next);
    apply(next);
    window.clearTimeout(urlTimer.current);
    if (mode === "push") writeUrl(next, "push");
    else urlTimer.current = window.setTimeout(() => writeUrl(next, "replace"), 300);
  };

  useEffect(() => {
    try {
      items.current = JSON.parse(document.getElementById("shop-data")?.textContent ?? "[]") as ShopItem[];
    } catch {
      items.current = [];
    }
    const initial = parseQuery(location.search);
    stateRef.current = initial;
    setState(initial);
    apply(initial);
    // live prices / sizes / hidden products (the page is built without prices)
    const onLive = (e: Event) => {
      const d = (e as CustomEvent<LiveDetail>).detail;
      if (!items.current || !d) return;
      items.current = items.current
        .filter((i) => !d.hidden.includes(i.s))
        .map((i) => (i.s in d.from ? { ...i, p: d.from[i.s] ?? 0, z: d.sizes[i.s] ?? [] } : i));
      apply(stateRef.current);
    };
    document.addEventListener("gz:live", onLive);
    const last = (window as unknown as { gzLive?: LiveDetail }).gzLive;
    if (last) onLive(new CustomEvent("gz:live", { detail: last }));
    if (location.hash === "#search") searchRef.current?.focus();

    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-clear-filters]")) update({ ...EMPTY_FILTERS }, "push");
    };
    const onHash = () => location.hash === "#search" && searchRef.current?.focus();
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("gz:live", onLive);
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHash);
      window.clearTimeout(urlTimer.current);
      document.documentElement.removeAttribute("data-sheet-open");
    };
  }, []);

  // mobile bottom sheet: lock scroll, Esc to close, return focus
  useEffect(() => {
    document.documentElement.toggleAttribute("data-sheet-open", sheet);
    if (!sheet) return;
    panelRef.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSheet(false);
        openBtn.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  const active = activeCount(state);
  const flip = (key: ListKey, id: string) => update({ ...state, [key]: toggle(state[key], id) });

  const group = (key: ListKey, title: string, opts: Option[]) => (
    <fieldset class="flt__group">
      <legend>{title}</legend>
      <div class="flt__chips">
        {opts.map((o) => (
          <button
            type="button"
            class={`chip${o.img ? " chip--img" : ""}${key === "family" ? " chip--fam" : ""}`}
            style={key === "family" ? `--tint:var(--fam-${o.id})` : undefined}
            aria-pressed={state[key].includes(o.id)}
            onClick={() => flip(key, o.id)}
          >
            {o.img && <img src={o.img} alt="" width="24" height="24" loading="lazy" decoding="async" />}
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );

  // Brand tiles: the top N (plus any brand already selected, so it can be unselected), or the full list.
  const brands = options.brand;
  const brandsCollapsed = brands.filter((b, i) => i < BRAND_TOP || state.brand.includes(b.id));
  const brandPool = brandAll ? brands : brandsCollapsed;
  const brandNeedle = normalize(brandQuery);
  const brandShown = brandAll && brandNeedle ? brandPool.filter((b) => normalize(b.label).includes(brandNeedle)) : brandPool;
  const brandHidden = brands.length - brandsCollapsed.length;

  const brandGroup = () => (
    <fieldset class="flt__group">
      <legend>{tr.brand}</legend>
      {brandAll && brands.length > BRAND_SEARCH_MIN && (
        <input
          class="input flt__brandsearch"
          type="search"
          autocomplete="off"
          aria-label={tr.brandSearch}
          placeholder={tr.brandSearch}
          value={brandQuery}
          onInput={(e) => setBrandQuery((e.currentTarget as HTMLInputElement).value)}
        />
      )}
      <div class="brand-grid">
        {brandShown.map((b) => (
          <button
            type="button"
            class="brand-tile"
            aria-pressed={state.brand.includes(b.id)}
            onClick={() => flip("brand", b.id)}
          >
            <span class="brand-tile__n">{b.label}</span>
          </button>
        ))}
      </div>
      {(brands.length > brandsCollapsed.length || brandAll) && (
        <button
          type="button"
          class="flt__more"
          aria-expanded={brandAll}
          onClick={() => {
            setBrandAll(!brandAll);
            setBrandQuery("");
          }}
        >
          {brandAll ? tr.showLessBrands : fill(tr.showAllBrands, { n: brandHidden })}
        </button>
      )}
    </fieldset>
  );

  const priceInput = (key: "min" | "max", label: string) => (
    <label class="flt__price">
      <span>{label}</span>
      <input
        class="input"
        type="number"
        inputMode="numeric"
        min={0}
        step={1000}
        placeholder="₮"
        value={state[key] ?? ""}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value;
          const v = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
          update({ ...state, [key]: v !== null && Number.isFinite(v) ? v : null });
        }}
      />
    </label>
  );

  return (
    <>
      <div class="flt__bar">
        <div class="flt__search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.500" />
            <path d="M16 16l5 5" />
          </svg>
          <input
            id="search"
            ref={searchRef}
            class="input"
            type="search"
            autocomplete="off"
            enterkeyhint="search"
            aria-label={tr.searchLabel}
            placeholder={tr.searchPlaceholder}
            value={state.q}
            onInput={(e) => update({ ...state, q: (e.currentTarget as HTMLInputElement).value }, "replace")}
          />
        </div>
        <button type="button" class="btn btn--sm flt__open" ref={openBtn} onClick={() => setSheet(true)} aria-haspopup="dialog" aria-expanded={sheet}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
            <path d="M3 7h18M6.500 12h11M10 17h4" />
          </svg>
          {tr.filters}
          {active > 0 && <b aria-label={fill(tr.active, { n: active })}>{active}</b>}
        </button>
        <p class="flt__count" role="status" aria-live="polite">
          {fill(tr.results, { n: count })}
        </p>
        <div class="flt__sort">
          <label for="flt-sort">{tr.sort}</label>
          <select id="flt-sort" class="select" value={state.sort} onChange={(e) => update({ ...state, sort: (e.currentTarget as HTMLSelectElement).value as SortKey })}>
            {SORTS.map((s) => (
              <option value={s}>{tr[SORT_LABEL[s]] as string}</option>
            ))}
          </select>
        </div>
      </div>

      <div class="flt__scrim" data-open={sheet ? "" : undefined} onClick={() => setSheet(false)} aria-hidden="true" />
      <aside class="flt" ref={panelRef} data-open={sheet ? "" : undefined} aria-label={tr.filters}>
        <div class="flt__head">
          <h2 class="t-title">{tr.filters}</h2>
          <button type="button" class="flt__clear" onClick={() => update({ ...EMPTY_FILTERS, sort: state.sort })} disabled={active === 0}>
            {tr.clearShort}
          </button>
          <button type="button" class="flt__close" onClick={() => setSheet(false)} aria-label={closeLabel}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </div>

        <div class="flt__body">
          {group("family", tr.family, options.family)}
          {brandGroup()}
          {group("gender", tr.gender, options.gender)}
          {group("notes", tr.notes, options.notes)}

          <fieldset class="flt__group">
            <legend>
              {tr.price} <small>· {tr.priceHint}</small>
            </legend>
            <div class="flt__prices">
              {priceInput("min", tr.min)}
              <i aria-hidden="true" />
              {priceInput("max", tr.max)}
            </div>
          </fieldset>

          <fieldset class="flt__group">
            <legend>{tr.size}</legend>
            <div class="flt__chips">
              {options.size.map((z) => (
                <button type="button" class="chip" aria-pressed={state.size.includes(z)} onClick={() => update({ ...state, size: toggle(state.size, z) })}>
                  {z} {ml}
                </button>
              ))}
            </div>
          </fieldset>

          {group("season", tr.season, options.season)}
          {group("occasion", tr.occasion, options.occasion)}
        </div>

        <div class="flt__foot">
          <button type="button" class="btn btn--gold btn--block" onClick={() => setSheet(false)}>
            {fill(tr.show, { n: count })}
          </button>
        </div>
      </aside>
    </>
  );
}
