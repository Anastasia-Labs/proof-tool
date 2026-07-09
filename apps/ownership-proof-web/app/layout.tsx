import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ownership Recovery",
  description: "Claim swept Cardano funds with local ownership proofs and owner-bound reclaim contracts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
