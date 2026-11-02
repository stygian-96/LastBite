import { Suspense, type ReactNode } from "react";
import { PageSkeleton } from "@/components/ui";

// useSearchParams on a static page needs a Suspense boundary.
export default function SignInLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
