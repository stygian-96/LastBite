-- A refund the gateway definitely refused waits until this time before its next attempt, so a
-- passing refusal cannot use up every attempt in three ticks.
ALTER TABLE refunds ADD COLUMN retry_at timestamptz;
