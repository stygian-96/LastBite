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

## Run it against the backend

Set `NEXT_PUBLIC_API_MOCK=0` and `NEXT_PUBLIC_API_URL` to the API, including `/api/v1`. See [API-GAPS.md](API-GAPS.md) first: some fields aren't on `main` yet, and online payment isn't connected. `src/lib/payment.ts` is where Razorpay Checkout goes.

## Where things are

| Path | What |
|---|---|
| `src/config/brand.ts` | Brand name and sample rates. The brand is undecided, so change it only here |
| `src/lib/api/` | Types, client, mock |
| `src/components/` | Shared UI, customer and vendor pieces |
| `src/app/` | Pages |
