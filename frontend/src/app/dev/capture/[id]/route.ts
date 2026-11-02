import type { NextRequest } from "next/server";

// Local only: finishes a payment on a backend running its fake gateway, until Razorpay is
// connected. The secret stays on the server, and this answers 404 anywhere else.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.DEV_CAPTURE_SECRET;
  if (!secret || process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const { id } = await params;
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/internal/dev/capture/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
}
