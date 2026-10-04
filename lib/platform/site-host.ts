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

/** Tài nguyên tĩnh mà trang giới thiệu cần ngay trên tên miền gốc (JS/CSS của Next, biểu tượng, robots). */
const SITE_STATIC_PREFIXES = ["/_next", "/favicon", "/icon", "/apple-icon", "/manifest", "/robots", "/sitemap"];

export type SiteHostKind = "APEX" | "WWW";

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

/**
 * Đọc biến `SITE_DOMAIN`: chưa khai ⇒ mặc định; `off` / `none` / `false` ⇒ `null` (tắt); còn lại phải là tên miền thuần
 * (chữ, số, chấm, gạch) — ký tự lạ ⇒ `null`, vì một tên miền sai dạng mà vẫn được so khớp là đoán.
 */
export function siteDomainFrom(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return DEFAULT_SITE_DOMAIN;
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!v) return DEFAULT_SITE_DOMAIN;
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
