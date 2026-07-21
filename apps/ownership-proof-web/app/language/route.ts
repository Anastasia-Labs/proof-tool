import { type NextRequest, NextResponse } from "next/server";
import type { AppLocale } from "../../lib/i18n/locales";
import { localeCookieName } from "../../lib/i18n/locales";

const allowedPaths = new Set(["/", "/claim", "/reclaim", "/jp", "/jp/claim", "/jp/reclaim"]);

export function GET(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale");
  const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/";
  if (!isAppLocale(locale) || !allowedPaths.has(returnTo)) {
    return NextResponse.json({ error: "Invalid language preference." }, { status: 400 });
  }

  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(localeCookieName, locale, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

function isAppLocale(value: string | null): value is AppLocale {
  return value === "en" || value === "ja";
}
