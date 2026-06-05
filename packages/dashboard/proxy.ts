import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const PUBLIC_PATHS = ["/", "/login", "/forgot-password", "/reset-password", "/pricing", "/v2", "/blog", "/terms", "/privacy"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static/API paths — skip
  if (pathname.startsWith("/_next") || pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  // GEO machine view: handled client-side by &lt;MachineMode /&gt; reading
  // ?mode=machine from the URL and toggling a CSS class on &lt;html&gt;. The page
  // renders normally but with markdown-styled visual transform (dark, mono,
  // hash prefixes on headings). Optimized for vision-based agents browsing
  // the page (Claude computer-use, ChatGPT browsing, Operator). Raw markdown
  // for text scrapers stays at /llms.txt and /llms-full.txt.

  const sessionCookie = getSessionCookie(request);

  // Authenticated user hitting /login → redirect to dashboard
  if (pathname === "/login" && sessionCookie) {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  // Public paths — no auth required
  if (PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/blog") || pathname.startsWith("/case-studies")) {
    return NextResponse.next();
  }

  // CLI auth page — allow with session (it's a standalone page)
  if (pathname === "/cli-auth") {
    if (!sessionCookie) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // Protected paths — redirect to login if no session
  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    const redirect = request.nextUrl.search
      ? `${pathname}${request.nextUrl.search}`
      : pathname;
    loginUrl.searchParams.set("redirect", redirect);
    return NextResponse.redirect(loginUrl);
  }

  // Onboarding page — assign A/B variant cookie
  if (pathname.startsWith("/onboarding")) {
    const forced = request.nextUrl.searchParams.get("variant")?.toUpperCase();
    const needsCookie = forced === "A" || forced === "B" || !request.cookies.get("onboarding_variant");
    if (needsCookie) {
      const response = NextResponse.next();
      const variant = forced === "A" || forced === "B" ? forced : "A";
      response.cookies.set("onboarding_variant", variant, {
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
        sameSite: "lax",
      });
      return response;
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*$).*)",
  ],
};
