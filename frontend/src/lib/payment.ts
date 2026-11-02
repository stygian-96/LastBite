import { ApiError, mockControls, type PayInfo } from "@/lib/api";

const devCapture = process.env.NEXT_PUBLIC_DEV_CAPTURE === "1";

// True while no real money can move, so checkout can say so.
export const isTestPayment = !!mockControls || devCapture;

// Razorpay Checkout goes here. For now payment is a mocked success: the order is captured
// straight away, and the checkout page confirms it by polling as it will for real.
export async function completePayment(orderId: string, _info: PayInfo): Promise<void> {
  if (mockControls) {
    mockControls.capture(orderId);
    return;
  }
  if (devCapture) {
    const res = await fetch(`/dev/capture/${orderId}`, { method: "POST" });
    if (res.ok) return;
    throw new ApiError("payment_failed", "The test payment didn’t go through.", res.status);
  }
  throw new ApiError("payment_unavailable", "Online payment isn’t connected yet.");
}
