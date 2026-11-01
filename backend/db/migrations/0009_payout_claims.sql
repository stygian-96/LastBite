-- When a run claimed this payment's transfer, so two runs cannot both send it. A claim that runs out
-- goes again on the same idempotency key.
ALTER TABLE payments ADD COLUMN transfer_claimed_at timestamptz;
CREATE INDEX payments_to_transfer_idx ON payments (created_at)
  WHERE status = 'captured' AND transfer_status = 'none';

-- When a run claimed the creation of this account's linked account. Linked accounts have no
-- idempotency key, so this is what stops two runs making two.
ALTER TABLE payout_accounts ADD COLUMN linked_claimed_at timestamptz;
