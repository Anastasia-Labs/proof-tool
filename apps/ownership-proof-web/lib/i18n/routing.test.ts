import { describe, expect, it } from "vitest";
import { parseAcceptLanguage, preferredLocale } from "./routing";

describe("locale negotiation", () => {
  it("selects Japanese for Japanese browser preferences", () => {
    expect(preferredLocale("ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
    expect(preferredLocale("fr-FR,ja;q=0.8,en;q=0.7")).toBe("ja");
  });

  it("respects quality values and defaults unsupported languages to English", () => {
    expect(preferredLocale("en-US;q=0.9,ja;q=0.8")).toBe("en");
    expect(preferredLocale("ja;q=0,en;q=0.5")).toBe("en");
    expect(preferredLocale("fr-FR,de;q=0.8")).toBe("en");
    expect(preferredLocale(null)).toBe("en");
  });

  it("lets an explicit language cookie override the browser header", () => {
    expect(preferredLocale("ja-JP", "en")).toBe("en");
    expect(preferredLocale("en-US", "ja")).toBe("ja");
    expect(preferredLocale("ja-JP", "unsupported")).toBe("ja");
  });

  it("orders valid entries by quality and ignores q=0", () => {
    expect(parseAcceptLanguage("en;q=0.4, ja-JP;q=0.9, fr;q=0")).toEqual([
      { language: "ja-jp", quality: 0.9, order: 1 },
      { language: "en", quality: 0.4, order: 0 },
    ]);
  });
});
