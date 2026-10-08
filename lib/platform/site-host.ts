/**
 * ═══════════ TRANG GIỚI THIỆU Ở TÊN MIỀN GỐC — PHẦN THUẦN, EDGE-SAFE ═══════════
 *
 * `vnxcommerce.com` (và `www.`) là MẶT TIỀN của nền tảng: một trang giới thiệu công khai với hai lối vào — «Đăng ký»
 * (trình hướng dẫn tạo tổ chức `/start`) và «Đăng nhập» (`/login`). Cả hai lối vào SỐNG Ở `APP_URL`
 * (`erp.vnxcommerce.com`), không ở tên miền gốc:
 *
 *  · cookie phiên (`erp_session`) gắn với host của ERP — đăng nhập ở tên miền gốc thì cookie nằm ở đó và ERP không đọc
 *    được, người dùng đăng nhập xong vẫn bị đá ra màn đăng nhập;
 *  · tên miền gốc KHÔNG BAO GIỜ dựng dashboard: mọi đường dẫn khác chuyển sang ERP (người gõ nhầm `vnxcommerce.com/orders`
 *    tới đúng chỗ), còn `/api/*` trả 404 — webhook / cron gọi nhầm host thì phải thấy lỗi, không được im lặng bị chuyển.
 *
 * Tệp này KHÔNG import gì: middleware (Edge, không CSDL) gọi `siteRoute()` để quyết định; route Caddy hỏi chứng chỉ
 * (`/api/platform/domain-allowed`) gọi `siteHostKind()` để cấp chứng chỉ cho đúng hai host này.
 */

/** Tên miền gốc mặc định khi máy chủ không khai `SITE_DOMAIN`. Khai `SITE_DOMAIN=off` để tắt hẳn trang giới thiệu. */
export const DEFAULT_SITE_DOMAIN = "vnxcommerce.com";

/** Đường dẫn THẬT của trang giới thiệu. Ở tên miền gốc nó được phục vụ tại `/`; ở host ERP mở được để xem trước. */
export const SITE_PAGE_PATH = "/gioi-thieu";

/**
 * Văn bản pháp lý CÔNG KHAI — phục vụ NGAY tại tên miền gốc (không chuyển sang ERP): Google / Facebook đòi link chính sách
 * quyền riêng tư nằm trên tên miền đã khai của ứng dụng đăng nhập (`vnxcommerce.com`).
 */
export const SITE_LEGAL_PATHS = ["/chinh-sach-bao-mat", "/dieu-khoan-su-dung"] as const;

/** Bí danh tiếng Việt in trên tài liệu / danh thiếp → tuyến thật của ERP. */
export const SITE_AUTH_ALIASES: Readonly<Record<string, string>> = { "/dang-ky": "/start", "/dang-nhap": "/login" };

/**
 * Tài nguyên tĩnh của MỘT thương hiệu (`public/brand/<thương hiệu>/`): biểu tượng, ảnh chia sẻ, manifest. Phải công khai ở
 * CẢ mặt tiền lẫn host phần mềm — trước đây biểu tượng Chốt Đơn nằm ở `/chotdon-icon.svg`, mặt tiền chuyển nó sang
 * `app.`, còn `app.` đòi đăng nhập ⇒ tab trình duyệt không có biểu tượng ở cả hai host (đo 05/10/2026).
 */
export const BRAND_ASSET_PREFIX = "/brand/";

/** Tài nguyên tĩnh mà trang giới thiệu cần ngay trên tên miền gốc (JS/CSS của Next, biểu tượng, robots). */
const SITE_STATIC_PREFIXES = ["/_next", "/favicon", "/icon", "/apple-icon", "/apple-touch-icon", "/manifest", "/robots", "/sitemap", BRAND_ASSET_PREFIX];

/** Bộ biểu tượng của «Chốt Đơn Tự Động» — dựng từ MỘT hình vẽ (bong bóng chat đặc + dấu tích), mọi cỡ cùng nét. */
export const CHOTDON_ASSETS = {
  /** SVG cho tab trình duyệt hiện đại. */
  icon: "/brand/chotdon/icon.svg",
  /** ICO 16 · 32 · 48 — trình duyệt cũ và Google Search đọc `/favicon.ico`. */
  favicon: "/brand/chotdon/favicon.ico",
  /** 180×180 tràn viền — iOS tự bo góc khi thêm vào màn hình chính. */
  apple: "/brand/chotdon/apple-touch-icon.png",
  /** Ảnh chia sẻ 1200×630 (Facebook, Zalo, Messenger). */
  og: "/brand/chotdon/og.png",
  manifest: "/brand/chotdon/site.webmanifest",
} as const;

/**
 * Đường biểu tượng MẶC ĐỊNH mà trình duyệt / bot tự xin (không đọc thẻ `<link>`): `/favicon.ico`, `/apple-touch-icon.png`…
 * Ở host Chốt Đơn chúng phải trả biểu tượng Chốt Đơn, không phải của VNXcommerce trong `public/`. Thương hiệu khác ⇒ `null`
 * (giữ nguyên tệp gốc).
 */
export function brandIconPath(brand: SiteBrand, pathname: string): string | null {
  if (brand !== "chotdon") return null;
  switch (pathname) {
    case "/favicon.ico":
      return CHOTDON_ASSETS.favicon;
    case "/icon.svg":
      return CHOTDON_ASSETS.icon;
    case "/apple-touch-icon.png":
    case "/apple-touch-icon-precomposed.png":
      return CHOTDON_ASSETS.apple;
    default:
      return null;
  }
}

export type SiteHostKind = "APEX" | "WWW";

// ═══════════ THƯƠNG HIỆU THEO TÊN MIỀN ═══════════
//
// Một app, hai mặt tiền (chủ nền tảng chốt 04/10/2026):
//  · `vnx`     — `vnxcommerce.com`: nền tảng đầy đủ, phần mềm ở `APP_URL` (`erp.vnxcommerce.com`);
//  · `chotdon` — `chotdontudong.com`: sản phẩm «Chốt Đơn Tự Động» (AI bán hàng), phần mềm ở `app.chotdontudong.com`.
// Cùng một CSDL, cùng một bộ tổ chức — thương hiệu chỉ đổi CHỮ và LỐI VÀO, không đổi dữ liệu hay quyền.

export type SiteBrand = "vnx" | "chotdon";

/** Tên miền gốc mặc định của Chốt Đơn Tự Động khi máy chủ không khai `CHOTDON_DOMAIN`; `off` để tắt. */
export const DEFAULT_CHOTDON_DOMAIN = "chotdontudong.com";

/**
 * Header MÁY CHỦ mang thương hiệu của host đang gọi. Đặt SAU khi middleware xoá mọi `x-erp-*` trình duyệt gửi lên — trình
 * duyệt không tự khai được mình đang ở thương hiệu nào. Vắng header ⇒ `hostBrand()` suy lại bằng CHÍNH luật của middleware
 * (`brandOfRequest`); ngoài ngữ cảnh request ⇒ `vnx`.
 */
export const ERP_SITE_BRAND_HEADER = "x-erp-site-brand";

export type SiteEnv = { SITE_DOMAIN?: string; CHOTDON_DOMAIN?: string; APP_URL?: string; CHOTDON_APP_URL?: string };

export type SiteMatch = { brand: SiteBrand; kind: SiteHostKind; domain: string };

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

/**
 * Đọc biến `SITE_DOMAIN`: chưa khai ⇒ mặc định; `off` / `none` / `false` ⇒ `null` (tắt); còn lại phải là tên miền thuần
 * (chữ, số, chấm, gạch) — ký tự lạ ⇒ `null`, vì một tên miền sai dạng mà vẫn được so khớp là đoán.
 */
export function siteDomainFrom(raw: string | null | undefined, fallback: string = DEFAULT_SITE_DOMAIN): string | null {
  if (raw === undefined || raw === null) return fallback;
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!v) return fallback;
  if (v === "off" || v === "none" || v === "false") return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(v) ? v : null;
}

/** `APEX` khi host đúng là tên miền gốc, `WWW` khi là `www.<gốc>`; mọi host khác (kể cả `erp.<gốc>`) ⇒ `null`. */
export function siteHostKind(host: string | null | undefined, siteDomain: string | null | undefined): SiteHostKind | null {
  const h = bareHost(String(host ?? ""));
  const d = bareHost(String(siteDomain ?? ""));
  if (!h || !d) return null;
  if (h === d) return "APEX";
  if (h === `www.${d}`) return "WWW";
  return null;
}

/**
 * Gốc của ERP lấy từ `APP_URL`, CHỈ khi nó là một URL http(s) hợp lệ và KHÔNG trỏ về chính tên miền gốc / `www.` — trỏ về
 * đó thì «chuyển sang ERP» là chuyển vòng tròn mãi mãi. Sai ⇒ `null`, và lối vào được phục vụ ngay tại chỗ.
 */
export function siteAppOrigin(appUrl: string | null | undefined, siteDomain: string): string | null {
  const raw = String(appUrl ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (siteHostKind(u.host, siteDomain)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Tên miền gốc của Chốt Đơn Tự Động (`CHOTDON_DOMAIN`, mặc định `chotdontudong.com`). */
export function chotdonDomainFrom(raw: string | null | undefined): string | null {
  return siteDomainFrom(raw, DEFAULT_CHOTDON_DOMAIN);
}

/**
 * Host đang gọi là mặt tiền của thương hiệu nào. Hai tên miền trùng nhau (khai sai) ⇒ `vnx` thắng — mặt tiền cũ không
 * được lặng lẽ đổi chủ vì một biến môi trường gõ nhầm.
 */
export function matchSite(host: string | null | undefined, env: SiteEnv): SiteMatch | null {
  const vnx = siteDomainFrom(env.SITE_DOMAIN);
  const vk = siteHostKind(host, vnx);
  if (vk && vnx) return { brand: "vnx", kind: vk, domain: vnx };
  const cd = chotdonDomainFrom(env.CHOTDON_DOMAIN);
  const ck = siteHostKind(host, cd);
  if (ck && cd) return { brand: "chotdon", kind: ck, domain: cd };
  return null;
}

/** Host PHẦN MỀM của Chốt Đơn Tự Động: `app.<CHOTDON_DOMAIN>`. */
export function chotdonAppHost(env: SiteEnv): string | null {
  const cd = chotdonDomainFrom(env.CHOTDON_DOMAIN);
  return cd ? `app.${cd}` : null;
}

/**
 * Thương hiệu của MỌI host (mặt tiền lẫn phần mềm): `chotdontudong.com` · `www.` · `app.` ⇒ `chotdon`; còn lại ⇒ `vnx`.
 * Middleware đặt kết quả vào `ERP_SITE_BRAND_HEADER` cho mọi lượt gọi — host đưa vào chọn bằng `brandHost` (dưới).
 */
export function brandOfHost(host: string | null | undefined, env: SiteEnv): SiteBrand {
  const site = matchSite(host, env);
  if (site) return site.brand;
  const appHost = chotdonAppHost(env);
  return appHost && bareHost(String(host ?? "")) === appHost ? "chotdon" : "vnx";
}

/** Đọc lại header thương hiệu — giá trị lạ / vắng ⇒ `vnx`, không bao giờ đoán sang thương hiệu khác. */
export function brandFromHeader(raw: string | null | undefined): SiteBrand {
  return raw === "chotdon" ? "chotdon" : "vnx";
}

/**
 * ═══ HOST NÀO QUYẾT THƯƠNG HIỆU: `x-forwarded-host` TRƯỚC, `host` SAU ═══
 *
 * P1 Finish Line R2 (08/10/2026): khách Chốt Đơn đặt mật khẩu ở `/reset/…` trên host Chốt Đơn ⇒ trang đăng nhập hiện ra mang
 * thương hiệu VNXcommerce; tải lại thì đúng. Cơ chế (truy trong Next 15.5.25 — `createRedirectRenderResult` của
 * `server/app-render/action-handler`): server action `redirect(X)` khiến máy chủ TỰ xin RSC của X bằng `fetch` tới
 * `__NEXT_PRIVATE_ORIGIN` (`http://localhost:<cổng>` — `HOSTNAME=0.0.0.0` của Docker cũng ra `localhost`), mang theo header của
 * lượt POST. `fetch` của Node BỎ header `Host` (header cấm của chuẩn Fetch) và dùng host của URL ⇒ lượt ấy đi qua middleware
 * với `host = localhost:<cổng>` ⇒ thương hiệu `vnx`. Header `x-forwarded-host` thì đi nguyên: Caddy đặt nó bằng host thật
 * (production), Next tự đặt khi chạy không có proxy.
 *
 * Chỉ dùng cho THƯƠNG HIỆU — chữ và hình, không quyết quyền, không quyết dữ liệu: một lượt gọi thẳng vào cổng Node tự khai
 * `x-forwarded-host` chỉ đổi được thương hiệu của chính trang nó xem, đúng như tự gõ host kia vào thanh địa chỉ (cả hai host
 * đều công khai). KHÔNG dùng cho tên miền con của tổ chức (`hostSlug` — gắn phiên với tổ chức) hay định tuyến mặt tiền
 * (`matchSite`): những thứ ấy vẫn đọc `host`.
 */
export function brandHost(host: string | null | undefined, forwardedHost: string | null | undefined): string | null {
  const forwarded = String(forwardedHost ?? "").split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const h = String(host ?? "").trim();
  return h || null;
}

/** Thương hiệu của MỘT lượt gọi từ header của nó — luật duy nhất cho middleware lẫn `hostBrand()` khi thiếu header máy chủ. */
export function brandOfRequest(get: (name: string) => string | null | undefined, env: SiteEnv): SiteBrand {
  return brandOfHost(brandHost(get("host"), get("x-forwarded-host")), env);
}

/** Biến môi trường của lớp mặt tiền — đọc ở MỖI lượt gọi (middleware chạy ở Edge, không có `lib/env`). */
export function siteEnvFromProcess(): SiteEnv {
  return { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL };
}

/**
 * Gốc PHẦN MỀM của một thương hiệu: `vnx` ⇒ `APP_URL`; `chotdon` ⇒ `CHOTDON_APP_URL` hoặc `https://app.<CHOTDON_DOMAIN>`.
 * Cùng luật chống vòng tròn của `siteAppOrigin`.
 */
export function brandAppOrigin(brand: SiteBrand, env: SiteEnv): string | null {
  if (brand === "vnx") {
    const d = siteDomainFrom(env.SITE_DOMAIN);
    return d ? siteAppOrigin(env.APP_URL, d) : null;
  }
  const cd = chotdonDomainFrom(env.CHOTDON_DOMAIN);
  if (!cd) return null;
  return siteAppOrigin(env.CHOTDON_APP_URL?.trim() || `https://app.${cd}`, cd);
}

export type SiteRoute =
  | { kind: "REWRITE"; path: string }
  | { kind: "REDIRECT"; url: string; status: 301 | 302 | 308 }
  | { kind: "PASS" }
  | { kind: "NOT_FOUND" };

/**
 * Quyết định cho MỘT lượt gọi tới tên miền gốc. Hàm THUẦN — middleware chỉ thi hành kết quả.
 *
 *  · `www.` ⇒ 301 về tên miền gốc (một địa chỉ chuẩn cho công cụ tìm kiếm);
 *  · `/` ⇒ phục vụ trang giới thiệu; `/gioi-thieu` ⇒ 308 về `/` (không để hai địa chỉ cho cùng một trang);
 *  · tài nguyên tĩnh ⇒ cho qua;
 *  · `/api/*` ⇒ 404;
 *  · `/dang-ky`, `/dang-nhap` và mọi đường dẫn khác ⇒ 302 sang ERP, GIỮ query (`?invite=` của lời mời phải tới nơi).
 *    Thiếu gốc ERP hợp lệ: bí danh chuyển về tuyến thật ngay trên host này, đường dẫn khác về trang giới thiệu.
 */
export function siteRoute(input: { host: SiteHostKind; pathname: string; search: string; siteDomain: string; protocol: string; appOrigin: string | null }): SiteRoute {
  const { host, pathname, search, siteDomain, appOrigin } = input;
  const protocol = input.protocol === "http:" ? "http:" : "https:";
  // Mọi đích chuyển hướng đều TUYỆT ĐỐI: `request.url` trong middleware mang host Next tự đặt (đo khi chạy thử:
  // `localhost:3300` dù trình duyệt gửi `Host: vnxcommerce.com`), dựng đích tương đối theo nó là đẩy khách về host nội bộ.
  const self = `${protocol}//${siteDomain}`;
  if (host === "WWW") return { kind: "REDIRECT", url: `${self}${pathname}${search}`, status: 301 };
  if (pathname === "/") return { kind: "REWRITE", path: SITE_PAGE_PATH };
  if (pathname === SITE_PAGE_PATH || pathname === `${SITE_PAGE_PATH}/`) return { kind: "REDIRECT", url: `${self}/${search}`, status: 308 };
  if (SITE_STATIC_PREFIXES.some((p) => pathname.startsWith(p))) return { kind: "PASS" };
  if ((SITE_LEGAL_PATHS as readonly string[]).includes(pathname.replace(/\/+$/, "") || "/")) return { kind: "PASS" };
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "NOT_FOUND" };
  const alias = SITE_AUTH_ALIASES[pathname.replace(/\/+$/, "")] ?? null;
  if (appOrigin) return { kind: "REDIRECT", url: `${appOrigin}${alias ?? pathname}${search}`, status: 302 };
  if (alias) return { kind: "REDIRECT", url: `${self}${alias}${search}`, status: 302 };
  if (pathname === "/login" || pathname === "/start" || pathname.startsWith("/join/")) return { kind: "PASS" };
  return { kind: "REDIRECT", url: `${self}/`, status: 302 };
}
