# genzst

A perfume-decant shop website for Mongolia. Customers browse about 24 perfumes (sample data for now), pick a size (2, 5, 10 or 30 ml), fill a cart and place an order. Payment is by bank transfer or QPay and is confirmed by hand. Mongolian is the default language; English lives under `/en/`.

Built with Astro 5 and Preact islands, served from Cloudflare Workers with a D1 (SQLite) database for orders.

Repository: `shugden-tech/online-shopping`. Work happens on the **`genzst`** branch (`main` is the default branch).

```bash
git clone -b genzst https://github.com/shugden-tech/online-shopping.git
cd online-shopping
```

New here? Start with [`context.md`](context.md): it covers the status, the history, how to run the site and the open items.

Page map:

| Page | Mongolian | English |
|---|---|---|
| Home | `/` | `/en/` |
| Shop | `/delguur/` | `/en/shop/` |
| Product | `/delguur/<slug>/` | `/en/shop/<slug>/` |
| Scent Finder (quiz) | `/unertei-tanilts/` | `/en/scent-finder/` |
| Checkout | `/zahialga/` | `/en/checkout/` |
| Order success | `/zahialga/amjilttai/` | `/en/checkout/success/` |
| About | `/bidnii-tuhai/` | `/en/about/` |
| Help / delivery / returns | `/tuslamj/` | `/en/help/` |
| Order API (POST only) | `/api/orders` | same |

## Requirements and quick start

You need Node.js 20 or newer and npm. (Edge is only needed for the browser tests.)

```
npm install
copy .dev.vars.example .dev.vars        (PowerShell / cmd; on macOS/Linux: cp)
npx wrangler d1 migrations apply genzst --local
npm run dev
```

Open http://localhost:4321. The dev server uses the local D1 database and `.dev.vars` automatically.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 4321 |
| `npm run build` | Builds the site into `dist/` (fails on bad product data) |
| `npm run preview` | `wrangler dev`: serves the built worker from `dist/` like production |
| `npm run check` | TypeScript / Astro type check |
| `npm run deploy` | Build, then `wrangler deploy` |

Run `npm run build` before `npm run preview`.

## Editing content

**Products.** One JSON file per perfume in `src/content/products/`; the file name is the URL slug. Full field list: `src/content/products/README.md`. In short:
- Copy an existing file, rename it (lowercase, digits, dashes), set `slug` to the same name.
- Fill brand, name, concentration, gender, family, notes (top/heart/base), mn and en description, `sizes` (ml, price in MNT, `inStock`).
- Optional: `image` (real photo), `featured`, `isNew`.
- `npm run build` fails with the file and field name if anything is wrong, so a broken product never goes live.
- The server re-reads prices from these files at order time. Price changes need a new deploy.

**Notes.** `src/data/notes.json` lists every scent note with mn and en names. Add a note there before using it in a product.

**Shop settings.** `src/data/settings.json`:
- `delivery.fee` and `delivery.freeThreshold` (MNT). Used by the cart and by the server.
- `payment`: bank name, account number, account holder, and the bank/QPay instruction text shown after checkout.
- `contact`: phone, opening hours, Instagram / Facebook / Telegram links.
- `districts`: the Ulaanbaatar district list in the checkout form.
- `turnstile.siteKey`: the public Turnstile key (see Secrets).

**Translations.** `src/i18n/mn.json` and `src/i18n/en.json`. Both files must have the same keys; the type checker (`npm run check`) fails if they differ. Text marked `[[TODO owner]]` is a placeholder: the marker is stripped on the page, so it does not show to visitors. Find all of them:

```
grep -rn "TODO owner" src wrangler.jsonc astro.config.mjs
```

(PowerShell: `Select-String -Path src\*,wrangler.jsonc,astro.config.mjs -Pattern "TODO owner" -Recurse` or use your editor's search.)

**Logo and icons.** Put the logo at `assets/brand/genzst-logo-source.png`, then `npm run icons`. It writes the favicon, apple-touch-icon, social card and the transparent header logo.

**Fonts.** Cormorant Garamond and Montserrat are self-hosted in `src/assets/fonts/` (one small woff2 per weight, no Google requests). The stock font packages split Mongolian across several files (basic Cyrillic, Ө/Ү, and the tugrik sign ₮ are in different subsets). `scripts/build-fonts.py` merges them and keeps only the characters the site uses. It is already run and the output is committed; rerun only to change fonts: `python scripts/build-fonts.py` (needs `pip install fonttools brotli`).

## Orders

Flow:
1. Customer fills the checkout form (name, phone, address, payment choice) and passes the Turnstile check.
2. The browser POSTs to `/api/orders`.
3. The server validates the data, checks Turnstile, applies the rate limit, then re-prices every line from the product files and recomputes delivery. Prices sent by the browser are ignored.
4. The order is saved in D1.
5. If Telegram is configured, a message with the order goes to your chat. If not, this step is skipped.
6. The customer lands on the success page with the order number and payment instructions.
7. You check your bank / QPay, then update the order status by hand. There is no online payment.

Order number: `GZ-YYMMDD-XXXX`, for example `GZ-261113-K7QP`. The date is Ulaanbaatar time; `XXXX` is four random letters/digits (no confusing 0/O/1/I).

Rate limit: 5 orders per IP per 10 minutes (HTTP 429). Other API answers: 422 invalid data, bad item or failed Turnstile; 400 bad request or honeypot field filled; 500 server problem (for example a missing secret); 405 non-POST.

Read orders:

```
npm run db:orders:local
npx wrangler d1 execute genzst --remote --command "SELECT order_no, created_at, status, name, phone, total FROM orders ORDER BY id DESC LIMIT 20"
```

Items of one order (JSON in `items_json`):

```
npx wrangler d1 execute genzst --remote --command "SELECT * FROM orders WHERE order_no = 'GZ-261113-K7QP'"
```

Change a status:

```
npx wrangler d1 execute genzst --remote --command "UPDATE orders SET status = 'paid' WHERE order_no = 'GZ-261113-K7QP'"
```

Status values: `new` (default), `confirmed`, `paid`, `shipped`, `done`, `cancelled`. The database does not enforce the list, so type them exactly.

Columns: `order_no, created_at (UTC), status, name, phone, phone2, city, district, khoroo, address, note, payment, items_json, subtotal, delivery, total, locale, ip`.

## Secrets and environment

| Name | Required | Used for |
|---|---|---|
| `TURNSTILE_SECRET` | Yes | Server-side check of the anti-bot widget. Without it every order fails with 500. |
| `TELEGRAM_BOT_TOKEN` | No | Sends new orders to Telegram. |
| `TELEGRAM_CHAT_ID` | No | Which chat receives them. Both Telegram values must be set; otherwise it is skipped. |

The public Turnstile site key is not secret. It lives in two places that must match: `turnstile.siteKey` in `src/data/settings.json` (used by the checkout form) and `PUBLIC_TURNSTILE_SITE_KEY` in `wrangler.jsonc`.

Local: `.dev.vars` (copied from `.dev.vars.example`) holds Cloudflare's always-pass test secret `1x0000000000000000000000000000000AA`, which matches the test site key already in the repo. Leave Telegram empty locally unless you want test messages. Never commit `.dev.vars`.

Production: set each one with

```
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Telegram in 3 steps:
1. In Telegram, message `@BotFather`, send `/newbot`, follow the prompts. It gives you the bot token.
2. Open a chat with your new bot (or add it to a group) and send any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `chat` -> `id` from the result. That is the chat id (group ids are negative).

## Deploying to Cloudflare

Not deployed yet. This needs the owner's Cloudflare login.

1. `npx wrangler login`
2. `npx wrangler d1 create genzst`, then paste the printed `database_id` into `wrangler.jsonc` (replace the all-zeros id).
3. `npm run db:migrate:remote`
4. Create a Turnstile widget in the Cloudflare dashboard (Turnstile). Set the three secrets (see above). Put the real site key in `src/data/settings.json` and in `wrangler.jsonc` (`PUBLIC_TURNSTILE_SITE_KEY`).
5. Set the real domain: `SITE` in `astro.config.mjs` and the `Sitemap:` line in `public/robots.txt` (both currently `https://genzst.mn`).
6. `npm run deploy`
7. Attach the domain to the Worker in the Cloudflare dashboard, then place a real test order and check D1 / Telegram.

If the Astro adapter mentions a `SESSION` KV namespace, ignore it. The site does not use sessions and `wrangler.jsonc` has no KV binding.

## Testing and checks

End-to-end scripts use Playwright with Edge. Start `npm run dev` first, or point to another server with `BASE`. Set `CHROME_PATH` if Edge is not at `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`.

| Script | Checks |
|---|---|
| `node scripts/e2e-shop.mjs` | Shop filters, URL state, back/forward, cart persistence |
| `node scripts/e2e-home.mjs` | Home layering slider, sticky hero pin, reduced motion, scroll smoothness |
| `node scripts/e2e-finder.mjs` | Scent Finder keyboard run, refresh, results |
| `node scripts/e2e-checkout.mjs` | Checkout -> `/api/orders` -> D1 -> success page, API error codes (400/403/405/413/415/422/429), offline submit, empty cart, English 404 (needs the local migration applied). Leaves "E2E ..." rows in the local DB. |
| `node scripts/e2e-keyboard.mjs` | Tab order, focus visibility, no focus loss mid-page |
| `node scripts/probe-hero.mjs` | Home hero visible on first paint: with JS, without JS, reduced motion, mobile |
| `node scripts/shot-finder.mjs` | Scent Finder screenshots at 360 and 1440 px |
| `node scripts/shot.mjs <path> <name>` | Screenshots into `docs/screens/` |

PowerShell example against another server: `$env:BASE="http://localhost:8787"; node scripts/e2e-shop.mjs`

Other checks:
- `npm run build` then `npm run linkcheck`: internal links, sitemap, and mn/en alternate links in `dist/`.
- `npm run check`: type check.
- `npm run budget` (after a build): JavaScript per page, gzip. Budgets: home and `/en/` 90 KB total, shop 40, product 50, Scent Finder and checkout 25, other pages 20 (initial JS).
- Lighthouse (build and run `npm run preview` first):

```
$env:CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npx lighthouse http://localhost:8787/ --preset=desktop --view
npx lighthouse http://localhost:8787/delguur/ --form-factor=mobile --view
```

## Project layout

```
src/
  pages/        routes (mn at the root, en under en/), api/orders.ts
  views/        page bodies shared by the mn and en routes
  layouts/      Base.astro (head, meta, hreflang, fonts)
  components/   Header, Footer, ProductCard, bottle art, icons
  islands/      Preact: ShopFilters, CartDrawer, CheckoutForm, ScentFinder, LayeringSlider
  lib/          cart, filter, quiz, order schema/validation, price helpers
  content/      products/*.json (+ README.md)
  data/         notes.json, settings.json
  i18n/         mn.json, en.json, routes.mjs
  styles/       CSS per area
  assets/       fonts, brand, note and family images
migrations/     D1 schema
scripts/        tests, font and icon tools
public/         favicon, robots.txt
```

## Owner TODO checklist

- [ ] Replace the 24 sample products and prices with the real catalog
- [ ] Add real product photos and set `image` on each product
- [ ] Enter the real bank account (bank, number, holder) and QPay text in `settings.json`
- [ ] Enter the real phone, opening hours and social links in `settings.json`
- [ ] Confirm the delivery fee and free-delivery threshold
- [ ] Confirm the delivery and return policy text on the Help page
- [ ] Replace all placeholder copy marked `[[TODO owner]]` (About page, Help page and others)
- [ ] Choose and register the real domain; set it in `astro.config.mjs` and `public/robots.txt`
- [ ] Create the Turnstile site and secret keys
- [ ] Create the Telegram bot token and chat id
- [ ] Set the three Worker secrets
- [ ] Create the production D1 database, apply migrations
- [ ] Deploy with `npm run deploy` and place a real test order

## Known limitations (v1)

Out of scope on purpose:
- No online payment (you confirm bank/QPay transfers by hand)
- No user accounts
- No admin panel: read orders from D1 with wrangler and from Telegram
- No reviews
- Not deployed yet

Deviations from the original plan (see `PROGRESS.md`):
- Fonts are merged from four subsets into one file per face, because the planned two subsets cannot render Mongolian.
- Signals use `@preact/signals-core` plus a small hook to stay within the JavaScript budget. The cart drawer loads on first interaction.
- The notes filter works on the 11 photographed note groups, and selecting several narrows the result. Individual notes are found through search; there are no separate note pages.
- No animation or slider library: the home hero pin is `position: sticky` driven by a few CSS variables, and the layering slider is a CSS scroll-snap track (the plan named GSAP ScrollTrigger and Swiper). Home JS went from 116 KB to 26 KB.
- The Scent Finder and checkout have a 25 KB JS budget instead of 20 (they are island pages; see `VERIFY.md`).
