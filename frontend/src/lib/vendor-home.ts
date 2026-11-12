import type { VendorOutlet } from "@/lib/api";

const LAST_STEP = 6;

/**
 * Where a vendor should land: the form for a new applicant, the step a first draft stopped at, the
 * application page once it has been sent (or sent back, or rejected), and the dashboard once live.
 */
export function vendorHome(outlets: VendorOutlet[]): string {
  const open = outlets.filter((o) => o.status !== "closed");
  if (open.length === 0) return "/partner/apply/1";
  if (open.some((o) => o.status === "live" || o.status === "suspended")) return "/vendor";
  const draft = open.find((o) => o.status === "draft" && !o.submittedAt);
  if (draft && open.length === 1) {
    // onboarding_step is the next step to fill; the listing step (5) is followed by the agreement.
    return `/partner/apply/${Math.min(LAST_STEP, Math.max(2, draft.onboardingStep + (draft.onboardingStep >= 5 ? 1 : 0)))}`;
  }
  return "/vendor/application";
}
