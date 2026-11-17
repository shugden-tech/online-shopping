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
