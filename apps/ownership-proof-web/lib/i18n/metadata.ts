import type { Metadata } from "next";
import type { AppLocale } from "./locales";
import { localizedPath } from "./locales";

const productionOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://proof-tool.vercel.app";

const descriptions: Record<AppLocale, string> = {
  en: "If your Cardano wallet was compromised, rescued funds may be locked for you on-chain. Prove you're the original owner — on your own device — and claim them to a safe wallet. Your recovery phrase never leaves your device.",
  ja: "Cardanoウォレットが侵害された場合、救出された資金があなたのためにオンチェーンでロックされている可能性があります。元の所有者であることを自分の端末上で証明し、安全なウォレットへ請求できます。リカバリーフレーズが端末の外へ送信されることはありません。",
};

const titles: Record<AppLocale, string> = {
  en: "ReclaimGlobal — Cardano ownership recovery",
  ja: "ReclaimGlobal — Cardano所有権リカバリー",
};

export function rootMetadata(locale: AppLocale): Metadata {
  const title = titles[locale];
  const description = descriptions[locale];
  return {
    metadataBase: new URL(productionOrigin),
    title,
    description,
    alternates: pageAlternates(locale, "/"),
    openGraph: {
      title,
      description,
      type: "website",
      locale: locale === "ja" ? "ja_JP" : "en_US",
      alternateLocale: locale === "ja" ? ["en_US"] : ["ja_JP"],
    },
  };
}

export function pageMetadata(locale: AppLocale, route: "/claim" | "/reclaim"): Metadata {
  const pageTitle =
    route === "/claim"
      ? locale === "ja"
        ? "資金を請求"
        : "Claim funds"
      : locale === "ja"
        ? "資金をロック・寄付"
        : "Lock or donate funds";
  const description = descriptions[locale];
  return {
    title: `${pageTitle} | ReclaimGlobal`,
    description,
    alternates: pageAlternates(locale, route),
    openGraph: {
      title: `${pageTitle} | ReclaimGlobal`,
      description,
      locale: locale === "ja" ? "ja_JP" : "en_US",
      alternateLocale: locale === "ja" ? ["en_US"] : ["ja_JP"],
    },
  };
}

function pageAlternates(locale: AppLocale, route: "/" | "/claim" | "/reclaim"): NonNullable<Metadata["alternates"]> {
  return {
    canonical: localizedPath(locale, route),
    languages: {
      en: localizedPath("en", route),
      ja: localizedPath("ja", route),
      "x-default": localizedPath("en", route),
    },
  };
}
