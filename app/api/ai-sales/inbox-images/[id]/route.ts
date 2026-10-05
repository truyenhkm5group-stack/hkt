import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { readStaffImage } from "@/lib/sales-chatbot/inbox";

export const dynamic = "force-dynamic";

/**
 * Ảnh nhân viên đã gửi khách từ HỘP THƯ KHÁCH (0211 · `sales_chat_staff_images`) — để hộp thư hiện lại đúng ảnh đã gửi. Đòi
 * phiên + quyền xem AI bán hàng của CHÍNH tổ chức (CSDL ngữ cảnh). Khách không đi qua đây — kênh nhận ảnh bằng tải lên từ máy chủ.
 * Kiểu nội dung là kiểu ĐÃ KIỂM từ byte lúc gửi (JPEG / PNG / WEBP); `nosniff` + `sandbox` như các tệp khác trong CSDL.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ai_sales:view")) return new NextResponse("Không có quyền xem AI bán hàng", { status: 403 });
  const { id } = await ctx.params;
  const img = await readStaffImage(id);
  if (!img) return new NextResponse("Không tìm thấy ảnh", { status: 404 });
  return new NextResponse(new Uint8Array(img.data), {
    status: 200,
    headers: {
      "content-type": img.contentType,
      "content-length": String(img.data.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
