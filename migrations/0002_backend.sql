-- 0002: backend hardening (additive only; 0001 is unchanged).
--   * orders: idempotency key, updated_at
--   * order_events: status history (who changed what, when)
--   * inventory: optional server-side price/stock overrides per product size (EMPTY by default)
--   * rate_limits: atomic fixed-window counters

ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN updated_at TEXT;
UPDATE orders SET updated_at = created_at WHERE updated_at IS NULL;
-- NULLs never collide in a SQLite UNIQUE index, so old orders without a key are fine.
CREATE UNIQUE INDEX idx_orders_idempotency ON orders(idempotency_key);
CREATE INDEX idx_orders_status ON orders(status, id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  from_status TEXT,                 -- NULL for the "created" event
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,              -- 'customer' | 'admin'
  note TEXT
);
CREATE INDEX idx_order_events_order ON order_events(order_id, id);
-- history for orders placed before this migration
INSERT INTO order_events (order_id, at, from_status, to_status, actor, note)
  SELECT id, created_at, NULL, status, 'customer', 'backfilled by 0002' FROM orders;

-- One row per product size the owner wants to manage on the server. product_id = the product slug
-- (catalog id), ml = the size. A NULL column means "use the build-time value from the product JSON".
-- The CHECK on stock is what makes the order-time decrement atomic: an UPDATE that would take stock
-- below zero fails the whole D1 batch, so no order row and no partial decrement are written.
CREATE TABLE inventory (
  product_id TEXT NOT NULL,
  ml INTEGER NOT NULL,
  price INTEGER CONSTRAINT inventory_price_positive CHECK (price IS NULL OR price > 0),
  stock INTEGER CONSTRAINT inventory_stock_nonnegative CHECK (stock IS NULL OR stock >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, ml)
);

-- Fixed-window counters, one row per scope+client. Updated with a single upsert ... RETURNING.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,             -- e.g. 'order:203.0.113.5'
  window_start INTEGER NOT NULL,    -- unix seconds, start of the current window
  count INTEGER NOT NULL
);
