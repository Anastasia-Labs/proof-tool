import { type NextRequest, NextResponse } from "next/server";
import { localeCookieName, localizedPath } from "./lib/i18n/locales";
import { preferredLocale } from "./lib/i18n/routing";

export function middleware(request: NextRequest) {
  const locale = preferredLocale(request.headers.get("accept-language"), request.cookies.get(localeCookieName)?.value);
  if (locale !== "ja") {
    const response = NextResponse.next();
    response.headers.set("Vary", "Accept-Language, Cookie");
    return response;
  }

  const destination = request.nextUrl.clone();
  destination.pathname = localizedPath("ja", destination.pathname);
  const response = NextResponse.redirect(destination);
  response.headers.set("Vary", "Accept-Language, Cookie");
  return response;
}

export const config = {
  matcher: ["/", "/claim", "/reclaim"],
};
