"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ErrorState, PageSkeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { vendorHome } from "@/lib/vendor-home";

// The one way into the partner side: sign in first, then pick up where the vendor left off.
export default function PartnerStart() {
  const router = useRouter();
  const { me, loading } = useSession();
  const outlets = useQuery(() => api.getVendorOutlets(), [me?.id], { enabled: !!me });

  useEffect(() => {
    if (!loading && !me) router.replace("/signin?next=/partner/start");
    else if (outlets.data) router.replace(vendorHome(outlets.data));
  }, [loading, me, outlets.data, router]);

  if (outlets.error && !outlets.data) return <ErrorState message={errorMessage(outlets.error)} onRetry={outlets.reload} />;
  return <PageSkeleton />;
}
