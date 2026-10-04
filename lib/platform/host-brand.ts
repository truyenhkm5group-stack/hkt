import { headers } from "next/headers";
import { brandFromHeader, ERP_SITE_BRAND_HEADER, type SiteBrand } from "@/lib/platform/site-host";

/**
 * Thương hiệu của host đang gọi (`vnx` · `chotdon`) — đọc header MÁY CHỦ mà middleware đặt (lib/platform/site-host.ts
 * `brandOfHost`). Ngoài ngữ cảnh request (job, script) hoặc thiếu header ⇒ `vnx`: lỗi luôn rơi về thương hiệu gốc.
 */
export async function hostBrand(): Promise<SiteBrand> {
  try {
    return brandFromHeader((await headers()).get(ERP_SITE_BRAND_HEADER));
  } catch {
    return "vnx";
  }
}
