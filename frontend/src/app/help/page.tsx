import type { Metadata } from "next";
import { TopBar } from "@/components/ui";

export const metadata: Metadata = { title: "Help" };

const ANSWERS = [
  ["If the vendor cancels", "You get a full refund automatically, to the way you paid. It usually takes 5–7 working days."],
  ["If you miss your pickup", "The order is forfeited and there’s no refund, because the food can’t be held overnight."],
  ["If you can’t pay in time", "Your hold ends after 5 minutes and the bag goes back on sale. You aren’t charged."],
  ["If something’s wrong with your bag", "Open Orders, find the order and tap Report a problem. We reply on WhatsApp within 24 hours."],
];

export default function Help() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col">
      <TopBar title="Help" back="/browse" />
      <div className="flex flex-col gap-2.5 px-4 pb-8 pt-2">
        <h1 className="mb-1 text-2xl font-bold">Help &amp; refund policy</h1>
        {ANSWERS.map(([question, answer]) => (
          <section key={question} className="flex flex-col gap-1 rounded-[18px] bg-fill p-4">
            <h2 className="text-[15px] font-medium">{question}</h2>
            <p className="text-sm leading-relaxed text-body">{answer}</p>
          </section>
        ))}
        <p className="pt-2 text-[13px] text-muted">Full terms and privacy policy are on the way.</p>
      </div>
    </div>
  );
}
