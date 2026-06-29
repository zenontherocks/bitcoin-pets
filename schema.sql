-- Bitcoin Pets Marketplace - D1 Database Schema
-- Listings are imported from pbtmarketplace.com via the sync cron.
-- No user accounts; buyers check out with contact/shipping info only.
-- BTC addresses are derived at order time from BTC_XPUB (Worker secret).
--
-- Safe to re-run: all statements use IF NOT EXISTS / INSERT OR IGNORE.

-- Pets: listings imported from pbtmarketplace.com
CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  pbt_id TEXT NOT NULL UNIQUE,                   -- pbtmarketplace.com listing ID (dedup key)
  pbt_url TEXT NOT NULL,                         -- full URL on PBT (used when purchasing from them)
  name TEXT NOT NULL,
  species TEXT NOT NULL,                         -- 'dog', 'cat', etc. (derived from PBT category)
  breed TEXT,
  date_of_birth TEXT,                            -- ISO 8601, computed from PBT age string at sync time
  weight_lbs REAL,
  gender TEXT CHECK(gender IN ('male', 'female', 'unknown')),
  color TEXT,
  description TEXT,
  health_info TEXT,
  vaccinations TEXT,                             -- formatted text from PBT vaccine records
  registry_name TEXT,
  registry_number TEXT,
  microchip_id TEXT,
  price_usd REAL NOT NULL,                       -- always USD (PBT buy-now price)
  status TEXT NOT NULL DEFAULT 'available'
    CHECK(status IN ('available', 'pending', 'sold', 'ended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pet pictures: one pet can have many photos; one is flagged as primary.
-- url stores PBT S3 URLs directly (public CDN, no proxy needed).
CREATE TABLE IF NOT EXISTS pet_pictures (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders: buyer submits contact info and gets a Bitcoin invoice.
-- The platform pays PBT and ships to the buyer upon payment confirmation.
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
  paid_at     TEXT,
  -- Buyer contact and shipping info (collected at checkout, no account required)
  buyer_name      TEXT NOT NULL,
  buyer_email     TEXT NOT NULL,
  buyer_phone     TEXT NOT NULL,
  buyer_address1  TEXT NOT NULL,
  buyer_address2  TEXT,
  buyer_city      TEXT NOT NULL,
  buyer_state     TEXT NOT NULL,
  buyer_zip       TEXT NOT NULL,
  buyer_country   TEXT NOT NULL DEFAULT 'US'
);

-- Key-value store for worker settings.
-- next_address_index: monotonically increasing BIP32 derivation index for payment addresses.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('next_address_index', '0');
