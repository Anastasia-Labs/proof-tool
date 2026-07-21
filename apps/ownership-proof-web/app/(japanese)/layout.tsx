import { Inter } from "next/font/google";
import { I18nProvider } from "../../components/I18nProvider";
import { rootMetadata } from "../../lib/i18n/metadata";
import "../globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = rootMetadata("ja");

export default function JapaneseRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className={inter.className}>
        <I18nProvider locale="ja">{children}</I18nProvider>
      </body>
    </html>
  );
}
