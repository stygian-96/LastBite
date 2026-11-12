import { redirect } from "next/navigation";

// The short link in vendor WhatsApp and SMS messages about their application.
export default function PartnerLink() {
  redirect("/vendor/application");
}
