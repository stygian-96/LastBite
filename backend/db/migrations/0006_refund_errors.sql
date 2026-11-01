-- Sends with an unclear result, which never move a refund to a new key.
ALTER TABLE refunds ADD COLUMN send_errors smallint NOT NULL DEFAULT 0;
-- Gateway IDs already counted as failed, so a late report of one is known and not redelivered for ever.
ALTER TABLE refunds ADD COLUMN failed_razorpay_ids text[] NOT NULL DEFAULT '{}';
-- When the sweep last asked the gateway about this refund, so it can take the longest-unchecked first.
ALTER TABLE refunds ADD COLUMN last_checked_at timestamptz;
CREATE INDEX refunds_to_check_idx ON refunds (last_checked_at) WHERE status = 'pending' AND razorpay_refund_id IS NOT NULL;
