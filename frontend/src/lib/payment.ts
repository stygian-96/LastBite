import { ApiError, mockControls, type PayInfo } from "@/lib/api";

// Razorpay Checkout goes here. For now payment is a mocked success: the order is captured
// straight away, and the checkout page confirms it by polling as it will for real.
export async function completePayment(orderId: string, _info: PayInfo): Promise<void> {
  if (mockControls) {
    mockControls.capture(orderId);
    return;
  }
  throw new ApiError("payment_unavailable", "Online payment isn’t connected yet.");
}
