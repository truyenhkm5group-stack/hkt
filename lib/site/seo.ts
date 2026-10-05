/**
 * ═══════════ ROBOTS + SITEMAP CỦA MẶT TIỀN — PHẦN THUẦN ═══════════
 *
 * Chỉ MẶT TIỀN (`vnxcommerce.com`, `chotdontudong.com`) có robots.txt và sitemap.xml: đó là các trang công khai muốn
 * được tìm thấy. Host phần mềm (ERP, `app.`, tên miền con của tổ chức) giữ nguyên như trước — 404 — để một tệp mới không
 * lặng lẽ đổi cách bot đối xử với phần mềm của khách.
 *
 * Danh sách trang = trang giới thiệu + hai văn bản pháp lý (`SITE_LEGAL_PATHS`), đúng những đường `siteRoute()` phục vụ
 * ngay trên mặt tiền; đường nào bị chuyển sang phần mềm thì không có trong sitemap.
 */
import { SITE_LEGAL_PATHS } from "@/lib/platform/site-host";

/** Các đường mặt tiền phục vụ tại chỗ, theo thứ tự ưu tiên. */
export const SITE_INDEXABLE_PATHS = ["/", ...SITE_LEGAL_PATHS] as const;

function origin(domain: string): string {
  return `https://${domain}`;
}

export function robotsTxt(domain: string): string {
  return ["User-agent: *", "Allow: /", "Disallow: /api/", "", `Sitemap: ${origin(domain)}/sitemap.xml`, ""].join("\n");
}

export function sitemapXml(domain: string): string {
  const urls = SITE_INDEXABLE_PATHS.map((p, i) => {
    const loc = `${origin(domain)}${p}`;
    return `  <url><loc>${loc}</loc><changefreq>${i === 0 ? "weekly" : "monthly"}</changefreq><priority>${i === 0 ? "1.0" : "0.3"}</priority></url>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}
