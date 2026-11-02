# LastBite backend implementation doc

Status: draft for review. No code has been written yet.
Date: 1 Nov 2026

## 1. What we are building

A website where bakeries, cafés and restaurants in Bengaluru and Hyderabad sell tonight's surplus food. Customers reserve and pay online, then collect in person with a pickup code. There is no delivery.

The design calls the product Saanjh and this folder calls it LastBite. Code uses neutral names, so the brand can be decided later.

### What is in the MVP

- Vendor onboarding with admin review
- Listings and nightly quantities
- Browse by city and area
- Phone OTP sign-in
- 5-minute hold, online payment, pickup code
- Vendor order handling and code check
- Automatic refunds when a vendor cancels
- Weekly payouts and statements
- WhatsApp and SMS notifications
- Follow an outlet
- Report a problem and admin resolution

### What is deliberately out

| Left out | Why | What replaces it |
|---|---|---|
| Maps, coordinates, distance | You asked for links only | `maps_url` on each outlet opens Google Maps |
| Waitlist | Adds a second queue and hold flow | Sold out state only |
| Cart, more than one bag per order | Agreed in the design review | One bag per order, per outlet, per night |
| Coupons, referrals, wallet | Not needed to prove demand | Nothing |
| Customer cancellation after payment | Matches the agreed refund rules | Missed pickup is forfeited |
| Native apps, push notifications | Website-only MVP | WhatsApp, then SMS |
| Automatic document checks | Too few vendors to justify it | Admin reviews by hand |

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | One language across backend and website |
| Backend | Hono on Node, in `backend/` | A separate, small API service that any frontend can call |
| Frontend | Next.js, in `frontend/`, built later | Website, vendor and admin screens, separate from the API |
| Database | PostgreSQL, Mumbai region | Row locks and constraints protect stock and money |
| ORM | Drizzle | Plain SQL when we need it, such as the hold query |
| Files | Private S3-compatible bucket | Documents stay private, served by short-lived signed links |
| Payments | Razorpay Checkout and Route | UPI, cards and netbanking, plus money split to vendors |
| OTP SMS | DLT-registered SMS provider | Required for transactional SMS in India |
| WhatsApp | WhatsApp Business provider | Template messages from the design |
| Jobs | One cron call every minute to a protected endpoint | No queue system to run |

Hosting: the backend needs a Node host with a Mumbai region, and Supabase can provide Postgres, storage and cron. The frontend deploys on its own, such as on Vercel. Nothing in this design depends on these hosts.

The two services share cookies by running on subdomains of one domain, such as `api.` and `www.`. The API allows only the frontend's origin, with credentials.

We use our own OTP and session tables, not a hosted auth product. It is about two small tables, and customers, vendor staff and admins all share one phone-based identity.

## 3. Core concepts

| Term | Meaning | Example |
|---|---|---|
| Brand | The name customers recognise | Butterfold Bakehouse |
| Outlet | One physical branch. This is the unit that sells | Butterfold, Indiranagar |
| Payout account | The legal entity that gets paid: PAN and bank | Ananya Rao, or a franchisee's company |
| Listing | A reusable product definition at one outlet | Bakery Surprise Bag, ₹149 |
| Drop | One listing on sale on one night, with a quantity | Tonight's Bakery Surprise Bag, 6 bags |
| Order | One customer's reservation of one drop | Order with code K472 |

Splitting listing from drop is the key modelling choice. Editing a listing never changes what an existing customer bought, because each drop keeps its own copy of the name, price and dietary details.

## 4. How multiple branches work

```text
Brand ──┬── Outlet (Indiranagar) ──┐
        ├── Outlet (Koramangala) ──┼── Payout account A (owner's PAN and bank)
        ├── Outlet (Madhapur) ─────┘
        └── Outlet (Whitefield) ────── Payout account B (franchisee's PAN and bank)
```

### What belongs where

| Data | Lives on | Why |
|---|---|---|
| Name, logo | Brand | Same everywhere |
| Address, hours, pickup instructions, maps link | Outlet | Different at each branch |
| FSSAI number and expiry | Outlet | Licences are tied to the premises |
| GSTIN | Outlet | GST registration is per state, so one PAN can have several GSTINs |
| Listings, drops, orders, follows, ratings | Outlet | Each branch has its own stock and service |
| PAN, bank account, agreement, payouts | Payout account | These belong to whoever legally gets paid |
| Commission rate | Outlet | Lets us give one branch a pilot rate |

### Common situations

| Situation | How it is set up |
|---|---|
| One owner, many branches, one bank account | One brand, one payout account, many outlets |
| Franchise, each branch has its own company | One brand, one payout account per franchisee |
| Same brand in Bengaluru and Hyderabad | Two outlets, same PAN, a different GSTIN on each |
| Same owner, two different brands | Two brands, each with its own payout account |
| Staff member works at two branches | Two membership rows |
| National chain with many stores | Admin seed script from a spreadsheet, not 16 trips through the form |

### Roles

| Role | Scope | Can do |
|---|---|---|
| Owner | Whole brand | Everything, including adding outlets and managing staff |
| Manager | One outlet, or the brand | Listings, quantities, orders, earnings |
| Counter | One outlet | Check codes, mark collected or no-show, cancel an order |
| Admin | Whole platform | Review, suspend, refund, run payouts |

A franchisee is a manager scoped to their outlets and can see earnings only for the payout account linked to their membership. The brand owner can see outlet sales but not a franchisee's bank details.

### Adding a second outlet

1. The owner taps Add outlet and the brand is prefilled.
2. They choose an existing payout account or add a new one.
3. They enter address, hours, maps link, photos, FSSAI and GSTIN.
4. Listings can be copied from another outlet. Copies are independent rows.
5. Admin reviews only the new items. A new payout account also needs a signed agreement.

### Customer view

- Browse shows outlets and drops, never a merged brand.
- Each card shows the brand and the area, such as "Butterfold · Indiranagar".
- Outlet pages have their own link: `/{city}/{brandSlug}/{outletSlug}`.
- Follow applies to one outlet, because people care about the branch near them.
- Ratings apply to one outlet, because a bad branch should not damage the others.

## 5. Database design

Rules used in every table:

- Primary keys are UUIDs unless stated.
- Money is stored as integer paise. Never use floats.
- Timestamps are `timestamptz` in UTC and shown in IST.
- `service_date` is the IST calendar date of a drop's pickup start.
- Status columns are `text` with a `CHECK`, so adding a state is an easy migration.

### 5.1 People and access

```sql
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             text NOT NULL UNIQUE,          -- E.164, +91...
  name              text,
  email             text,
  is_admin          boolean NOT NULL DEFAULT false,
  whatsapp_opt_in   boolean NOT NULL DEFAULT true,
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_codes (phone, created_at DESC);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 5.2 Brands, outlets and staff

```sql
CREATE TABLE areas (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city  text NOT NULL CHECK (city IN ('bengaluru','hyderabad')),
  name  text NOT NULL,
  UNIQUE (city, name)
);

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  logo_key    text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payout_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid NOT NULL REFERENCES brands(id),
  legal_name           text NOT NULL,
  pan_encrypted        bytea NOT NULL,
  pan_last4            text NOT NULL,
  holder_name          text NOT NULL,
  account_encrypted    bytea NOT NULL,
  account_last4        text NOT NULL,
  ifsc                 text NOT NULL,
  razorpay_account_id  text UNIQUE,                -- Route linked account
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','verified','rejected','on_hold')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outlets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid NOT NULL REFERENCES brands(id),
  payout_account_id    uuid REFERENCES payout_accounts(id),  -- null while in draft
  area_id              uuid REFERENCES areas(id),
  branch_name          text NOT NULL,                        -- "Indiranagar"
  slug                 text NOT NULL,
  category             text NOT NULL CHECK (category IN
                       ('bakery','cafe','restaurant','sweets','kitchen')),
  address              text,
  pincode              text,
  maps_url             text,
  contact_phone        text,
  pickup_instructions  text,
  opening_hours        jsonb,        -- {"mon":[["08:00","22:00"]], ...}
  photo_keys           text[] NOT NULL DEFAULT '{}',
  fssai_number         text,
  fssai_expires_on     date,
  gstin                text,
  commission_bps       integer NOT NULL DEFAULT 2000,        -- 20.00%, sample rate
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','in_review','changes_needed','live','suspended','closed')),
  onboarding_step      smallint NOT NULL DEFAULT 1,
  paused_until         timestamptz,                          -- holiday closure
  pause_reason         text,
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, slug)
);
CREATE INDEX ON outlets (area_id) WHERE status = 'live';
CREATE INDEX ON outlets (status, submitted_at);
CREATE INDEX ON outlets (fssai_number);                       -- duplicate check, not unique

CREATE TABLE memberships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  brand_id           uuid NOT NULL REFERENCES brands(id),
  outlet_id          uuid REFERENCES outlets(id),            -- null means whole brand
  payout_account_id  uuid REFERENCES payout_accounts(id),    -- franchisee's earnings
  role               text NOT NULL CHECK (role IN ('owner','manager','counter')),
  removed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON memberships (user_id, brand_id, coalesce(outlet_id::text, 'all'))
  WHERE removed_at IS NULL;

CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id          uuid REFERENCES outlets(id),            -- FSSAI, GST
  payout_account_id  uuid REFERENCES payout_accounts(id),    -- PAN, bank proof
  kind               text NOT NULL CHECK (kind IN ('fssai','pan','gst','bank_proof')),
  file_key           text NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','replaced')),
  rejection_reason   text,
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((outlet_id IS NOT NULL) <> (payout_account_id IS NOT NULL))
);

CREATE TABLE agreements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_account_id  uuid NOT NULL REFERENCES payout_accounts(id),
  version            text NOT NULL,
  signed_name        text NOT NULL,
  signed_by          uuid NOT NULL REFERENCES users(id),
  ip_address         inet NOT NULL,
  signed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_account_id, version)
);
```

### 5.3 Listings and drops

```sql
CREATE TABLE listings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id         uuid NOT NULL REFERENCES outlets(id),
  type              text NOT NULL CHECK (type IN ('surprise_bag','fixed_box')),
  name              text NOT NULL,
  description       text NOT NULL,
  food_category     text NOT NULL CHECK (food_category IN
                    ('bakery','cafe','meals','desserts')),
  diet              text NOT NULL CHECK (diet IN ('veg','egg','nonveg','mixed')),
  allergens         text[] NOT NULL DEFAULT '{}',
  value_paise       integer NOT NULL CHECK (value_paise > 0),
  price_paise       integer NOT NULL CHECK (price_paise > 0),
  default_quantity  integer NOT NULL CHECK (default_quantity > 0),
  pickup_start      time NOT NULL,
  pickup_end        time NOT NULL,                 -- earlier than start means next day
  repeat_days       smallint[] NOT NULL DEFAULT '{}',  -- 1 = Mon ... 7 = Sun
  photo_key         text,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (price_paise <= value_paise)
);

CREATE TABLE drops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       uuid NOT NULL REFERENCES listings(id),
  outlet_id        uuid NOT NULL REFERENCES outlets(id),
  service_date     date NOT NULL,
  quantity         integer NOT NULL CHECK (quantity >= 0),
  reserved_count   integer NOT NULL DEFAULT 0,     -- held + paid + collected + no_show
  status           text NOT NULL DEFAULT 'live'
                   CHECK (status IN ('live','paused','cancelled')),
  -- copied from the listing when the drop is created
  name             text NOT NULL,
  description      text NOT NULL,
  type             text NOT NULL,
  food_category    text NOT NULL,
  diet             text NOT NULL,
  allergens        text[] NOT NULL,
  value_paise      integer NOT NULL,
  price_paise      integer NOT NULL,
  photo_key        text,
  pickup_start_at  timestamptz NOT NULL,
  pickup_end_at    timestamptz NOT NULL,
  sales_end_at     timestamptz NOT NULL,           -- pickup_end_at minus 15 minutes
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, service_date),
  CHECK (reserved_count >= 0 AND reserved_count <= quantity),
  CHECK (pickup_end_at > pickup_start_at)
);
CREATE INDEX ON drops (service_date, status);
CREATE INDEX ON drops (outlet_id, service_date);
```

The `CHECK (reserved_count <= quantity)` is the final protection against overselling. Even a bug in application code cannot store more reservations than stock.

### 5.4 Orders and money

```sql
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigserial UNIQUE,              -- shown as SJ-20481
  user_id           uuid REFERENCES users(id),     -- null until OTP is verified
  anon_id           text,                          -- signed cookie for signed-out holds
  drop_id           uuid NOT NULL REFERENCES drops(id),
  outlet_id         uuid NOT NULL REFERENCES outlets(id),
  service_date      date NOT NULL,
  status            text NOT NULL DEFAULT 'held' CHECK (status IN
                    ('held','expired','paid','collected','no_show','cancelled')),
  price_paise       integer NOT NULL,
  commission_bps    integer NOT NULL,
  commission_paise  integer NOT NULL,
  tax_paise         integer NOT NULL DEFAULT 0,    -- see section 12
  pickup_code       text,
  hold_expires_at   timestamptz NOT NULL,
  allergen_ack_at   timestamptz,
  paid_at           timestamptz,
  collected_at      timestamptz,
  collected_by      uuid REFERENCES users(id),
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  cancel_reason     text,
  rating            smallint CHECK (rating BETWEEN 1 AND 5),
  payout_id         uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- One bag per customer, per outlet, per night
CREATE UNIQUE INDEX one_order_per_outlet_night
  ON orders (user_id, outlet_id, service_date)
  WHERE user_id IS NOT NULL AND status IN ('held','paid','collected','no_show');
-- A pickup code is unique within one outlet and night
CREATE UNIQUE INDEX pickup_code_per_outlet_night
  ON orders (outlet_id, service_date, pickup_code)
  WHERE pickup_code IS NOT NULL;
CREATE INDEX ON orders (user_id, created_at DESC);
CREATE INDEX ON orders (drop_id, status);
CREATE INDEX ON orders (status, hold_expires_at) WHERE status = 'held';

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id),
  razorpay_order_id     text NOT NULL UNIQUE,
  razorpay_payment_id   text UNIQUE,
  status                text NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','captured','failed')),
  amount_paise          integer NOT NULL,
  fee_paise             integer,
  method                text,
  razorpay_transfer_id  text UNIQUE,
  transfer_paise        integer,
  transfer_status       text NOT NULL DEFAULT 'none' CHECK (transfer_status IN
                        ('none','on_hold','released','reversed')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (order_id);

CREATE TABLE refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id),
  payment_id          uuid NOT NULL REFERENCES payments(id),
  amount_paise        integer NOT NULL CHECK (amount_paise > 0),
  reason              text NOT NULL CHECK (reason IN ('vendor_cancelled',
                      'late_payment','duplicate_payment','issue_resolution')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processed','failed')),
  razorpay_refund_id  text UNIQUE,
  charged_to          text NOT NULL CHECK (charged_to IN ('vendor','platform')),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, reason)
);

CREATE TABLE payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_account_id  uuid NOT NULL REFERENCES payout_accounts(id),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  gross_paise        integer NOT NULL,
  commission_paise   integer NOT NULL,
  fees_paise         integer NOT NULL,
  adjustment_paise   integer NOT NULL DEFAULT 0,   -- refunds after an earlier payout
  net_paise          integer NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','held','released','paid')),
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_account_id, period_start)
);
ALTER TABLE orders ADD FOREIGN KEY (payout_id) REFERENCES payouts(id);
```

### 5.5 Everything else

```sql
CREATE TABLE follows (
  user_id     uuid NOT NULL REFERENCES users(id),
  outlet_id   uuid NOT NULL REFERENCES outlets(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, outlet_id)
);
CREATE INDEX ON follows (outlet_id);

CREATE TABLE issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (reason IN
               ('bag_not_ready','quality','allergen','code_rejected','other')),
  description  text,
  photo_key    text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution   text,
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key   text NOT NULL UNIQUE,   -- e.g. reminder:{order_id}
  phone        text NOT NULL,
  template     text NOT NULL,
  variables    jsonb NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('whatsapp','sms')),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','failed')),
  attempts     smallint NOT NULL DEFAULT 0,
  provider_id  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (status, created_at) WHERE status = 'pending';

CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,       -- x-razorpay-event-id
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,         -- dropped in 5.6: only IDs are kept
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,           -- 'outlet.approved', 'refund.created'
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 5.6 Additions from implementation planning

```sql
CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE refunds ADD COLUMN attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN adjusted_payout_id uuid REFERENCES payouts(id);
ALTER TABLE payouts ADD COLUMN tax_paise integer NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN last_checked_at timestamptz;
ALTER TABLE refunds ADD COLUMN sending_at timestamptz;
ALTER TABLE refunds ADD COLUMN send_errors smallint NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN failed_razorpay_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE refunds ADD COLUMN last_checked_at timestamptz;
ALTER TABLE refunds ADD COLUMN reverse_transfer boolean NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN transfer_claimed_at timestamptz;
ALTER TABLE payout_accounts ADD COLUMN linked_claimed_at timestamptz;
ALTER TABLE payments ADD COLUMN reversed_paise integer NOT NULL DEFAULT 0 CHECK (reversed_paise >= 0);
ALTER TABLE orders ADD COLUMN payout_account_id uuid REFERENCES payout_accounts(id);
ALTER TABLE payments ADD COLUMN released_payout_id uuid REFERENCES payouts(id);
ALTER TABLE payouts ADD COLUMN hold_reason text;
ALTER TABLE payouts ADD COLUMN approving_at timestamptz;
CREATE UNIQUE INDEX one_approval_per_account ON payouts (payout_account_id) WHERE approving_at IS NOT NULL;
CREATE UNIQUE INDEX one_hold_per_anon ON orders (anon_id) WHERE status = 'held' AND user_id IS NULL;
ALTER TABLE notifications ADD COLUMN sending_at timestamptz;

CREATE TABLE job_runs (
  name         text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL
);

ALTER TABLE payout_accounts
  ADD COLUMN linked_account_step text NOT NULL DEFAULT 'none'
    CHECK (linked_account_step IN ('none', 'account', 'stakeholder', 'product', 'done')),
  ADD COLUMN linked_product_id text,
  ADD COLUMN linked_account_failures integer NOT NULL DEFAULT 0 CHECK (linked_account_failures >= 0),
  ADD COLUMN linked_account_generation integer NOT NULL DEFAULT 0 CHECK (linked_account_generation >= 0);

ALTER TABLE refunds ADD COLUMN retry_at timestamptz;
ALTER TABLE outlets ADD COLUMN changes_reason text;
ALTER TABLE webhook_events ADD COLUMN subject_id text;
ALTER TABLE webhook_events DROP COLUMN payload;
```

Indexes for the jobs' queues are also added: `refunds_to_send_idx`, `refunds_to_check_idx`, `payments_to_transfer_idx` and `orders_unpaid_by_account_idx`.

- `rate_limits` gives shared counters across serverless instances.
- `refunds.attempts` supports alerting after 3 failures.
- `refunds.adjusted_payout_id` stops a refund being deducted twice.
- `payouts.tax_paise` keeps tax withheld separate from gateway fees.
- `payments.last_checked_at` lets reconciliation take the longest-unchecked payment first.
- `refunds.sending_at` marks a refund claimed by a run, so two runs cannot both send it.
- `refunds.send_errors` counts sends with an unclear result, which keep their idempotency key.
- `refunds.failed_razorpay_ids` remembers gateway IDs counted as failed, so a late report of one is not redelivered.
- `refunds.last_checked_at` lets the refund job ask the gateway about the longest-unchecked sent refund first.
- `refunds.reverse_transfer` is set at creation and can change only while the refund is unsent, so one idempotency key always carries one payload. It is true for a vendor-charged refund of the whole remainder of a payment while the transfer is on hold. A released transfer is deducted from the next payout instead.
- `payments.transfer_claimed_at` marks a transfer claimed by a run, so two runs cannot both send it. A claim that runs out goes again on the same idempotency key.
- `payout_accounts.linked_claimed_at` does the same for creating a linked account, which has no idempotency key.
- `payments.reversed_paise` is how much of a transfer was reversed to settle a payout's negative adjustment, so a retry never reverses twice.
- `payments.released_payout_id` is the payout whose approval released the transfer, so an approval can tell what it moved, and a retry sees the same balance.
- `payouts.hold_reason` says why an admin holds a payout. It is null on one held for its account or a negative net.
- `payouts.approving_at` marks an approval under way. Only one runs per payout account, and it stays marked through a failure, so that payout must be retried before any other on the account.
- `orders.payout_account_id` is the account that sold the order. Payouts and transfers read it, so a franchise that changes hands leaves its unpaid orders with the old account.
- `one_hold_per_anon` allows one active hold per signed-out browser.
- `notifications.sending_at` marks a message claimed by a send run, as `refunds.sending_at` does.
- `job_runs` records when each job last ran, so the tick knows what is due.
- `payout_accounts.linked_account_step` and `linked_product_id` record how far making the Razorpay linked account has got, so a retry resumes on the same account. `linked_account_failures` stops the job at 5 for an admin, and `linked_account_generation` goes up on a bank change, giving the new linked account a new unique email.
- `refunds.retry_at` spaces attempts after a definite refusal at least 15 minutes apart.
- `outlets.changes_reason` is the admin's reason for `changes_needed`, shown as a fix until the vendor submits again.
- `webhook_events` keeps the event ID, type and the payment, refund or transfer ID only. The body holds customer details and nothing reads it again.

## 6. State machines

### Outlet

```text
draft -> in_review -> live -> suspended -> live
              |   ^           |
              v   |           v
       changes_needed      closed
```

- `closed` is permanent, and history stays.
- Holiday closure is not a status. It sets `paused_until`, so the outlet returns on its own.

### Order

```text
held -> paid -> collected
  |       |---> no_show
  |       '---> cancelled (refund starts)
  v
expired
```

- Failed payment keeps the order in `held` so the customer can retry until the hold ends.
- Stock returns only on `expired` and `cancelled`. `reserved_count` goes down in the same transaction.
- A refund for a food problem does not change the order status. It is recorded in `refunds`.

## 7. The critical flows

### 7.1 Reserve

Runs on tapping Reserve, before sign-in, so OTP uses the same 5 minutes.

```sql
BEGIN;
UPDATE drops d
SET reserved_count = reserved_count + 1
FROM outlets o
WHERE d.id = $1
  AND o.id = d.outlet_id
  AND d.status = 'live'
  AND o.status = 'live'
  AND (o.paused_until IS NULL OR o.paused_until < now())
  AND d.sales_end_at > now()
  AND d.reserved_count < d.quantity
RETURNING d.*;
-- no row returned: respond 409 sold_out
INSERT INTO orders (...) VALUES (..., 'held', now() + interval '5 minutes');
COMMIT;
```

The single conditional `UPDATE` is what prevents overselling. Two people cannot both take the last bag, because the second update sees the new count and matches nothing.

Signed-out customers get a signed `anon_id` cookie, limited to 1 active hold per `anon_id` and 5 holds an hour per IP. On OTP success, the order gets its `user_id`. If that breaks the one-per-night rule, the hold is released and the customer sees their existing order.

### 7.2 Pay

1. Client calls `POST /orders/:id/pay`, with the allergen acknowledgement for that order. The customer must be signed in by now, so every paid order has a `user_id`.
2. Server confirms the hold is active and creates a Razorpay order for the snapshot price. A retry after a failed payment reuses the same Razorpay order.
3. Checkout opens with its timeout set to the seconds left on the hold.
4. Browser callback only moves the customer to a "confirming" screen. It never marks an order paid.
5. The `payment.captured` webhook marks the order paid.

Webhook handling:

1. Verify `X-Razorpay-Signature` against the raw body.
2. Insert into `webhook_events`. If the `event_id` already exists, return 200 and stop.
3. Fetch the payment from Razorpay and check status and amount.
4. In one transaction, lock the order, then apply the outcome below.
5. Return 200. Notifications go through the `notifications` table, so a slow provider cannot cause Razorpay retries.

| Order state when payment is captured | Outcome |
|---|---|
| `held` | Mark `paid`, generate code, create the held transfer, queue confirmation |
| `paid`, same payment | Nothing, it's a duplicate |
| `paid`, different payment | Full refund, reason `duplicate_payment` |
| `expired`, stock still available | Take stock again, mark `paid` |
| `expired`, sold out, sales ended, or customer already has a newer order there | Full refund, reason `late_payment`, tell the customer |
| `cancelled` | Full refund |

A reconciliation job also polls Razorpay for orders that have a payment record and are still `held` near expiry, in case a webhook is delayed. It then checks `expired` and `cancelled` orders whose payment record from the last 3 days isn't captured, in case every webhook was lost, and applies the table above.

### 7.3 Pickup

- Code format is one letter plus three digits, such as K472, skipping I and O. It is generated at payment and retried on a unique clash.
- The vendor enters the code, and the lookup is limited to that outlet's drops whose pickup end plus 30 minutes is still ahead. It never uses today's calendar date, because windows can pass midnight.
- Collection uses `UPDATE orders SET status='collected' WHERE ... AND status='paid'`, so two staff tapping at once cannot both succeed.
- Staff can also search tonight's orders by customer name if the code is unreadable.
- The code is also in the WhatsApp confirmation, so a weak network on the website doesn't block pickup.

### 7.4 Vendor cancels

1. Vendor picks an order, or the whole drop, and a reason.
2. Orders move to `cancelled`, stock is released, and refunds are created in the same transaction.
3. A job sends refunds to Razorpay, reversing the held transfer.
4. The customer gets the cancellation message right away.

### 7.5 Nightly drop creation

- At 5:00 pm IST, the job messages each outlet that has a listing repeating today.
- "Same as usual" creates drops at `default_quantity`.
- "Set numbers" opens the Today screen.
- No reply means no drop that night. We never publish stock that nobody confirmed.

### 7.6 Weekly payout

Sales close Sunday night IST and payouts run on Tuesday, matching the agreement screen.

1. Monday job groups `collected` and `no_show` orders per payout account into a `draft` payout.
2. Admin reviews totals and approves. Automation can come later.
3. The system settles any negative adjustment by reversing part of the held transfers, largest first, then releases them, so the money that moves equals the payout net. If they cannot cover it, the payout stays `held` and carries forward.
4. Statements become downloadable.

```text
Vendor net = order price - commission - payment gateway fee - tax withheld
Payout net = sum of vendor nets + adjustment from earlier refunds
Adjustment = this payout's refunds + carried balance
Carried balance = owed to date - money moved, recomputed from the money rather than earlier nets
```

Commission is rounded to the nearest paisa per order. Vendors keep the money on no-shows, as the agreement states.

## 8. API

All routes are under `/api/v1` and return JSON, with every timestamp in ISO 8601 UTC. Errors use `{ "error": { "code": "sold_out", "message": "..." } }`.

### Public

| Method | Route | Purpose |
|---|---|---|
| GET | `/cities` | Cities and areas |
| GET | `/drops?city=&area=&category=&veg=&pickup_by=&max_price=&q=` | Tonight's feed |
| GET | `/drops/:id` | Listing details |
| GET | `/outlets/:brandSlug/:outletSlug` | Outlet page with tonight's drops |

### Auth

| Method | Route | Purpose |
|---|---|---|
| POST | `/auth/otp/send` | Send a 6-digit code |
| POST | `/auth/otp/verify` | Start a session and attach any hold |
| POST | `/auth/logout` | End the session |

### Customer

| Method | Route | Purpose |
|---|---|---|
| POST | `/orders` | Reserve, body `{ dropId }`. JSON bodies use camelCase, query params use snake_case |
| GET | `/orders/:id` | Order status, used while confirming |
| POST | `/orders/:id/pay` | Create the Razorpay order |
| DELETE | `/orders/:id/hold` | Release a hold |
| GET | `/me/orders?status=` | Orders, all of them or `active` or `past` |
| POST | `/orders/:id/rating` | Rate a collected order |
| POST | `/orders/:id/issues` | Report a problem |
| GET, PATCH, DELETE | `/me` | Profile, preferences, account deletion |
| POST | `/me/uploads` | Get a signed upload link for an issue photo, 30 an hour per user with `/vendor/uploads` |
| GET | `/me/following` | Followed outlets |
| PUT, DELETE | `/outlets/:id/follow` | Follow, unfollow |

### Vendor onboarding

| Method | Route | Purpose |
|---|---|---|
| POST | `/vendor/outlets` | Start an outlet, creating the brand if needed |
| PATCH | `/vendor/outlets/:id` | Save a step, used for save and resume |
| POST | `/vendor/uploads` | Get a signed upload link, 30 an hour per user with `/me/uploads` |
| POST | `/vendor/outlets/:id/documents` | Record an uploaded document |
| GET | `/vendor/payout-accounts?brand_id=` | The brand's payout accounts this user may see, last 4 digits only |
| POST | `/vendor/payout-accounts` | Add PAN and bank details. Returns `nameWarning` when the holder matches neither the legal name nor the owner |
| PATCH | `/vendor/payout-accounts/:id` | Change bank details, which holds payouts until re-verified |
| POST | `/vendor/payout-accounts/:id/agreement` | Sign the agreement |
| POST | `/vendor/outlets/:id/submit` | Submit for review |
| GET | `/vendor/outlets/:id/status` | Status and anything to fix, including the admin's reason for `changes_needed` |
| PATCH | `/vendor/outlets/:id/settings` | Edit a live outlet's hours, address, area, maps link, pickup instructions, contact phone and photos |
| POST | `/vendor/outlets/:id/pause` | Holiday closure, with `until` and `reason`. Paid orders stand and no customer is told |
| POST | `/vendor/outlets/:id/resume` | End a holiday closure early |

### Vendor daily use

| Method | Route | Purpose |
|---|---|---|
| GET | `/vendor/outlets` | Outlets this user can access |
| GET, POST | `/vendor/outlets/:id/listings` | List and add listings |
| PATCH, DELETE | `/vendor/listings/:id` | Edit or archive a listing |
| POST | `/vendor/listings/:id/copy` | Copy to another outlet |
| GET | `/vendor/outlets/:id/today` | Drops and tonight's totals |
| PUT | `/vendor/listings/:id/drops/today` | Set quantity, publish |
| PATCH | `/vendor/drops/:id` | Pause, resume, change quantity |
| POST | `/vendor/drops/:id/cancel` | Cancel a drop and refund everyone |
| GET | `/vendor/outlets/:id/orders?date=` | Tonight's orders |
| POST | `/vendor/outlets/:id/collect` | Collect by code, a no-show too during the 30-minute grace |
| POST | `/vendor/orders/:id/collect` | Collect one order by ID, as from a name search |
| POST | `/vendor/orders/:id/no-show` | Mark no-show |
| POST | `/vendor/orders/:id/cancel` | Cancel one order |
| GET | `/vendor/earnings?payout_account=` | Payouts and statements |
| GET | `/vendor/payouts/:id/statement` | Statement as CSV |
| GET | `/vendor/outlets/:id/staff` | Staff of the outlet, for its owner or a manager |
| POST, DELETE | `/vendor/outlets/:id/staff` | Add or remove staff. A manager may be given a `payoutAccountId` as a franchisee |

### Admin

| Method | Route | Purpose |
|---|---|---|
| GET | `/admin/applications` | Review queue |
| POST | `/admin/documents/:id/review` | Approve or reject a document |
| POST | `/admin/outlets/:id/decision` | Approve, request changes, suspend |
| PATCH | `/admin/outlets/:id` | Move brand, set commission, switch the payout account to a verified one of the brand |
| GET | `/admin/orders`, `/admin/issues` | Support views |
| GET | `/admin/alerts?action=&from=&to=` | Audit entries that need an admin: failed, stuck and unknown refunds, unmatched or wrong payments, orphaned, failed or empty transfers, payout mismatches, stuck linked accounts |
| GET | `/admin/users?phone=` | Find a user's ID |
| POST | `/admin/orders/:id/refund` | Refund, choosing who pays |
| POST | `/admin/orders/:id/cancel` | Cancel a paid order, with a reason and who pays |
| POST | `/admin/refunds/:id/retry` | Send a failed refund again on the same terms |
| POST | `/admin/issues/:id/resolve` | Close an issue with a note and no refund |
| GET | `/admin/outlets/:id/stats` | Cancellation rate |
| POST | `/admin/users/:id/phone` | Change a verified user's phone |
| GET | `/admin/payouts` | Weekly payouts |
| GET | `/admin/payout-accounts?status=` | Payout accounts, last 4 digits only |
| POST | `/admin/payouts/:id/approve` | Release a payout |
| POST | `/admin/payouts/:id/hold` | Hold a draft, with a reason |
| POST | `/admin/payouts/:id/unhold` | End an admin's hold |
| POST | `/admin/payouts/:id/mark-paid` | Record that the money arrived |
| POST | `/admin/payout-accounts/:id/verify` | Verify changed bank details |

### System

| Method | Route | Purpose |
|---|---|---|
| POST | `/webhooks/razorpay` | Payment, refund and transfer events |
| POST | `/webhooks/whatsapp` | Delivery status and quick replies |
| POST | `/internal/jobs/tick` | Cron entry, protected by a secret |

## 9. Background jobs

All jobs run from the one-minute tick. Each must be safe to run twice, and a failed tick is simply caught by the next one.

| Job | When | What it does |
|---|---|---|
| Reconcile payments | Every minute | Check Razorpay for payments on holds about to expire. First, so a paid hold is settled before it can expire |
| Expire holds | Every minute | `held` past `hold_expires_at + 60s` becomes `expired`, stock returns |
| Send notifications | Every minute | Send pending messages, fall back from WhatsApp to SMS |
| Send refunds | Every minute | Send pending refunds, at least 15 minutes apart after a refusal, and check sent ones heard nothing of for 15 minutes |
| Pickup reminders | Every minute | 30 minutes before pickup opens |
| Create transfers | Every minute | Held Route transfers for sold bags, then settle stale claims and reverse transfers stranded on cancelled orders |
| Link payout accounts | Every minute | Create linked accounts for verified payout accounts |
| Mark no-shows | Every 5 minutes | `paid` orders 30 minutes past pickup end |
| Vendor prompt | Daily, between 5:00 and 5:14 pm IST | "How many tonight?", not to outlets whose licence has expired |
| Licence check | Daily, between 10:00 and 10:14 am IST | Warn at 30 and 7 days, block new drops on expiry |
| Clean up | Daily | Remove used or expired OTPs and rate limit rows over a day old, expired sessions, and sent messages over 90 days old |
| Build payouts | Monday from 6:00 am IST, once a week | Create draft payouts for the week before |

Followed outlet alerts are not a job: they are queued with each first drop of the night, one message per customer, per outlet, per night.

The browse and reserve queries check dates directly, so a late job can never sell something it shouldn't. Jobs only tidy up.

## 10. Edge cases

### Stock and holds

| Case | Handling |
|---|---|
| Two people tap the last bag together | The conditional update lets one through. The other gets `sold_out` |
| Customer closes the tab during a hold | Hold expires and stock returns |
| Hold expires while paying | 60 seconds of grace, then the late payment rules in 7.2 |
| Vendor lowers quantity below sold | Rejected, the minimum is `reserved_count` |
| Vendor pauses with holds active | Existing holds can finish, no new ones start |
| Someone holds everything repeatedly | Limits per anon ID and IP, and one order per outlet per night |
| Customer already has an order at that outlet | Blocked by the unique index, and shown the existing order |

### Payments

| Case | Handling |
|---|---|
| Webhook arrives twice | `webhook_events` primary key ignores the second |
| Webhook arrives before the browser returns | Normal, because the client polls order status |
| Browser callback never arrives | The webhook still confirms the order |
| Webhook delayed or lost | Reconcile job catches it |
| Money debited, order not confirmed | Late payment rules guarantee a confirmed bag or a refund |
| Paid twice | Second payment refunded in full |
| Refund fails | Stays `pending`, retried, and alerts admin after 3 failures |
| Refund requested twice | `UNIQUE (payment_id, reason)` blocks it |
| Webhook amount differs from the order | Do not confirm, flag to admin |

### Pickup

| Case | Handling |
|---|---|
| Customer arrives before the window | Code shows a "not open yet" state, and staff decide |
| Customer arrives after the window | Staff can still collect for 30 minutes, then it auto-marks no-show |
| Staff need to correct a no-show | Allowed until the payout is approved. Money is the same either way |
| Wrong code entered | "Not found", limited to 10 tries a minute per staff user |
| Code used twice | "Already collected at 8:41 pm" |
| Code used at another branch | Not found, because lookup is outlet-scoped |
| Vendor is shut when the customer arrives | Customer reports it, admin refunds at the vendor's cost |
| Friend collects for the customer | Allowed. The code is the proof |
| Food unsafe or allergen problem | `issues` entry, priority for admin, refund or vendor suspension |

### Vendors and branches

| Case | Handling |
|---|---|
| Outlet suspended with paid orders tonight | Orders stay valid unless admin cancels them, which refunds customers |
| FSSAI expires | Tonight's paid orders are honoured, no new drops can be created |
| Vendor changes bank details | Payout account moves to `on_hold` and payouts pause until admin re-verifies. This guards against account takeover |
| Bank name doesn't match PAN | Warned at entry, decided by admin |
| Owner's phone number changes | Admin changes it after verifying identity |
| Staff member leaves | `removed_at` is set and their sessions for that brand stop working |
| Two people apply as the same brand | Admin moves the outlet to the correct brand |
| Franchise switches owner | New payout account and agreement. Unpaid orders stay with the old account |
| Branch closes | `closed`, followers told once, history kept |
| Same FSSAI on two outlets | Admin warning, not a block, because shared kitchens exist |
| Vendor cancels too often | Admin sees cancellation rate. Manual pause in the MVP |
| Price edited during sales | Listing edits affect future drops only. A drop's price locks after its first reservation |
| Pickup time edited after sales | Blocked. Cancel and refund instead |
| Multiple listings at one outlet | Allowed, each with its own drop |
| Pickup window passes midnight | `pickup_end` before `pickup_start` means next day. `service_date` stays the start date |

### Money after the fact

| Case | Handling |
|---|---|
| Refund before payout | Held transfer reversed, nothing else to do |
| Refund after payout | `adjustment_paise` deducted from the next payout |
| Adjustment bigger than next payout | Balance carries forward. Admin chases it if the outlet closes |
| Vendor goes dark with pending payouts | Admin moves the draft to `held` with a reason. It stays held until admin decides |
| Payout fails at the bank | Status stays unpaid and admin is alerted |

### Accounts and data

| Case | Handling |
|---|---|
| OTP spam | 3 sends per 10 minutes per phone, plus IP limits |
| OTP guessing | 5 tries per code, 5-minute expiry |
| WhatsApp not delivered | Falls back to SMS |
| Customer deletes account | Name and phone anonymised, financial records kept |
| Vendor sees customer data | First name and last initial only, never a phone number |

## 11. Security and privacy

- Sessions use `httpOnly`, `Secure`, `SameSite=Lax` cookies. Only hashed tokens are stored.
- Every vendor route checks membership for that specific outlet, in one shared helper.
- PAN and bank numbers use application-level encryption, with the key outside the database. Screens show only the last 4 digits.
- Documents stay in a private bucket and use signed links lasting 5 minutes.
- Uploads are limited to images and PDFs, up to 10 MB.
- Every admin action and every money movement writes to `audit_log`.
- Secrets live in environment variables and never in the repository.
- The privacy policy should cover India's DPDP Act. Have this reviewed before launch.

## 12. Things to settle before launch

These need a real answer from a CA, lawyer or Razorpay. Sections of the build depend on them.

| Question | Why it matters | Who answers |
|---|---|---|
| Who pays GST on these sales? | E-commerce operators have paid 5% GST on restaurant services since January 2022. A marketplace like this may be covered, and bakeries or packaged goods may be treated differently | CA |
| Is the shown price inclusive of tax? | Decides how `tax_paise` is calculated and what vendors receive | CA |
| Do TCS and TDS apply on vendor payouts? | May change the payout formula and require filings | CA |
| Do we need our own FSSAI e-commerce licence? | Replate lists one for itself as well as each outlet's | FSSAI consultant |
| Will Razorpay approve this model on Route? | Route needs activation and linked accounts for each vendor | Razorpay |
| Is the 20% commission final? | It's a sample number in the design | You |
| Who invoices the customer? | Depends on the GST answer | CA |

The `tax_paise` column and payout formula leave room for this, so the answers won't require a redesign.

Payout fallback: if Route is delayed, the same `payouts` table works with manual bank transfers for the pilot. Get advice first, because holding customers' money and passing it on can raise payment aggregator questions.

## 13. Design changes this causes

| Screen | Change |
|---|---|
| Customer map (`K6-Map`) | Remove |
| Home and desktop browse | Remove the Map button, map pane, distance and "Within 2 km". Add an area picker |
| Listing, vendor page and pickup | "Get directions" opens `maps_url` |
| Vendor outlet step (`K12-Outlet`) | Replace map pin with an area picker and "Paste your Google Maps link" |
| Edge states | Remove "Join waitlist" and "On the waitlist" |
| Vendor app | Add an outlet switcher for people with more than one outlet |
| Partner flow | Add "Add another outlet" and a staff screen |
| Vendor documents | No screen change for a first outlet. FSSAI and GSTIN save to the outlet, PAN saves to the payout account. A later outlet skips PAN if it reuses a payout account |
| Commission | Confirm the real rate |

## 14. Build order

| Phase | Deliverable | Done when |
|---|---|---|
| 1. Foundation | Project, migrations, OTP, sessions, roles, jobs tick | A phone number can sign in and roles are enforced |
| 2. Onboarding | Brands, outlets, documents, payout accounts, admin review | An outlet goes from draft to live |
| 3. Catalogue | Listings, drops, browse | Tonight's bags show by city and area |
| 4. Orders | Hold, expiry, stock | 20 parallel reserves on 5 bags give exactly 5 orders |
| 5. Payments | Razorpay, webhooks, reconciliation, refunds | Every row of the payment table in 7.2 passes in test mode |
| 6. Pickup | Codes, collect, no-show, cancel | A full order runs from reserve to collected |
| 7. Messaging | WhatsApp, SMS, reminders, follow alerts | Every template sends with fallback |
| 8. Payouts | Route transfers, statements, adjustments | One test week reconciles to the paisa |
| 9. Launch checks | Rate limits, audit review, restore test | A database restore has been tested |

## 15. Testing

Focus tests where bugs cost real money:

- Concurrency: overselling, double collection, double refund
- Webhooks: duplicates, wrong order, missing events, bad signatures
- State changes: every allowed and blocked order transition
- Permissions: staff at outlet A cannot touch outlet B, and franchisees cannot see each other's earnings
- Money: commission rounding, payout totals, refund after payout
- Time: IST day boundaries and windows past midnight

Run these against a real Postgres database in test mode. Mocks can't prove locking works.

## 16. Sources checked

- [Razorpay Route transfers API](https://razorpay.com/docs/api/payments/route/transfers)
- [Razorpay Route settlement schedules](https://razorpay.com/docs/payments/route/schedule-settlement.md)
- [Razorpay order webhooks](https://razorpay.com/docs/webhooks/orders.md)
- [CBIC Circular 167/2021: GST on restaurant services through e-commerce operators](https://www.gstcouncil.gov.in/sites/default/files/2024-06/circular-167-2021-gst.pdf)
- [ClearTax: GST on restaurant services through e-commerce operators](https://cleartax.in/s/gst-on-service-supplied-restaurants-ecommerce-operators)
- [Replate terms](https://tryreplate.com/terms)
