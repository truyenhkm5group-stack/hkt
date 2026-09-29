/**
 * ═══════════ TÊN MIỀN CON CỦA TỔ CHỨC — PHẦN THUẦN, CLIENT/EDGE-SAFE (0180) ═══════════
 *
 * Tài liệu: docs/platform/self-service-journey.md mục «Tên miền con». Một tổ chức đã XUẤT BẢN chạy ở
 * `<slug>.<PLATFORM_BASE_DOMAIN>`: KHÔNG sửa nginx / Caddy cho từng khách, KHÔNG deploy — một bản ghi DNS wildcard và một
 * khối Caddy on-demand TLS dựng MỘT lần cho cả nền tảng (việc hạ tầng, `deploy/Caddyfile`), còn lại là tra
 * host → slug → tổ chức ĐÃ XUẤT BẢN ở máy chủ.
 *
 * Tệp này KHÔNG import gì: middleware (Edge, không CSDL) dùng `hostSlug()` để đặt header máy chủ `x-erp-host-slug`; máy
 * chủ tra slug → tổ chức (`lib/platform/publish.ts::organizationForHostSlug`). Header đó chỉ MIDDLEWARE đặt — mọi `x-erp-*`
 * trình duyệt gửi lên bị xoá trước (middleware.ts `serverHeaders`).
 *
 * ─── SLUG KHÁC MÃ TỔ CHỨC ───
 * Mã tổ chức (`code`) là BẤT BIẾN: nằm trong JWT, khoá đệm, tên CSDL. Slug là thứ khách chọn để in lên danh thiếp — đổi
 * được tới lúc xuất bản. Hai thứ tách nhau để đổi tên miền không bao giờ đụng vào danh tính.
 */

export const DOMAIN_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Nhãn không cấp được làm tên miền con: tên tuyến / dịch vụ của nền tảng (`www`, `api`, `mail`…), mã dựng sẵn của nhà,
 * và nhãn dễ bị dùng để giả mạo (`login`, `admin`, `support`…). Bổ sung cho `RESERVED_ORG_CODES`, không thay.
 */
export const RESERVED_DOMAIN_SLUGS = [
  "www", "api", "app", "admin", "platform", "start", "login", "join", "chat", "static", "assets", "cdn", "mail", "smtp", "imap", "pop", "ftp", "ns1", "ns2",
  "home", "vnx", "erp", "system", "root", "support", "help", "status", "test", "dev", "staging", "demo", "billing", "account", "accounts", "auth", "sso", "secure", "security",
] as const;

export type SlugProblem = "FORMAT" | "RESERVED" | "EDGE_HYPHEN" | "DOUBLE_HYPHEN";

/** Kiểm DẠNG của slug (không CSDL). `null` = dùng được về mặt hình thức; còn phải kiểm trùng ở máy chủ. */
export function domainSlugProblem(raw: string): { code: SlugProblem; message: string } | null {
  const s = raw.trim().toLowerCase();
  if (!DOMAIN_SLUG_PATTERN.test(s)) return { code: "FORMAT", message: "Tên miền con: chữ thường không dấu, số, gạch ngang; 2–31 ký tự, bắt đầu bằng chữ." };
  if (s.endsWith("-")) return { code: "EDGE_HYPHEN", message: "Tên miền con không được kết thúc bằng gạch ngang." };
  if (s.includes("--")) return { code: "DOUBLE_HYPHEN", message: "Tên miền con không được có hai gạch ngang liền nhau." };
  if ((RESERVED_DOMAIN_SLUGS as readonly string[]).includes(s)) return { code: "RESERVED", message: "Tên này dành riêng cho nền tảng — chọn tên khác." };
  return null;
}

/** Bỏ cổng + chữ thường + bỏ dấu chấm cuối. `"HSLC.erp.vn:443."` ⇒ `"hslc.erp.vn"`. */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

/**
 * Slug trong `host` khi host là `<slug>.<base>` — đúng MỘT nhãn trước miền gốc. `null` khi: chưa khai miền gốc, host chính
 * là miền gốc, host thuộc miền khác, nhiều hơn một nhãn (`a.b.<base>`), hay nhãn sai dạng. Hàm THUẦN.
 *
 * `base` có thể mang cổng (`localhost:3000` khi chạy thử): so phần tên, bỏ cổng ở cả hai phía.
 */
export function hostSlug(host: string | null | undefined, base: string | null | undefined): string | null {
  const h = bareHost(String(host ?? ""));
  const b = bareHost(String(base ?? ""));
  if (!h || !b || h === b) return null;
  if (!h.endsWith(`.${b}`)) return null;
  const label = h.slice(0, -(b.length + 1));
  if (!label || label.includes(".")) return null;
  return DOMAIN_SLUG_PATTERN.test(label) ? label : null;
}

/**
 * Gốc URL của tên miền con: `https://<slug>.<base>` (giữ cổng của `base` khi chạy thử). `protocol` mặc định `https:` —
 * miền gốc `localhost…` dùng `http:` vì máy thử không có chứng chỉ.
 */
export function subdomainOrigin(slug: string, base: string): string {
  const b = base.trim().toLowerCase().replace(/\/$/, "");
  const protocol = /^localhost(:\d+)?$|\.localhost(:\d+)?$/.test(b) ? "http:" : "https:";
  return `${protocol}//${slug}.${b}`;
}
