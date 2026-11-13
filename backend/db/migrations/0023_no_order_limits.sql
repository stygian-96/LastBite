-- A customer may place as many orders as they like, at any outlet, any night. The only limits left are
-- stock and the vendor's "most bags one customer can take", checked per customer per night in code.
DROP INDEX one_order_per_outlet_night;
DROP INDEX one_hold_per_anon;
ALTER TABLE orders DROP CONSTRAINT orders_quantity_check;
ALTER TABLE orders ADD CONSTRAINT orders_quantity_check CHECK (quantity >= 1);
-- Still found by customer, outlet and night, as the per-customer limit is.
CREATE INDEX orders_user_outlet_night_idx ON orders (user_id, outlet_id, service_date) WHERE user_id IS NOT NULL;
CREATE INDEX orders_anon_held_idx ON orders (anon_id) WHERE user_id IS NULL;
