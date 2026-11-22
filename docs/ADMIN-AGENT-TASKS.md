# GenZST implementation task packets

Status: planned, not assigned or executed. Date: 2026-11-17.

The product plan and acceptance criteria are in `docs/ADMIN-COMMERCE-PLAN.mn.md`.
Copy the common instructions plus exactly one packet into the chosen agent.
Names such as Claude and Devin describe possible assignees, not active integrations.

## Common instructions — include with every packet

```text
Work on GenZST, the existing Astro/Preact/TypeScript Cloudflare perfume shop.
Read docs/ADMIN-COMMERCE-PLAN.mn.md first, then inspect the CURRENT code, git
status and any applicable AGENTS.md. Treat old handoff documents as historical.
Implement your assigned module completely against the frozen A0 contracts.
Do not redesign the existing storefront or substitute a disconnected demo.

Use a separate branch/worktree from the agreed integration baseline. Preserve
uncommitted user work, existing catalog identities and R2 mappings. Never reset,
clean, overwrite unrelated work, mass re-upload media, expose tokens, or push/
deploy production as an assumed part of this packet.

A0/integrator owns migrations, shared contracts/auth/settings/jobs infrastructure,
root runtime config and dependency/lockfile changes. Request changes through the
integrator; do not independently create competing schemas or endpoint DTOs.
Every module must enforce backend permissions, schema validation, idempotency
where relevant, optimistic concurrency for edits, and safe private responses.

Catalog facts and mutable edits are authoritative in D1 after the validated
initial R2 import; R2 catalog JSON becomes a versioned facts-only export. Keep
commerce/customer/internal provenance out of that public master snapshot.
Public shop endpoints may return selling prices and safe availability.
Preserve null metadata and stable IDs. Never invent facts, images, owner prices,
stock, provider endpoints, payment confirmations or successful deliveries.

Tests may use explicit fixtures in local/isolated preview. UI fixture work is
not completion until connected to real backend endpoints. Unconfigured payment
or delivery providers stay disabled with precise blockers. Do not create real
charges or shipment bookings without a separately agreed controlled test.

Use npm.cmd on Windows. Run relevant checks and meaningful module integration
tests; distinguish local, remote preview and provider verification. End with:
changed files; migrations/config requested; contracts used; tests and evidence;
remaining blockers; exact run commands; handoff notes for the next agent.
Never call mocks or unverified integrations production-ready.
```

## A0 — architecture, database, auth and integration foundation

Suggested first assignee: Claude/backend lead. This packet starts first.

```text
Audit src/pages/admin.astro, src/pages/api/**, src/lib/server.ts, products.ts,
order-schema.ts, account.ts, checkout/cart, astro.config.mjs, migrations,
wrangler.jsonc, existing test scripts, catalog schema and export/import tools.

Produce and then implement the shared foundation:
1. Canonical entity relationships, SQL migrations/backfill, inventory accounting,
   order/payment/fulfillment transition and permission matrices.
2. docs/commerce-api.openapi.yaml plus shared validated server DTOs and safe
   client types. Freeze paths, IDs, envelopes, version conflicts, pagination,
   idempotency fingerprints and public/private projections before parallel work.
3. Cloudflare Access JWT verification + app roles, request context, admin actor,
   CSRF/Origin protection, fail-closed behavior, alternate-origin protection,
   streamed request-size limits and shared rate limiting.
4. D1 repositories/transaction strategy, outbox/inbox primitives, leased job
   processing infrastructure and scheduled runtime entrypoint wiring. Prove a
   failed inventory guard cannot leave partial writes, including zero-row cases.
5. Additive migration preserving legacy orders and catalog identity. Report how
   legacy paid/shipped/done data maps without fabricating provider verification.
   Maintain explicit reviewed legacy slug-to-catalog mappings.
6. Typed settings, feature toggles, audit interface, media storage interface,
   separate preview/production config and secret variable NAMES only.
7. Define module ownership and an integration baseline commit. Provide runnable
   local test setup and fixtures, not just interface declarations.

Coordinate stock model with A1/A2: available = on_hand - reserved - allocated;
reserve on order, allocate on verified payment, consume once on physical handover.
Choose a D1-supported strategy and test concurrency, rollback and missing rows.
Keep direct provider calls outside database transactions. Validate live official
platform docs before relying on runtime features. No paid service activation.

Acceptance: migration upgrade on existing fixture data plus clean DB passes;
auth and role bypass tests fail correctly; OpenAPI/type validation passes;
core transaction/idempotency/job tests pass; A1-A5 can build against one contract.
Deliver a short contract freeze and ownership note before other agents mutate
shared files. Shared changes later require coordinated contract revision.
```

## A1 — catalog, product management, media, offers and inventory

Start after A0 contract freeze. Own catalog/media/offer/stock service files and
their APIs/import-export tooling. Do not edit admin or storefront UI.

```text
Implement persistent perfume CRUD, translations, taxonomies, draft preview,
publish/hide/archive, per-product and SKU sales locks, redirects, search and
pagination using A0 schema/contracts. Permit multiple full-bottle SKUs plus
decants. Support optional unknown fields rather than manufacturing metadata.

Implement validated image uploads to R2: front/back/gallery, signature/type/size
and dimension checks, metadata stripping, safe encoding, immutable keys,
reference protection and authorized upload completion. Private documents must
not enter the public media namespace. Do not enable arbitrary server URL fetches.

Import the existing 1,000 catalog identities and correct image mappings with a
dry-run report and stable explicit legacy mapping. Reimports must not overwrite
owner edits, selling prices or stock. Revise fixed-count public catalog schema
with versioning so admin can add product 1,001. Export facts-only snapshots via
outbox/revision with failure visibility, never a second mutable source of truth.

Implement D1 offers/prices, unit and shared-ml stock pools, stock movements,
low-stock queries, receipts/adjustments and conversion from bulk to prepacked.
Coordinate reservation/allocated accounting with A2; do not independently create
a conflicting ledger. Protect reserved/allocated stock from destructive edits.
Audit price/publication/media/stock changes and enforce expectedVersion.

Acceptance: CRUD->upload->publish reads correctly through public projection;
hidden/locked direct-order validation has shared guards; import is repeatable;
IDs/images preserved; missing metadata remains honest; stock adjustment and
packing cannot duplicate inventory; stale edits conflict; R2 failure is recoverable.
```

## A2 — checkout, order lifecycle, inventory reservations and payments

Own order/payment/reservation services, APIs, expiry/payment reconciliation jobs
and their tests. Use A0 primitives; coordinate stock mutations with A1.

```text
Replace build-time commerce fallback with authoritative D1 quote/order creation.
Validate current publication/locks/settings/offer revisions and all address,
quantity, price, delivery and payment-method rules server-side. Detect stale
quote totals and return a recoverable requote before charging a different total.

Atomically create order snapshots + all stock reservations + event/outbox.
Require scoped idempotency keys plus canonical payload fingerprints; parallel
same-key submits converge, changed payload returns conflict. Test last-stock
and cross-size shared ml orders, mixed valid/invalid lines, deleted inventory
rows, price changes, DB failures and double cancellations.

Implement independent order/payment/fulfillment state guards; unpaid expiry,
verified payment allocation, late payment review and pre/post-handover cancel
semantics. A shipment handover uses a shared idempotent consume action, not a
second implementation of inventory deduction. Refunds do not imply restocking.

Implement real manual-bank instructions and finance-only confirmation with
amount/reference validation and duplicate protection. QPay integration must use
the merchant product's current official docs and actual sandbox credentials.
Persist invoice/payment IDs, amount/currency, expiry, QR/deeplink and verification
events. Call server-side provider checks; redirects/receipt images/client flags
alone must never mark paid. Handle duplicate/out-of-order callback, timeouts,
late payment after expiry, partial/overpayment, cancellation and supported refund.
If credentials are missing, disable QPay initiation and report the exact blocker.
Toggle-off prevents new initiation but preserves in-flight callback/reconcile.

Implement guest order-scoped access issuance/hash verification and safe tracking
responses under A0 auth policy. Never expose history by phone suffix alone or
attach guest orders to an unverified phone. Use recoverable invoice/job errors.

Acceptance: meaningful local D1 concurrency/integration tests plus configured
provider sandbox flow; paid and stock state independently verified. Document
policy defaults awaiting owner confirmation and all unverified provider paths.
```

## A3 — delivery company integration and operational jobs

Suggested assignee: Devin/integration agent. Own shipping service/adapters,
shipping APIs/jobs/tests. Depends on A0 and A2 payment/stock transition contract.

```text
Obtain the chosen delivery company's official docs and account capability list.
Do not guess the company or fabricate URLs, payloads or tracking responses.
Implement createShipment/findByMerchantReference/getStatus/cancelShipment,
optional quote/label, and capability flags against the real provider API.
While provider details are absent, implement the common shipping workflow and
explicit manual export/tracking path; keep automatic dispatch unavailable.

Dispatch requires backend fulfillment permission, a paid ready order, valid
address/pickup/package details and no live shipment. Persist a unique dispatch
job before the network call; reuse its merchant reference for retries. Record
provider request result separately from shipment business status.

Handle double click, timeout after remote success, duplicate and out-of-order
events, signed/verified callbacks where supported, polling fallback, retry
backoff, lease expiry, failed-job review and manual reconciliation. If the
provider lacks idempotency AND lookup, do not blindly retry create after an
unknown outcome: require reconciliation. Do not promise exactly-once networking.

Implement tracking, cancellation/return/address correction, safe errors and
redacted logs; labels/customer documents private. On physical handover invoke
A2/A0 shared stock consume transition once. Accepted booking is not handover
unless the actual provider status explicitly represents it. COD stays disabled.

Acceptance: sandbox or agreed controlled booking produces one shipment and
real tracking; timeout/retry/webhook tests show no duplicate booking; manual
mode is distinctly labeled. Report account/docs blockers honestly.
```

## A4 — admin interface and dashboard

Suggested assignee: Devin/frontend agent. Own admin pages/components/styles and
admin-specific typed API client. Do not rewrite backend schemas or storefront.

```text
Build a responsive Mongolian admin using the existing design language and A0
contracts: dashboard, orders/details/timeline, perfume editor, translations,
front/back/gallery uploads, SKU/price controls, inventory movements, payments,
delivery queue/detail, shop toggles, staff/permissions and audit views.

Wire every mutation to real backend endpoints. A fixture client is acceptable
only during parallel UI development and must be replaced before acceptance.
No localStorage account/auth imitation, hardcoded dashboard sales or fake saved
forms. Secrets are write-only operational configuration outside client bundles;
UI shows configured/disabled/error status, never returns existing secret values.

Provide draft/preview/publish, hide vs sales lock, separate payment/checkout
toggles, version-conflict recovery, loading/empty/error states, pagination and
filters. Forms preserve user input on failed save and show field errors.
Render role-appropriate actions and handle server forbidden responses. Dangerous
actions show affected order/amount/product and require reason where specified.

Dashboard aggregates paid/refunded/net collected separately and uses Ulaanbaatar
date boundaries. Surface low stock, overdue reservations, payment-review and
shipping-reconcile queues; no invented revenue/profit. Allow owner to see what
integration is unconfigured and the concrete next operational step.

Acceptance: mobile/desktop browser paths with real APIs for create product ->
upload -> publish -> price/stock -> order -> bank confirm -> dispatch/review;
hide/lock/toggle paths, role denial, stale edit and failed network verified.
```

## A5 — storefront, cart, checkout, success and secure tracking

Own public storefront routes/views/islands/cart adapters and MN/EN strings.
Coordinate backend contract changes through A0/A1/A2, not parallel schema edits.

```text
Keep the existing public design while connecting listing/filter/detail/related
products, cart, checkout, success and tracking to D1-backed commerce contracts.
Newly published product slugs must work without rebuilding static route lists.
Preserve MN/EN URL structure, redirects, safe SEO/sitemap behavior and honest
unknown metadata. Hidden products must not leak through public search/detail/API.

Persist safe trusted R2 image URLs through cart refresh. Revalidate current
offers, prices, quantities, sold-out and sales-lock states when opening cart and
checkout. On stale quote ask the customer to accept updated totals. Server remains
authoritative. UI respects checkout/payment toggles and explains temporary closure.

Implement bank instructions and configured QPay QR/deeplink/invoice expiry,
payment check and polling as supported by the backend. Order created is distinct
from payment confirmed. Recover after lost response, page refresh or provider
timeout without duplicate order/invoice. Handle disabled QPay honestly.

Replace demo account/history presentation with secure server-backed tracking.
Guest access uses A0/A2 token/session flow; never treat localStorage as ownership.
Real customer accounts are a separate dependency on configured identity/session
services. If absent, use guest checkout/tracking and remove misleading demo claims.

Acceptance: MN/EN mobile/desktop browse -> add -> refresh -> quote -> order ->
bank/QPay pending -> server-confirmed payment -> shipment tracking works; hidden,
locked, sold-out, backend error and price-change states are tested.
```

## A6 — integration, independent verification and release readiness

Start after modules are merged onto the integration branch. Own integration
fixes, cross-module tests and release runbook; coordinate shared file changes.

```text
Do not accept individual agent summaries as verification. Inspect and run the
integrated app and execute all acceptance checks in section 14 of the product
plan. Check OpenAPI vs actual endpoints and remove remaining fixture clients.

Test with clean and upgraded D1 data, concurrency, cross-size shared stock,
idempotency fingerprint mismatches, toggle races, partial failures, late payment,
duplicate provider events, dispatch timeout and handover/cancel/return accounting.
Verify Access JWT signature/issuer/audience/expiry, app roles, alternate origin,
CSRF, guest ownership, stream limits, rate limits, private media and log redaction.
Inspect public bundles/catalog endpoints for secrets, private files and demo data.

Run npm.cmd run check and npm.cmd run build plus relevant existing scripts and
new meaningful backend/E2E checks. Verify real Cloudflare preview bindings and
configured provider sandbox behavior. Do not run charge/booking tests against
production without the separate controlled-test agreement.

Deliver reproducible evidence with environment and result for each acceptance
row, a backup/restore rehearsal, migration/deployment/rollback sequence, exact
commands and required secret NAMES, monitoring/reconciliation checklist and
remaining owner configuration. Production remains a separate release gate.
Mark each feature as implemented/local-tested/preview-tested/provider-verified/
blocked; do not label disabled automatic integrations fully complete.
```

## Integration rules and first assignment

1. Resolve the owner's provider/payment/hide-lock answers in the product plan.
   Credentials and final commercial policy may remain explicit launch blockers.
2. Give A0 the common instructions and A0 packet. Finish the contract freeze.
3. Give A1-A5 only their packet + common instructions + the same baseline commit
   and contracts. Agents can operate sequentially if only one tool is available.
4. Integrator reviews and merges small module changes in dependency order,
   resolving contract changes centrally; no direct work on the same shared tree.
5. A6 validates the complete flow, then owner configuration and release gates.

If an older all-in-one backend handoff is already assigned to another agent,
reconcile ownership before assigning overlapping packets. Do not let it and
A0/A1/A2 concurrently modify the same schemas and routes.
