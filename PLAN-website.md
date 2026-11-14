# Plan: genzst website (v1)

**Executor:** Fable 5.2. Work only inside `C:\Users\mtemu\Dev\trying things\genzst`.
**Pace:** don't rush. Each phase ends with a check that must pass before the next one starts. "Done" means it works in the browser, not just that it compiles.

---

## 0. What we're building

genzst is a Mongolian perfume **decant** shop: 2 / 5 / 10 ml samples of designer and niche fragrances. The v1 site lets people:

- **Browse:** a catalog with filters, search, scent families and notes.
- **Choose:** a product page with size chips, a notes pyramid and similar scents.
- **Discover:** a creative **Scent Finder** quiz that recommends perfumes.
- **Order:** cart, then an order form (name, phone, address), then the order is saved and the owner is notified. Payment (QPay or bank transfer) is confirmed **manually** by the owner. There is no online payment in v1.

**Languages:** Mongolian is the default at `/`, with an English toggle at `/en/`. Every visible string must exist in both languages.

---

## 1. Decisions (fixed, don't revisit)

| Area | Choice | Why |
|---|---|---|
| Framework | **Astro 5** (latest stable), TypeScript strict | Static HTML by default, so pages are fast. Interactive parts (cart, filters, quiz) are small islands. |
| Islands | **Preact** + `@preact/signals` | Tiny (~4 KB). Cart state is shared across islands with signals. |
| Styling | Plain CSS with custom properties, one global `tokens.css` and scoped `<style>` per component | No framework overhead, and full control over the luxury look. |
| Motion | **GSAP 3** + ScrollTrigger, **only on pages that need it** (home, product). CSS transitions everywhere else. | Follows `animation1.md`. |
| Carousel | **Swiper 11** with the creative effect, desktop only | Per `animation1.md` §C. |
| Fonts | `@fontsource/cormorant-garamond` (300, 500, 300 italic) and `@fontsource/montserrat` (300, 400, 500), **self-hosted**, with `cyrillic-ext` + `latin` subsets only | Mongolian Ө/Ү must render, and there are no external font requests. |
| Data | Astro **content collection** `products` as JSON, validated with **zod** | The owner edits one JSON file per product. Bad data fails the build instead of the page. |
| Hosting | **Cloudflare Workers** (static assets + one server route) via `@astrojs/cloudflare` | Free tier and fast in Asia. |
| Orders DB | **Cloudflare D1** (SQLite) | Orders are stored server-side. |
| Notifications | **Telegram bot** message to the owner on every order (optional env vars; skipped if not set) | Easy for the owner to get on their phone. |
| Anti-spam | **Cloudflare Turnstile** on the order form (test keys locally) + honeypot field + server-side validation | |
| Package manager | npm | Already installed (Node 24, npm 11). |

> Tooling note (user rule): the Astro Cloudflare setup creates a `wrangler.jsonc`. Because the project then has a Wrangler config, use **wrangler** for D1, dev and deploy commands in this project.

---

## 2. Brand and design system

**Mood:** dark-first luxury, after `assets/reference/NOTES.md` (D&G Velvet): near-black backgrounds, one muted gold accent, hairline rules, wide tracking and slow fades. It should feel editorial, not like a generic store.

```css
/* src/styles/tokens.css */
:root {
  --ink: #070707;                      /* page background, matches the logo backdrop */
  --ink-2: #111110;                    /* cards */
  --ink-3: #1b1a18;                    /* raised / hover */
  --line: rgba(204, 158, 72, .22);     /* gold hairline */
  --gold: #CC9E48;
  --gold-soft: #e2c48a;
  --text: #EDE8DF;                     /* warm off-white */
  --text-dim: #9C968C;
  --danger: #D9534F;

  --font-head: "Cormorant Garamond", "Times New Roman", serif;
  --font-sans: "Montserrat", "Helvetica Neue", Arial, sans-serif;
  --fs-head: clamp(40px, 5.5vw + 1rem, 88px);
  --fs-h2: clamp(28px, 2.5vw + 1rem, 48px);
  --fs-title: clamp(12px, 0.3vw + 11px, 14px);
  --fs-body: clamp(15px, 0.25vw + 14px, 17px);

  --ease-sine: cubic-bezier(.445, .05, .55, .95);   /* from animation1.md */
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --radius: 2px;                       /* near-square, luxury */
  --gutter: clamp(16px, 4vw, 48px);
  --maxw: 1320px;
}
```

**Type tiers** (exactly as agreed earlier):
- `.t-head`: Cormorant 300, `--fs-head`, line-height 1.05
- `.t-title`: Montserrat 500, uppercase, letter-spacing .24em, reduced to .18em under `:lang(mn)`
- `.t-body`: Montserrat 300, line-height 1.7, max 62ch. Use weight 400 under `:lang(mn)`.

**Logo:** use `assets/brand/genzst-logo-source.png` **as-is** (the user doesn't want an SVG rebuild). Its backdrop `#070707` equals `--ink`, so it blends into the page. Generate the favicon and apple-touch-icon by resizing that PNG with `sharp` at build time or once with a script. Never put the logo on a light background.

**Rules:**
- `prefers-reduced-motion: reduce` turns off every GSAP and parallax effect. Content shows immediately, with no fade.
- Visible focus rings (gold, 2px outline). Every interactive element is keyboard-reachable.
- Minimum tap target 44px. No horizontal scroll at 360px.
- Body text must reach WCAG AA contrast against `--ink`.

---

## 3. Assets to use

| Source | Use |
|---|---|
| `assets/brand/genzst-logo-source.png` | Header logo, favicon, OG fallback |
| `assets/notes/*.jpeg/png` (11 dark editorial photos, ~636×789) | The **Notes** explorer on home, note filter chips and note pages. Names: amber, aromatic-notes, green-notes, incense-minerals, leather, musk, oud, saffron, vanilla, white-flowers, woods. |
| `assets/families/*.avif` (5 transparent ingredient strips, 660×110) | Scent-family bands: amber, chypre, citrus, medley (use as "Fresh/Fougère mix"), woody |
| `animation1.md` | The behavior of the layering slider (§5.3) |
| `assets/reference/*` | Mood reference only. **Never copy their images or text into the site.** |
| `decantx/*.json` | **Don't use.** It's copyrighted third-party data. Don't import it, read it into the site, or copy text from it. |

Copy the used assets into `src/assets/…` so Astro optimizes them (AVIF/WebP, responsive `srcset`). Leave the originals untouched.

**Product images:** the owner has no photos yet. Build a `BottleArt` component: an **SVG perfume-bottle illustration generated from data**. Each product gets a bottle shape (choose from 4 silhouettes by `bottleShape`) and a liquid tint from its scent family, with a gold label showing the brand initial. It must look intentional and premium, not like a gray placeholder. When `image` is set in the product JSON, show the photo instead.

---

## 4. Data model

`src/content/products/<slug>.json`, validated by `src/content.config.ts`:

```ts
{
  slug: string,                          // filename
  brand: string,                         // "Maison Francis Kurkdjian"
  name: string,                          // "Baccarat Rouge 540"
  concentration: "EDT" | "EDP" | "Parfum" | "Extrait" | "Cologne",
  gender: "women" | "men" | "unisex",
  family: "amber" | "woody" | "floral" | "citrus" | "chypre" | "fresh" | "gourmand" | "aromatic",
  notes: { top: string[], heart: string[], base: string[] },   // note ids, see notes.json
  description: { mn: string, en: string },                     // our own words, 1–3 sentences
  sizes: { ml: 2 | 5 | 10 | 30, price: number /* MNT */, inStock: boolean }[],
  bottleShape: "classic" | "tall" | "round" | "square",
  image?: string,                        // optional real photo later
  featured?: boolean,
  isNew?: boolean,
  intensity: 1 | 2 | 3 | 4 | 5,          // quiz + filters
  season: ("spring" | "summer" | "autumn" | "winter")[],
  occasion: ("day" | "night" | "office" | "date")[]
}
```

`src/data/notes.json` maps note ids to `{ mn, en, image? }`. Example: `"oud": {"mn": "Агар мод", "en": "Oud", "image": "oud"}`.

`src/data/settings.json` holds the owner-editable settings:
- delivery fee and free-delivery threshold
- payment instructions (bank name, account number placeholder, QPay note) in mn and en
- Telegram/Instagram/Facebook links
- phone number
- the Ulaanbaatar district list (Баянгол, Баянзүрх, Сонгинохайрхан, Сүхбаатар, Хан-Уул, Чингэлтэй, Налайх, Багануур, Багахангай) plus "Орон нутаг" for the provinces

**Seed catalog:** create **24 sample products** across all families and genders, using well-known perfumes (brand and name are facts and fine to use) with **original** descriptions in both languages written by you. Use realistic placeholder prices in ₮ (for example 2 ml ≈ 15,000–45,000₮). Mark the file's top-level README so the owner knows to replace them: add `src/content/products/README.md` that explains how to add or edit a product.

**Formatting:** prices print as `35,000₮` in Mongolian and `₮35,000` in English (`Intl.NumberFormat('mn-MN')`).

---

## 5. Pages and features

Routes are mirrored under `/en/…`. Use Astro i18n config (`defaultLocale: "mn"`, `prefixDefaultLocale: false`) with strings in `src/i18n/mn.json` and `src/i18n/en.json`, and a typed `t()` helper. The language toggle keeps the current page. Set `<html lang>` correctly and add `hreflang` alternates.

### 5.1 Global shell
- **Header:** logo; nav (Дэлгүүр / Shop, Үнэр хайгч / Scent Finder, Бидний тухай / About); search icon; MN|EN toggle; cart button with a count badge.
  - The header is transparent over the hero, then turns `--ink` with a hairline after 40px of scroll.
  - On mobile, a full-screen menu opens with a staggered fade of its links.
- **Cart drawer** (Preact island):
  - Slides in from the right.
  - Lists items with a size label, a quantity stepper, a remove button and a subtotal.
  - Shows the delivery-fee hint ("X₮ more for free delivery") and a checkout button.
  - Is persisted to `localStorage` (try/catch, so it works without storage).
  - "Add to cart" anywhere opens the drawer with a subtle gold pulse on the cart icon.
- **Footer:** short brand line, links, social links, the hours and phone from settings, and "© genzst".
- **Page transitions:** Astro `<ClientRouter />` (View Transitions) with a 300 ms crossfade. Re-initialize GSAP on `astro:page-load`.

### 5.2 Home `/`
1. **Hero (scroll-driven, inspired by D&G but original):**
   - Full-viewport `--ink` background with a soft top spotlight (radial gradient) and drifting gold dust particles (one `<canvas>`, max 60 particles, paused when off-screen).
   - The logo and the line "genzst" fade in. The headline is "Үнэрээ ол." / "Find your scent." with the subline "Брэнд үнэртнүүдийг 2, 5, 10 мл-ээр туршиж үзээрэй."
   - Below them: a "Scroll" hint and two CTAs, Дэлгүүр and Үнэр хайгч.
   - On scroll (GSAP ScrollTrigger, pinned for ~100vh), the headline drifts up and fades, and the spotlight widens.
2. **Scent families:** 5 horizontal bands, one per family. Each shows its ingredient strip `.avif` sliding slowly sideways (parallax tied to scroll), with the family name in large Cormorant and a short line of copy. Clicking a band opens the shop filtered by that family.
3. **Featured: the Layering Slider** (§5.3).
4. **Notes explorer:** a grid of the 11 note photos.
   - On hover or focus, the photo scales to 1.04 and the note name appears with its mn/en text.
   - Clicking a note opens the shop filtered by that note.
   - The grid has a staggered entrance (opacity + 12px rise, 0.65s `--ease-sine`, `--delay` per card).
5. **How decants work:** 3 steps (Сонго → Захиал → Турш), with a 2/5/10 ml comparison drawn as three SVG vials at true relative height.
6. **Scent Finder teaser:** a full-width dark band with light rays and a "Take the quiz →" button.
7. **New arrivals:** a horizontal rail of product cards.

### 5.3 Layering Slider (implements `animation1.md`)
- **Container:** `position: relative`. The `.slider-list` scrolls vertically on mobile (`overflow-y: scroll`, scroll-snap), and the desktop version is a Swiper.
- **Entrance:** cards fade in with `transition: opacity .65s var(--ease-sine)`, each delayed by `--delay` (index × 80 ms).
- **Scroll mask:** `mask-image: linear-gradient(...)` driven by scroll progress, which a `useScrollProgress` helper maps to 0–1.
  - Top-edge alpha ramps across progress 0.015 → 0.05.
  - Bottom-edge alpha ramps across 0.8 → 1.0.
  - Update with `requestAnimationFrame`, not on every scroll event.
- **Desktop Swiper:** `effect: "creative"`. Neighbor slides are translated ±7.5% and fade to opacity 0 the further they are from the center, with slow, eased transitions (700 ms). Arrow buttons and keyboard arrows work.
- **Each slide:** bottle art, brand, name, family chip, "from 15,000₮" and a quick-add for the 2 ml size.

### 5.4 Shop `/delguur` (en: `/en/shop`)
- **Filters**, in a sidebar on desktop and a bottom sheet on mobile:
  - family, gender, notes (multi-select chips), price range, size availability, season, occasion
  - search box (brand or name, instant, diacritics-insensitive; also matches the Mongolian note names)
  - sort: featured, newest, price ↑, price ↓, A–Z
- Filter state lives in the **URL query** (shareable, and Back works). Results update instantly with no page reload.
- The grid uses `.ProductCard` (bottle art, brand in small caps, name in Cormorant, family, size chips, price for the selected size, add-to-cart).
- **Empty state:** "Тохирох үнэр олдсонгүй", with a button to clear the filters.
- **Implementation:** product data is embedded as a JSON island at build time, so filtering is client-side and instant. That's fine for under ~500 products.

### 5.5 Product `/delguur/[slug]`
- Large bottle art on the left with a slow float animation, and info on the right:
  - brand, name, concentration, gender, family
  - description
  - **size selector** (radio chips with the price of each; out-of-stock sizes are disabled and struck through)
  - quantity, Add to cart
  - an "intensity" meter of 5 gold dots, season and occasion icons
- **Notes pyramid:** three tiers (Top / Heart / Base) with note chips. Chips that have a photo show a thumbnail.
- **Similar scents:** 4 products ranked by shared family and notes.
- JSON-LD `Product` structured data, plus OG and meta tags per locale.

### 5.6 Scent Finder `/unertei-tanilts` (en: `/en/scent-finder`) — the creative piece
- A full-screen, step-by-step quiz in the spirit of the D&G quiz, but original.
- **5 questions:**
  1. Who is it for?
  2. When will you wear it? (day / night / office / date)
  3. Which mood? Pick from the family bands, which show their ingredient strips.
  4. Pick up to 3 notes you love, from the photo grid.
  5. How strong? A vertical gold slider from Зөөлөн to Хүчтэй, like the D&G slider. It must be keyboard-accessible and work as a `range` input.
- Each step has its own background color wash that crossfades between steps, plus a progress hairline, Back and Next.
- **Result:** the top 3 matches, scored by weighted overlap (family 3, notes 2 each, occasion 1, intensity distance −1). Each shows a "why this matches" line, and there's an "add all 2 ml to cart" button.
- The state is kept in the URL hash, so a refresh doesn't lose progress.

### 5.7 Checkout `/zahialga` (en: `/en/checkout`)
- **Left column, the form:**
  - name
  - **phone**: Mongolian 8 digits, validated by the regex `^[6-9]\d{7}$`
  - optional second phone
  - city: Улаанбаатар or Орон нутаг
  - district (select)
  - khoroo
  - address details (textarea)
  - delivery note
  - payment method: Банкны шилжүүлэг or QPay, both settled manually
  - Turnstile widget
  - a hidden honeypot field
- **Right column:** an order summary that can't be edited here (there's a link back to the cart), with the delivery fee and total.
- **Submit:** POST JSON to `/api/orders`.
  - Disable the button while sending and show inline field errors in the right language.
  - Never lose the cart on error.
- **Success page** `/zahialga/amjilttai?no=GZ-…`:
  - the order number in large Cormorant
  - the payment instructions from settings, with the amount and order number to put in the transfer description
  - "we will call you to confirm"
  - clear the cart

### 5.8 Server: `src/pages/api/orders.ts` (`prerender = false`)
- Validate the body with zod: same rules as the client, quantities 1–10, and 1–30 items.
- **Re-price everything on the server** from the product collection. Never trust client prices.
- Verify the Turnstile token (env `TURNSTILE_SECRET`; use the always-passes test secret in dev).
- Reject the request if the honeypot is filled.
- Insert the order into D1, then send the Telegram message (env `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; if they're missing, skip and log). The message contains the order number, name, phone, address, items with sizes, total and payment method.
- Return `{ ok: true, orderNo }`, or `{ ok: false, errors }` with status 400/422/500.
- **Order number format:** `GZ-YYMMDD-XXXX`, where the last part is 4 random characters from `A–Z` and `2–9`.
- **Rate limit:** at most 5 orders per IP per 10 min, checked with a D1 count query.

D1 migration `migrations/0001_orders.sql`:
```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new',        -- new | confirmed | paid | shipped | done | cancelled
  name TEXT NOT NULL, phone TEXT NOT NULL, phone2 TEXT,
  city TEXT NOT NULL, district TEXT, khoroo TEXT, address TEXT NOT NULL, note TEXT,
  payment TEXT NOT NULL, items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL, delivery INTEGER NOT NULL, total INTEGER NOT NULL,
  locale TEXT NOT NULL, ip TEXT
);
CREATE INDEX idx_orders_created ON orders(created_at);
```

### 5.9 Simple pages
- **About** `/bidnii-tuhai`: the brand story placeholder text.
- **FAQ and delivery** `/tuslamj`: an accordion covering what a decant is, authenticity, delivery times, payment and returns.
- **404:** a styled page.

Copy that isn't real business information gets the marker `[[TODO owner]]` in the i18n files, so the owner can find it.

---

## 6. Performance and quality targets
- **Lighthouse** (mobile, production build) on home, shop and product pages: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95.
- **JavaScript budget:**
  - home ≤ 90 KB gzip, including GSAP and Swiper
  - shop ≤ 40 KB
  - product ≤ 50 KB
  - other pages ≤ 20 KB
  - Load GSAP and Swiper only on pages that use them, through dynamic `import()` inside islands or scripts.
- **Fonts:** preload the two main woff2 files (Cormorant 300 and Montserrat 400, Cyrillic-ext + Latin), use `font-display: swap`, and add size-adjusted fallbacks to avoid layout shift.
- **Images:** everything goes through `astro:assets` with explicit width and height. Lazy-load everything below the fold.
- **No layout shift** from the cart badge, fonts or images (CLS < 0.05).
- **SEO:** `sitemap.xml` (via `@astrojs/sitemap`), `robots.txt`, canonical URLs, `hreflang`, and per-page titles and descriptions in both languages.

---

## 7. Project layout

```
genzst/
  astro.config.mjs  wrangler.jsonc  package.json  tsconfig.json
  migrations/0001_orders.sql
  public/  favicon.png  apple-touch-icon.png  robots.txt
  src/
    assets/ brand/ notes/ families/
    content.config.ts
    content/products/*.json  (+ README.md)
    data/ notes.json  settings.json
    i18n/ mn.json  en.json  index.ts
    lib/ cart.ts (signals + storage)  price.ts  filter.ts  quiz.ts  scroll-progress.ts  order-schema.ts
    components/ Header.astro  Footer.astro  LangToggle.astro  ProductCard.astro  BottleArt.astro
                NotesPyramid.astro  FamilyBand.astro  NoteTile.astro  ...
    islands/ CartDrawer.tsx  AddToCart.tsx  ShopFilters.tsx  ScentFinder.tsx  CheckoutForm.tsx  LayeringSlider.tsx
    layouts/ Base.astro
    pages/ index.astro  delguur/index.astro  delguur/[slug].astro  unertei-tanilts.astro
           zahialga/index.astro  zahialga/amjilttai.astro  bidnii-tuhai.astro  tuslamj.astro  404.astro
           en/...(mirrors)  api/orders.ts
    styles/ tokens.css  global.css
```

The existing `assets/`, `animation1.md`, `decantx/` and `PLAN-*.md` files stay where they are, untouched.

---

## 8. Execution phases (in order; each has a gate)

| # | Phase | Gate (must pass before moving on) |
|---|---|---|
| 1 | **Scaffold**: Astro + TS strict, Preact, the Cloudflare adapter, sitemap; tokens, global CSS, fonts; Base layout; i18n helper and routing; header, footer, language toggle | `npm run build` passes. `npm run dev` shows a styled empty home in mn and in en. Ө/Ү render in Cormorant and Montserrat (check visually). |
| 2 | **Data**: zod schema, 24 seed products, notes.json, settings.json, BottleArt, ProductCard, price formatting | Build fails on a deliberately broken product (test it, then revert). All 24 cards render, and the bottle art looks premium. |
| 3 | **Shop and product pages**: filters, search, sort, URL state; product page, notes pyramid, similar scents, JSON-LD | Every filter combination works. Back and Forward restore the filters. The product page works in both languages. |
| 4 | **Cart**: signals store, drawer, add-to-cart everywhere, persistence | Add 3 different sizes, reload, and the cart persists. The quantity and remove buttons work. The totals are right. |
| 5 | **Home**: hero, families, layering slider (exactly per §5.3), notes explorer, decant explainer, teaser, new arrivals | Animations are smooth (no jank in the Performance panel). The mask behaves per the spec. Reduced motion turns them off. |
| 6 | **Scent Finder** | Each answer path gives sensible top-3 results. The keyboard-only run works. Refreshing keeps the step. |
| 7 | **Checkout and API**: form, validation, Turnstile, D1 migration (local), the orders endpoint, Telegram (optional), success page | `wrangler d1 migrations apply genzst --local` succeeds. Placing an order locally saves a D1 row with server-calculated prices. A tampered client price is ignored. Bad input shows localized errors. Six fast orders hit the rate limit. |
| 8 | **Simple pages, SEO, 404** | Sitemap and hreflang are present and every link resolves (run a link check over `dist/`). |
| 9 | **Polish and verify**: run Lighthouse; check the budgets; test at 360px, 768px and 1440px in the browser pane; do a keyboard pass and check the console for errors | All §6 targets are met, or each miss is written in `VERIFY.md` with its reason. |

After every phase, write a short entry in `PROGRESS.md`: what was done, the gate result, and the screenshots taken. Save the screenshots to `docs/screens/`.

## 9. Out of scope for v1 (don't build)
- Online payment
- User accounts
- An admin panel: orders are read from D1 via `wrangler d1 execute` and from Telegram
- Reviews
- Real deployment: the site is prepared for Cloudflare but not deployed. Deploying needs the owner's Cloudflare login. Document the command in `README.md`.

## 10. Owner TODOs to list in README.md
- Replace the 24 sample products and their prices with the real catalog.
- Add real product photos and set `image` on each product.
- Fill in `settings.json`: bank account, QPay details, phone, social links, delivery fee.
- Create the Turnstile site and secret keys and the Telegram bot token and chat id, and set them as Worker secrets.
- Create the production D1 database and apply the migrations, then deploy.
