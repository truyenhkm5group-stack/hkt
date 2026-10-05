/**
 * ═══════════ GỐC LIÊN KẾT CHO NGƯỜI CỦA MỘT TỔ CHỨC — MỘT ĐƯỜNG DUY NHẤT ═══════════
 *
 * Liên kết mời, đặt lại mật khẩu, liên kết đơn trong tin nhóm, tin cảnh báo Lark / Telegram: tất cả đi qua
 * `organizationBaseUrl()`. Cùng một app phục vụ hai thương hiệu (erp.vnxcommerce.com · app.chotdontudong.com) và tên miền
 * con của tổ chức đã xuất bản; đọc `APP_URL` thẳng là gửi khách Chốt Đơn sang tên miền họ chưa từng đăng nhập.
 *
 * Tệp NHẸ có chủ đích (sổ tổ chức + ngữ cảnh + biến môi trường): đường gửi cảnh báo import nó mà không kéo theo
 * `lib/platform/publish.ts` (luật workflow, blueprint).
 */
import { env } from "@/lib/env";
import { currentOrganization } from "@/lib/platform/context";
import { subdomainOrigin } from "@/lib/platform/host";
import { findOrganization } from "@/lib/platform/organizations";
import { brandAppOrigin, type SiteBrand } from "@/lib/platform/site-host";
import type { Organization } from "@/lib/platform/types";

/**
 * Gốc liên kết của MỘT tổ chức — hàm THUẦN, ba bậc, bậc đầu tiên có đủ dữ kiện thắng:
 *  1. ĐÃ XUẤT BẢN + nền tảng có miền gốc ⇒ tên miền con của chính tổ chức;
 *  2. khách tự đăng ký ở Chốt Đơn Tự Động (`brand = chotdon`, 0215) ⇒ `app.chotdontudong.com` — người của tổ chức đăng
 *     nhập ở đó, cookie phiên gắn với host đó, và đó là thương hiệu họ đã mua;
 *  3. còn lại (kể cả `brand = NULL`: không theo dõi) ⇒ `APP_URL`, đúng như trước 0215.
 * Tổ chức nhà luôn ở bậc 3. Không xác định được gốc Chốt Đơn (biến môi trường tắt) ⇒ bậc 3, không đoán.
 */
export function organizationLinkOrigin(
  org: Pick<Organization, "isHome" | "publishState" | "domainSlug" | "brand"> | null | undefined,
  ctx: { baseDomain: string | null; appUrl: string; chotdonOrigin: string | null },
): string {
  if (org && !org.isHome && org.publishState === "PUBLISHED" && org.domainSlug && ctx.baseDomain) return subdomainOrigin(org.domainSlug, ctx.baseDomain);
  if (org && !org.isHome && org.brand === "chotdon" && ctx.chotdonOrigin) return ctx.chotdonOrigin;
  return ctx.appUrl;
}

function chotdonAppOrigin(): string | null {
  return brandAppOrigin("chotdon", { SITE_DOMAIN: process.env.SITE_DOMAIN, CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN, APP_URL: process.env.APP_URL, CHOTDON_APP_URL: process.env.CHOTDON_APP_URL });
}

/**
 * Gốc URL để dựng liên kết cho người của tổ chức `code` (liên kết đơn trong tin nhóm, liên kết mời, đặt lại mật khẩu, tin
 * cảnh báo Lark / Telegram) — luật ở `organizationLinkOrigin`. Mọi liên kết gửi cho người của một tổ chức đi qua ĐÂY, không
 * đọc `APP_URL` trực tiếp: đọc thẳng là gửi khách Chốt Đơn sang erp.vnxcommerce.com, nơi họ chưa từng đăng nhập.
 */
export async function organizationBaseUrl(code?: string): Promise<string> {
  const c = code ?? (await currentOrganization()).code;
  const org = await findOrganization(c);
  return organizationLinkOrigin(org, { baseDomain: env.platformBaseDomain, appUrl: env.appUrl, chotdonOrigin: chotdonAppOrigin() });
}

/** Thương hiệu của tổ chức — `null` (không theo dõi) đọc là `vnx`, đúng như trước 0215. */
export async function organizationBrand(code?: string): Promise<SiteBrand> {
  const c = code ?? (await currentOrganization()).code;
  return (await findOrganization(c))?.brand === "chotdon" ? "chotdon" : "vnx";
}

/** Tên sản phẩm in trong tin gửi cho người của tổ chức (tin thử kết nối, tiêu đề cảnh báo). */
export function productNameFor(brand: SiteBrand): string {
  return brand === "chotdon" ? "Chốt Đơn Tự Động" : "VNXcommerce ERP";
}
