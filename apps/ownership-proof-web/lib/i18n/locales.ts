export const locales = ["en", "ja"] as const;

export type AppLocale = (typeof locales)[number];

export const localeCookieName = "RECLAIM_LOCALE";

export function localizedPath(locale: AppLocale, path: string): string {
  const normalized = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (locale === "en") {
    return normalized;
  }
  return normalized === "/" ? "/jp" : `/jp${normalized}`;
}

export function alternateLocale(locale: AppLocale): AppLocale {
  return locale === "ja" ? "en" : "ja";
}

export function languageSwitchPath(locale: AppLocale, returnTo: string): string {
  const params = new URLSearchParams({ locale, returnTo });
  return `/language?${params.toString()}`;
}
