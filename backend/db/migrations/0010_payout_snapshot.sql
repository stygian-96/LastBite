-- How much of this payment's transfer was reversed to settle a payout's negative adjustment. What
-- the vendor receives is transfer_paise less this.
ALTER TABLE payments ADD COLUMN reversed_paise integer NOT NULL DEFAULT 0 CHECK (reversed_paise >= 0);

-- The payout account that sold this order. A franchise that changes hands leaves its unpaid orders
-- with the old account, so payouts and transfers read this, not the outlet's current account.
ALTER TABLE orders ADD COLUMN payout_account_id uuid REFERENCES payout_accounts(id);
UPDATE orders o
   SET payout_account_id = outlets.payout_account_id
  FROM outlets
 WHERE outlets.id = o.outlet_id;
CREATE INDEX orders_unpaid_by_account_idx ON orders (payout_account_id) WHERE payout_id IS NULL;
