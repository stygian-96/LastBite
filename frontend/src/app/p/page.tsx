import { redirect } from "next/navigation";

// The short link in vendor WhatsApp and SMS messages: signs them in if needed, then the right page.
export default function PartnerLink() {
  redirect("/partner/start");
}
