-- An order can hold several kinds of bag from one outlet, each a line with its own quantity. Still one
-- order per customer, per outlet, per night, with one payment and one pickup code. orders.drop_id stays
-- as the first line, and orders.quantity and price_paise stay the totals of the active lines.
CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id),
  drop_id          uuid NOT NULL REFERENCES drops(id),
  quantity         smallint NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_paise integer NOT NULL CHECK (unit_price_paise > 0),
  -- A line the vendor cancelled while the rest of the order went ahead; it was refunded on its own.
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, drop_id)
);
CREATE INDEX order_items_drop_id_idx ON order_items (drop_id);

INSERT INTO order_items (order_id, drop_id, quantity, unit_price_paise, created_at)
SELECT id, drop_id, quantity, price_paise / quantity, created_at FROM orders;

-- The pickup window of the whole order: the earliest start and latest end of its active lines. A drop's
-- times can't change once anyone has reserved it, so this stays true.
ALTER TABLE orders ADD COLUMN pickup_start_at timestamptz;
ALTER TABLE orders ADD COLUMN pickup_end_at timestamptz;
UPDATE orders o SET pickup_start_at = d.pickup_start_at, pickup_end_at = d.pickup_end_at FROM drops d WHERE d.id = o.drop_id;
ALTER TABLE orders ALTER COLUMN pickup_start_at SET NOT NULL;
ALTER TABLE orders ALTER COLUMN pickup_end_at SET NOT NULL;

-- A cancelled line is refunded on its own, so a payment can carry one such refund per line.
ALTER TABLE refunds ADD COLUMN order_item_id uuid REFERENCES order_items(id);
ALTER TABLE refunds DROP CONSTRAINT refunds_reason_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_reason_check
  CHECK (reason = ANY (ARRAY['vendor_cancelled', 'late_payment', 'duplicate_payment', 'issue_resolution', 'item_cancelled']));
ALTER TABLE refunds ADD CONSTRAINT refunds_item_reason_check CHECK ((reason = 'item_cancelled') = (order_item_id IS NOT NULL));
ALTER TABLE refunds DROP CONSTRAINT refunds_payment_id_reason_key;
CREATE UNIQUE INDEX refunds_payment_id_reason_key ON refunds (payment_id, reason) WHERE order_item_id IS NULL;
CREATE UNIQUE INDEX refunds_order_item_id_key ON refunds (order_item_id) WHERE order_item_id IS NOT NULL;
