# Production plan

How LastBite goes from a laptop to a live site, cheaply, on AWS Mumbai. Written 14 Nov 2026 against `main` at `31751d4`.

## Where the code stands

What decides the plan, read from the code:

| Piece | State | Effect on launch |
|---|---|---|
| Backend (Hono, Node 24, Postgres) | Done, tested | Deploys as is |
| Frontend (Next.js 16) | Done, needs a Node server (dynamic routes, so no static export) | Deploys as is |
| Production mode | Refuses to start without Razorpay, messaging, S3 and `CRON_SECRET` (`backend/src/lib/env.ts`) | Real launch waits on those accounts |
| Payment in the browser | **Not built.** `frontend/src/lib/payment.ts` has no Razorpay Checkout yet | Blocks taking real money |
| SMS / WhatsApp | Generic adapter; needs a provider, likely behind a small relay | Blocks sign-in (OTP) in production |
| Files | Written for AWS S3, two buckets | Fits AWS directly |
| Cookies | `Secure`, `SameSite=Lax`, shared parent domain | Needs one real domain with `www.` and `api.` |
| Background jobs | One `POST /internal/jobs/tick` every minute, up to 5 min | Needs a cron caller |
| Database | Must not go through a transaction pooler | Rules out pooled endpoints (Neon/Supabase pooler in transaction mode) |
| Rate limits | Stored in Postgres | Safe to run more than one API instance later |

So: everything that exists can go live today as **staging**. Real customers need three more things, of which two are paperwork with lead time.

## Hosting: what and why

All in `ap-south-1` (Mumbai): close to users, and the S3 code already defaults there.

| Part | Service | Approx. cost / month |
|---|---|---|
| App server: Caddy (HTTPS) + frontend + API + cron | AWS Lightsail Linux, 2 GB | $12 |
| Database | Staging: Postgres in Compose on the same server, nightly dumps (`deploy/`). Before real money: Lightsail managed Postgres 16, standard | $0 now, $15 later |
| Files | S3, two buckets (public photos, private documents) | < $1 at launch |
| DNS | Cloudflare (free) or Route 53 ($0.50) | $0–1 |
| Domain | Any registrar | ~$10 / year |
| Uptime alerts | UptimeRobot free | $0 |
| Error tracking | Sentry free tier (optional) | $0 |
| **Total** | | **≈ $28 / month** |

Why this shape:

- **One box, Docker Compose.** At launch traffic one 2 GB machine runs both Node apps easily. Lightsail is flat-priced, so no surprise bills, and it's still AWS, so moving to ECS/RDS later is a lift, not a rewrite.
- **Managed database, not Postgres on the box.** This app holds money and bank details. Managed Postgres gives daily backups and point-in-time restore without us running it. It is the one place not to save $15.
- **Cron on the same box.** A crontab line with `curl` every minute. No extra service.
- **Lightsail can't attach an IAM role**, so S3 uses an IAM user whose keys can only touch the two buckets.

Cheaper still, if needed: Postgres on the same Lightsail box ($12 total) with nightly `pg_dump` to S3. Acceptable for staging, not for real money.

Alternatives considered: Vercel (Hobby plan is non-commercial, Pro is $20 for the frontend alone), Railway/Render (fine, but Singapore region and costs climb with two services + DB + cron), ECS Fargate + RDS (~$60+, overkill now).

## Phase 1: Staging live (this week, no external approvals)

Goal: the real stack running on the real domain, usable by the team and a few friendly vendors.

Run the backend in `NODE_ENV=development` with `DEV_FAKE_PROVIDERS=true`. Production mode won't start without Razorpay and messaging, and this mode is what the code offers for no-keys use. In it OTPs go to the server log (so only someone with log access can hand out codes) and Pay goes through the fake gateway. Files go to the fake store, so photos won't show yet.

1. **Domain.** Buy one. Plan for `www.<domain>` (frontend) and `api.<domain>` (API). Use `staging.` / `api-staging.` if the main names should stay free.
2. **AWS account.** Turn on MFA for root, make an admin IAM user, set a billing alarm at $40.
3. **Database.** Lightsail managed Postgres 16, Mumbai, standard plan. Public mode off; reachable only from the instance.
4. **Instance.** Lightsail Ubuntu, 2 GB, Mumbai. Static IP. Firewall: 22 (your IP only), 80, 443.
5. **DNS.** `A` records for `www` and `api` to the static IP.
6. **Repo additions** (small, one commit):
   - `backend/Dockerfile`: Node 24, `npm ci`, `npm run build`, `npm start`. Keep `tsx` available for `db:migrate` and `admin:super`, or compile the scripts.
   - `frontend/Dockerfile`: `next build` with `output: "standalone"` in `next.config.ts`. `NEXT_PUBLIC_*` are baked in at build time, so pass them as build args.
   - `deploy/compose.yaml`: `caddy`, `api`, `web`.
   - `deploy/Caddyfile`: `www.<domain> → web:3000`, `api.<domain> → api:4000`. Caddy gets certificates itself.
   - `deploy/README.md`: the deploy and rollback steps below.
7. **Server env** (`/opt/lastbite/api.env`, mode 600, never in git):
   - `FRONTEND_ORIGIN=https://www.<domain>`, `COOKIE_DOMAIN=<domain>`
   - `TRUST_PROXY=true`, `TRUSTED_PROXY_HOPS=1` (Caddy in front)
   - Fresh `ENCRYPTION_KEY`, `SESSION_SECRET`, `CRON_SECRET`. **Store `ENCRYPTION_KEY` in a password manager too:** losing it makes every saved bank account unreadable.
   - `DATABASE_URL` to the managed DB, direct connection, `?sslmode=require`.
8. **Frontend build args:** `NEXT_PUBLIC_API_MOCK=0`, `NEXT_PUBLIC_API_URL=https://api.<domain>/api/v1`. The built site always runs with `NODE_ENV=production`, so its fake-Pay route (`src/app/dev/capture/[id]/route.ts`) answers 404 there. In staging, finish a payment with the backend's dev capture `curl` from `backend/README.md`, or change that route to check its own flag.
9. **First run:** `docker compose up -d`, then `npm run db:migrate`, `npm run db:seed`, `npm run admin:super -- <your number>` inside the api container.
10. **Cron:** `* * * * * curl -fsS -m 300 -X POST https://api.<domain>/api/v1/internal/jobs/tick -H "x-cron-secret: …"`, logging the response so `failed` entries can be seen.
11. **Checks:** UptimeRobot on `https://api.<domain>/api/v1/health` and the home page. Walk the whole flow once: apply as vendor → approve in `/admin` → publish a bag → reserve → pay → collect.

Deploys: `git pull && docker compose build && docker compose up -d && docker compose exec api npm run db:migrate`. Rollback: check out the previous commit and run the same. Migrations only go forward, so write each one to be safe against the previous code.

## Phase 2: Unblock real launch (start now, runs in parallel; weeks of lead time)

These are the long poles. Start them on day one.

**Razorpay** (payments, plus Route for vendor payouts)
- Sign up and do business KYC. Activation asks for a live website with Terms, Privacy, Refund/Cancellation, Contact and Shipping/Delivery pages. Phase 1 gives you the live site; the pages still need writing.
- Ask for **Route** (linked accounts) separately. The payouts code depends on it, and it needs its own approval.
- Test-mode keys are free and immediate: use them to build Checkout.
- `RAZORPAY_LINKED_EMAIL_DOMAIN` can be the same domain.

**SMS and WhatsApp** (OTP and order messages)
- Indian SMS needs **DLT registration** (entity, sender ID, every template approved). Typically 1–3 weeks. Do it through the provider (MSG91, Gupshup, or similar).
- WhatsApp needs Meta Business verification and approved templates; it can follow SMS.
- The backend posts its own JSON shape (see `backend/README.md`, Messaging). Unless the provider accepts that, add a small relay. A ~50-line route on the same box is enough.

**Code work**
- **Razorpay Checkout** in `frontend/src/lib/payment.ts`. The backend start/webhook/reconcile flow is already there. This is the one real feature left before launch.
- **Policy pages** on the frontend (Terms, Privacy, Refund, Contact).
- Messaging relay, if the chosen provider needs one.
- From `frontend/API-GAPS.md`, decide which gaps matter for day one. Most are cosmetic.

**AWS for real files**
- Create the two S3 buckets: public with public read on objects; private with Block Public Access on. Both need CORS allowing `PUT` from `https://www.<domain>` with `Content-Type`.
- IAM user limited to `s3:PutObject` / `s3:GetObject` on those two buckets; keys go in `api.env`.

## Phase 3: Switch to production

When Razorpay is live and SMS templates are approved:

1. Fill in the Razorpay, messaging and S3 variables in `api.env`. Set `NODE_ENV=production` (or rely on `npm start`) and remove `DEV_FAKE_PROVIDERS`. The server says what's missing if anything is.
2. Rebuild the frontend with `NEXT_PUBLIC_DEV_CAPTURE=0` and no `DEV_CAPTURE_SECRET`.
3. Point webhooks: Razorpay → `https://api.<domain>/api/v1/webhooks/razorpay`, messaging → `/api/v1/webhooks/whatsapp`.
4. **Start from a clean database:** staging data has fake payments. Make a new database (or drop and re-migrate), seed areas, make the super admin.
5. One real ₹1 order end to end, refund it, and check the money and messages arrive.
6. Soft launch: one area, a handful of vendors.

## Before real money: the short checklist

- [ ] Managed DB backups on; a restore actually tried once
- [ ] `ENCRYPTION_KEY`, `SESSION_SECRET`, `CRON_SECRET` in a password manager, nowhere in git
- [ ] SSH by key only, port 22 limited to your IP; automatic security updates on
- [ ] Alert when the tick returns anything in `failed` (or stops running)
- [ ] Uptime alerts on API health and home page
- [ ] Billing alarm on AWS
- [ ] Razorpay webhook secret set and a test webhook received
- [ ] Logs kept somewhere you can read after a restart (Docker `json-file` with rotation is enough to start)

## Later, when it grows

- CloudFront in front of the public bucket (`S3_PUBLIC_BASE_URL`) once photos get real traffic.
- A second instance behind a Lightsail load balancer. Rate limits are in Postgres, so this works; the cron should still run from one place only. The tick takes a lock, so double calls are safe anyway.
- CI: GitHub Actions running `npm test` (needs a Postgres service) and building the images, then deploying over SSH.
- Move to RDS + ECS if the box outgrows a 4 GB Lightsail plan.
