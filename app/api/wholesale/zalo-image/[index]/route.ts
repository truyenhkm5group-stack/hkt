import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { fetchPublicUrl } from "@/lib/net/public-url";
import { getLeadHunterConfig } from "@/lib/wholesale/store";

export const dynamic = "force-dynamic";

/**
 * Ảnh kèm tin Zalo, phục vụ CÙNG NGUỒN với ERP để điện thoại chia sẻ được sang Zalo (`navigator.share` cần tệp, trình duyệt
 * không đọc được ảnh của máy chủ khác vì CORS). Chỉ trả ảnh ĐÃ KHAI trong cấu hình Săn khách sỉ theo SỐ THỨ TỰ — không
 * nhận link tuỳ ý, nên đây không phải một proxy mở; tải qua `fetchPublicUrl` (chặn địa chỉ nội bộ, giới hạn kích thước).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ index: string }> }) {
  const guard = await apiGuard("wholesale:work", { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "wholesale:work")) return new Response("Cần quyền chăm lead khách sỉ (wholesale:work)", { status: 403 });
  const { index } = await params;
  const i = Number(index);
  const cfg = await getLeadHunterConfig();
  const url = Number.isInteger(i) && i >= 0 ? cfg.outreach.zaloImages[i] : undefined;
  if (!url) return new Response("Không có ảnh này trong cấu hình", { status: 404 });
  const r = await fetchPublicUrl(url, { accept: "image/*" });
  if (!r.ok) return new Response(`Không tải được ảnh: ${r.error}`, { status: 502 });
  if (!/^image\//i.test(r.contentType)) return new Response("Link không phải ảnh", { status: 415 });
  return new Response(new Blob([new Uint8Array(r.body)]), { headers: { "Content-Type": r.contentType, "Cache-Control": "private, max-age=3600" } });
}
