import { describe, expect, it } from "vitest";
import { pageMetadata, rootMetadata } from "./metadata";

describe("localized metadata", () => {
  it("self-canonicalizes Japanese pages and publishes language alternatives", () => {
    const metadata = pageMetadata("ja", "/claim");

    expect(metadata.title).toBe("資金を請求 | ReclaimGlobal");
    expect(metadata.alternates).toEqual({
      canonical: "/jp/claim",
      languages: { en: "/claim", ja: "/jp/claim", "x-default": "/claim" },
    });
    expect(metadata.openGraph).toMatchObject({ locale: "ja_JP", alternateLocale: ["en_US"] });
  });

  it("sets the production metadata base and Japanese root copy", () => {
    const metadata = rootMetadata("ja");

    expect(metadata.metadataBase?.toString()).toBe("https://proof-tool.vercel.app/");
    expect(metadata.title).toBe("ReclaimGlobal — Cardano所有権リカバリー");
    expect(metadata.description).toContain("リカバリーフレーズ");
  });
});
