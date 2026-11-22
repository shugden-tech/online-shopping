# Brief: rebuild the genzst admin (`/admin/`) — complete, on-brand, working live

**Owner's request:**
- **"It doesn't work."** Make the admin match the website (fonts, logo and so on).
- Add an order dashboard, delivery webhooks, and adding products with front and back photos.
- Do **everything**, and leave nothing undone.

**Live site:** https://genzst.genzst-images-3885aee2.workers.dev. It's a Cloudflare Worker named `genzst`:
- D1 binding `DB`, connected to the database `genzst` (`d6de523a-9212-4a53-b635-996765ffd48a`). Migrations 0001–0003 are applied, and the catalog holds 1,123 products, 207 of them active, with 422 SKUs. **No SKU has a price yet.**
- R2 binding `MEDIA` → bucket `genzst-images`, served publicly at `PUBLIC_MEDIA_BASE`.
- Secrets set: **only `ADMIN_TOKEN`**. A local copy is in `.secrets/admin-token.txt`, which is gitignored. Never print it.

Read first, in this order:
1. `context.md`, especially §3a
2. `docs/CONTRACTS.md`: the backend contract (schema, endpoints, permissions, state machines)
3. `docs/ADMIN-AGENT-TASKS.md`
4. `src/admin-ui/*` and `src/pages/admin/index.astro`

The backend modules (catalog, orders, payments, delivery, auth, audit) already exist and passed their tests on 2026-11-17. **Reuse them, and extend rather than rewrite.**

---

## 0. Why login "doesn't work" (fix first)
- The login form offers *username + password*. `/api/admin/login` answers **503 `login-disabled`** until the secrets `ADMIN_USERNAME` and `ADMIN_PASSWORD` (≥ 12 characters) exist. The UI probably shows a vague error.
- **Fix:**
  - Generate a strong `ADMIN_PASSWORD`.
  - Use `ADMIN_USERNAME=admin`, unless a username is already configured.
  - Save both to `.secrets/admin-login.txt`, which is gitignored. **Never print either value.**
  - Set them with `npx wrangler secret put …`, piping the value from the file.
- Make the login UI show clear Mongolian errors for each case: 503 (login disabled), 401 (wrong details), 429 (too many tries) and network errors.
- Keep token login working as well.

## 1. Brand the admin like the storefront
- **Same design tokens** (`src/styles/tokens.css`):
  - dark `--ink #070707` surfaces with `--ink-2` and `--ink-3` cards
  - `--gold #CC9E48` as the accent, with gold hairlines
  - Cormorant Garamond for headings and Montserrat for UI and body, using the same self-hosted subset fonts
  - the **genzst logo** (`src/assets/brand/logo.png`, already keyed to transparent)
  - the same favicon
- It must still be a fast, dense **work tool**: readable tables, clear status colors (new / paid / shipped / cancelled), and good contrast (WCAG AA). It's a luxury back-office, not a marketing page.
- **Layout:**
  - a sidebar (desktop) or bottom/top nav (mobile) with the logo
  - sections: Хянах самбар, Захиалга, Бараа, Үлдэгдэл, Төлбөр, Хүргэлт, Тохиргоо, Түүх (audit)
  - a header with the role, logout and a link to the store
  - It must work at 360 px on a phone.
- All UI text is in natural Mongolian. Use a `sonnet` subagent to review the copy.

## 2. Order dashboard (Хянах самбар)
- **Today, 7 days and 30 days:**
  - number of orders
  - revenue (paid only)
  - average order value
  - pending payments
  - orders to ship
  - low-stock SKUs
- A **chart** of orders and revenue per day over 30 days, as an inline SVG with no heavy library.
- **Latest orders:** order number, time, customer, phone, total, payment status and order status, with click-through to the order detail.
- **Order detail:**
  - items with size and quantity, the delivery address and note
  - payment info, with a "mark paid" action for bank transfers
  - status timeline (`order_events`)
  - actions: confirm, cancel (releases stock), create shipment, add an internal note
  - a printable packing slip
- **Filters and search:** order number, phone, name, status, date range.
- **New-order awareness:** poll every 30–60 s while the tab is visible, show a badge on Захиалга, and an optional sound or title flash.
- Add server endpoints if they're missing, such as `/api/admin/stats?range=`. Do the aggregation in SQL and add indexes through a new migration if needed.

## 3. Delivery and webhooks (Хүргэлт)
- **Shipments:**
  - create one from an order
  - fields: courier or provider, tracking number, fee, notes
  - status flow: pending → picked_up → in_transit → delivered / failed / returned
  - manual status updates
  - the order follows the shipment status (per CONTRACTS)
- **Inbound webhooks:** `/api/delivery/webhook/{provider}` exists. Make sure it:
  - verifies the HMAC signature (`DELIVERY_WEBHOOK_SECRET`)
  - is idempotent per event id
  - logs every call to a `webhook_events` table (add it by migration if missing)
  - shows a **Webhook log** in the admin with payload, result and a replay button
- **Outbound webhooks** (the owner's own integrations, e.g. Telegram, Make or Zapier):
  - an admin page to add endpoint URLs and choose events: `order.created`, `order.paid`, `order.cancelled`, `shipment.updated`
  - each delivery is signed with HMAC-SHA256 (a per-endpoint secret, shown once when created)
  - retry with backoff (reuse the existing retry job)
  - a delivery log with a "send test event" button
  - Store the endpoints in D1 by migration.
- **Delivery company:** none has been chosen yet. Keep the `manual` adapter as the default, and write a short guide in the admin settings explaining how a provider plugs in.

## 4. Products (Бараа): add and edit with front and back photos
- **List:**
  - search, filters (status draft / active / hidden, brand, gender, family, has price, has photo, low stock), sorting and pagination (1,123 items)
  - bulk actions: activate, hide, set price for a size
- **Create a product** (not just edit):
  - brand, name, concentration, gender, family, release year
  - notes as top/heart/base chip inputs
  - mn and en descriptions
  - status
  - the id or slug is generated from brand + name, and must be unique
- **Photos:**
  - **front and back** upload with drag-and-drop or the file picker, and a preview
  - client-side resize to at most 1600 px and WebP before upload
  - stored in R2 `MEDIA` via `/api/admin/media`
  - replace and remove
  - the storefront shows the front photo and uses the back photo on hover or as the second slide
- **SKUs per size** (2/5/10/30 ml, plus adding other sizes):
  - price in ₮, compare-at price, active toggle
  - **stock** with adjust (+/−, a reason, and the movement history)
- **Live storefront:** make sure a product edited in the admin shows on the live storefront without a redeploy, through `/api/store/catalog-state` and live prices. If the shop and product pages are static, products created in the admin must still be reachable. Either render the product page on demand from D1 (`prerender = false` with a cache), or document clearly that new products need a rebuild. **Prefer on-demand.**

## 5. Everything else in the admin (no gaps)
- **Payments:**
  - list and filter
  - mark a bank transfer paid, with the amount and reference
  - QPay status check
- **Settings:**
  - store open/closed, payment methods on/off
  - delivery fee and free-delivery threshold
  - bank details shown to customers
  - contact info
  - These should move from `settings.json` to D1-backed settings if they aren't already, so the owner can edit them live.
- **Audit log:** a readable history of who changed what.
- **Staff role:** the owner can see what staff can do. Staff credentials are optional, using the same secret mechanism.
- **Empty, loading and error states** everywhere. Confirm destructive actions.

## 6. Rules
- **Workspace:** `C:\Users\mtemu\Dev\trying things\genzst`. It's a git repo; work on branch `genzst`. Commit in logical steps, with each commit message ending in the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push to `origin genzst` at the end.
- **Test locally first:**
  - Use a local D1 (`--persist-to .wrangler/state-admin`) with demo prices locally only.
  - Run the existing test suites (`npm run test:*`; see context.md §3a for the commands), and add tests for the new endpoints.
  - Exercise the admin in a real browser with playwright-core and Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) at 360 and 1440 px.
  - Screenshots go to `docs/screens/admin-*`.
- **Going live:**
  - Apply new migrations to the remote database with `npx wrangler d1 migrations apply DB --remote`.
  - Set the secrets, then `npm run build` and `npx wrangler deploy`.
  - Verify on the live URL: log in with username/password through the API, check the dashboard data and the product list, and do one photo upload of a test image, then delete it.
  - **Don't create test orders or fake prices in the remote database.**
  - Don't delete or overwrite real data.
- **Don't:** use `decantx/` data on the site (except the approved `men.jpg`, `women.jpg` and `unisex.jpg`), print secrets, or touch other Cloudflare resources.
- **Delegation:** do the hard code yourself.
  - Use a `sonnet` subagent for the Mongolian UI copy.
  - Use a `haiku` subagent for mechanical sweeps: screenshots and running test suites.
  - Never let two agents edit the same file. Give short, exact briefs.
- **Logging:** keep `PROGRESS.md` updated with a "Admin rebuild" entry, including the models used. Update `context.md` §3a and `docs/CONTRACTS.md` for any new endpoints or tables.

## 7. Report back
- what changed
- the test results
- the screenshots taken
- the live verification results
- where the login details are saved (the file path only)
- anything the owner must still do (Turnstile, QPay credentials, a delivery provider, prices)
