# Backend build notes

Kept from the build ledger so they survive cleanup. The spec is `docs/backend-implementation.md`.

## Decisions made during the build

- 0001_init.sql is spec 5.1 to 5.5, 0002_additions.sql is 5.6 — section 5.6 was added after the plan text and would duplicate tables — none if wrong, easy migration move.
- Task 12 may modify src/modules/orders/expire.ts for FOR UPDATE SKIP LOCKED — plan text requires it though Files omits it — none.
- Work on main with no worktree — user chose the checked-out branch at the prompt, repo is new — low, history stays linear.
- User asked for separate backend and frontend folders mid-run. Backend moved to backend/ on Hono; plan and spec updated — user's direct request — Next scaffolding from Task 1 reworked.
- typescript-eslint and @eslint/js accepted, controller requested the plain TS lint config — dev-only — none.
- Co-Authored-By stays Claude Opus 5.5 per this session's attribution — reviewer query only — none.
- Fold notFound envelope and HTTPException handling into fix round 1, though labelled minor — Global Constraint says all errors use the envelope — one small change.
- Sped up test reset within Task 4 scope — 4-7s per test would make the suite unusable — none.
- Live outlets may upload a renewed document, which stays pending while the approved one stays in force until admin approves it — renewal must be possible and an approved licence must not lapse during review — low. Task 7 approve must retire the older approved row.
- pickup_by means pickup starts at or before that IST time — matches the "Pickup by 9 pm" chip — small filter change if wrong.
- POST /orders takes dropId and JSON is camelCase; spec updated — consistent with all other routes — frontend client follows, told by message.
- Released holds become expired; extra codes not_on_sale and hold_not_active kept — clearer than sold_out for the UI — none.
- Holds count only successful signed-out holds per IP, with small overshoot under parallel requests — avoids blocking shared IPs — low.
- Capture lock order is order then drop, not my suggested drop-first — implementer proved drop-first deadlocks with expireHolds — low, tested both ways.
- refund.failed keeps the refund pending, counts an attempt, fails only on the third — spec section 10 — none.
- Reconcile also sweeps expired and cancelled orders with no captured row for 3 days, oldest-checked first via payments.last_checked_at — spec section 10 guarantee overrides 7.2's held-only prose — extra Razorpay API calls.
- Thrown or unclear gateway calls keep the same idempotency key; attempts advance only on a definite refusal or refund.failed — a timeout may have succeeded, and Task 16 adds partial refunds — needs Razorpay refund idempotency confirmed in test mode, checked in Task 18.
- Add gateway fetchRefund and a stale sweep for pending rows with an ID older than 15 minutes — spec section 10 needs lost events caught — one extra API call per stuck refund.
- Cancel always succeeds on a paid order, refunding only the unrefunded remainder and auditing when nothing remains — one admin-refunded order must not block a drop — low.
- refund.failed restores a reversed transfer to on_hold — implementer's reasoning accepted, verify in Task 18 test mode — vendor payout could be wrong if Razorpay behaves differently.
- Unknown refund events audited as refund.unknown and answered 200 unless our own save may be in flight — a dashboard refund must not get the webhook disabled — low.
- Followed-outlet alerts are not marketing and ignore marketing_opt_in — the customer asked for them by tapping Follow and the default opt-in is false — an unwanted alert costs one unfollow.
- Pending messages to a deleted user are cancelled in deleteAccount via cancelPendingFor, since claim can't link a rewritten phone — Task 16 must call it.
- notifications.sending_at added, dedupe keys widened where the plan's would suppress later messages, status failed on WhatsApp reverts to SMS — needed for correctness — low.
- A refund's reverseTransfer is fixed at creation in refunds.reverse_transfer. Only a vendor-charged refund of the full remainder reverses the transfer; a partial vendor-charged refund is deducted from the payout in Task 17; a platform-charged refund never reverses — Route reversal is all-or-nothing in our model and one key must carry one payload — partial cases rely on payout adjustment.
- reverse_transfer also requires transfer_status on_hold at creation; a released transfer is deducted by payout adjustment — prevents charging a vendor twice — low.
- Customers upload issue photos through POST /me/uploads into the private bucket — no customer upload route existed — small API addition, frontend must use it.
- Retrying a failed issue_resolution refund reuses its row, reset to pending — the unique constraint otherwise blocks a retry — low.
- Late capture for a deleted user refunds instead of retaking stock; phone change moves pending notifications to the new number — low.
- Linked accounts are created by a job syncLinkedAccounts, not inside decideOutlet — provider calls never run in a transaction — approval and activation can lag by a minute.
- Adjustments are settled with real partial transfer reversals at approve, recorded on the payment, so money moved equals net — needs Razorpay behaviour confirmed in test mode.
- createTransfers requires a verified payout account — old bank details must not receive money after a change — payouts wait for re-verification.
- orders snapshot payout_account_id at reservation — spec says unpaid orders stay with the old account on a franchise switch — small migration.
- Transfers already held before a bank change stay on the old linked account and are released there — that account was verified, and in a takeover it's the genuine one — vendor may need the old account open for one week.
- Carried balance is recomputed from what is owed minus money actually moved, not from a stale payout net — fixes overpayment after a reversal and approval mismatches in one rule — a larger change to build and approve.
- Stale transfer claims on no-longer-eligible payments are checked with a new gateway listPaymentTransfers, reversing any found transfer in full and auditing — otherwise money stays locked unseen — one API call per stale claim.
- Admin can hold a draft payout via POST /admin/payouts/:id/hold — spec section 10 vendor goes dark — small addition.
- No clawback of released transfers. When money moved already exceeds money owed, the payout is held and the balance carries into later weeks — spec section 10 carries forward, and the implementer showed my 8340 example was wrong — company is exposed if the vendor leaves.
- One approval per payout account at a time, with a started approval having to finish before another payout on that account can start — closes double reversal — a failed approval blocks that account's next payout until retried.
- DEV_FAKE_PROVIDERS=true enables fake gateway and store in development only, refused in production — frontend integration needs a local backend without Razorpay keys — low.
- Exact-size presigned uploads accepted; frontend sends the exact size — S3 presigned PUT can't enforce a maximum — frontend note.
- Vendor's real email isn't sent to Razorpay; RAZORPAY_LINKED_EMAIL_DOMAIN supplies unique addresses — avoids uniqueness failures — verify in test mode.
- Outlet link is /{city}/{brandSlug}/{outletSlug}, matching the API, and vendor action links stay /p — a joined hyphen slug can't be split — frontend route follows.

## Deferred for later

- Task 1: minor (deferred): route auth option silently ignored until Task 4; Task 4 wires it.
- Task 1: minor (deferred): no CORS preflight or malformed JSON test.
- Task 1: minor (deferred): HTTPException custom response headers ignored; check when auth lands. dev script needs backend/.env. Test reads private errorHandler field.
- Task 2: minor (deferred): schema.ts array defaults render as [""], should be []; .op() classes wrong; generated noise.
- Task 2: minor (deferred): orders.number is bigint mode, JSON.stringify throws; convert when serialising (Task 10).
- Task 2: minor (deferred): migrate.ts ROLLBACK failure can mask original error; makeOrder default uses Date.now; no recorded RED run.
- Task 3: minor (deferred): pickupBounds no format validation, validate HH:MM at route boundary (Task 8). rate_limits rows never pruned, add to Task 18 cleanup. decrypt short-input error generic.
- Task 4: minor (deferred): otp latest ordering ties on same createdAt; IP key 'unknown' shared bucket and x-forwarded-for trust; dev messenger logs OTP if NODE_ENV unset; lib/http imports db via session; cookie Domain untested; expired OTP/session cleanup is in Task 18.
- Task 5: minor (deferred): brand-wide owner bypasses role list by design; outlet-scoped owner inconsistency; removeStaff outletId optional; no HTTP path removes brand-wide memberships; 403/404 ordering reveals membership UUID validity.
- Task 6: minor (deferred): agreement IP from x-forwarded-for spoofable; agreement_missing accepts any version; ApiError details can overwrite code/message; runChecks outside tx; 10 MB maxBytes untested; document status read outside tx; content types listed twice. signedRead 5-minute link to verify in Task 18.
- Task 7: minor (deferred): fssaiExpiresOn accepts impossible dates like 02-31, giving 500 not 400; audit test misses approve and request_changes; request_changes reason not shown to vendor; listApplications unpaginated; two approved rows possible when not live.
- Task 8: minor (deferred): route test real-clock flake at 23:59 IST; duplicate asserts in listings.ts; empty patch audited; resume does not re-check outlet (reserve does).
- Task 9: minor (deferred): max_price unbounded could 500; NUL bytes in q could 500; no salesOpen flag on getDrop; hhmm coupled to listings module; HTTP param tests thin.
- Task 10: minor (deferred): lapsed held order shows active until job runs; allergens empty-string filter unexplained (schema default bug); no pagination.
- Task 11: minor (deferred): refusal() can say sold_out after losing a race; outlets.ts and review.ts unique paths lack concurrent tests.
- Task 12: minor (deferred): created_at uses DB now(); start.ts missing limit(1); `in` on REFUND_STATUS; tests with redundant steps; pay route sits in customer-orders.ts (accepted).
- Task 13: minor (deferred): send-error rows have no backoff; refunds_to_check_idx default nulls last.
- Task 14: minor (deferred): autoMarkNoShows one row at a time; list date accepts impossible days; SJ- format duplicated in list.ts and views.ts; weak assert at pickup.test.ts:794.
- Task 15: minor (deferred): non-ASCII vendor names make UCS-2 SMS; fitSms over-trims repeated variables; same_as_usual check not atomic; cancelled first drop suppresses that night's alert; smsOnly unused.
- Task 16: minor (deferred): listIssues no limit; EXTENSIONS and CONTENT_TYPES duplicated; /me/uploads no rate limit; reopened refund jumps the queue.
- Task 17: for final review: settleAdjustment one key per payout and payment can reuse a seen key after a refund changes the plan between retries, so recorded reversal exceeds real (approve.ts:264); excess on retry ignores released amounts, under-reverses, surfaces as payout.mismatch.
- Task 18: minor (deferred): client error listener removed before release(true); failing build logs every minute; docs job table order; failed notifications kept forever.
- Final: fix wave e990fcb..d239e25 re-reviewed clean; minors parked: hasNul literal backslash-u0000 refused, isoTimestamps could 500 on timestamp-shaped free text, platform admin cancel labelled vendor_cancelled.

## Before taking real money

## Behaviour not confirmed from docs, with the test-mode check for each

Docs reached: orders capture settings, webhook validation, fetch transfers, modify hold, create transfers, reverse a transfer, fetch reversals, normal refunds, refund idempotency (a white-label mirror of Razorpay docs), reverse_all, linked account, stakeholder, product configuration. Some razorpay.com/docs URLs returned 404 and I used search to find their current paths.

| # | Unconfirmed | Risk if wrong | Test-mode check |
|---|---|---|---|
| 1 | `X-Refund-Idempotency` is honoured on main razorpay.com with `reverse_all` | Double refund on a retry | Send one refund twice with the same header and body, including `reverse_all`. Expect one refund ID |
| 2 | Transfers from payments have no documented idempotency. Protection is the lookup of `notes.idempotency_key` first, and `X-Transfer-Idempotency` is sent untested | Double transfer if a response is lost and notes are not listed | Create a transfer with notes, confirm `GET /payments/:id/transfers` shows `notes.idempotency_key`. Then repeat the POST with the same header and see whether it replays |
| 3 | Reversals: same scheme, `notes` is a documented input, the sample only shows `[]` | Double reversal on a retry, taking money from a vendor | Reverse with notes, confirm `GET /transfers/:id/reversals` returns them |
| 4 | `amount_reversed` counts reversals made by the reversal API, not only refunds. Docs say "for refunds" | Retries reason from the wrong remainder | Partly reverse, read the transfer |
| 5 | `on_hold: true` really holds. Docs say a linked account's settlement schedule takes precedence over it | Vendor paid before approval, the payout model breaks | Create a held transfer to an account with a default schedule, confirm `settlement_status: on_hold`, watch past the schedule |
| 6 | Field names on list: `status` in samples, `transfer_status` in the parameter list. Code reads `status`, `on_hold` | Wrong transfer state | Read one real response. Check `on_hold` after `on_hold:false`, undocumented in samples |
| 7 | PATCH `on_hold:false` twice, and on a fully reversed or settled transfer | Handled by refetch if refused, confirm it | Release twice, release a reversed one |
| 8 | Refund on a failed `reverse_all`: does a failed refund undo the reversal? (Task 13 ruling) | Vendor payout wrong | Force a failed refund with `reverse_all`, read the transfer |
| 9 | `reverse_all` on a held transfer, on a part-reversed transfer, and with no transfer on the payment | Refund refused or stuck | Try each |
| 10 | Mismatched body on the same refund key: docs give both 400 and 409. A 400 would count as a refusal | A retry with a different body looks like a refusal. Not expected, as a key carries one payload | Send one and read the status |
| 11 | Business error status: docs say "4xx" for bad keys. The code treats text mentioning API key or authentication as plain | A bad key could read as a refusal, and fail a refund | Call with a wrong secret, confirm 401 |
| 12 | `capture_options` with both periods 12, and `refund_speed: normal`. Docs sample uses 7200 and `optimum`. Chosen so a late authorised payment goes straight back, not after 5 days | Order creation refused | Create an order, pay late, watch it |
| 13 | Payment `fee` is the full charge including GST, in paise | Vendor net off | Read one captured payment |
| 14 | Linked account values: `profile.category: food`, `subcategory: restaurant`, business types `proprietorship, private_limited, partnership, trust, other`. The lists were not reachable | All linked accounts refused | Create one of each |
| 15 | Business type guessed from the PAN's fourth letter, and a proprietor's PAN on stakeholder `kyc.pan`. business_type cannot be changed later | Wrong type sticks, and KYC may stall | Create a proprietor account, check activation |
| 16 | `reference_id` is not sent: it needs the `route_code_support` feature and may be unique, which recreation would break. It goes in the email instead | None if the email is accepted | Confirm a `+` address is accepted |
| 17 | Recreating an account on a bank change: unique email handles the one known refusal. Same PAN or phone may also be refused | Bank change stuck | Create two accounts with one PAN and phone |
| 18 | Activation: bank verification is async, 10 to 15 minutes. The ID is saved straight away, and a transfer to an unready account would be refused | Transfer waits or errors | Transfer right after creating an account, see how `createTransfers` copes |
| 19 | Minimum 100 paise on transfers and reversals | A settlement under Rs 1 is refused and the payout stays incomplete | Reverse 50 paise |

## What the user must run (Step 6)

1. Razorpay dashboard in test mode: enable Route, make keys and a webhook secret, and subscribe the webhook to payment and refund events at `/api/v1/webhooks/razorpay` (a tunnel for local).
2. Run the server with `NODE_ENV=production` and every variable in `.env.example`. Real adapters run only in production mode, so test keys go there. Messaging and S3 need values too, dummy will do for payment-only testing, but sends and uploads will then fail.
3. `npm run db:migrate && npm run db:seed`, and schedule or `curl` the tick each minute: `curl -X POST .../api/v1/internal/jobs/tick -H "x-cron-secret: $CRON_SECRET"`.
4. Sign in, reserve, pay with test UPI `success@razorpay`, confirm the webhook marks the order paid.
5. Cancel, tick, confirm the refund reaches `processed`.
6. Then the checks in the table, 1 to 5 first, as those touch money. Record results in the pull request.

- **A lost answer on a step can still go stuck, safely.** If a stakeholder or product call took effect but its answer was lost, or the save after it failed, the retry repeats that step. Razorpay refuses a second stakeholder and the docs do not cover a repeated product request. If the save after step 1 fails, the ID is lost, and the same email is refused. All of these end at 5 failures and `linked_account.stuck`, with no second account made, but need an admin and possibly a Razorpay fix. Add these to the test-mode checks. Check 16 and 17 above now use a stable email, not a random one.
- **A bank change part way abandons that account at Razorpay.** Verify clears the ID, as it must. Bounded to one per bank change.
- **Verify now does two things**, keyed on status. `invalid_state` still answers on a healthy verified account.
- **A build that keeps failing retries every minute** until fixed, and logs each time, as ruled. `failed` in the tick answer is what to alert on.
- New test-mode check 20: `notes` on refunds are returned by `GET /payments/:id/refunds`, the same risk as checks 2 and 3. The list is read to 100 refunds, far beyond what one payment has.
