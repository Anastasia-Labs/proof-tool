import { Inter } from "next/font/google";
import { I18nProvider } from "../../components/I18nProvider";
import { rootMetadata } from "../../lib/i18n/metadata";
import "../globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = rootMetadata("en");

export default function EnglishRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <I18nProvider locale="en">{children}</I18nProvider>
      </body>
    </html>
  );
}
