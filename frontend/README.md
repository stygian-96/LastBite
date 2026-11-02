# LastBite frontend

Next.js website for customers, vendors and admins. Every page fetches in the browser through one typed client in `src/lib/api/`.

## Run it with no backend

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000. With `NEXT_PUBLIC_API_MOCK=1`, a mock in `src/lib/api/mock.ts` stands in for the API and keeps its state in the browser's localStorage.

Sign in with any 10-digit number and any 6-digit code except `000000`.

| Number starts | You are |
|---|---|
| `90000` | A brand new customer or vendor |
| `98860` | Owner of Butterfold Bakehouse, two outlets (`/vendor`) |
| `99999` | Admin (`/admin`) |
| Anything else | Priya, a customer with past orders |

Dessert Surprise Bag shows one left but loses the race on Reserve, to show `sold_out`. Clear the site's localStorage to reset.

## Run it against a local backend

Start the backend as its README says, with `NODE_ENV=development`, `DEV_FAKE_PROVIDERS=true` and a `CRON_SECRET`. Then in `.env.local`:

```bash
NEXT_PUBLIC_API_MOCK=0
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_DEV_CAPTURE=1
DEV_CAPTURE_SECRET=the backend's CRON_SECRET
```

- **Sign in:** the code is printed in the backend's console.
- **Pay:** with `NEXT_PUBLIC_DEV_CAPTURE=1`, Pay finishes through the backend's fake gateway, via `src/app/dev/capture/[id]/route.ts`. That route keeps the secret on the server and answers 404 in production. Razorpay Checkout goes in `src/lib/payment.ts`.
- **Admin:** no route makes an admin, so set `is_admin` on your user in the dev database.
- **An empty database:** apply as a vendor at `/partner`, approve it at `/admin`, then publish tonight's quantity at `/vendor`.

[API-GAPS.md](API-GAPS.md) lists what the backend doesn't give yet.

## Where things are

| Path | What |
|---|---|
| `src/config/brand.ts` | Brand name and sample rates. The brand is undecided, so change it only here |
| `src/lib/api/` | Types, client, mock |
| `src/components/` | Shared UI, customer and vendor pieces |
| `src/app/` | Pages |
