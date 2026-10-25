import { NextResponse, type NextRequest } from "next/server";

/*
 * Public demo: give every browser its own sandbox id (a cookie), and pass it to
 * the API routes on a request header so each visitor gets a separate copy of
 * the demo (see runtimeFor in src/server/runtime.ts). Off unless PUBLIC_DEMO=1.
 */

const COOKIE = "moa_sandbox";
const HEADER = "x-moa-sandbox";

export function proxy(request: NextRequest) {
  if (process.env.PUBLIC_DEMO !== "1" && process.env.PUBLIC_DEMO !== "true") return NextResponse.next();
  const existing = request.cookies.get(COOKIE)?.value;
  const id = existing && /^[a-z0-9-]{16,64}$/i.test(existing) ? existing : crypto.randomUUID();
  const headers = new Headers(request.headers);
  // Always from the cookie, never from the client: a request cannot pick someone else's sandbox by header.
  headers.set(HEADER, id);
  const response = NextResponse.next({ request: { headers } });
  if (id !== existing) {
    response.cookies.set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 12 });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|logos/).*)"],
};
