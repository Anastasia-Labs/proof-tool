import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

describe("locale middleware", () => {
  it("redirects Japanese browsers to the matching /jp route and preserves search parameters", () => {
    const request = new NextRequest("https://proof-tool.vercel.app/claim?fixtureState=deployment-review", {
      headers: { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" },
    });

    const response = middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://proof-tool.vercel.app/jp/claim?fixtureState=deployment-review",
    );
    expect(response.headers.get("vary")).toBe("Accept-Language, Cookie");
  });

  it("serves English in place when preferred or explicitly selected", () => {
    const englishBrowser = middleware(
      new NextRequest("https://proof-tool.vercel.app/reclaim", {
        headers: { "accept-language": "en-US,en;q=0.9" },
      }),
    );
    const englishCookie = middleware(
      new NextRequest("https://proof-tool.vercel.app/", {
        headers: { "accept-language": "ja-JP", cookie: "RECLAIM_LOCALE=en" },
      }),
    );

    expect(englishBrowser.headers.get("x-middleware-next")).toBe("1");
    expect(englishCookie.headers.get("x-middleware-next")).toBe("1");
    expect(englishBrowser.headers.get("vary")).toBe("Accept-Language, Cookie");
  });
});
