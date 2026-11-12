import { redirect } from "next/navigation";

// The application now lives in the vendor dashboard.
export default function Status() {
  redirect("/vendor/application");
}
