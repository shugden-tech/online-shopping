-- 0008: Wire payment gateway (hosted checkout). Contract: docs/CONTRACTS.md §11.
--   * payments: rebuilt to add 'wire' to the provider CHECK (SQLite cannot ALTER a CHECK). Every row is copied
--     with its id; nothing references payments, so no other table is touched.
--   * wire_events: one row per accepted webhook event id (evt_…), so a redelivery is applied once.

PRAGMA defer_foreign_keys = on;

CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('qpay','bank','wire')),
  provider_ref TEXT,                         -- QPay invoice_id / bank transfer reference / Wire pi_…
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','cancelled','refunded')),
  paid_amount INTEGER,
  provider_payment_id TEXT,                  -- QPay payment_id / Wire ch_… once paid
  data_json TEXT,                            -- provider response (QR, URLs, Wire checkout url); never secrets
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
INSERT INTO payments_new (id, order_id, provider, provider_ref, amount, status, paid_amount, provider_payment_id, data_json,
                          created_at, updated_at, paid_at)
  SELECT id, order_id, provider, provider_ref, amount, status, paid_amount, provider_payment_id, data_json,
         created_at, updated_at, paid_at FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE UNIQUE INDEX idx_payments_provider_ref ON payments(provider, provider_ref);
CREATE UNIQUE INDEX idx_payments_provider_payment ON payments(provider, provider_payment_id);
CREATE INDEX idx_payments_order ON payments(order_id, id);
CREATE INDEX idx_payments_status ON payments(status, id);
CREATE INDEX idx_payments_paid_at ON payments(status, paid_at);

CREATE TABLE wire_events (
  id TEXT PRIMARY KEY,                       -- Wire event id evt_…
  type TEXT NOT NULL,
  object_id TEXT,                            -- data.id (pi_… / re_…)
  result TEXT,                               -- what we did: paid | already | cancelled | failed | pending | ignored | unknown | …
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_wire_events_received ON wire_events(received_at);
