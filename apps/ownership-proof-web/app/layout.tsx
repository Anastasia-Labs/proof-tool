import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Credential Proof",
  description: "Generate and verify a Cardano payment key credential proof.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
