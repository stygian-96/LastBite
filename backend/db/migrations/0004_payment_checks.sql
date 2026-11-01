-- When reconcile last asked the gateway about this payment, so it can take the longest-unchecked first.
ALTER TABLE payments ADD COLUMN last_checked_at timestamptz;
