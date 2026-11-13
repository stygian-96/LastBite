-- A vendor can delete a listing. One never put on sale is removed outright; one with past nights is
-- marked deleted instead, so those nights, their orders and payouts keep their listing.
ALTER TABLE listings ADD COLUMN deleted_at timestamptz;
