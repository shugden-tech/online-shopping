-- 0004: admin rebuild (lead). Additive except the shipments rebuild, which copies every row.
--   * shipments: + 'returned' status, + courier / fee / note (manual delivery details)
--   * order_notes: internal notes on an order (never shown to the customer)
--   * webhook_events: log of every inbound delivery webhook call (payload, result, replay)
--   * webhook_endpoints / webhook_deliveries: the owner's outbound webhooks (outbox + retry with backoff)
--   * indexes for the dashboard aggregates
-- Contract: docs/CONTRACTS.md §8.

PRAGMA defer_foreign_keys = on;

-- ---------- shipments: rebuilt to widen the status CHECK (SQLite cannot ALTER a CHECK) ----------
-- shipment_events references shipments with ON DELETE CASCADE, so it is copied aside first: dropping
-- shipments while it exists would delete its rows.
CREATE TABLE shipment_events_copy AS SELECT * FROM shipment_events;
DROP TABLE shipment_events;

CREATE TABLE shipments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  tracking_no TEXT,
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','created','picked_up','in_transit','delivered','failed','cancelled','returned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  courier TEXT,                              -- free text for manual delivery (who carries it)
  fee INTEGER CHECK (fee IS NULL OR fee >= 0), -- what the shop pays the courier, ₮
  note TEXT                                  -- internal note
);
INSERT INTO shipments_new (id, order_id, provider, provider_ref, tracking_no, tracking_url, status, attempts, last_error,
                           next_retry_at, data_json, created_at, updated_at)
  SELECT id, order_id, provider, provider_ref, tracking_no, tracking_url, status, attempts, last_error,
         next_retry_at, data_json, created_at, updated_at FROM shipments;
DROP TABLE shipments;
ALTER TABLE shipments_new RENAME TO shipments;
CREATE INDEX idx_shipments_order ON shipments(order_id, id);
CREATE INDEX idx_shipments_status ON shipments(status, next_retry_at);
CREATE UNIQUE INDEX idx_shipments_provider_ref ON shipments(provider, provider_ref);

CREATE TABLE shipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  source TEXT NOT NULL,
  external_event_id TEXT,
  note TEXT
);
INSERT INTO shipment_events (id, shipment_id, at, from_status, to_status, source, external_event_id, note)
  SELECT id, shipment_id, at, from_status, to_status, source, external_event_id, note FROM shipment_events_copy;
DROP TABLE shipment_events_copy;
CREATE UNIQUE INDEX idx_shipment_events_external ON shipment_events(shipment_id, external_event_id);

-- ---------- internal order notes ----------
CREATE TABLE order_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX idx_order_notes_order ON order_notes(order_id, id);

-- ---------- inbound delivery webhooks ----------
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  signature_ok INTEGER NOT NULL CHECK (signature_ok IN (0,1)),
  http_status INTEGER NOT NULL,
  event_ids TEXT,                            -- comma separated provider event ids (for search)
  result_json TEXT,                          -- per-event results, or the error code
  payload TEXT,                              -- raw body (≤ 64 KB, kept for replay)
  replayed_at TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_webhook_events_provider ON webhook_events(provider, id);

-- ---------- outbound webhooks (owner integrations) ----------
CREATE TABLE webhook_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,                         -- https only
  description TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',    -- ["order.created","order.paid","order.cancelled","shipment.updated"]
  secret TEXT NOT NULL,                      -- HMAC-SHA256 key, shown once when created
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outbox: one row per (endpoint, event). Written in the same batch as the change that caused it.
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT DEFAULT (datetime('now')),
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, id);

-- ---------- dashboard ----------
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_payments_paid_at ON payments(status, paid_at);
