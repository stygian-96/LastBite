import type { NextRequest } from "next/server";

// Test payments: finishes a payment on a backend running its fake gateway, until Razorpay is
// connected. On only when the site is built with NEXT_PUBLIC_DEV_CAPTURE=1 and given the secret,
// which stays on the server. The backend mounts its side only with DEV_FAKE_PROVIDERS on, so a
// production backend refuses it whatever this route does. Remove both with Razorpay Checkout.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.DEV_CAPTURE_SECRET;
  if (!secret || process.env.NEXT_PUBLIC_DEV_CAPTURE !== "1") return new Response(null, { status: 404 });
  const { id } = await params;
  // On a server, the API's address inside the private network. Locally, the public one.
  const api = process.env.DEV_CAPTURE_API_URL || process.env.NEXT_PUBLIC_API_URL;
  const res = await fetch(`${api}/internal/dev/capture/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
}
