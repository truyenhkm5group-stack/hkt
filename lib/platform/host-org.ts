/**
 * ═══════════ TỔ CHỨC CỦA HOST ĐANG MỞ (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Middleware (Edge, không CSDL) tách slug từ host `<slug>.<PLATFORM_BASE_DOMAIN>` rồi đặt header máy chủ
 * `x-erp-host-slug` (trình duyệt không giả được — mọi `x-erp-*` client gửi lên bị xoá trước). Ở đây tra slug → tổ chức
 * ĐÃ XUẤT BẢN (`organizationForHostSlug`).
 *
 * Ba câu trả lời, không hai:
 *  · `slug = null` — host là miền chính (hoặc nền tảng chưa bật tên miền con): hành vi y như trước 0180.
 *  · `slug` có, `org` có — ERP của đúng tổ chức đó: đăng nhập gắn cứng tổ chức này, phiên của tổ chức khác bị từ chối.
 *  · `slug` có, `org = null` — không có ERP (đã xuất bản) ở địa chỉ này: KHÔNG BAO GIỜ rơi về tổ chức nhà.
 *
 * Host chỉ ĐỊNH TUYẾN; danh tính vẫn là claim `org` do máy chủ ký trong phiên (lib/platform/context.ts). Host và phiên
 * nói hai tổ chức khác nhau ⇒ từ chối (`HOST_MISMATCH`), không chọn bên nào.
 */
import { headers } from "next/headers";
import { ERP_HOST_SLUG_HEADER } from "@/lib/constants/session";
import { organizationForHostSlug } from "@/lib/platform/publish";
import type { Organization } from "@/lib/platform/types";

let slugOverride: (() => string | null) | null = null;
/** Chỉ bài kiểm (chạy ngoài Next, không có header): giả lập "request tới host này". `null` để gỡ. */
export function setRequestHostSlugForTests(source: (() => string | null) | null) {
  slugOverride = source;
}

export async function requestHostSlug(): Promise<string | null> {
  if (slugOverride) return slugOverride();
  try {
    const v = (await headers()).get(ERP_HOST_SLUG_HEADER);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export type HostOrganization = { slug: null; org: null } | { slug: string; org: Organization | null };

export async function hostOrganization(): Promise<HostOrganization> {
  const slug = await requestHostSlug();
  if (!slug) return { slug: null, org: null };
  return { slug, org: await organizationForHostSlug(slug) };
}

export const HOST_NOT_FOUND_MESSAGE = "Không có ERP nào ở địa chỉ này (chưa xuất bản hoặc sai tên miền).";
