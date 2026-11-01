CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE refunds ADD COLUMN attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN adjusted_payout_id uuid REFERENCES payouts(id);
ALTER TABLE payouts ADD COLUMN tax_paise integer NOT NULL DEFAULT 0;
