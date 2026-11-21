-- 0006: real customer accounts (replaces the browser-only demo account).
-- Login = Mongolian phone (8 digits) + password (PBKDF2-SHA256), or optional Google sign-in.
-- Sessions: only the SHA-256 of the random cookie token is stored. Contract: docs/CONTRACTS.md §10.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 8-digit Mongolian mobile. NULL only for a Google sign-up that has not given a phone yet (and after deletion).
  phone TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  -- NULL for a Google-only account that never set a password.
  password_hash TEXT,
  password_salt TEXT,
  password_iter INTEGER,
  -- 1 after an admin reset: the profile asks the customer to choose a new password.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  avatar_key TEXT,
  show_on_board INTEGER NOT NULL DEFAULT 0 CHECK (show_on_board IN (0, 1)),
  -- Google account id (`sub` of the verified ID token). Never matched by e-mail.
  google_sub TEXT UNIQUE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- set when the customer deleted the account; the row stays (orders reference it) with PII removed
  deleted_at TEXT
);

CREATE TABLE customer_sessions (
  id TEXT PRIMARY KEY,                       -- hex SHA-256 of the cookie token (the token itself is never stored)
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                  -- sliding: pushed to now + 30 days while the session is used
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent TEXT                            -- short browser label for the sessions list (<= 120 chars)
);
CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX idx_customer_sessions_expires ON customer_sessions(expires_at);

CREATE TABLE customer_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  label TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'ub' CHECK (city IN ('ub', 'countryside')),
  district TEXT NOT NULL DEFAULT '',         -- UB district id, or the province name for countryside
  khoroo TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);
-- at most one default address per customer
CREATE UNIQUE INDEX idx_customer_addresses_default ON customer_addresses(customer_id) WHERE is_default = 1;

CREATE TABLE customer_wishlist (
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL,
  item_json TEXT NOT NULL,                   -- sanitized copy of the browser wishlist item (display data only)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, product_id)
);

-- orders placed while signed in (the id comes from the session cookie, never from the request body), and past
-- guest orders claimed at sign-up when the order phone equals the account phone
ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
