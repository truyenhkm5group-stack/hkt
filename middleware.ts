import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { hostSlug } from "@/lib/platform/host";
import { BRAND_ASSET_PREFIX, brandAppOrigin, brandIconPath, brandOfHost, ERP_SITE_BRAND_HEADER, matchSite, SITE_LEGAL_PATHS, SITE_PAGE_PATH, siteRoute, type SiteEnv } from "@/lib/platform/site-host";
import { WIDGET_EMBED_PATH, WIDGET_SCRIPT_PATH } from "@/lib/sales-chatbot/widget";
import {
  ERP_HEADER_PREFIX,
  ERP_HOST_SLUG_HEADER,
  ERP_METHOD_HEADER, ERP_PATH_HEADER,
  SESSION_COOKIE,
  claimsFrom,
  cookieMaxAgeSec,
  decideRenewal,
  renewalClaims,
  sessionCookieSecure,
} from "@/lib/constants/session";

/**
 * ĐƯỜNG KHÔNG ĐI QUA PHIÊN ĐĂNG NHẬP — MỖI MỤC TỰ XÁC THỰC BẰNG CÁCH KHÁC.
 *
 * Middleware này chạy TRƯỚC mọi route handler, nên một tuyến máy-gọi-máy không có tên ở đây sẽ
 * nhận 401 mà KHÔNG BAO GIỜ chạy tới phép kiểm khoá của chính nó — và người vận hành thấy 401 sẽ
 * đi tìm nhầm chỗ: họ tưởng khoá sai, trong khi khoá chưa từng được đọc.
 *
 * ĐÃ ĐO THẬT trên production (20/09/2026, bản `d24a5da`):
 *
 *     POST /api/tech/agent-run  (không khoá)   ⇒ 401
 *     POST /api/tech/agent-run  (khoá sai)     ⇒ 401
 *     GET  /api/tech/agent-run                 ⇒ 401   ← route này KHÔNG có GET, lẽ ra phải 405
 *
 * Cả ba giống hệt nhau vì cả ba dừng ở middleware. Cửa chép sổ lượt chạy agent vì thế KHÔNG THỂ
 * mở được từ máy GitHub Actions dù khai đúng khoá gì đi nữa.
 *
 * ─── KHAI ĐÚNG MỘT TUYẾN, KHÔNG KHAI CẢ NHÁNH ───
 *
 * Viết `/api/tech` ở đây là mở TOÀN BỘ bề mặt API của Phòng Tech AI cho mọi lượt gọi không đăng
 * nhập — một ký tự thiếu đổi một cửa hẹp thành một cửa rộng. Nên khai ĐẦY ĐỦ đường dẫn của đúng
 * tuyến tự xác thực ấy, và `tests/agent-run-ingest.test.ts` khoá cả hai vế: tuyến phải có mặt, và
 * tiền tố cụt `/api/tech` phải KHÔNG có mặt.
 *
 * Cùng luật với `/api/sync` (bí mật cron qua header) và `/api/webhooks` (bí mật trong đường dẫn /
 * chữ ký HMAC).
 *
 * `/start` (Phase 10 · tạo tổ chức tự phục vụ): trang KHÔNG cần phiên; cổng của nó là cờ `PLATFORM_SIGNUP_MODE` đọc ở
 * máy chủ — `off` (mặc định) thì trang chỉ in "chưa mở đăng ký" và mọi server action của nó từ chối.
 *
 * `/gioi-thieu` (`SITE_PAGE_PATH`): trang giới thiệu công khai — chỉ đọc gói cước và chế độ đăng ký, không dữ liệu khách nào.
 * Ở tên miền gốc nó được phục vụ tại `/` (khối tên miền gốc trong `middleware()`); ở host ERP mở được để xem trước.
 *
 * `/api/tech/worker/` (Pha 2, docs/tech-control-plane/README.md mục 4): worker headless ở máy khác gọi về bằng khoá
 * RIÊNG từng worker (`Authorization: Bearer tw_…`, CSDL chỉ giữ băm) — tự xác thực trong route. Khai kèm dấu `/` cuối:
 * chỉ mở đúng nhánh của worker, không phải `/api/tech`.
 *
 * `/join/` (mời người dùng qua liên kết): người được mời CHƯA có tài khoản. Trang chỉ đọc; cổng của nó là mã mời
 * 256 bit trong đường dẫn, tra trong CSDL của tổ chức ghi trong đường dẫn bằng `withOrganization` tường minh
 * (lib/users/invites.ts). Khai kèm dấu `/` cuối: chỉ mở đúng nhánh `/join/<tổ chức>/<mã>`.
 */
const PUBLIC_PREFIXES = ["/login", "/start", SITE_PAGE_PATH, ...SITE_LEGAL_PATHS, "/join/", "/reset/", "/api/webhooks", "/api/health", "/api/sync", "/api/tech/agent-run", "/api/tech/agent-task", "/api/tech/worker/", "/api/video-scale/public/", "/api/ical/", "/_next", "/favicon", "/icon", "/apple-icon", "/apple-touch-icon", "/manifest", "/robots", "/sitemap", BRAND_ASSET_PREFIX];

/**
 * Đường công khai khớp ĐÚNG TỪNG CHỮ (0180), không theo tiền tố — `/chat` theo tiền tố sẽ mở luôn `/chatbot` (trang bot
 * Pancake của nhà). Mỗi mục tự gác:
 *  · `/chat` — trang chat của chatbot bán hàng; chỉ chạy trên tên miền con của tổ chức ĐÃ XUẤT BẢN có bot đang bật
 *    (tra ở máy chủ), miền chính / tên miền lạ ⇒ "không có".
 *  · `/chat/embed` · `/chat/widget.js` — khung chat nhúng website của shop và script vẽ nút (lib/sales-chatbot/widget.ts);
 *    cùng lõi, cùng cách gác với `/chat`.
 *  · `/api/platform/domain-allowed` — Caddy on-demand TLS hỏi "có cấp chứng chỉ cho host này không": chỉ trả 200 cho tên
 *    miền con của tổ chức đã xuất bản, không lộ gì khác.
 *  · `/pricing` — trang giá công khai (0222): chỉ đọc gói cước ở `platform_plans` + chế độ đăng ký, không dữ liệu khách nào.
 */
const PUBLIC_EXACT = ["/chat", WIDGET_EMBED_PATH, WIDGET_SCRIPT_PATH, "/api/platform/domain-allowed", "/sw.js", "/pricing"];
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
/**
 * ═══════════ HEADER `x-erp-*`: CHỈ MÁY CHỦ ĐẶT ═══════════
 *
 * `resolveCurrentUser()` đọc `x-erp-path` để từ chối đường dẫn thuộc module đang tắt
 * (docs/platform/target-architecture.md P9). Một header mà trình duyệt tự gửi được thì không phải
 * chứng cứ của máy chủ: gửi `x-erp-path: /` kèm lượt gọi `/production` là đi vòng qua cổng module.
 * Nên XOÁ mọi `x-erp-*` client gửi lên TRƯỚC, rồi mới đặt giá trị của chính middleware — ở MỌI
 * request đi qua đây, kể cả đường công khai (một tuyến công khai hôm nay có thể gọi hàm đọc header
 * này ngày mai).
 */
function serverHeaders(request: NextRequest, pathname: string): Headers {
  const headers = new Headers(request.headers);
  const clientSent = [...headers.keys()].filter((name) => name.toLowerCase().startsWith(ERP_HEADER_PREFIX));
  for (const name of clientSent) headers.delete(name);
  headers.set(ERP_PATH_HEADER, pathname);
  headers.set(ERP_METHOD_HEADER, request.method);
  // Tên miền con (0180): đặt SAU khi xoá header client — trình duyệt không tự khai được mình đang ở ERP nào.
  const slug = hostSlug(request.headers.get("host"), process.env.PLATFORM_BASE_DOMAIN);
  if (slug) headers.set(ERP_HOST_SLUG_HEADER, slug);
  // Thương hiệu của host (vnxcommerce.com ⇒ vnx, chotdontudong.com · www · app ⇒ chotdon) — cùng luật "chỉ máy chủ đặt".
  headers.set(ERP_SITE_BRAND_HEADER, brandOfHost(request.headers.get("host"), siteEnv()));
  return headers;
}

/** Biến môi trường của lớp mặt tiền — đọc ở mỗi lượt gọi (Edge không có `lib/env`). */
function siteEnv(): SiteEnv {
  return { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const next = () => NextResponse.next({ request: { headers: serverHeaders(request, pathname) } });

  // Biểu tượng mặc định (`/favicon.ico`…) theo thương hiệu của host — bot và trình duyệt xin thẳng, không đọc `<link>`.
  const icon = brandIconPath(brandOfHost(request.headers.get("host"), siteEnv()), pathname);
  if (icon) {
    const url = request.nextUrl.clone();
    url.pathname = icon;
    return NextResponse.rewrite(url);
  }

  /*
    TÊN MIỀN GỐC (`vnxcommerce.com`, `www.`) là trang giới thiệu, KHÔNG phải ERP — quyết định trước mọi phép kiểm phiên,
    vì ở host này không có đường nào cần phiên. Luật nằm trong hàm thuần `siteRoute()` (lib/platform/site-host.ts).
  */
  const site = matchSite(request.headers.get("host"), siteEnv());
  if (site) {
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const route = siteRoute({
      host: site.kind,
      pathname,
      search: request.nextUrl.search,
      siteDomain: site.domain,
      protocol: forwarded ? `${forwarded}:` : request.nextUrl.protocol,
      appOrigin: brandAppOrigin(site.brand, siteEnv()),
    });
    if (route.kind === "REWRITE") {
      // `clone()` giữ nguyên gốc của chính lượt gọi ⇒ rewrite NỘI BỘ; một URL khác gốc biến rewrite thành proxy ra ngoài.
      const url = request.nextUrl.clone();
      url.pathname = route.path;
      return NextResponse.rewrite(url, { request: { headers: serverHeaders(request, route.path) } });
    }
    if (route.kind === "REDIRECT") return NextResponse.redirect(route.url, route.status);
    if (route.kind === "NOT_FOUND") return NextResponse.json({ error: "Không có ở tên miền này" }, { status: 404 });
    return next();
  }
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || PUBLIC_EXACT.includes(pathname)) return next();

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
    const res = next();
    if (request.method === "GET" || request.method === "HEAD") {
      const nowSec = Math.floor(Date.now() / 1000);
      const quyet = decideRenewal(claimsFrom(payload), nowSec);
      if (quyet.renew) {
        /*
          Giữ NGUYÊN danh tính của token cũ — MỌI claim, kể cả `org` (mã tổ chức). Không đọc lại từ
          đâu cả: email/tên/vai trò chỉ để hiển thị, còn vai trò và quyền THẬT được
          `getCurrentUser()` nạp lại từ CSDL ở mỗi lần dựng. Quên `org` ở đây là đá người của tổ
          chức khác về tổ chức nhà ở lần gia hạn đầu tiên (ISO-09) — nên phép dựng claim là một hàm
          thuần có bài kiểm (`renewalClaims`), không phải một khối liệt kê tay.
          Mốc đăng nhập gốc đi theo token, nếu không thì mỗi lần gia hạn là một lần dời trần sống.
        */
        const moi = await new SignJWT(renewalClaims(payload, quyet.loginAtSec))
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
  matcher: ["/((?!_next/static|_next/image).*)"],
};
