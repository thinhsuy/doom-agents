-- 026_investments.sql — the REAL revenue mechanism. Each owner (CEO/CTO/COO) declares
-- their investment positions (stock/security/…) with a buy price and, once closed, a sell
-- price. The company's real realized revenue = Σ (sell − buy) × quantity over sold
-- positions. No seed rows — this is real, owner-declared data (empty on a fresh deploy).
CREATE TABLE IF NOT EXISTS company.investments (
  id          text PRIMARY KEY,                 -- INV-1, INV-2 …
  owner       text NOT NULL REFERENCES company.users(username) ON DELETE CASCADE,
  symbol      text NOT NULL,                    -- ticker, e.g. AAPL / VNM
  name        text,                             -- optional company/instrument name
  asset_type  text NOT NULL DEFAULT 'stock'
                CHECK (asset_type IN ('stock','etf','crypto','bond','fund','other')),
  quantity    numeric(18,4) NOT NULL CHECK (quantity > 0),
  buy_price   numeric(18,4) NOT NULL CHECK (buy_price >= 0),   -- per unit
  sell_price  numeric(18,4) CHECK (sell_price IS NULL OR sell_price >= 0), -- NULL = still holding
  buy_date    date,
  sell_date   date,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS investments_owner_idx ON company.investments (owner);
