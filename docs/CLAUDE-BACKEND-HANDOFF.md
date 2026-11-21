# GenZST backend handoff for Claude

Prepared by **Codex, OpenAI's coding assistant**, on 2026-11-17.

## Task

Work in `C:\Users\mtemu\Dev\trying things\genzst`.

Complete the backend of the existing GenZST perfume shop so it is ready for a
verified Cloudflare preview and a later production rollout. Implement and test
the changes; do not stop after writing a plan or producing disconnected examples.
Preserve the existing storefront design and Mongolian/English navigation.

This phase is backend completion and preview verification. Report production
readiness honestly; missing real prices, credentials or business details are
launch blockers, not reasons to fill in fictional values.

## Existing state — inspect again before changing anything

- Astro 5, Preact, TypeScript, Cloudflare Workers adapter and Wrangler.
- `src/pages/api/orders.ts` already validates orders, verifies Turnstile,
  recomputes prices from the product collection, inserts an order in D1 and
  optionally notifies Telegram. Extend/refactor this implementation.
- `migrations/0001_orders.sql` contains the existing orders table.
- The root `wrangler.jsonc` has an all-zero placeholder D1 ID and a Turnstile
  test site key. These are not production configuration.
- Prices/stock currently come from `src/content/products/*.json`; stock is
  checked but not atomically consumed by an order. Some stock/prices are demos.
- `src/lib/account.ts` is explicitly a localStorage demo. Its account and order
  history are not authentication or authoritative purchase records.
- The storefront still needs integration with the new 1,000-product catalog.
- `src/lib/cart.ts` currently retains persisted image URLs only when they start
  with `/`; account for the trusted HTTPS R2 origin when integrating catalog photos.
- The working tree contains uncommitted catalog/migration work. Inspect
  `git status`; preserve it. Do not reset, clean, overwrite or push unrelated work.

Read `package.json`, `astro.config.mjs`, `src/lib/products.ts`, the order schema,
checkout components, migrations and existing checkout tests before implementing.
Treat older handoff/status documents as historical; verify their claims against
current code and the explicit requirements in this handoff.

## Existing catalog and R2 assets — preserve these

Public catalog:

`https://pub-83d529150bc84a489ddcb74b42624830.r2.dev/catalog.json`

Local files:

- `decantx/catalog.json`: public export.
- `decantx/catalog.schema.json`: public catalog schema.
- `decantx/selected-1000.json`: working selection.
- `decantx/catalog-r2-images.json`: internal verified upload mappings.
- `decantx/back-photo-overrides.json`: reviewed bottle-and-box replacement sources.
- `decantx/r2-upload-report.json`: current image totals/missing slots.
- `docs/r2-image-upload.md`: migration workflow and exceptional in-memory relay.

Latest verified totals: 1,000 products, 982 front photos and 1,000 back photos
(1,982 images). The 50 previously missing back photos were visually checked for
the named product and bottle-plus-box presentation, then uploaded and verified.
Eighteen front slots remain null. The other 950 back images were migrated from
the existing data; do not claim that all of those received a new visual audit.

Public records contain exactly:

```text
id, brand, name, concentration, bottle_sizes_ml, release_year,
notes: { top, heart, base }, images: { front, back }
```

Rules:

- Keep IDs, R2 object names, URLs and image associations stable.
- Preserve `decantx/merged.json` and its backups. The proposed folder rename was
  not performed. Do not rename/rewrite them as part of this backend task.
- Do not rename third-party source hosts to GenZST; those strings are historical
  provenance used by internal matching/upload tools.
- The public master catalog must not gain prices, decant sizes, inventory,
  customer data, orders or research/source links.
- `bottle_sizes_ml` means the manufacturer's full retail bottle sizes, never
  the shop's decant options. At the last audit only seven products had confirmed
  sizes; 993 were null. Other metadata also has gaps. Never invent missing facts.
- Keep nulls/empty tiers meaningful. Do not split a flat note list into invented
  top/heart/base notes or substitute an unrelated perfume photo.
- Internal source maps, migration tokens and research files are not public
  catalog assets. Never expose them through an API or static build.
- `genzst-images` is the existing R2 bucket. The image importer is a separate
  Worker under `workers/image-importer/`; it is not the shop backend. Preserve
  those assets and do not rerun the full image migration unnecessarily.

## Required implementation

### 1. Separate catalog facts from commerce data

Use the R2 master catalog for fragrance facts and images. Use D1 for store-owned
offers/SKUs, prices in integer MNT, sellable sizes, publication state, inventory,
customers, orders, payments and admin audit records.

Join through a stable catalog ID. Write an explicit, reviewable mapping from
legacy product slugs; do not fuzzy-match ambiguous perfumes automatically.
Re-running imports must not overwrite owner prices, stock, orders or IDs.

The master catalog's full bottle sizes and the shop's sellable variants are
different concepts. Existing decant sales remain commerce records in D1.
Do not put their 2/5/10/30 ml options back into the public perfume catalog.

Browsing 1,000 catalog entries does not mean all 1,000 are purchasable. Offers
without owner-confirmed prices/stock stay unpublished or unavailable. Keep demo
data out of production commerce seeds. Do not reuse USD-converted placeholders
as verified selling prices.

Create a catalog/commerce adapter for the existing UI and filters. Some fields
required by the old Astro product schema are absent from the master catalog;
preserve reliable existing enrichment or handle unknowns explicitly rather
than assigning every unknown product a fictional gender/family/description.

Validate fetched catalog data, use timeouts/caching and an explicit fallback
policy. Do not fetch the whole master catalog repeatedly for every cart line.
Prices and inventory must reflect D1 changes without a site rebuild. Never
silently accept stale commerce prices when the authoritative database fails.

### 2. Database and migrations

Design additive, indexed D1 migrations for the minimum complete commerce model:
offers, inventory/reservations, orders, line-item snapshots, payment records,
idempotency, customer sessions where needed, and owner audit events.

Preserve existing orders. Test on a local/preview database first. Keep preview
and production bindings distinct; do not reset a remote database. Provide
repeatable seed/import commands and backup/restore instructions.

### 3. Correct order and inventory behavior

- Validate server-side: product/offer identity, publication state, size, integer
  quantity, availability, customer/address fields and supported payment methods.
- Bound actual request-body reads, not only the Content-Length header.
- Ignore client prices/totals and recompute prices, delivery and totals on the server.
- Use an atomic, D1-supported strategy for order creation and stock reservation.
  A read-then-write check does not prevent overselling. A zero-row conditional
  update is not itself a SQL error: ensure a failed stock condition cannot leave
  a partial order or consume another item's stock.
- Define inventory units explicitly. If decants share a bulk perfume supply,
  reserve the total millilitres across sizes; do not create independent stock
  pools that oversell the same bottle. Prepacked retail SKUs may use unit counts.
- Persist idempotency keys and request fingerprints. Double clicks, retries and
  parallel submissions must return the same order without duplicate reservations.
  Reusing a key with different data must be rejected.
- Store immutable line-item price/name/size snapshots so later catalog edits do
  not rewrite order history.
- Define valid order/payment transitions. Cancellation, expiration and restocking
  must be consistent and run once, including under repeated requests.
- Configure an unpaid-reservation expiry policy. Do not reserve stock forever or
  silently choose a final business policy without documenting it for the owner.

Cloudflare documents transactional D1 batches here:
https://developers.cloudflare.com/d1/worker-api/d1-database/
Verify current platform behavior before relying on transaction syntax or features.

### 4. Payment behavior

Implement a real manual bank-transfer path and protected owner confirmation.
Do not mark an order paid from a browser redirect, client flag, uploaded receipt
alone, or the mere creation of an invoice.

If QPay credentials and merchant details are available, implement the real
server-side integration: invoice persistence, verified callback/status checks,
amount/currency/order matching, idempotency, expiry and duplicate-event handling.
Use current official QPay documentation. If credentials are absent, keep the
unconfigured automatic QPay path disabled and list the exact blocker. Do not
present a mock invoice or payment confirmation as a working integration.

### 5. Customer and owner access

Guest checkout may remain available. Replace any account/order-history features
that are presented as real with server-backed functionality and real sessions;
localStorage is not an authentication or order-ownership boundary.

Choose and explain a minimal, established Workers-compatible authentication
approach. Use secure HttpOnly cookies, expiry/revocation and appropriate CSRF
protection. Never store passwords/tokens in localStorage or write custom crypto.
Do not pretend that an SMS/email OTP was delivered without a configured provider.
Missing provider-dependent functionality must be explicit and disabled safely.

Order history belongs to the authenticated user ID. Knowing a phone number or
an order number is not sufficient to retrieve someone's address or order history;
do not automatically attach guest orders by matching an unverified phone number.

Provide an owner-only admin interface/API for:

- Publishing offers and managing real prices, sellable sizes and stock.
- Viewing/paginating/filtering orders and inspecting their line items.
- Confirming manual payments and updating allowed fulfillment states.
- Cancelling orders/restocking according to the defined policy.
- Recording who changed prices, stock, payment and order state.

Cloudflare Access is a suitable owner-access option if configured, but protect
the backend as well. Validate its JWT signature, issuer, audience and expiry;
do not trust a submitted email/role/header alone. See:
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

Unconfigured admin authentication must fail closed. Test-only bypasses must not
be usable in production or through the public workers.dev origin.

### 6. Abuse prevention and operational behavior

- Use real production Turnstile keys and server-side verification. Validate the
  expected hostname/action where applicable. Handle expired/replayed tokens and
  retries without duplicating orders. Production must reject test credentials.
  Reference: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Use shared/persistent rate limiting for sensitive endpoints, including failed
  attempts. An isolate-local map or counting only successful orders is insufficient.
- Keep personal/order data private; use no-store responses where appropriate.
- Use prepared statements, safe error responses and structured logs without
  passwords, tokens, full payment credentials or unnecessary customer details.
- Keep secrets in appropriate local ignored files/Cloudflare secrets. Never
  print, commit, include in client bundles or publish existing migration tokens.
- Telegram notification failure must not undo a saved order or make a retry
  create a second one. Implement an appropriate retry/outbox mechanism.
- Add useful health/readiness checks that reveal no secrets or private data.

### 7. Integrate and verify the real storefront

Connect shop pages, product pages, cart, checkout, success page, account/order
history and owner admin to the backend. An API that the frontend never calls
does not complete this task.

Preserve the current visual design, responsive layout and Mongolian/English
routes. Add only the UI needed for real backend behavior. Handle missing front
photos by using an available back photo or the existing honest fallback. Preserve
trusted R2 cart image URLs after refresh. Do not expose private admin data through
public catalog endpoints.

## Acceptance checks — demonstrate these, do not merely list them

1. Catalog integration loads all 1,000 identities and the correct image URLs.
2. Only configured/published offers with real stock/prices can be purchased.
3. Client price/total tampering does not change the server-calculated amount.
4. Two simultaneous orders for the last available inventory cannot oversell it.
   Include a cross-size shared-stock case if the shop sells poured decants.
5. An invalid line causes no partial order or stock deduction.
6. Repeated/parallel submissions with the same idempotency key create one order;
   mismatched payloads are rejected.
7. A database failure or payment-provider timeout produces a recoverable result
   without orphaned reservations, duplicate orders or false paid status.
8. Unpaid expiry/cancellation releases reservations once; retries do not add stock twice.
9. Payment status cannot be forged; duplicate provider events are safe when QPay is enabled.
10. Unauthenticated/forged owner requests and cross-customer order access are rejected.
11. Cart refresh, checkout, server-confirmed success and order history work on
    mobile and desktop, in Mongolian and English.
12. The actual Cloudflare preview uses its real D1 binding and passes a test
    order flow. Distinguish local mocks from remotely verified behavior.

Run `npm.cmd run check` and `npm.cmd run build` on Windows, meaningful backend
integration tests and the relevant existing E2E checks. Update old tests where
the implementation intentionally changes; preserve their security coverage.
Never run synthetic tests against real paid orders or trigger real charges.

## Work process and final deliverables

Start with a concise audit of current gaps and the implementation approach.
Ask one bundled set of genuinely necessary owner questions (real prices/stock,
bank details, delivery policy, authentication/provider choices, domain/credentials).
Continue independent implementation while waiting. Do not ask the owner to choose
routine code structure or reconfirm every file change.

Use current official Cloudflare documentation for deployment/runtime decisions.
Prefer the existing Cloudflare stack and available free allowances. Do not
silently add paid services, activate paid plans, or claim unlimited free hosting.

Deliver working code, migrations, seed/import tooling, a verified preview when
credentials permit, and an updated backend/deployment handoff. Include:

- What works end to end and which checks actually passed.
- Database/API/auth/inventory/payment design and important tradeoffs.
- Exact local/preview run commands and required environment variable names.
- Remaining owner-supplied configuration and precise launch blockers.
- Production migration/deployment order, backup/restore and rollback steps.

Finish with a clear distinction between implemented/tested features, configured
integrations, and remaining blockers. Do not label unfinished mocks as production-ready.
