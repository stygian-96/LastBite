-- When a refund run claimed this row. Set while it is with the gateway, so a second run leaves it alone.
ALTER TABLE refunds ADD COLUMN sending_at timestamptz;
CREATE INDEX refunds_to_send_idx ON refunds (created_at) WHERE status = 'pending' AND razorpay_refund_id IS NULL;
