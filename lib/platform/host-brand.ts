import { headers } from "next/headers";
import { brandFromHeader, brandOfRequest, ERP_SITE_BRAND_HEADER, siteEnvFromProcess, type SiteBrand } from "@/lib/platform/site-host";

/**
 * Thương hiệu của host đang gọi (`vnx` · `chotdon`) — đọc header MÁY CHỦ mà middleware đặt (`brandOfRequest`,
 * lib/platform/site-host.ts). Header vắng (lượt gọi không qua middleware) ⇒ suy lại từ `x-forwarded-host` / `host` bằng CHÍNH
 * hàm đó — không luật thứ hai. Thương hiệu chỉ là trình bày (chữ, hình), không quyết quyền hay dữ liệu, nên đọc host là chấp
 * nhận được. Ngoài ngữ cảnh request (job, script) ⇒ `vnx`: lỗi luôn rơi về thương hiệu gốc.
 */
export async function hostBrand(): Promise<SiteBrand> {
  try {
    const h = await headers();
    const raw = h.get(ERP_SITE_BRAND_HEADER);
    return raw !== null ? brandFromHeader(raw) : brandOfRequest((name) => h.get(name), siteEnvFromProcess());
  } catch {
    return "vnx";
  }
}
