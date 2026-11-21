# GenZst commerce — frozen contracts (A0)

Status: **FROZEN**. Only the lead agent changes this file, `migrations/**`, `src/lib/contracts.ts`,
`src/lib/auth.ts`, `src/lib/settings.ts`, `src/lib/audit.ts`, `src/lib/server.ts`, `src/env.d.ts`,
`wrangler.jsonc`, `.dev.vars.example`, `astro.config.mjs`, `package.json` / lockfile, `context.md`, `PROGRESS.md`.
A module that needs a contract change stops and reports the exact change it needs.

Sources of truth: schema = `migrations/0003_commerce.sql` (on top of 0001, 0002); types, enums, state
machines, settings, roles = `src/lib/contracts.ts`.

## 1. Rules for every module

- Money: integer ₮. No invented prices or stock. A SKU with `price NULL` is not sellable; the importer
  never fills prices (a local-only `--demo-prices` flag may copy the build-time JSON prices into a
  local dev database and must refuse `--remote`).
- Sellability is `isSellable()` in contracts.ts. Server routes decide; the storefront only displays.
- Every admin write: `authorize(request, env, ip, "<permission>")` from `src/lib/auth.ts`, then the
  change **and** `auditStatement(...)` in one `env.DB.batch([...])`.
- Every state change uses the transition maps in contracts.ts and a conditional SQL update
  (`UPDATE ... SET status = ?new WHERE id = ? AND status = ?old`), checking `meta.changes`.
- Responses: `json()` / `fail()` from `src/lib/server.ts`. Success `{ ok: true, ... }`, failure
  `{ ok: false, errors: { field: code } }`. Lists: `{ ok, items, page, limit, total }` or keyset
  `{ ok, items, nextCursor }`. Admin responses are `no-store`.
- Routes are `export const prerender = false;` Astro endpoints under `src/pages/api/`.
- Request bodies: `readJson(request, maxBytes)`; validate with `astro/zod` in server-only files.
  Never import zod from an island.
- Customer PII (name, phone, address) never goes into `audit_log.data_json`, logs or provider calls
  beyond what the provider needs.
- Times: SQLite `datetime('now')` UTC text.

## 2. Permissions

| Role | Token | Permissions |
|---|---|---|
| owner | `ADMIN_TOKEN` | all |
| staff | `STAFF_TOKEN` | catalog.read, inventory.write, orders.read, orders.write, payments.read, delivery.read, delivery.write, settings.read |

`GET /api/admin/me` → `{ ok, role, permissions }` (lead).

## 3. State machines (contracts.ts)

- **Product**: `status` draft | active | hidden (any → any, admin, `catalog.write`); `sale_locked` 0/1
  independent ("visible but cannot be bought"). Per-SKU `active` 0/1.
- **Store switches** (`store_settings`): `checkout.open`, `payments.qpay.enabled`, `payments.bank.enabled`.
- **Order**: new → confirmed | paid | cancelled; confirmed → paid | cancelled; paid → shipped | cancelled;
  shipped → done. done, cancelled terminal.
- **Reservation**: held → committed (order paid) | released (order cancelled / hold expired).
- **Payment**: pending → paid | failed | expired | cancelled; paid → refunded.
- **Shipment**: pending → created | failed | cancelled; created → picked_up | in_transit | delivered | failed | cancelled;
  picked_up → in_transit | delivered | failed; in_transit → delivered | failed; failed → pending (retry) | cancelled.
  Side effects on the order: shipment created/picked_up/in_transit ⇒ order paid → shipped; delivered ⇒ shipped → done.

### Stock arithmetic (skus)

`available = stock - reserved` (stock NULL = untracked → available NULL, unlimited).

| Event | skus | reservations | stock_movements |
|---|---|---|---|
| order placed (tracked line) | reserved += qty (CHECK fails batch if over) | insert held, tracked=1 | — |
| order placed (untracked) | — | insert held, tracked=0 | — |
| order paid | stock -= qty, reserved -= qty | held → committed | reason `sale`, delta −qty |
| cancelled / expired before paid | reserved -= qty | held → released | — |
| cancelled after paid | stock += qty | (stays committed) | reason `cancel_after_paid`, +qty |
| admin restock / correction | stock = n or += d (CHECK keeps reserved ≤ stock) | — | `restock` / `correction` |

All rows of one event go in one D1 batch.

## 4. HTTP API

`A1` … `A5` = owning module. Bodies are JSON. `ip` rate limits use `hitRateLimit` (server.ts).

### Public

| Method & path | Owner | Contract |
|---|---|---|
| `GET /api/store/catalog-state?ids=a,b,…` (≤ 60 ids; no ids = 400) | A1 | `StoreState` (contracts.ts). `Cache-Control: public, max-age=30`. Unknown ids omitted. Hidden/draft products → `visible:false`, all `sellable:false`. |
| `POST /api/orders` | A2 | Body = current `orderSchema` + items `{ sku, qty }` (legacy `{ slug, ml, qty }` still accepted → `skuId(slug, ml)`). Header `Idempotency-Key` (UUID). 201 `{ ok, orderNo, total, subtotal, delivery, holdExpiresAt, payment: PaymentInstructions }`; same key → 200 with the same body. Errors: 409 `{ form:"stock", sku }`, 409 `{ form:"unavailable", sku }`, 423 `{ form:"closed" }` (checkout closed), 422 `{ payment:"disabled" }`, existing 400/403/413/415/429. Prices/totals always from D1 `skus` + settings. |
| `GET /api/orders/lookup?no=&phone=` | A2 | existing + `paymentStatus`, `holdExpiresAt`, `shipment: { status, trackingNo, trackingUrl } \| null`. |
| `POST /api/orders/{no}/payment-check` `{ phone }` | A2 | Re-checks QPay for that order (rate limited 10/10 min/ip). `{ ok, paymentStatus, status }`. |
| `GET\|POST /api/payments/qpay/callback?order=&sig=` | A2 | `sig` = hex HMAC-SHA256(`QPAY_CALLBACK_SECRET`, order no). Never trusts the body: calls QPay `POST /v2/payment/check` and marks paid only when `paid_amount ≥ amount`. Idempotent. Always 200 `SUCCESS` for a valid sig (so QPay stops retrying), 403 otherwise. |
| `POST /api/delivery/webhook/{provider}` | A3 | Header `X-Signature` = hex HMAC-SHA256(`DELIVERY_WEBHOOK_SECRET`, raw body). De-duplicated by `external_event_id`. 200 `{ ok }`, 401 bad sig, 404 unknown shipment. |

### Admin (Bearer; permission in brackets)

| Method & path | Owner | Contract |
|---|---|---|
| `GET /api/admin/me` | lead | `{ role, permissions }` |
| `GET/PUT /api/admin/settings` [settings.read / settings.write] | lead | `{ settings }`; PUT partial object, unknown key → 400 |
| `GET /api/admin/audit?entity=&entityId=&cursor=` [audit.read] | lead | keyset list |
| `POST /api/admin/jobs/run` [orders.write] | lead | runs `sweepExpiredHolds(env)` (A2) + `retryShipments(env)` (A3); `{ ok, expired, retried }` |
| `GET /api/admin/products?q=&status=&brand=&page=&limit=` [catalog.read] | A1 | `Page<AdminProduct>` (skus included) |
| `POST /api/admin/products` [catalog.write] | A1 | create (id must match `PRODUCT_ID_RE`, unique) → 201 `{ product }` |
| `GET/PATCH /api/admin/products/{id}` [catalog.read / catalog.write] | A1 | PATCH any editable AdminProduct field incl. `status`, `saleLocked`, `imageFront`, `imageBack` (https on `PUBLIC_MEDIA_BASE` host or site path `/…`) |
| `PUT /api/admin/products/{id}/skus/{ml}` [catalog.write] | A1 | upsert `{ kind, price, compareAt, active }` (price null allowed = not for sale) |
| `DELETE /api/admin/products/{id}/skus/{ml}` [catalog.write] | A1 | only when no reservations reference it, else 409 |
| `GET /api/admin/inventory?low=&cursor=` [catalog.read] | A1 | SKU list with stock/reserved/available |
| `POST /api/admin/inventory/adjust` [inventory.write] | A1 | `{ sku, set? , delta?, reason: "restock"\|"correction", note? }` exactly one of set/delta; 409 if it would go below reserved |
| `GET /api/admin/inventory/{sku}/movements` [catalog.read] | A1 | movement history |
| `POST /api/admin/media` [media.write] | A1 | multipart `file` (jpeg/png/webp ≤ 5 MB) + `productId` + `side` front\|back → stores in `MEDIA` at `products/{id}/{side}-{sha256-12}.{ext}`, returns `{ url }`; does not change the product (the UI then PATCHes) |
| `GET /api/admin/orders?status=&q=&cursor=` [orders.read] | A2 | keyset list incl. `paymentStatus`, `holdExpiresAt` |
| `GET/PATCH /api/admin/orders/{no}` [orders.read / orders.write] | A2 | PATCH `{ status, note? }` via ORDER_TRANSITIONS; `paid` via PATCH requires payments.write; cancel releases/restores stock |
| `POST /api/admin/orders/{no}/mark-paid` [payments.write] | A2 | bank transfer: `{ amount, reference }`; creates/updates a `bank` payment row, commits reservations |
| `GET /api/admin/payments?status=&provider=&cursor=` [payments.read] | A2 | keyset list |
| `POST /api/admin/shipments` [delivery.write] | A3 | `{ orderNo, provider? }` order must be `paid`; creates shipment and calls the provider (or leaves `pending` for retry) |
| `GET /api/admin/shipments?status=&cursor=` [delivery.read] | A3 | keyset list |
| `GET/PATCH /api/admin/shipments/{id}` [delivery.read / delivery.write] | A3 | PATCH `{ status?, trackingNo?, trackingUrl?, note? }` via SHIPMENT_TRANSITIONS (manual provider) |
| `POST /api/admin/shipments/{id}/retry` [delivery.write] | A3 | failed → pending → provider call |

### Clarifications (lead, after A1/A4)

- All JSON fields are **camelCase** (`orderNo`, `createdAt`, `paymentStatus`, `holdExpiresAt`, `trackingNo`, …).
- `GET /api/admin/orders` also filters by `paymentStatus=` (unpaid | pending | paid | refunded); rows include `paymentStatus`, `holdExpiresAt`, `total`, `payment`.
- `GET /api/admin/orders/{no}` → `{ ok, order }` where `order` has `items`, `events[]`, `payments[]` (`id, provider, providerRef, amount, paidAmount, status, createdAt, paidAt`), `reservations[]` (`skuId, qty, tracked, status`), `shipments[]` (`id, provider, status, trackingNo, trackingUrl, createdAt`).
- Shipment rows: `id, orderNo, provider, providerRef, trackingNo, trackingUrl, status, attempts, lastError, nextRetryAt, createdAt, updatedAt`; detail adds `events[]` (`at, fromStatus, toStatus, source, note`).
- `GET /api/admin/inventory?low=N` = tracked SKUs whose `available ≤ N`.
- SKU PUT → `{ ok, sku, created }`; `kind` required only on create; `compareAt` must be > `price`. Stock `delta` on an untracked SKU → 409 `{ stock: "untracked" }` (use `set`). Media → `{ ok, url, key }`, 404 unknown product.
- A3 adds `POST /api/admin/shipments/run-retries` [delivery.write] → `{ ok, retried, failed }`; shipment rows also carry `orderStatus`. Errors: 409 `has-shipment` / `not-paid`, 422 unknown/unconfigured provider, 502 provider cancel failed. Delivery webhooks must send `Content-Type: application/json`.
- **Security (2026-11-19):** `/api/orders/lookup` is POST-only (`{ orderNo, phone }`, phone ≥ 6 digits; GET → 405) so phone digits never reach URLs/logs. Admin routes answer 503 `insecure-secret` when a public dev secret (`dev-only…`, `demo-…`) is configured on a non-localhost host. `public/_headers` sets CSP, X-Frame-Options, HSTS, nosniff, Referrer-/Permissions-Policy; `/admin/*` is `no-store` + noindex.
- Astro `checkOrigin`: multipart POSTs and body-less DELETEs need a same-site `Origin` header (browsers send it; scripts must).

### Shared module functions (signatures frozen)

```ts
// A2  src/lib/orders/holds.ts
export function sweepExpiredHolds(env: Env, limit?: number): Promise<{ expired: number }>;
// A3  src/lib/delivery/retry.ts
export function retryShipments(env: Env, limit?: number): Promise<{ retried: number; failed: number }>;
```

`POST /api/orders` also calls `sweepExpiredHolds(env, 20)` via `waitUntil` so holds expire without cron.

## 5. Integrations

- **QPay v2** (https://developer.qpay.mn/mn/docs/merchant?version=2.0.0): `POST {QPAY_BASE_URL}/v2/auth/token`
  (Basic `QPAY_USERNAME:QPAY_PASSWORD`) → bearer; `POST /v2/invoice` `{ invoice_code, sender_invoice_no,
  invoice_receiver_code, invoice_description, amount, callback_url }` → `invoice_id, qr_text, qr_image,
  qPay_shortUrl, urls[]`; `POST /v2/payment/check` `{ object_type:"INVOICE", object_id, offset:{ page_number:1,
  page_limit:100 } }` → `count, paid_amount, rows[]`. QPay is "enabled" only when the setting is on **and**
  all four QPAY secrets are set. Verify field names against the official doc before go-live; tests use a
  local mock server via `QPAY_BASE_URL`.
- **Bank transfer**: instructions from `src/data/settings.json` (owner placeholders); confirmed by admin `mark-paid`.
- **Delivery**: company not chosen yet. A3 defines an adapter interface (`create`, `cancel`, `track`,
  `parseWebhook`) with `manual` (no API; admin enters tracking) and `mock` (HTTP JSON protocol in
  `src/lib/delivery/README.md`, used by tests against a local mock server via `DELIVERY_BASE_URL`).
  A real company adapter is added later behind the same interface.

## 6. File ownership

| Module | Owns (may create/edit only these) |
|---|---|
| lead (A0/A6) | everything in the header list; `src/pages/api/admin/{me,settings,audit}.ts`, `src/pages/api/admin/jobs/**`; `docs/CONTRACTS.md`; `scripts/test-e2e-*.mjs` |
| A1 catalog | `src/lib/catalog/**`, `src/pages/api/store/**`, `src/pages/api/admin/products/**`, `src/pages/api/admin/products.ts`, `src/pages/api/admin/inventory.ts`, `src/pages/api/admin/inventory/**`, `src/pages/api/admin/media.ts`, `scripts/import-catalog.mjs`, `scripts/test-catalog.mjs`, `data/catalog/**` |
| A2 orders/payments | `src/lib/orders/**`, `src/lib/payments/**`, `src/lib/order-schema.ts`, `src/pages/api/orders.ts`, `src/pages/api/orders/**`, `src/pages/api/payments/**`, `src/pages/api/admin/orders.ts`, `src/pages/api/admin/orders/**`, `src/pages/api/admin/payments.ts`, `scripts/test-api.mjs`, `scripts/test-payments.mjs`, `scripts/mock-qpay.mjs` |
| A3 delivery | `src/lib/delivery/**`, `src/pages/api/delivery/**`, `src/pages/api/admin/shipments.ts`, `src/pages/api/admin/shipments/**`, `scripts/test-delivery.mjs`, `scripts/mock-delivery.mjs` |
| A4 admin UI | `src/pages/admin.astro` (to be replaced by) `src/pages/admin/**`, `src/admin-ui/**`, `src/styles/admin.css`, `scripts/test-admin-ui.mjs` |
| A5 storefront | `src/islands/**`, `src/scripts/**`, `src/components/**`, `src/views/**`, `src/i18n/*.json`, `src/styles/*.css` except admin.css, `src/lib/order-validate.ts`, `src/lib/cart*.ts`, `scripts/test-storefront.mjs` |

Nobody edits another module's files. Shared helpers a module needs go inside its own directory.

## 7. Local test setup (each module)

```bash
npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-<module>
npx astro build && npx wrangler dev --port <port> --persist-to .wrangler/state-<module>
```

Ports: A1 8791, A2 8792, A3 8793, A4 8794, A5 8795, lead 8788. Tests are plain `node` scripts
(`BASE=http://localhost:<port> node scripts/test-*.mjs`), print `N passed, M failed`, exit 1 on failure.
Turnstile uses the always-pass test secret in `.dev.vars`.

## 8. Admin rebuild (lead, 2026-11-19, migration 0004)

Schema `migrations/0004_admin.sql`:
- `shipments` rebuilt (rows copied): status adds **`returned`**; new columns `courier`, `fee` (₮), `note`.
  Transitions (contracts.ts): pending → created | picked_up | in_transit | failed | cancelled; picked_up / in_transit /
  failed → returned (terminal; the owner decides about the order). Order side effects unchanged.
- `order_notes` (internal, admin only), `webhook_events` (every inbound delivery-webhook call: signature ok, HTTP status,
  event ids, result, payload ≤ 16 KB), `webhook_endpoints` + `webhook_deliveries` (outbound outbox).
- Settings (contracts.ts `SETTINGS`): `bank.name`, `bank.account`, `bank.holder`, `contact.phone`, `contact.hours_mn`,
  `contact.hours_en`, `contact.instagram`, `contact.facebook`, `contact.telegram` (empty = settings.json value).
- `StoreProductState` gains optional `imageFront` / `imageBack`.

Outbound webhooks: the event row is written **in the same D1 batch** as the change (`emitStatement`, src/lib/webhooks.ts):
`order.created` (orders/create), `order.paid` (payments.markPaid), `order.cancelled` (orders/state.transitionOrder),
`shipment.updated` (delivery/service.transition). Sent by `deliverDue()` (POST /api/orders via waitUntil, and jobs/run, which
the admin calls every few minutes while open). Request: POST JSON `{ id, event, createdAt, data }`, headers `X-Genzst-Event`,
`X-Genzst-Delivery`, `X-Genzst-Timestamp`, `X-Genzst-Signature: sha256=<hex HMAC-SHA256(endpoint secret, "<timestamp>.<body>")>`.
2xx = delivered, else backoff 2^n min (≤ 6 h), 8 attempts. Payloads hold order numbers, statuses, totals and SKUs only
(no name / phone / address).

| Method & path | Permission | Contract |
|---|---|---|
| `GET /api/admin/stats?range=today\|7d\|30d` | orders.read | `{ kpi:{orders,cancelled,paidOrders,revenue,aov}, now:{pendingPayments,toShip,lowStock,outOfStock,failedShipments,failedWebhooks,draftProducts,unpricedActive}, series[30]:{day,orders,revenue}, latest[10] }`; days are UTC+8 |
| `GET /api/admin/orders/poll` | orders.read | `{ latestId, newCount }` |
| `GET /api/admin/orders?from=&to=` | orders.read | adds a Mongolia-day date range (YYYY-MM-DD, inclusive) |
| `POST /api/admin/orders/{no}/notes { note }` | orders.write | 201 `{ note }`; the order detail adds `notes[]` |
| `GET /api/admin/products?gender=&family=&hasPrice=&hasPhoto=&lowStock=&sort=` | catalog.read | gender/family `none` = NULL; sort default, name, brand, updated, created |
| `GET /api/admin/products/facets` | catalog.read | `{ brands[], families[], counts }` |
| `POST /api/admin/products/bulk { ids ≤ 100, action }` | catalog.write | action activate, hide, draft, or price `{ ml, price, kind? }` (creates the size) |
| `GET /api/admin/inventory?q=&tracked=1&active=1` | catalog.read | search and filters added |
| `POST /api/admin/shipments` | delivery.write | also `{ courier?, fee?, notes?, trackingNo?, trackingUrl? }` |
| `PATCH /api/admin/shipments/{id}` | delivery.write | also `{ courier?, fee?, notes? }`; rows carry `courier, fee, notes` |
| `POST /api/admin/payments/{id}/check` | payments.write | QPay re-check of that payment's order → `{ results, paymentStatus, status }`; 422 not-qpay / not-configured, 502 unreachable |
| `GET /api/admin/webhooks/inbound?provider=&cursor=` | delivery.read | inbound log |
| `POST /api/admin/webhooks/inbound/{id}/replay` | delivery.write | re-applies a signed call (de-duplicated by event id); unsigned → 409 |
| `GET/POST /api/admin/webhooks/endpoints` | settings.read / settings.write | POST `{ url (https), events[], description? }` → 201 `{ endpoint, secret }` (the secret is shown once, never listed) |
| `PATCH/DELETE /api/admin/webhooks/endpoints/{id}` | settings.write | |
| `POST /api/admin/webhooks/endpoints/{id}/test` | settings.write | signed `ping`, sent now → `{ delivery:{status,httpStatus,error} }` |
| `GET /api/admin/webhooks/deliveries?endpoint=&status=` | settings.read | outbound log |
| `POST /api/admin/webhooks/deliveries/{id}` | settings.write | send again now |
| `POST /api/admin/jobs/run` | orders.write | also sends due webhooks and prunes logs older than 90 days → `{ …, webhooks:{delivered,failed} }` |
| `GET /api/store/info` (public) | — | `{ contact, notice }`, max-age 60 |
| `GET /delguur/p/{id}`, `/en/shop/p/{id}` (public page) | — | on-demand page for D1-only products (active only; built ones 301 to the static page) |

Dev only: `WEBHOOK_ALLOW_LOCAL=1` lets an endpoint be `http://127.0.0.1:port` (tests). Never set it in production.
Tests: `scripts/test-admin-api.mjs` (65 checks), `scripts/test-admin-ui.mjs` (96); screenshots: `scripts/shot-admin.mjs`.

## 9. Bundles (lead, 2026-11-20, migration 0005)

Schema `migrations/0005_bundles.sql` (also seeds the owner's 8 bundles, 99,000₮, `/bundles/1..8.webp`):
- `bundles` — `id` (URL slug, `BUNDLE_ID_RE`), `name_mn`, `name_en`, `description_mn`, `description_en`, `image` (https on the
  `PUBLIC_MEDIA_BASE` host or a site path), `price` (NULL = not for sale), `compare_at` (> price), `status` draft | active | hidden,
  `sort`, timestamps.
- `bundle_items` — `(bundle_id, sku)` primary key, `qty` 1–10 per bundle, `label` (shown while the product is not in the catalog),
  `sort`. No foreign key to `skus`: a bundle may name a size that does not exist yet (the bundle is then not sellable).

Types: `src/lib/bundles/types.ts` (`BundleView`, `BundlePart`, `BundleState`, `bundleLineSku`). Server: `src/lib/bundles/store.ts`
(reads + rule), `admin.ts` (zod + writes), `page.ts` (on-demand page loaders).

**Sellable** (`judge()` in store.ts): checkout open, bundle `active`, `price` set, at least one part, and every part SKU sellable on its
own by `isSellable` (product active, not sale-locked, SKU exists, active, priced). `available` = min over tracked parts of
`floor((stock − reserved) / qty)`; untracked parts do not limit it. `block` (why not): `hidden`, `soon` (no price), `off` (a part cannot
be sold), `out` (a part is short), `closed` (checkout closed).

**Orders:** an item may be `{ bundle: "<id>", qty }` (1–10) next to `{ sku, qty }`. `priceCart` prices it from `bundles.price`
(never the client), sums the units each SKU needs across all lines (bundle parts × qty + plain lines) and checks stock on that total;
`placeOrder` reserves one `reservations` row per SKU in the same D1 batch (so commit on paid, release on cancel/expiry and
restore after paid work unchanged). The stored line (`orders.items_json`) is `{ sku: "bundle:<id>", slug: <id>, brand: "Багц"|"Bundle",
name, ml: total ml, qty, price, tracked, bundle: { id, nameMn, nameEn, parts: [{ sku, slug, brand, name, ml, qty /* per bundle */ }] } }`.
Errors on a bundle line use `sku: "bundle:<id>"` (409 `stock` / `unavailable`). Audit `order.create` and the `order.created` webhook
list `{ sku, qty, price, bundle?, name?, parts?: [{ sku, qty }] }`. The Telegram message lists the bundle and its parts. Customer
lookup and the admin order detail return `bundle` on the line; the packing slip lists every part.

| Method & path | Permission | Contract |
|---|---|---|
| `GET /api/store/bundles?ids=a,b` (public, ≤ 30 ids; no `ids` = every active bundle) | — | `{ ok, checkoutOpen, payments:{qpay,bank}, bundles: BundleState[] }`, `max-age=30`; unknown ids omitted |
| `GET /api/admin/bundles` | catalog.read | `{ ok, items: BundleView[] }` (all statuses) |
| `POST /api/admin/bundles` | catalog.write | `{ id, nameMn, nameEn?, descriptionMn?, descriptionEn?, image?, price, compareAt?, status?, sort?, items:[{ sku, qty?, label? }] }` → 201 `{ bundle }`; 409 `{ id:"taken" }`; 400 codes `required`, `invalid`, `host`, `duplicate`, `compare` |
| `GET / PATCH / DELETE /api/admin/bundles/{id}` | catalog.read / catalog.write | PATCH any create field except `id` (`items` replaces all parts); DELETE removes it (past orders keep their copy). Each write is audit-logged (`bundle.create|update|delete`, entity `bundle`) |
| `POST /api/admin/media` | media.write | also accepts `bundleId` (instead of `productId`) → key `bundles/{id}/front-{sha256-12}.{ext}` |
| `GET /bundles/`, `/bundles/{id}/`, `/en/bundles/…` (pages) | — | rendered on demand from D1 (active bundles only, else 404), `Cache-Control: public, max-age=60`, security headers set by the page |

`wrangler.jsonc` adds the compatibility flag `assets_navigation_has_no_effect`: without it a browser navigation
(`Sec-Fetch-Mode: navigate`) to any on-demand page (`/bundles/…`, and the existing `/delguur/p/{id}`) got the static 404 page.
Tests: `scripts/test-bundles.mjs` (68), bundle blocks in `test-api`, `test-admin-api`, `test-e2e-commerce`; browser + screenshots:
`scripts/shot-bundles.mjs` → `docs/screens/bundles-*`.

## 10. Customer accounts (lead, 2026-11-21, migration 0007)

Replaces the browser-only demo account (`src/lib/account.ts` and its `gz_account` / `gz_orders` localStorage keys are
gone; old keys are simply ignored). Server code: `src/lib/customers/` (`crypto.ts`, `session.ts`, `store.ts`, `google.ts`,
`limits.ts`), routes `src/pages/api/account/**`. Browser: `src/scripts/profile.ts` (the /profile page), `account-api.ts`,
`account-badge.ts`, `wish-sync.ts`, `account-prefill.ts`. Tests: `scripts/test-accounts.mjs` (`npm run test:accounts`).

Schema `migrations/0007_customers.sql`:
- `customers` — `phone` UNIQUE (8 digits, `[6-9]…`; NULL only for a Google sign-up that has not given one yet, and after
  deletion), `name`, `display_name`, `password_hash` / `password_salt` / `password_iter` (NULL = no password, Google only),
  `must_change_password`, `avatar_key`, `show_on_board`, `google_sub` UNIQUE, `email` (from a verified Google ID token only),
  `created_at`, `updated_at`, `deleted_at`.
- `customer_sessions` — `id` = hex SHA-256 of the cookie token, `customer_id`, `created_at`, `expires_at`, `last_seen`,
  `user_agent` (short "Chrome · Android" label).
- `customer_addresses` — `label`, `city` ub | countryside, `district` (UB district id or province), `khoroo`, `address`,
  `is_default` (unique partial index: one default per customer), ≤ 10 per customer.
- `customer_wishlist` — `(customer_id, product_id)` PK, `item_json` (sanitized display copy of the browser wishlist item).
- `orders.customer_id` (nullable).

**Security rules**
- Passwords: PBKDF2-SHA256 via WebCrypto, 100,000 iterations (Workers' maximum), 16-byte random salt, constant-time compare.
  ≥ 8 and ≤ 200 characters; refused when in the common list (`common-passwords.ts`), containing the phone, one repeated
  character or a digit run. Never logged, never returned. An unknown phone still costs one PBKDF2 (no timing oracle).
- Session cookie `__Host-gz_session` = 32 random bytes base64url; `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 days`.
  D1 keeps only its SHA-256. Expiry slides to now + 30 days (and the cookie is re-sent) at most once an hour while used.
  Hint cookie `gz_in=1` (not HttpOnly, no secret) only tells the storefront JS to load the account code.
- CSRF: every POST / PUT / PATCH / DELETE under `/api/account/*` needs `Origin` equal to the request's origin, else
  403 `{ form: "origin" }` (on top of Astro's `checkOrigin`).
- Rate limits (`rate_limits` table): login — failed attempts only, 20 / IP / 10 min and 8 / phone / 15 min (checked before the
  password; 429 `{ form: "rate" }`); register — 5 / IP / hour and 3 / phone / hour; password / phone change / delete —
  10 / customer / 10 min; Google start + callback — 30 / IP / 10 min.
- Login answers the same 401 `{ form: "invalid" }` for an unknown phone, a wrong password and a password-less account.
  Register says 409 `{ phone: "taken" }` (unavoidable; behind Turnstile + limits).
- Customer PII never goes to `audit_log`; the admin reset row is `{ actor, action: "customer.reset_password", entity: "customer", entity_id }`.

**Orders.** `POST /api/orders` reads the session cookie: when signed in, `orders.customer_id` = that customer (anything in
the body is ignored); guests unchanged. At sign-up (and when a Google account first sets its phone) past orders with
`customer_id IS NULL AND phone = <account phone>` (exact) are linked. The phone is **not** SMS-verified, so the account
order list never returns the name, phone or address stored on an order.

| Method & path | Auth | Contract |
|---|---|---|
| `POST /api/account/register` | — | `{ phone, password, name, turnstileToken, website }` → 201 `{ ok, customer, claimed }` + cookies. 422 `{ phone \| name \| password: code, turnstile }` (password codes `short`, `long`, `common`), 409 `{ phone: "taken" }`, 429. |
| `POST /api/account/login` | — | `{ phone, password }` → `{ ok, customer }` + cookies; 401 `{ form: "invalid" }`; 429. |
| `POST /api/account/logout` | — | ends this session, clears cookies → `{ ok }` |
| `POST /api/account/logout-all` | session | ends every session of the customer → `{ ok, ended }` |
| `GET /api/account/me` | — | `{ ok, customer: Customer \| null, google: boolean }` |
| `PATCH /api/account/me` | session | `{ name?, displayName? (≤ 40), showOnBoard?, phone?, password? }` → `{ ok, customer, claimed? }`. Setting a phone when there is none needs nothing; changing it needs `password` (422 `{ password: "wrong" }`); 409 `{ phone: "taken" }`. |
| `POST /api/account/password` | session | `{ current?, next }` (`current` required when a password exists) → `{ ok, ended }`; ends every other session; 422 `{ current: "wrong" }` / `{ next: code }`. |
| `GET /api/account/sessions` | session | `{ items: [{ current, createdAt, lastSeen, expiresAt, device }] }` (no ids) |
| `GET /api/account/avatar` | session | own avatar bytes; `Cache-Control: private, max-age=86400`, `nosniff`, `CSP: default-src 'none'; sandbox`, CORP same-origin; 404 none |
| `POST /api/account/avatar` | session | multipart `file`, jpeg / png / webp by magic bytes, ≤ 2 MB → R2 `MEDIA` `customers/<id>.<ext>` → `{ ok, customer }`; 400 `{ file: "type" }`, 413 `{ file: "too_large" }`. The page crops to a 512 px square (canvas) first. |
| `DELETE /api/account/avatar` | session | `{ ok, customer }` |
| `GET / POST /api/account/addresses` | session | list / create `{ label?, city, district, khoroo?, address, isDefault? }` → 201 `{ address, items }`; first is default; 409 `{ form: "limit" }` |
| `PATCH / DELETE /api/account/addresses/{id}` | session | own rows only (else 404); `isDefault: true` moves the default; deleting the default promotes the oldest |
| `GET /api/account/wishlist` | session | `{ items }` |
| `PUT /api/account/wishlist` | session | `{ mode: "merge" \| "replace", items ≤ 200 }` → `{ items }`. Unsafe / malformed items are dropped (site-path `href`, https or site-path `img`). |
| `GET /api/account/orders` | session | ≤ 100 newest: `{ orderNo, createdAt, status, paymentStatus, payment, subtotal, delivery, total, items[], shipment \| null }` |
| `POST /api/account/delete` | session | `{ password }` (or `{ confirm: true }` without a password) → `{ ok }` + cookies cleared. Row kept as a tombstone with PII emptied (`deleted_at` set, phone / Google id freed); sessions, addresses, wishlist, avatar deleted; orders kept — `done` / `cancelled` ones lose name, phones, address, note, ip; open orders keep them until delivered. |
| `GET /api/account/google/start?mode=login\|link&return=` | — / session for link | 302 to Google; 404 when Google is not configured |
| `GET /api/account/google/callback` | — | 302 to the return path (`/profile/`, `/en/profile/`, checkout pages only) with `?google=ok\|new\|linked\|taken\|cancelled\|error` |
| `POST /api/account/google/unlink` | session | only with phone + password, else 409 `{ form: "no-password" }` |
| `GET /api/admin/customers?q=&cursor=&limit=` | customers.read (owner) | keyset `{ items: [{ id, phone, name, displayName, email, google, hasPassword, mustChangePassword, orders, createdAt, lastSeen, deleted }], nextCursor }` |
| `POST /api/admin/customers/{id}/reset-password` | customers.write (owner) | `{ ok, tempPassword, sessionsEnded }` — shown once; sets `must_change_password`; ends all sessions; audit-logged. 409 `{ form: "no-phone" }` for a phone-less account. Admin UI: `#/customers`. |

`Customer` = `{ id, phone, name, displayName, showOnBoard, avatarUrl, email, google, hasPassword, mustChangePassword, createdAt }`.
New permissions `customers.read`, `customers.write` (owner only).

**Google sign-in (optional).** On only when `GOOGLE_CLIENT_ID` (var) and `GOOGLE_CLIENT_SECRET` (secret) are set. Authorization
code flow with PKCE S256, `scope=openid email profile`, `prompt=select_account`. `state`, code verifier, `nonce`, mode, return
path and expiry live in an HMAC-SHA256-signed (key = client secret), HttpOnly `__Host-gz_goauth` cookie for 10 minutes. The
ID token from `oauth2.googleapis.com/token` is verified with WebCrypto: RS256 signature with the JWKS key of its `kid`
(`www.googleapis.com/oauth2/v3/certs`, cached 1 h, refetched once on an unknown kid), `iss` ∈ {`https://accounts.google.com`,
`accounts.google.com`}, `aud` = client id, `exp`, `iat`, `nonce`. Accounts are found by `sub` only — never merged by e-mail. A
first Google sign-in creates an account without a phone; the profile asks for the phone (needed for delivery). Linking from
the profile needs a session; unlinking needs a phone + password. `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_JWKS_URL`
override the endpoints for tests and are honoured only for requests to localhost.

**Storefront.** `/profile/` loads `profile.ts` (sign-in / register tabs with Turnstile, Google button, forgot-password help
"Утсаар холбогдоно уу"; signed in: profile + avatar crop, orders with live status (re-checked every 60 s), wishlist, addresses,
password, devices / sign out everywhere, Google link, delete). Other pages load account code only when `gz_in=1`: the header
badge (avatar or initial), wishlist sync (merge once per tab session and on sign-in, then replace after each change) and the
checkout prefill (name, phone, default address into empty fields).
