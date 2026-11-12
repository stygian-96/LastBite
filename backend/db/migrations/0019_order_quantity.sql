-- A customer can take more than one bag in an order, up to the listing's limit. price_paise and
-- commission_paise stay the order's totals, so payments, payouts and refunds read them as before.
-- Still one order per customer, per outlet, per night.
ALTER TABLE orders ADD COLUMN quantity smallint NOT NULL DEFAULT 1;
ALTER TABLE orders ADD CONSTRAINT orders_quantity_check CHECK (quantity BETWEEN 1 AND 10);

-- The most bags one customer may take of this listing in a night, set by the vendor.
ALTER TABLE listings ADD COLUMN max_per_order smallint NOT NULL DEFAULT 3;
ALTER TABLE listings ADD CONSTRAINT listings_max_per_order_check CHECK (max_per_order BETWEEN 1 AND 10);
