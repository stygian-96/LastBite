-- Whether this refund asks the gateway to reverse the payment's transfer. Fixed when the refund is
-- created, so one idempotency key always carries one payload.
ALTER TABLE refunds ADD COLUMN reverse_transfer boolean NOT NULL DEFAULT false;
