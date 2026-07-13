import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const description =
  "If your Cardano wallet was compromised, rescued funds may be locked for you on-chain. Prove you're the original owner — on your own device — and claim them to a safe wallet. Your recovery phrase never leaves your device.";

export const metadata: Metadata = {
  title: "ReclaimGlobal — Cardano ownership recovery",
  description,
  openGraph: {
    title: "ReclaimGlobal — Cardano ownership recovery",
    description,
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
