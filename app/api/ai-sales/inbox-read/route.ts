import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { markInboxReadCore } from "@/lib/sales-chatbot/inbox-read";

export const dynamic = "force-dynamic";

/**
 * ĐÁNH DẤU ĐỌC một hội thoại của hộp thư khách — khung chat gọi SAU KHI đã hiện nội dung, với mã tin KHÁCH cuối cùng có trong payload
 * (`thread.readThrough.id`). Máy chủ tự đọc mốc của tin đó (không nhận mốc từ trình duyệt), ghi con trỏ của RIÊNG người gọi, chỉ tiến,
 * và trả XÁC NHẬN (số chưa đọc trước / sau + dấu) để danh sách vá ngay — `lib/sales-chatbot/inbox-read.ts`. Route POST thay vì server
 * action vì lời gọi action xếp hàng sau lượt tự làm mới 5 giây của trang (cùng lý do với `inbox-thread`).
 */
export async function POST(request: Request) {
  const guard = await apiGuard(null);
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ai_sales:view")) return NextResponse.json({ ok: false, error: "Không có quyền xem AI bán hàng" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { c?: unknown; through?: unknown } | null;
  const result = await markInboxReadCore(user, body?.c, body?.through);
  return NextResponse.json(result, { status: result.ok ? 200 : 400, headers: { "cache-control": "no-store" } });
}
