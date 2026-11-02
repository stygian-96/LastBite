# LastBite backend

The API for LastBite: a Hono server on Node, with Postgres through Drizzle. All routes live under `/api/v1`. The full design is in `../docs/backend-implementation.md`.

## Setup

You need Node 24 and Docker.

```bash
cp .env.example .env        # then fill in ENCRYPTION_KEY, SESSION_SECRET and CRON_SECRET
docker compose up -d        # Postgres on port 5433, with a dev and a test database
npm install
npm run db:migrate
npm run db:seed             # the launch areas
npm run dev                 # http://localhost:4000
```

To make `ENCRYPTION_KEY`, run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

Scripts do not load `.env` on their own. The npm scripts pass `--env-file=.env`.

### What runs where

| `NODE_ENV` | Payments | Messages | Files |
|---|---|---|---|
| `production` | Razorpay | `MESSAGING_API_URL` provider | S3 |
| `test` | Fake | Fake | Fake |
| `development` with `DEV_FAKE_PROVIDERS=true` | Fake | Logged to the console, including OTPs | Fake |
| `development` | None: calls fail | Logged to the console, including OTPs | None: calls fail |
| anything else, or unset | None: calls fail | None: calls fail | None: calls fail |

`npm start` sets `NODE_ENV=production`. If you start the server another way, set it yourself. `npm run dev` takes `NODE_ENV=development` from `.env`, so an older `.env` needs that line added, or sign-in has no way to send a code. Production refuses to start with `DEV_FAKE_PROVIDERS` on, and the flag means nothing unless `NODE_ENV` is exactly `development`.

### Local development

`.env.example` sets `NODE_ENV=development` and `DEV_FAKE_PROVIDERS=true`, so the whole flow runs with no keys:

- **Sign in:** the OTP is in the server's console.
- **Pay:** start the payment as usual, which makes a fake Razorpay order. There is no checkout to finish, so finish it with the call below, which fakes a capture and runs it through the same `applyCapture` as the webhook. The order becomes paid and gets its pickup code. It answers `{ settled }`, 409 `payment_not_started` if the payment was not started, and a repeat changes nothing.

```bash
curl -X POST http://localhost:4000/api/v1/internal/dev/capture/ORDER_ID \
  -H "x-cron-secret: $CRON_SECRET"
```

- **Upload:** an upload link comes back, and the key can be saved as usual, but its `fake-storage.test` address takes no file, so nothing is stored and no image shows.
- **Jobs:** call the tick by hand, as under Cron. The fake gateway lives in memory, so after a server restart it no longer knows earlier refunds or transfers, and jobs asking about them log errors.

The capture route is mounted only in `development` with the flag on. Anywhere else it is a 404.

## Tests

Tests need Docker running. They use the test database, migrate it themselves, and run one file at a time.

```bash
npm test                                   # everything
npm test -- tests/modules/jobs.test.ts     # one file
npx tsc --noEmit && npm run lint           # types and lint
```

## Environment variables

`.env.example` lists them all, with notes.

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | Always | Postgres. Must not go through a transaction pooler such as PgBouncer in transaction mode: the tick holds a session lock on one connection. Connect directly, or use session mode |
| `TEST_DATABASE_URL` | Tests | Postgres for tests, never the dev database |
| `FRONTEND_ORIGIN` | Always | The one origin allowed by CORS, and the base of links in messages |
| `BRAND_NAME` | No, default `LastBite` | The product name in messages |
| `COOKIE_DOMAIN` | Production | Parent domain shared by `api.` and `www.` |
| `ENCRYPTION_KEY` | Always | 32 bytes, base64. Encrypts bank details |
| `SESSION_SECRET` | Always | At least 16 characters |
| `PORT` | No, default 4000 | Port to listen on |
| `TRUST_PROXY` | No, default off | `true` only behind a proxy that sets `x-forwarded-for` |
| `TRUSTED_PROXY_HOPS` | No, default 1 | How many proxies in front add to `x-forwarded-for`. The client address is that many entries from the right, so one a client sends itself is ignored |
| `DEV_FAKE_PROVIDERS` | No, default off | `true` runs the fakes in local development. Refused in production |
| `CRON_SECRET` | Production | Protects the tick route, and the local dev capture route |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Production | API keys |
| `RAZORPAY_WEBHOOK_SECRET` | Production | Checks webhook signatures |
| `RAZORPAY_LINKED_EMAIL_DOMAIN` | Production | Domain for the unique email each linked account needs |
| `MESSAGING_API_URL`, `MESSAGING_API_KEY` | Production | WhatsApp and SMS provider |
| `MESSAGING_WEBHOOK_SECRET` | Production | Checks provider webhooks, as a hex HMAC-SHA256 of the raw body |
| `MESSAGING_WEBHOOK_SIGNATURE_HEADER` | No, default `x-webhook-signature` | Header carrying that signature |
| `AWS_REGION`, `S3_PUBLIC_BUCKET`, `S3_PRIVATE_BUCKET` | Production | File storage |
| `S3_PUBLIC_BASE_URL` | No | CDN or custom domain for the public bucket |

In production the server refuses to start, and names what is missing, if any variable marked Production is empty (`COOKIE_DOMAIN` excepted). AWS credentials come from the SDK's usual chain.

The buckets need CORS allowing `PUT` from `FRONTEND_ORIGIN` with the `Content-Type` header. Upload links last 5 minutes, and sign the file's type and exact size, so the browser must send the same file it asked for.

The messaging adapter posts `{ to, channel, template, variables, text }` with a bearer key and expects `{ id }` back. Webhooks must send `{ type: 'status', providerId, status }` or `{ type: 'reply', phone, payload }`. A provider with another shape goes behind a small relay.

## Migrations

Migrations are plain SQL files in `db/migrations`, applied once each, in name order, in a transaction each. To add one, create the next numbered file and update `src/db/schema.ts` by hand to match. `schema.ts` was generated with `drizzle-kit pull` and is kept in that form, except the `bytea` columns, which drizzle-kit cannot map and are declared by hand at the top.

```bash
npm run db:migrate
```

## Cron

All background work runs from one call. Have a cron service make it every minute:

```bash
curl -X POST https://api.example.com/api/v1/internal/jobs/tick \
  -H "x-cron-secret: $CRON_SECRET"
```

- Without the right secret it answers 401, and with no `CRON_SECRET` set it refuses everything.
- It answers `{ skipped, ran, failed }` once the jobs are done, which can take a while on a busy tick, so give the call a long timeout, of at least 5 minutes.
- `failed` lists jobs that threw, with a 200 status. Those jobs run again on the next tick. Alert on it.
- Overlapping calls are safe: only one tick runs at a time, and the other answers `skipped: true`.
- A missed tick is harmless, as the next one catches up. Daily and weekly jobs are tracked in `job_runs`, so they run once however ticks fall.

| Runs | Jobs |
|---|---|
| Every minute | `reconcilePayments`, `expireHolds`, `sendPending`, `processRefunds`, `queuePickupReminders`, `createTransfers`, `syncLinkedAccounts` |
| Every 5 minutes | `autoMarkNoShows` |
| Once a day, 17:00 to 17:14 IST | `queueDailyPrompts` |
| Once a day, 10:00 to 10:14 IST | `checkLicences` |
| Once a day | `cleanup` |
| Once a week, from Monday 06:00 IST | `buildPayouts` for the week before |

### A stuck linked account

Making a linked account is several calls, and each finished step is saved, so a retry carries on from there on the same Razorpay account. After 5 failed tries the job stops and writes `linked_account.stuck` to the audit log. Fix the cause, then call `POST /api/v1/admin/payout-accounts/:id/verify`, which clears the count and sets it going again. A bank change that is re-verified starts a new linked account, on a new email.

## Webhooks

Point these at the API:

- Razorpay: `POST /api/v1/webhooks/razorpay`
- Messaging provider: `POST /api/v1/webhooks/whatsapp`

## Adding a chain

To add a chain's branches in one go, sign the owner up first, then:

```bash
npm run db:seed-chain -- chain.csv +919876543210 restaurant
```

The arguments are the file, the owner's phone, and the category for any row without one (`restaurant` if left out). The columns are `brand,branch,area,city,address,pincode,maps_url,fssai_number,fssai_expires_on,gstin,payout_account_id`, plus `category` if you want one per row. `payout_account_id` and `category` may be empty. Outlets start in review. The file goes in whole or not at all, and running it again skips branches the brand already has.
