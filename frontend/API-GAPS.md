# API gaps

What the screens need that the backend on `main` doesn't give yet. Checked against `backend/src` on 2 Nov 2026. Nothing here has been invented as a route: `src/lib/api/types.ts` matches the real responses, and optional fields there are the ones listed below.

## Promised in the fix pass

The frontend already expects these. Until they land, the feed and outlet page won't work properly against the real API.

| Field or route | Used by |
|---|---|
| `outletId`, `city`, `brandSlug`, `outletSlug`, `salesEndAt` on drop cards and details | Vendor link on cards and listings, sales-ended state |
| `outletId` on `GET /outlets/:brandSlug/:outletSlug` | Follow button |
| Read routes for staff and payout accounts | Staff screen, Add another outlet |
| Holiday pause and live outlet settings routes | Outlet settings screen |

## Missing fields

| Where | Needs | What the frontend does for now |
|---|---|---|
| `GET /vendor/outlets/:id/orders` | `pickupCode` on each row, or a route to look a code up without collecting | The design's Check then Hand over is one step: a matching code collects immediately. Rows show the order number instead of the code. Please decide if staff should see codes at all |
| Order view | `foodCategory` | Shows the bakery illustration on order cards |
| Order view | `brandSlug`, `outletSlug`, `city` | Hides "See vendor" |
| Order view | `rating` | Stars show as unrated after a refresh. A second rating gets `already_rated` |
| Order view | `collectedAt`, `paidAt`, payment method | Collected time, "Paid by UPI" and "Picked up 9:41 pm" left out |
| Order view | `cancelReason`, and refund id and dates | Copy says the vendor cancelled, without the reason, refund ID or start time |
| Order view | The prefix in `number` is hardcoded as `SJ-` in the backend | Shown as sent, so a rebrand needs a backend change |
| `GET /me` | `isAdmin`, and a date for "since June" | Admin page relies on the 403. Impact card says "so far" |
| `GET /me/following` | `city` | Falls back to `/outlet/{brand}/{outlet}`. The first path part isn't read |
| Drops | Only one `photoUrl`, but the design shows up to 3 | One photo, no carousel |
| Outlet rating | A count of ratings | "212 pickups rated" left out |
| `GET /vendor/outlets` | `brandName`. Rows are raw outlets | Switcher and headers show the branch name alone |
| `GET /vendor/earnings` | Bags per payout | Left out of past payouts |
| `GET /admin/applications` | Owner name and phone, first listing | Left out of the detail panel |
| `GET /vendor/outlets/:id/status` | Dates for each stage, reviewer and time on a fix | Timeline has no dates |

## No route exists

| Screen | Needs | What the frontend does for now |
|---|---|---|
| Home, no listings tonight | "Notify me" for an area | Left out. Offers the whole city |
| New city | "Tell me when you launch" | Not built. The picker only offers live cities |
| Landing | Search by pincode | Area picker only |
| Onboarding payout step | IFSC bank lookup | Format check only |
| Agreement | Full agreement text or PDF | Key points only, link left out. Version sent is `AGREEMENT_VERSION` in `src/config/brand.ts`, which is a placeholder |
| Admin application review | A Reject decision. The API has approve, request_changes, suspend, reinstate, close | Reject button left out |
| Admin home | Metric tiles (bags sold, GMV, live vendors, no-show rate) | Left out |
| Earnings | Statement as PDF | CSV only |

## Behaviour to confirm

1. **Mark no-show before pickup ends.** The button always shows on paid orders. If the backend refuses it early, its message is shown.
2. **Cookies on localhost.** Cookies are `Secure` with `SameSite=Lax`, so connecting the frontend to a local backend needs both on one site over https or a dev override.
3. **`PATCH /me` on an empty name.** Checkout saves the customer's name there the first time, because sign-in never asks for it.
