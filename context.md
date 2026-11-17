# genzst — project context

This file is for anyone (person or AI agent) picking up the project on another computer or in a new session. It covers what genzst is, what has been done, and how to carry on. The detailed logs are in the files linked below.

_Last updated: 2026-11-17_

---

## 1. What genzst is

genzst is a perfume **decant** shop for Mongolia: 2 / 5 / 10 / 30 ml samples of designer and niche perfumes.
- **Language:** Mongolian is the default at `/`, with English under `/en/`.
- **Ordering:** customers browse, pick a size, add to the cart and submit an order form.
- **Payment:** bank transfer or QPay, confirmed **by hand** by the owner. There is no online payment in v1.

**Repo:** `shugden-tech/online-shopping`, branch **`genzst`** (do all work and pushes here).

---

## 2. Current status

| Area | Status |
|---|---|
| Website v1 | ✅ Built and verified locally (all 9 plan phases plus the handoff fixes) |
| Production build, type check, link check, JS budget | ✅ all pass |
| E2E tests (shop, home, finder, checkout, keyboard) | ✅ all pass against `wrangler dev` |
| Lighthouse mobile | Home 100/100/100/100 · Shop 100/100/100/100 · Product 97/100/100/100 |
| Test order | ✅ `GZ-261113-NEAJ` saved in local D1 with server-calculated prices |
| Backend hardening (idempotency, stock, admin, lookup) | ✅ `npm run test:api` 47/47 against `wrangler dev` (see §3a) |
| Deployment | ❌ Not deployed (needs the owner's Cloudflare login) |
| Real products, prices and photos | ⚠️ 100 products imported from `decantx/merged.json` (prices converted from USD; see PROGRESS.md) |
| Logo SVG | ⏸ Dropped by the owner: the logo PNG is used as-is |

---

## 3. Tech stack

- **Astro 5** + TypeScript (strict), with **Preact** islands and `@preact/signals-core`.
- **Cloudflare Workers** (`@astrojs/cloudflare`): static pages plus the server routes in §3a.
- **Cloudflare D1** (SQLite): `migrations/0001_orders.sql` (orders) and `0002_backend.sql` (idempotency, order_events, inventory, rate_limits).
- **Turnstile** anti-spam, plus a honeypot and an atomic D1 rate limit of 5 orders per IP per 10 minutes.
- **Telegram** bot notification on each new order (optional, configured by env vars).
- **Animation:** home is driven by `position: sticky` plus a scroll-progress helper writing CSS variables. GSAP and Swiper were removed to save JS: home went from 116 KB to 26 KB.
- **Fonts:** Cormorant Garamond (headings) and Montserrat (titles and body), self-hosted and subset so Mongolian Ө/Ү and ₮ render.
- **Design:** dark-first; `--ink #070707`, `--gold #CC9E48`, hairline gold rules, wide tracking.

---

## 3a. Backend (2026-11-17)

| Route | What |
|---|---|
| `POST /api/orders` | Checks: content type → 32 KB → JSON → `Idempotency-Key` format → zod → honeypot → Turnstile → replay by key → rate limit → re-price → one D1 batch. |
| `POST /api/orders/lookup` | `{ orderNo, phone }` (last 4–8 digits). Returns status, items and totals only. Not found and wrong phone are the same 404. 10 per IP per 10 min. |
| `GET /api/admin/orders` | `?status=&limit=&cursor=`, newest first, keyset paging. |
| `GET/PATCH /api/admin/orders/:no` | Order and its `order_events` history. PATCH `{status, note}` allows new → confirmed → paid → shipped → done, one step at a time, and any non-cancelled status → cancelled. Cancelled is final. |
| `GET/PUT/DELETE /api/admin/inventory` | Every catalog size with its product-file values and D1 override. PUT `{product_id, ml, price, stock}` (null = use the file); DELETE removes the override. |
| `/admin` | Plain owner page (noindex, not in the sitemap or any link). The token is kept in sessionStorage for the tab. |

- **Admin auth:** `Authorization: Bearer <ADMIN_TOKEN>` (a Worker secret of at least 24 characters), compared in constant time (SHA-256 of both sides). Without a valid token the API answers 401, or 503 if the secret is not set. Failed attempts are limited to 20 per IP per 10 minutes, and every response is `no-store`.
- **Duplicate orders:** the checkout keeps one UUID per attempt in sessionStorage (`gz-checkout-key`) and sends it as `Idempotency-Key`. When the same key arrives again (a retry, a double click or a lost response), the server returns the original order number and inserts nothing. The UNIQUE index also handles two requests that arrive at the same moment.
- **Stock:** the `inventory` table is **empty** by default, so prices and stock come from the product JSON as before. A non-null D1 `price`/`stock` overrides the JSON for orders. Tracked stock is decremented in the same D1 batch as the order insert. `CHECK (stock >= 0)` aborts the whole batch when stock would go negative, and the API answers 409 `{form:"stock", unavailable:[…]}`; no partial order is written. Cancelling an order restores the stock it took (lines marked `tracked` in `items_json`), at most once. The storefront is static, so it still shows the JSON prices and stock until the next build.
- **Rate limits:** `rate_limits` uses one upsert … RETURNING per request, so the count is exact even under concurrent requests.
- **Success page:** it no longer trusts `?no=`/`?t=`. The amount and status come from `/api/orders/lookup`, using the phone that the checkout stored for this tab (`gz-last-order`). The cart is cleared only for the order placed in this tab. A "check order status" form (order number + phone) is on the page for everyone else.
- **Tests:** `npm run db:migrate:local`, start `npm run dev` or `npm run preview`, then `BASE=http://localhost:8788 npm run test:api`. The tests read `ADMIN_TOKEN` from `.dev.vars`. They need the always-pass Turnstile test secret, which the server accepts without a network call.
- **Known stale test:** `scripts/e2e-checkout.mjs` still uses products from the old sample catalog (`sauvage`, `oud-wood`), so it no longer runs. Its success-page checks have been updated for the lookup.

### Launch blockers (backend)
- [ ] Real D1 `database_id` in `wrangler.jsonc` (now all zeros), then `npm run db:migrate:remote`.
- [ ] Real Turnstile site key (`PUBLIC_TURNSTILE_SITE_KEY` in `wrangler.jsonc` / `settings.json`) and `TURNSTILE_SECRET` (now Cloudflare's always-pass test keys).
- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets, if notifications are wanted.
- [ ] `ADMIN_TOKEN` secret: `openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN`. The `.dev.vars.example` value is dev-only.
- [ ] Real prices and stock: either correct product JSON or `inventory` rows entered through `/admin`. Nothing has been seeded.
- [ ] Bank account and QPay details in `src/data/settings.json` (still placeholders).

---

## 4. Running it

```bash
npm install
cp .dev.vars.example .dev.vars        # Windows: copy .dev.vars.example .dev.vars
npx wrangler d1 migrations apply genzst --local
npm run dev                           # http://localhost:4321
```

To run it like production: `npm run build`, then `npm run preview` (wrangler dev on port 8788).
To see the latest orders: `npm run db:orders:local`.

More detail, including editing products, secrets and deploying, is in `README.md`.

---

## 5. Where things are

| Path | What |
|---|---|
| `src/content/products/*.json` | One file per perfume (zod-validated; a bad file fails the build). See its `README.md`. |
| `src/data/settings.json` | Delivery fee, payment instructions, contacts, districts, Turnstile site key |
| `src/data/notes.json` | Scent notes (mn/en) |
| `src/i18n/mn.json`, `en.json` | All UI text. `[[TODO owner]]` marks text that needs real business info. |
| `src/islands/` | Cart drawer, shop filters, Scent Finder quiz, checkout form, layering slider |
| `src/pages/api/` | Order, lookup and admin APIs (§3a). Shared server helpers are in `src/lib/server.ts`. |
| `src/pages/admin.astro` | Owner admin page (§3a). |
| `scripts/` | E2E tests, screenshots, budget, link check, icon and font builders |
| `assets/` | Original source images: logo, notes, families, and the reference screenshots |
| `animation1.md` | Spec for the layering slider (scroll mask, staggered entrance, creative carousel) |
| `decantx/products.json` | Scraped DecantX catalog. Used **only** as reference for categories, sizes and pricing. The site doesn't import it. Don't publish its text or images on the site — except the three owner-approved gender tile images (`decantx/men.jpg`, `decantx/women.jpg`, `decantx/unisex.jpg`) used on the home page. |

**Not in the repo** (kept on the original computer only):
- `decantx/products_full.json`: 356 MB, over GitHub's 100 MB limit.
- `node_modules/`, `dist/`, `.astro/`, `.wrangler/`: regenerated by npm and the build.
- `.dev.vars`: local secrets. Copy it from `.dev.vars.example`.

---

## 6. History: how we got here

1. **Research.** We studied `animation1.md` (the D&G layering slider) and captured reference screenshots of the D&G Velvet, Jean Paul Gaultier, DecantX and Luckyscent sites into `assets/reference/`. Notes are in `assets/reference/NOTES.md`. Scentbird blocked automated capture. Brandfetch logos were skipped (no client ID).
2. **Type system.** We chose Cormorant Garamond for headings and Montserrat for titles and body, in a 3-tier hierarchy that supports Mongolian Cyrillic.
3. **Logo.** We planned an SVG rebuild (`PLAN-logo-svg.md`), then the owner dropped it. The PNG is used as-is, with its backdrop keyed to transparent.
4. **Website plan.** `PLAN-website.md` is the full spec: scope, stack, design tokens, data model, pages, API, performance targets and 9 phased gates. The owner's choices:
   - catalog + cart + an order form, with payment confirmed by hand
   - Mongolian by default with an English toggle
   - a curated catalog the owner will provide
   - the stack was left to us: build it decently and creatively, but working and efficient
5. **Build (Fable 5.2).** Fable built phases 1–6 itself, then most of 7–9, before hitting usage limits twice.
6. **Model routing (owner's rule).** To save tokens, the owner asked that Fable only plan and review. Hard coding goes to **Opus**, mechanical work to **Haiku** and copywriting to **Sonnet**. The owner then moved the lead role to **Opus**.
7. **Handoff (Opus).** Opus worked from `docs/HANDOFF-opus.md`:
   - fixed the hero visibility without JS
   - fixed the order API check order (bad JSON was hitting Astro's CSRF check)
   - removed GSAP and Swiper
   - fixed accessibility issues and the 360 px Scent Finder layout
   - polished the slider and notes grid
   - had Sonnet review the Mongolian copy and Haiku run Lighthouse and screenshots

   Full logs: `PROGRESS.md` (per phase, with the model used) and `VERIFY.md` (final numbers).
8. **Verification.** The main session rebuilt the site, browsed it, placed a test order and confirmed the D1 row.

---

## 7. Open items / next steps (owner)

- [ ] Replace the 24 sample products with the real catalog: names, prices in ₮, sizes and stock.
- [ ] Add real product photos (`image` field). Until then, generated SVG bottles are shown.
- [ ] Fill in `src/data/settings.json`: bank account, QPay, phone, socials and delivery fee. Also search for `[[TODO owner]]`.
- [ ] Create Turnstile site/secret keys and a Telegram bot token and chat id, and set them as Worker secrets.
- [ ] Create the production D1 database, apply the migrations, and run `npm run deploy` (with `wrangler`, because the project has `wrangler.jsonc`).
- [ ] Decide on the declined copy suggestions: the formal register, and the "Таван аяс" headline versus 8 families (see `PROGRESS.md`).
- [ ] Unverified: 60 fps smoothness on real hardware. The test machine's headless browser ran at 30 fps.

**Out of scope for v1:** online payment, user accounts and reviews. A minimal `/admin` exists (orders, status, inventory), see §3a.

---

## 8. Rules for whoever continues

- Work on the `genzst` branch.
- Don't put DecantX text or images, or any other brand's images, **on the site** — except the three owner-approved gender tile images (`decantx/men.jpg`, `decantx/women.jpg`, `decantx/unisex.jpg`) used on the home page.
- Verify changes in a real browser. A change that only compiles isn't done.
- Keep `PROGRESS.md` updated, and record which model did the work.
- Stay inside the JS budgets in `scripts/js-budget.mjs` (home ≤ 90 KB total, shop ≤ 40, product ≤ 50, finder and checkout ≤ 25, other pages ≤ 20).
