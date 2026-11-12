"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { VendorDetailView } from "@/components/admin";
import { ErrorState, Logo, PageSkeleton } from "@/components/ui";
import { api, errorMessage, errorStatus } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useSession } from "@/lib/session";

export default function AdminVendor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useSession();
  const vendor = useQuery(() => api.getVendor(id), [id, me?.id], { enabled: !!me, pollMs: 30_000 });

  useEffect(() => {
    if (!loading && !me) router.replace(`/signin?next=/admin/vendors/${id}`);
  }, [loading, me, router, id]);

  if (loading || !me || vendor.loading) return <PageSkeleton />;

  let body;
  if (errorStatus(vendor.error) === 403) body = <p className="text-sm text-muted">Admins only.</p>;
  else if (errorStatus(vendor.error) === 404) body = <p className="text-sm text-muted">This vendor doesn&rsquo;t exist, or hasn&rsquo;t applied yet.</p>;
  else if (vendor.error && !vendor.data) body = <ErrorState message={errorMessage(vendor.error)} onRetry={vendor.reload} />;
  else body = <VendorDetailView vendor={vendor.data!} onChanged={vendor.reload} />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center gap-3">
        <Link href="/admin#vendors" className="text-sm text-ink no-underline">
          ‹ Vendors
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <Logo size="sm" />
          <span className="text-sm text-muted">admin</span>
        </span>
      </div>
      {body}
    </div>
  );
}
