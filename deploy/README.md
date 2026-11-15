# Deploying LastBite

One server runs everything with Docker Compose:

| Service | What |
|---|---|
| `caddy` | HTTPS for both domains. The only thing open to the internet |
| `web` | The website, from `../frontend` |
| `api` | The API, from `../backend` |
| `db` | Postgres 16, data in the `pgdata` volume |
| `cron` | Calls the job tick every minute |
| `backup` | Dumps the database into `./backups` every night, keeping 14 |

## Server setup, once

A Lightsail Ubuntu instance (2 GB) in Mumbai, with a static IP. Firewall: 22 from your IP, 80 and 443 from anywhere. Point `A` records for both domains at the static IP before starting, so Caddy can get certificates.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # then log out and back in
git clone <repo-url> lastbite
cd lastbite/deploy
cp .env.example .env
chmod 600 .env
nano .env                         # domains and secrets
```

## First start

```bash
docker compose up -d --build
docker compose exec api tsx scripts/migrate.ts
docker compose exec api tsx scripts/seed-areas.ts
docker compose exec api tsx scripts/make-super-admin.ts 9876543210
```

Then open `https://<WEB_DOMAIN>/admin` and sign in with that number.

## Deploy a new version

```bash
cd ~/lastbite && git pull
cd deploy
docker compose up -d --build
docker compose exec api tsx scripts/migrate.ts
```

To roll back, `git checkout <previous commit>` and run the same. Migrations only go forward, so write each one to work with the code before it too.

## Everyday

```bash
docker compose ps                    # what's running
docker compose logs -f api           # API log, including sign-in codes in staging
docker compose logs --tail 20 cron   # last ticks: look for anything in "failed"
docker compose restart api
```

## Staging, until Razorpay and SMS are connected

`.env.example` starts in staging: `NODE_ENV=development` with `DEV_FAKE_PROVIDERS=true`.

- **Sign in:** no SMS goes out. The code is in `docker compose logs api`. Pass it on to whoever is testing.
- **Pay:** with `TEST_PAYMENTS=1`, Pay finishes without any money moving, and checkout says it's a test.
- **Photos and documents:** uploads are accepted but not stored, so no images show.

To turn test payments off, or once Razorpay Checkout is built, set `TEST_PAYMENTS=0` and rebuild the site with `docker compose up -d --build web`. Then delete the test route, `frontend/src/app/dev/capture/[id]/route.ts`.

## Going to production

1. In `.env`, delete `DEV_FAKE_PROVIDERS` and `TEST_PAYMENTS`, set `NODE_ENV=production`, and fill in the Razorpay and messaging lines (and S3, if staging didn't already). The API refuses to start, and names what's missing, until all are set.
2. Start from an empty database, since staging's payments are fake:
   ```bash
   docker compose down
   docker volume rm deploy_pgdata
   docker compose up -d --build
   ```
   Then run the three First start scripts again.
3. Point Razorpay's webhook at `https://<API_DOMAIN>/api/v1/webhooks/razorpay` and the messaging provider's at `/api/v1/webhooks/whatsapp`.

## Backups

The nightly dumps in `./backups` are on the same disk as the database, so they don't survive losing the server. Copy them off it as well, for example with a daily crontab line on the server:

```bash
aws s3 sync ~/lastbite/deploy/backups s3://<backup-bucket>/db/
```

Also turn on Lightsail's automatic snapshots for the instance.

To restore a dump into an empty database:

```bash
gunzip -c backups/lastbite-YYYYMMDD-HHMM.sql.gz | docker compose exec -T db psql -U lastbite lastbite
```

## Behind Cloudflare's proxy

If Cloudflare's orange cloud is on for these domains, there are two proxies in front of the API. Add `TRUSTED_PROXY_HOPS=2` to `.env`, or rate limits see Cloudflare's address instead of the visitor's.
