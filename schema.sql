-- Bitcoin Pets Marketplace - D1 Database Schema
-- Database: bitcoin-pets (ID: 20b9a4ee-5b6c-4aea-bb78-709b63df26e9)

-- Users: buyers and sellers on the platform
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  country TEXT DEFAULT 'US',
  password_hash TEXT NOT NULL,
  bitcoin_address TEXT,                          -- for receiving payment
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pets: listings for sale, linked back to their owner
CREATE TABLE pets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT NOT NULL,                         -- e.g. dog, cat, bird, reptile
  breed TEXT,
  date_of_birth TEXT,                            -- ISO 8601 date string
  weight_lbs REAL,
  gender TEXT CHECK(gender IN ('male', 'female', 'unknown')),
  color TEXT,
  description TEXT,                              -- free-form seller description
  health_info TEXT,                              -- vet records, conditions, notes
  vaccinations TEXT,                             -- vaccination history / status
  registry_name TEXT,                            -- e.g. AKC, CFA, TICA
  registry_number TEXT,
  microchip_id TEXT,
  price_btc REAL,
  price_usd REAL,                                -- asking price in USD (if seller chose USD anchor)
  price_currency TEXT NOT NULL DEFAULT 'btc'
    CHECK(price_currency IN ('btc', 'usd')),     -- which currency the price is anchored to
  bitcoin_address TEXT,                          -- per-listing receive address (overrides user default)                                -- asking price in BTC
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available', 'pending', 'sold')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pet pictures: one pet can have many photos; one is flagged as primary
CREATE TABLE pet_pictures (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,         -- 1 = primary/thumbnail image
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions: server-side login sessions (30-day expiry)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  pet_id      TEXT NOT NULL REFERENCES pets(id),
  pay_address TEXT NOT NULL,
  amount_btc  REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','paid','expired')),
  tx_id       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  paid_at     TEXT
);
