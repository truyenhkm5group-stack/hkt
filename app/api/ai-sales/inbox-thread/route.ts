import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { inboxThreadPayload } from "@/lib/sales-chatbot/inbox-thread-payload";

export const dynamic = "force-dynamic";

/**
 * NỘI DUNG MỘT HỘI THOẠI của hộp thư khách (`?c=<mã hội thoại>`) — khung chat gọi khi người bấm sang hội thoại khác, để KHÔNG dựng
 * lại cả trang (danh sách 100 hội thoại + 22 câu SQL — đo HSLC 10/10/2026: 350–800 ms mỗi lần bấm). Cùng lõi với trang
 * (`inboxThreadPayload`: quyền xem, đánh dấu đã đọc, lọc chữ nội bộ cho workspace khách). Route GET thay vì server action: lời gọi
 * action xếp hàng sau lượt tự làm mới 5 giây của trang, còn `fetch` thì không.
 */
export async function GET(request: Request) {
  const guard = await apiGuard(null);
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ai_sales:view")) return NextResponse.json({ ok: false, error: "Không có quyền xem AI bán hàng" }, { status: 403 });
  const id = new URL(request.url).searchParams.get("c")?.trim() ?? "";
  if (!id || id.length > 100) return NextResponse.json({ ok: false, error: "Thiếu mã hội thoại" }, { status: 400 });
  const payload = await inboxThreadPayload(user, id);
  return NextResponse.json(payload, { status: payload.ok ? 200 : 404, headers: { "cache-control": "no-store" } });
}
