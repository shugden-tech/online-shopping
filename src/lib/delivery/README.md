# Delivery module (A3)

The delivery company has **not been chosen yet**. This module has a small adapter interface and two adapters:

| id | What it does |
|---|---|
| `manual` | No API. A new shipment is `pending`. Staff hand the parcel to a courier and set the status and tracking number with `PATCH /api/admin/shipments/{id}`. |
| `mock` | Talks to a delivery API over the HTTP JSON protocol below. `scripts/mock-delivery.mjs` serves this protocol for tests. It is also the template for a real company adapter. |

New shipments use the provider the request names. If it names none, they use the `delivery.provider` store setting (default `manual`).

## Files

| File | Role |
|---|---|
| `types.ts` | `DeliveryAdapter` interface, `DeliveryOrder` (what a provider receives), `DeliveryError` |
| `adapters/manual.ts`, `adapters/mock.ts` | the two adapters |
| `registry.ts` | adapter list, `resolveProvider()` (request → setting) |
| `service.ts` | create, transitions + order side effects, provider call with lease/backoff, PATCH, webhook events, poll |
| `retry.ts` | `retryShipments(env, limit)` (signature frozen in CONTRACTS §4) |
| `signature.ts` | webhook HMAC-SHA256 check (constant time) |
| `validate.ts` | zod schemas for the admin bodies |

## Rules the service follows

- **Create**: the order must be `paid`, with no other shipment that is not `cancelled`. Otherwise the response is 409 (`has-shipment` or `not-paid`). The insert is conditional, so two creates at the same time cannot both succeed.
- **Transitions**: they follow `SHIPMENT_TRANSITIONS`. Each change is a single D1 batch made of:
  1. a conditional `UPDATE … WHERE status = ?from`;
  2. a guard that rolls back the whole batch if that update lost a race;
  3. a `shipment_events` row;
  4. the order side effects;
  5. an `audit_log` row.
- **Order side effects** (each is a conditional update plus an `order_events` row; the actor is `system` or the admin):
  - `created`, `picked_up` or `in_transit` moves the order from `paid` to `shipped`;
  - `delivered` moves it from `shipped` to `done` (and first from `paid` to `shipped` if that step was missed).
- **Provider call**: before calling the provider, the service claims a 5-minute lease in `next_retry_at`. Every call sends an idempotency key: `shipment-{id}`, or `shipment-{id}-after-{oldRef}` when a parcel is re-sent after a delivery failure.
  - On success, the shipment goes from `pending` to `created`.
  - On failure, it goes from `pending` to `failed`, `attempts` goes up by 1, and `next_retry_at` is set to now + min(2^attempts minutes, 6 h).
  - There is no automatic retry after 8 attempts, or after an error that cannot be retried (a provider 4xx other than 408 or 429).
- **Retry**: `retryShipments` picks `failed` and `pending` shipments whose `next_retry_at` is due. It moves `failed` back to `pending` and calls the provider again. An admin can always retry a shipment by hand with `POST /api/admin/shipments/{id}/retry`.
- **Webhooks**:
  - De-duplicated by the provider's event id (unique index on `shipment_events`).
  - An event that is out of order or not a valid transition is stored with the note `ignored <status>` and answered with 200. It changes nothing.
  - An event for an unknown shipment gets 404.
- **Privacy**: the provider receives only `reference` (order no), `idempotencyKey`, `recipient {name, phone, phone2}`, `address {city, district, khoroo, line}` and `itemsCount`. It never receives email, prices, the customer's note or the IP address. Logs, `last_error`, `shipment_events` and `audit_log` hold only ids and short error codes (`http_500`, `timeout`, `network`, `bad_response`, `duplicate_ref`, …).

## Mock protocol (v1)

Base URL: `DELIVERY_BASE_URL`. Auth: `Authorization: Bearer DELIVERY_API_KEY`. Bodies are JSON. Shipment statuses are `created | picked_up | in_transit | delivered | failed | cancelled`, the same names as ours.

### `POST /v1/shipments` — create
```json
{ "reference": "GZ-261117-AB3D", "idempotencyKey": "shipment-12",
  "recipient": { "name": "…", "phone": "99112233", "phone2": null },
  "address": { "city": "ub", "district": "bzd", "khoroo": "3", "line": "…" },
  "itemsCount": 3 }
```
- `201 { "id": "MOCK-…", "status": "created", "trackingNo": "TRK…", "trackingUrl": "https://…", "reference": "…" }`
- A repeated `idempotencyKey` returns `200` with the same shipment.
- Errors:
  - `401`: bad key.
  - `422`: invalid body; not retried.
  - `5xx`, `429`, `408`: retried with backoff.

### `GET /v1/shipments/{id}` — track
- `200` with the same shape as create. `404` if the shipment is unknown.

### `POST /v1/shipments/{id}/cancel`
- `200 { …, "status": "cancelled" }`.
- `409` if it was already delivered.
- `404` if the shipment is unknown.

### Webhook (provider → shop): `POST {site}/api/delivery/webhook/mock`
- Headers:
  - `Content-Type: application/json` (required: Astro's origin check rejects body-less or form-type POSTs without `Origin`);
  - `X-Signature: <hex HMAC-SHA256(DELIVERY_WEBHOOK_SECRET, raw body)>` (a `sha256=` prefix is accepted).
- Body: 1–50 events.
  ```json
  { "events": [ { "id": "evt-123", "shipmentId": "MOCK-…", "status": "in_transit", "trackingNo": "optional", "trackingUrl": "optional" } ] }
  ```
- Answers:
  - `200 { ok, results: [{ eventId, result: "applied" | "ignored" | "duplicate" }] }`;
  - `401` bad signature;
  - `400` bad payload;
  - `404` unknown provider or shipment;
  - `503` secret not set.

### Mock-only test controls (`scripts/mock-delivery.mjs`, no auth)
- `POST /__control/fail-create { count, status? }`
- `POST /__control/set-status { id, status }`
- `GET /__control/last-create`
- `GET /__control/stats`
- `POST /__control/reset`

## Adding a delivery company

1. Get the company's API documentation. Do not guess field names.
2. Copy `adapters/mock.ts` to `adapters/<company>.ts` and give it a new `id` that matches `^[a-z0-9_-]{2,32}$`. Then:
   - map our `DeliveryOrder` to their create request;
   - map their status names to `SHIPMENT_STATUSES`;
   - send `idempotencyKey` if they support one (otherwise use `reference` + `idempotencyKey` as their external id);
   - throw a `DeliveryError(code, retryable)` with no response text in the code.
3. Implement `parseWebhook` for their payload, and keep their event id as `eventId`. If they sign webhooks in a different way, ask the lead for a contract change (today's contract is `X-Signature` HMAC-SHA256).
4. Register the adapter in `registry.ts`. Set the secrets with `npx wrangler secret put DELIVERY_BASE_URL` (and `DELIVERY_API_KEY`, `DELIVERY_WEBHOOK_SECRET`). Give the company the webhook URL `https://<site>/api/delivery/webhook/<id>`.
5. Set `delivery.provider` to the new id with `PUT /api/admin/settings` (owner).
6. Run the tests against their sandbox if they have one. Otherwise, extend `scripts/mock-delivery.mjs`.

## Local test run

```bash
# .dev.vars: DELIVERY_BASE_URL=http://127.0.0.1:8893  DELIVERY_API_KEY=test-key  DELIVERY_WEBHOOK_SECRET=<≥16 chars>
node scripts/mock-delivery.mjs > mock.log &
npx wrangler d1 migrations apply genzst --local --persist-to .wrangler/state-a3
npx astro build && npx wrangler dev --port 8793 --persist-to .wrangler/state-a3 > dev.log 2>&1 &
BASE=http://localhost:8793 PERSIST=.wrangler/state-a3 LOG_FILES=dev.log,mock.log node scripts/test-delivery.mjs
```
