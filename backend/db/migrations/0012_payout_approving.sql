-- Set while an approval is under way. It stays through a failure, so that payout must be retried
-- before any other on the account: two approvals at once would reverse the same excess twice.
ALTER TABLE payouts ADD COLUMN approving_at timestamptz;
CREATE UNIQUE INDEX one_approval_per_account ON payouts (payout_account_id) WHERE approving_at IS NOT NULL;
