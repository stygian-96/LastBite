import type { Metadata, Viewport } from "next";
import { Roboto } from "next/font/google";
import { Suspense, type ReactNode } from "react";
import { brand } from "@/config/brand";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const roboto = Roboto({
  variable: "--font-roboto",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

export const metadata: Metadata = {
  title: { default: `${brand.name} · Good food at closing-time prices`, template: `%s · ${brand.name}` },
  description:
    "Bakeries, cafés and restaurants in Bengaluru and Hyderabad sell tonight’s surplus food. Reserve, pay online and collect in person.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${roboto.variable} antialiased`}>
      <body className="min-h-dvh">
        <SessionProvider>
          <Suspense>{children}</Suspense>
        </SessionProvider>
      </body>
    </html>
  );
}
