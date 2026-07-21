import { describe, expect, it } from "vitest";
import { alternateLocale, languageSwitchPath, localizedPath } from "./locales";

describe("locale paths", () => {
  it("keeps English routes unprefixed and exposes Japanese at /jp", () => {
    expect(localizedPath("en", "/")).toBe("/");
    expect(localizedPath("en", "/claim")).toBe("/claim");
    expect(localizedPath("ja", "/")).toBe("/jp");
    expect(localizedPath("ja", "/claim")).toBe("/jp/claim");
    expect(localizedPath("ja", "/reclaim")).toBe("/jp/reclaim");
  });

  it("builds an allowlisted language preference route", () => {
    expect(alternateLocale("en")).toBe("ja");
    expect(alternateLocale("ja")).toBe("en");
    expect(languageSwitchPath("ja", "/jp/claim")).toBe("/language?locale=ja&returnTo=%2Fjp%2Fclaim");
  });
});
