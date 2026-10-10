import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { avatarProxyCore } from "@/lib/sales-chatbot/avatar-proxy";

export const dynamic = "force-dynamic";

/**
 * ẢNH ĐẠI DIỆN KHÁCH của hộp thư qua proxy ERP — `lib/sales-chatbot/avatar-proxy.ts`. Đòi phiên + quyền xem AI bán hàng của CHÍNH tổ
 * chức (CSDL ngữ cảnh), cùng cổng với `inbox-read` / `inbox-images`. Máy chủ gắn token page lúc tải ảnh từ Pancake; phản hồi chỉ có
 * byte ảnh — không token, không URL nguồn. Lỗi nào cũng 404 không thân để `<img>` lùi về chữ cái đầu. Kiểu nội dung là kiểu ảnh
 * raster đã kiểm; `nosniff` + `sandbox` như các ảnh khác trong hộp thư.
 */
export async function GET(request: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ai_sales:view")) return new NextResponse("Không có quyền xem AI bán hàng", { status: 403 });
  const { conversationId } = await ctx.params;
  const r = await avatarProxyCore(user, conversationId, request.headers.get("if-none-match"));
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" };
  if (r.status === 304) return new NextResponse(null, { status: 304, headers: { ...base, etag: r.etag, "cache-control": "private, max-age=86400" } });
  if (r.status !== 200) return new NextResponse(null, { status: r.status, headers: { ...base, "cache-control": "private, no-store" } });
  return new NextResponse(new Uint8Array(r.body), {
    status: 200,
    headers: { ...base, "content-type": r.contentType, "content-length": String(r.body.byteLength), etag: r.etag, "cache-control": "private, max-age=86400" },
  });
}
