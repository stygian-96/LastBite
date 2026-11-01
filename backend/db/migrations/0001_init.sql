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
  payload      jsonb NOT NULL,
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
