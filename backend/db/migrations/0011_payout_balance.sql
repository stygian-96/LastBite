-- Which payout's approval released this transfer, so an approval can tell the money it moved from
-- what had moved before it, and a retry sees the same balance as the first try.
ALTER TABLE payments ADD COLUMN released_payout_id uuid REFERENCES payouts(id);

-- Why an admin holds this payout. Null on a payout held for its account or for a negative net.
ALTER TABLE payouts ADD COLUMN hold_reason text;
