CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new',        -- new | confirmed | paid | shipped | done | cancelled
  name TEXT NOT NULL, phone TEXT NOT NULL, phone2 TEXT,
  city TEXT NOT NULL, district TEXT, khoroo TEXT, address TEXT NOT NULL, note TEXT,
  payment TEXT NOT NULL, items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL, delivery INTEGER NOT NULL, total INTEGER NOT NULL,
  locale TEXT NOT NULL, ip TEXT
);
CREATE INDEX idx_orders_created ON orders(created_at);
