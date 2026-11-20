# genzst — project context

This file is for anyone (person or AI agent) picking up the project on another computer or in a new session. It covers what genzst is, what has been done, and how to carry on. The detailed logs are in the files linked below.

_Last updated: 2026-11-20_

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

## 3a. Commerce backend (A0–A6, 2026-11-17)

Full contract: **`docs/CONTRACTS.md`** (schema, every endpoint, permissions, state machines, stock arithmetic,
file ownership). Schema: `migrations/0003_commerce.sql`. Shared types/state maps: `src/lib/contracts.ts`.

| Module | Code | What it does |
|---|---|---|
| Catalog (A1) | `src/lib/catalog/`, `/api/admin/products…`, `/api/admin/inventory…`, `/api/admin/media`, `/api/store/catalog-state` | Products (draft/active/hidden, sale lock, front/back photos), one SKU per size (price, compare-at, active), stock with reservations and a movement history, photo upload to R2 `MEDIA`, public live state for the storefront. |
| Orders + payments (A2) | `src/lib/orders/`, `src/lib/payments/`, `/api/orders…`, `/api/payments/qpay/callback`, `/api/admin/orders…`, `/api/admin/payments` | Order = one D1 batch that reserves stock (CHECK constraint = no oversell); hold expires (QPay 30 min, bank 24 h); paid → stock committed; cancel → released/restored. QPay v2 invoice + signed callback verified with `payment/check`; bank transfer marked paid by the owner. |
| Delivery (A3) | `src/lib/delivery/` (+ README), `/api/admin/shipments…`, `/api/delivery/webhook/{provider}` | Adapter interface with `manual` and `mock`; tracking, signed webhook, retry with backoff (8 attempts). Order → shipped / done follows the shipment. |
| Admin UI (A4) | `src/pages/admin/`, `src/admin-ui/` | `/admin/` (Mongolian): dashboard, products + photos + SKUs + stock, orders, payments, shipments, store controls, audit log. Role-aware. |
| Storefront (A5) | `src/lib/store-state.ts`, `src/scripts/live-prices.ts`, cart/checkout/success | Prices and buy buttons come from the live server state (no build-time price is shown); cart re-checked before checkout; QPay QR / bank instructions; order tracking. |
| Lead (A0/A6) | `src/lib/{contracts,ids,auth,settings,audit,server}.ts`, `/api/admin/{me,settings,audit,jobs/run}` | Owner/staff tokens + permissions, store switches, audit log, housekeeping job (expire holds, retry shipments). |

**Admin rebuild (2026-11-19, migration 0004):** branded admin (dark ink + gold), username/password login (secrets set; local copy
`.secrets/admin-login.txt`), dashboard stats + chart, order notes / packing slip / date filters / new-order badge, shipments with
courier / fee / notes / `returned`, inbound webhook log + replay, outbound webhooks (signed, retried), product filters / bulk /
create with front + back photos (WebP ≤ 1600 px), a stock page, live bank / contact settings, and on-demand pages `/delguur/p/{id}`
for D1-only products. Contract: `docs/CONTRACTS.md` §8. Tests: `npm run test:admin-api`, `npm run test:admin-ui`; screenshots:
`npm run shots:admin` → `docs/screens/admin-*`.

**Bundles (2026-11-20, migration 0005):** `bundles` + `bundle_items` in D1 (the owner's 8 bundles seeded, 99,000₮). Pages
`/bundles/`, `/bundles/{id}/` (+ `/en/`) render on demand from D1 (60 s cache) with "Сагсанд нэмэх" / "Шууд захиалах"; a bundle is one
cart line `{ bundle, qty }`, priced by the server and reserving every part SKU in the order batch. Admin "Багц" section (`#/bundles`):
list, create, edit, parts picker, photo upload, hide, delete. A bundle sells only when every part is active, priced and in stock, so
live bundles show "Түр дууссан" until the owner prices/stocks the 10 ml sizes. Contract: `docs/CONTRACTS.md` §9. Tests:
`npm run test:bundles`; screenshots: `npm run shots:bundles` → `docs/screens/bundles-*`. Owner TODO: activate and add a priced 10 ml size
for the draft parts (montblanc-legend-edt, jean-paul-gaultier-le-male-edt, versace-eros-edp, versace-eros-parfum,
dolce-gabbana-light-blue-pour-homme-edt, dolce-gabbana-pour-homme-edt, paco-rabanne-invictus-edt); add the two products that are not in
the catalog at all (Maison Margiela Replica Sailing Day EDT, Moncler Pour Homme EDP) or swap them in the bundle editor.

**Hide / lock controls:** product hidden (status), product sale lock, payment method off (QPay / bank), checkout closed — all in `/admin/`.
**Catalog data:** `npm run import:catalog -- --apply local|remote` loads the 1000-item R2 catalog + the 207 site products (1123 products, prices and stock empty). `--demo-prices` is local-only.

**Tests** (local: `npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-lead`, `npx astro build`,
`node scripts/mock-qpay.mjs &`, `node scripts/mock-delivery.mjs &`, `npx wrangler dev --port 8788 --persist-to .wrangler/state-lead`, then
`BASE=http://localhost:8788 PERSIST=.wrangler/state-lead D1_PERSIST=.wrangler/state-lead npm run test:<name>`):
catalog 86, api 84, payments 45, delivery 85, storefront 57, admin-ui 94, e2e commerce 43 + browser 17 — all passing on the merged tree (2026-11-17).
`.dev.vars` needs the QPay/delivery test values from `.dev.vars.example` pointed at the mocks.

### Launch blockers (owner)
- [ ] Real D1 `database_id` in `wrangler.jsonc`, then `npm run db:migrate:remote` and `npm run import:catalog -- --apply remote`.
- [ ] R2 bucket name for `MEDIA` in `wrangler.jsonc` (the bucket behind `PUBLIC_MEDIA_BASE`).
- [ ] `PUBLIC_SITE_URL` = the real domain (QPay callback URLs are built from it).
- [ ] Secrets: `ADMIN_TOKEN` (and optional `STAFF_TOKEN`), `TURNSTILE_SECRET` + real site key, `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`, `QPAY_CALLBACK_SECRET`, optional Telegram.
- [ ] QPay: switch `QPAY_BASE_URL` from sandbox to production; check the field names in `src/lib/payments/qpay.ts` against the official v2 doc (tested only against a local mock). Confirm QPay calls the callback with GET or JSON POST (a form-encoded POST would be refused by Astro's origin check).
- [ ] Delivery company: name, API + webhook docs, sandbox → a real adapter in `src/lib/delivery/adapters/`.
- [ ] Real prices and stock for every SKU (in `/admin/`); gender/family/description for the 916 draft catalog products before activating them.
- [ ] Bank account details in `src/data/settings.json`.
- [ ] Image rights: the R2 photos and the owner's brand banners are other brands' images — CLAUDE.md's rule needs the owner's decision.

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
