import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import {
  SESSION_COOKIE,
  SESSION_LOGIN_CLAIM,
  claimsFrom,
  cookieMaxAgeSec,
  decideRenewal,
  sessionCookieSecure,
} from "@/lib/constants/session";

const PUBLIC_PREFIXES = ["/login", "/api/webhooks", "/api/health", "/api/sync", "/_next", "/favicon", "/icon", "/apple-icon", "/manifest", "/robots"];
const COOKIE = SESSION_COOKIE;

/**
 * ═══════════ GIA HẠN TRƯỢT: VÌ SAO NÓ PHẢI NẰM Ở ĐÂY ═══════════
 *
 * Cookie chỉ ghi được ở Server Action, Route Handler hoặc middleware. Nó KHÔNG ghi được trong lúc
 * dựng trang (Next ném lỗi), mà dựng trang lại đúng là thứ người dùng làm cả ngày. Middleware là
 * chỗ duy nhất thấy được MỌI lượt gọi — điều hướng, `/api/events`, `/api/notifications` — nên nó
 * là chỗ duy nhất gia hạn được mà không phải bắt trình duyệt gọi thêm một địa chỉ riêng.
 *
 * ─── CHỈ GET/HEAD, VÀ ĐÂY KHÔNG PHẢI MỘT CHI TIẾT NHỎ ───
 *
 * Một lượt POST có thể là `logoutAction` — hàm đó XOÁ cookie. Nếu middleware cũng ghi cookie trên
 * cùng một phản hồi thì hai lệnh `Set-Cookie` đua nhau, và cái thua là "đăng xuất không ăn". Một
 * nút Đăng xuất thỉnh thoảng không đăng xuất là lỗi an ninh, không phải lỗi giao diện.
 *
 * Bỏ POST đi không mất gì: người dùng nào cũng GET trước khi POST, và cả hai bộ đếm nền
 * (`/api/events`, `/api/notifications` 30 giây/lần) đều là GET.
 *
 * ─── MIDDLEWARE KHÔNG BIẾT NGƯỜI NÀY CÒN ĐƯỢC PHÉP DÙNG ERP KHÔNG ───
 *
 * Ở Edge không có CSDL, nên nó chỉ kiểm được CHỮ KÝ và HẠN. Việc "tài khoản còn hoạt động không,
 * quyền tới đâu" do `getCurrentUser()` làm — và hàm đó đọc CSDL ở MỌI lần dựng trang và MỌI route
 * `/api/*`. Nên một tài khoản vừa bị khoá vẫn có thể được gia hạn cookie ở đây, nhưng mọi màn hình
 * và mọi API vẫn từ chối nó ngay lập tức. Trần tuyệt đối trong `lib/constants/session.ts` là thứ
 * chặn cookie ấy sống mãi.
 */
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
  const key = new TextEncoder().encode(secret);

  let payload: Record<string, unknown> | null = null;
  if (token) {
    try {
      payload = (await jwtVerify(token, key)).payload as Record<string, unknown>;
    } catch {
      // Chữ ký sai hoặc đã hết hạn — cả hai đều là "chưa đăng nhập" ở đây.
      payload = null;
    }
  }

  if (payload) {
    const res = NextResponse.next();
    if (request.method === "GET" || request.method === "HEAD") {
      const nowSec = Math.floor(Date.now() / 1000);
      const quyet = decideRenewal(claimsFrom(payload), nowSec);
      if (quyet.renew) {
        const moi = await new SignJWT({
          // Giữ NGUYÊN danh tính của token cũ. Không đọc lại từ đâu cả: ba trường này chỉ để hiển
          // thị, còn vai trò và quyền THẬT được `getCurrentUser()` nạp lại từ CSDL ở mỗi lần dựng.
          email: payload.email,
          name: payload.name,
          role: payload.role,
          // Mốc đăng nhập gốc đi theo token, nếu không thì mỗi lần gia hạn là một lần dời trần sống.
          [SESSION_LOGIN_CLAIM]: quyet.loginAtSec,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(String(payload.sub ?? ""))
          .setIssuedAt(nowSec)
          .setExpirationTime(quyet.expiresAtSec)
          .sign(key);
        res.cookies.set(COOKIE, moi, {
          httpOnly: true,
          sameSite: "lax",
          secure: sessionCookieSecure(process.env.NODE_ENV, process.env.APP_URL, request.nextUrl.protocol),
          path: "/",
          maxAge: cookieMaxAgeSec(quyet.expiresAtSec, nowSec),
        });
      }
    }
    return res;
  }

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
