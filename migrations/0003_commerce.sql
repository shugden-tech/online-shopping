-- 0003: commerce core (FROZEN by A0 — change only through the lead agent, as a new migration).
-- Catalog + offers (SKUs) + inventory with reservations, payments, shipments, store settings, audit log.
-- Contract: docs/CONTRACTS.md. Types: src/lib/contracts.ts.
--
-- Money is INTEGER MNT (₮). Times are ISO-8601 UTC text (datetime('now') format: 'YYYY-MM-DD HH:MM:SS').
-- Nothing here invents a price or stock figure: a SKU with price NULL is not sellable.

-- ---------- catalog ----------
CREATE TABLE products (
  id TEXT PRIMARY KEY,                       -- catalog id / URL slug, e.g. 'mugler-alien-edp' (never renamed)
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  concentration TEXT,                        -- 'EDP' | 'EDT' | 'Parfum' | 'Extrait' | 'Cologne' | NULL
  gender TEXT CHECK (gender IS NULL OR gender IN ('women','men','unisex')),
  family TEXT,                               -- scent family id (src/lib/families) or NULL
  release_year INTEGER,
  notes_json TEXT NOT NULL DEFAULT '{"top":[],"heart":[],"base":[]}',
  description_mn TEXT,
  description_en TEXT,
  image_front TEXT,                          -- https URL (R2 public host) or site path, or NULL
  image_back TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','hidden')),
  sale_locked INTEGER NOT NULL DEFAULT 0 CHECK (sale_locked IN (0,1)),  -- visible but cannot be bought
  sort INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'admin',      -- 'r2-catalog' | 'content' | 'admin'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_status ON products(status, sort, id);
CREATE INDEX idx_products_brand ON products(brand);

-- One offer per product size. id = '<product_id>:<ml>'.
-- available = stock - reserved when stock IS NOT NULL; stock NULL = not tracked (unlimited).
-- The CHECKs make reservation atomic: an UPDATE that would over-reserve fails the whole D1 batch.
CREATE TABLE skus (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ml INTEGER NOT NULL CHECK (ml > 0 AND ml <= 1000),
  kind TEXT NOT NULL CHECK (kind IN ('decant','full')),
  price INTEGER CHECK (price IS NULL OR price > 0),
  compare_at INTEGER CHECK (compare_at IS NULL OR compare_at > 0),
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (stock IS NULL OR reserved <= stock),
  UNIQUE (product_id, ml)
);
CREATE INDEX idx_skus_product ON skus(product_id);

-- Every stock change, for the admin history and for reconciling.
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  delta INTEGER NOT NULL,                    -- change to `stock` (reservations do not appear here)
  reason TEXT NOT NULL CHECK (reason IN ('restock','correction','sale','cancel_after_paid','import')),
  order_id INTEGER REFERENCES orders(id),
  actor TEXT NOT NULL,                       -- 'admin:owner' | 'admin:staff' | 'system'
  note TEXT
);
CREATE INDEX idx_stock_movements_sku ON stock_movements(sku_id, id);

-- The 0002 per-size overrides are replaced by skus (the table was never used in production).
DROP TABLE inventory;

-- ---------- orders ----------
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid','pending','paid','refunded'));
ALTER TABLE orders ADD COLUMN hold_expires_at TEXT;   -- reservations are released after this (status 'new' only)
ALTER TABLE orders ADD COLUMN cancel_reason TEXT;     -- 'customer' | 'admin' | 'expired' | 'payment_failed' | free text
CREATE INDEX idx_orders_hold ON orders(status, hold_expires_at);

-- Stock held for an order. held -> committed (payment confirmed) | released (cancel / expiry).
CREATE TABLE reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  tracked INTEGER NOT NULL CHECK (tracked IN (0,1)),  -- 1 = skus.reserved was incremented
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','committed','released')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, sku_id)
);
CREATE INDEX idx_reservations_status ON reservations(status, order_id);

-- ---------- payments ----------
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('qpay','bank')),
  provider_ref TEXT,                         -- QPay invoice_id / bank transfer reference
  amount INTEGER NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','cancelled','refunded')),
  paid_amount INTEGER,
  provider_payment_id TEXT,                  -- QPay payment_id once paid
  data_json TEXT,                            -- provider response (QR, URLs); never secrets
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE UNIQUE INDEX idx_payments_provider_ref ON payments(provider, provider_ref);
CREATE UNIQUE INDEX idx_payments_provider_payment ON payments(provider, provider_payment_id);
CREATE INDEX idx_payments_order ON payments(order_id, id);
CREATE INDEX idx_payments_status ON payments(status, id);

-- ---------- delivery ----------
CREATE TABLE shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                    -- 'manual' | 'mock' | a real company adapter id
  provider_ref TEXT,                         -- the company's shipment id
  tracking_no TEXT,
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','created','picked_up','in_transit','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_shipments_order ON shipments(order_id, id);
CREATE INDEX idx_shipments_status ON shipments(status, next_retry_at);
CREATE UNIQUE INDEX idx_shipments_provider_ref ON shipments(provider, provider_ref);

CREATE TABLE shipment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  source TEXT NOT NULL,                      -- 'admin' | 'webhook' | 'poll' | 'system'
  external_event_id TEXT,                    -- for webhook de-duplication
  note TEXT
);
CREATE UNIQUE INDEX idx_shipment_events_external ON shipment_events(shipment_id, external_event_id);

-- ---------- store controls & audit ----------
CREATE TABLE store_settings (
  key TEXT PRIMARY KEY,                      -- see SETTINGS in src/lib/contracts.ts
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,                       -- 'admin:owner' | 'admin:staff' | 'system' | 'customer'
  action TEXT NOT NULL,                      -- e.g. 'product.update', 'sku.price', 'order.status', 'settings.update'
  entity TEXT NOT NULL,                      -- 'product' | 'sku' | 'order' | 'payment' | 'shipment' | 'settings'
  entity_id TEXT,
  data_json TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id, id);
CREATE INDEX idx_audit_at ON audit_log(id);
