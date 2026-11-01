# API gaps

What the customer screens need that section 8 of `docs/backend-implementation.md` doesn't give. Nothing here has been invented as a route. Vendor and admin gaps will be added when those screens are built.

## No route exists

| Screen | Needs | What the frontend does for now |
|---|---|---|
| Home, no listings tonight | "Notify me" for an area | Button left out. Offers the whole city instead |
| Landing, city not live | "Tell me when you launch" | Not built. The picker only offers the two live cities |
| Report a problem | A customer photo upload. `issues.photo_key` exists, but `/vendor/uploads` is the only upload route | Photo field left out |
| Landing search | Search by pincode | Area picker only |

## Route exists, response or behaviour isn't specified

Section 8 lists routes, not bodies. `src/lib/api/types.ts` follows the column names. These are the assumptions that go beyond the columns.

| Route | Assumed |
|---|---|
| `GET /cities` | `[{ id, name, areas: [{ id, name }] }]`, with `id` as the `city` value |
| `GET /drops` | Each drop embeds an outlet summary. `area` takes an area id. Sold-out drops are included. `pickup_by` is `HH:MM` IST compared with pickup start. `max_price` is paise. `veg=true` |
| `GET /drops`, `/drops/:id` | `photo_urls: string[]`. The schema has one `photo_key`, but the design shows up to 3 photos |
| `GET /drops/:id` | Outlet includes address, pincode, `maps_url`, `pickup_instructions`, `fssai_number` |
| Outlet summary | `rating_avg` and `rating_count`. The schema only has `orders.rating`, so these need computing |
| `GET /outlets/:brandSlug/:outletSlug` | Adds `opening_hours_today` as display text, `following`, and all of tonight's `drops` |
| `POST /orders`, `GET /orders/:id`, `GET /me/orders` | Order includes the snapshot fields, the outlet with its pickup info, `pickup_start_at`, `pickup_end_at`, `payment_method`, and `refund` |
| `GET /me/orders?status=` | `active` is held, paid, and cancelled with a refund still pending. `past` is everything else except expired |
| `POST /orders/:id/pay` | Body `{ allergen_ack: true }`. Returns `{ razorpay_order_id, key_id, amount_paise, currency, timeout_seconds }` |
| `GET /me` | Signed out returns 401 with code `unauthorized`. Adds `bags_rescued` and `saved_paise` for the impact card |

## Please decide

1. **Outlet URL.** The spec's `/{city}/{brand-slug}-{outlet-slug}` can't be split back into two slugs, because either can contain a hyphen. The API needs both. The frontend will use `/{city}/{brand-slug}/{outlet-slug}`.
2. **Hold released at sign-in.** When OTP verify hits the one-per-night rule, the hold is released and the customer should see their existing order. `verify` needs to return that order's id. Until then the frontend sends them to Orders.
3. **`already_ordered`.** The error has no order id. The frontend finds the order through `/me/orders?status=active`, matching on outlet.
4. **Second signed-out hold.** The spec limits `anon_id` to 1 active hold but gives no error code. Should it replace the old hold, or return an error? The mock replaces it.
5. **Customer name.** The pickup code and vendor order search use the customer's name, but sign-in never asks for it. The frontend will ask at checkout when `name` is empty and save it with `PATCH /me`.

## Error codes the frontend relies on

`sold_out`, `hold_expired`, `already_ordered`, `unauthorized`, `invalid_otp`, `rate_limited`, `not_found`. The spec only names `sold_out`, so the backend should confirm the others.
