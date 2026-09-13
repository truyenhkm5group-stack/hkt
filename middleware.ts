import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PREFIXES = ["/login", "/api/webhooks", "/api/health", "/api/sync", "/_next", "/favicon", "/icon", "/apple-icon", "/manifest", "/robots"];
const COOKIE = "erp_session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();

  const token = request.cookies.get(COOKIE)?.value;
  /*
    Cùng luật với `lib/env.ts`: trên production thiếu AUTH_SECRET là cửa mở, không phải bất tiện.
    Middleware chạy ở Edge nên không import được `lib/env`; luật phải chép lại đúng ở đây, và
    `tests/scope-enforcement.test.ts` kiểm hai chỗ nói cùng một câu.
  */
  const secret = process.env.AUTH_SECRET?.trim() || (process.env.NODE_ENV === "production" ? "" : "dev-secret-change-me-please-32-chars-min");
  if (!secret) return NextResponse.json({ error: "Máy chủ chưa cấu hình AUTH_SECRET" }, { status: 500 });
  let valid = false;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      valid = true;
    } catch {
      valid = false;
    }
  }
  if (valid) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
