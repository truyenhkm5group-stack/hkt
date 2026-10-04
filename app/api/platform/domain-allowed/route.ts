import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { hostSlug } from "@/lib/platform/host";
import { organizationForHostSlug } from "@/lib/platform/publish";
import { chotdonAppHost, matchSite, type SiteEnv } from "@/lib/platform/site-host";

/**
 * CADDY ON-DEMAND TLS HỎI "CÓ CẤP CHỨNG CHỈ CHO HOST NÀY KHÔNG" (0180 · deploy/Caddyfile).
 *
 * `GET /api/platform/domain-allowed?domain=<host>` ⇒ 200 CHỈ khi host là `<slug>.<PLATFORM_BASE_DOMAIN>` của một tổ chức
 * ĐÃ XUẤT BẢN, đang hoạt động; còn lại 404. Không trả thân nào ngoài "ok" / "no": không lộ tổ chức nào tồn tại, nháp hay
 * đình chỉ. Không có đường này thì on-demand TLS cấp chứng chỉ cho BẤT KỲ tên nào trỏ về máy chủ — một cửa đốt hạn mức
 * Let's Encrypt của nền tảng.
 */
/*
 * Thêm ĐÚNG hai host của trang giới thiệu: tên miền gốc `SITE_DOMAIN` và `www.` của nó (lib/platform/site-host.ts). Khối
 * Caddy của chúng cũng xin chứng chỉ THEO YÊU CẦU, nên trước ngày DNS trỏ về máy này Caddy không gọi Let's Encrypt lần nào.
 */
export async function GET(request: NextRequest) {
  const domain = request.nextUrl.searchParams.get("domain") ?? "";
  const siteEnv: SiteEnv = { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN };
  const bare = domain.trim().toLowerCase().replace(/\.$/, "");
  if (matchSite(domain, siteEnv) || (bare && bare === chotdonAppHost(siteEnv))) {
    return new NextResponse("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const slug = hostSlug(domain, env.platformBaseDomain);
  const org = slug ? await organizationForHostSlug(slug) : null;
  return new NextResponse(org ? "ok" : "no", { status: org ? 200 : 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
