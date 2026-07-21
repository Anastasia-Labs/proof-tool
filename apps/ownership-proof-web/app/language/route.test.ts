import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("language preference route", () => {
  it("sets a private locale cookie and redirects to an allowed Japanese route", () => {
    const response = GET(new NextRequest("https://proof-tool.vercel.app/language?locale=ja&returnTo=%2Fjp%2Fclaim"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://proof-tool.vercel.app/jp/claim");
    expect(response.headers.get("set-cookie")).toMatch(
      /^RECLAIM_LOCALE=ja; Path=\/; Expires=.*; Max-Age=31536000; Secure; HttpOnly; SameSite=lax$/u,
    );
  });

  it("rejects invalid locales and open-redirect destinations", async () => {
    const invalidLocale = GET(new NextRequest("https://proof-tool.vercel.app/language?locale=jp&returnTo=%2Fjp"));
    const externalReturn = GET(
      new NextRequest("https://proof-tool.vercel.app/language?locale=ja&returnTo=https%3A%2F%2Fevil.example"),
    );

    expect(invalidLocale.status).toBe(400);
    expect(externalReturn.status).toBe(400);
    await expect(externalReturn.json()).resolves.toEqual({ error: "Invalid language preference." });
  });
});
