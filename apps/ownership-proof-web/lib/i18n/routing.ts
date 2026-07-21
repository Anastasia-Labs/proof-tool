import type { AppLocale } from "./locales";

type WeightedLanguage = {
  language: string;
  quality: number;
  order: number;
};

export function preferredLocale(acceptLanguage: string | null, cookieLocale?: string | null): AppLocale {
  if (cookieLocale === "en" || cookieLocale === "ja") {
    return cookieLocale;
  }

  const languages = parseAcceptLanguage(acceptLanguage);
  for (const candidate of languages) {
    const primary = candidate.language.split("-", 1)[0]?.toLowerCase();
    if (primary === "ja") {
      return "ja";
    }
    if (primary === "en" || candidate.language === "*") {
      return "en";
    }
  }
  return "en";
}

export function parseAcceptLanguage(value: string | null): WeightedLanguage[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry, order) => {
      const [rawLanguage, ...parameters] = entry.trim().split(";");
      const language = rawLanguage?.trim().toLowerCase() ?? "";
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter);
        if (match) {
          quality = Number.parseFloat(match[1]);
        }
      }
      return { language, quality, order };
    })
    .filter((entry) => entry.language !== "" && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order);
}
