-- How far making this account's linked account has got, so a retry resumes on the same account at
-- Razorpay instead of making another with the vendor's details. razorpay_account_id is set from the
-- first step: only 'done' means it can take transfers.
ALTER TABLE payout_accounts
  ADD COLUMN linked_account_step text NOT NULL DEFAULT 'none'
    CHECK (linked_account_step IN ('none', 'account', 'stakeholder', 'product', 'done')),
  -- The Route product the last step configures. Razorpay has no way to look it up.
  ADD COLUMN linked_product_id text,
  -- Failed tries. At 5 the job stops, until an admin verifies the account again.
  ADD COLUMN linked_account_failures integer NOT NULL DEFAULT 0 CHECK (linked_account_failures >= 0),
  -- Part of the email on the linked account, which Razorpay requires to be unique. Goes up when a bank
  -- change makes a new linked account, and at no other time.
  ADD COLUMN linked_account_generation integer NOT NULL DEFAULT 0 CHECK (linked_account_generation >= 0);

UPDATE payout_accounts SET linked_account_step = 'done' WHERE razorpay_account_id IS NOT NULL;
