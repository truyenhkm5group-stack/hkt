import { getDb, schema } from "@/db";

/**
 * KHÁCH THAN GIAO CHẬM TRONG HỘI THOẠI BOT ⇒ MỘT CA CSKH `URGE_DELIVERY` (P0 21/10/2026, ca HSLC #BD31267C).
 *
 * Không dựng hàng đợi mới: dùng lại `cs_cases` — loại `URGE_DELIVERY` đã nằm trong `CS_ESCALATE_KINDS` (khách đang chờ câu trả lời),
 * phòng và hạn xử lý lấy từ `CASE_TEAM` / `CASE_SLA_HOURS` qua `applyWorkConfig()` như mọi ca khác. Ca KHÔNG gán người (luật 22: sở hữu
 * chỉ trỏ tới PHÒNG), không ghi ô kết luận (máy không xử lý gì).
 *
 * Chống trùng theo ĐƠN (`dedupe_key`): khách nhắn «sao chưa giao» ba lần là MỘT việc, không phải ba. Không có đơn ⇒ khoá theo hội thoại.
 */
export const CHAT_DELAY_CASE_SOURCE = "AUTO_SALES_CHAT_DELAY";

export type ChatDelayCaseInput = {
  conversationId: string;
  orderId: string | null;
  shortCode: string | null;
  waitedDays: number | null;
  /** Câu ERP biết về vận chuyển (đã dựng ở engine) — không suy ra «chưa gửi» từ việc ERP không có vận đơn. */
  shipInfo: string;
  customer: { name: string; phone: string } | null | undefined;
};

/** Dòng ca cần ghi. HÀM THUẦN. */
export function chatDelayCaseRow(i: ChatDelayCaseInput) {
  const waited = typeof i.waitedDays === "number" && Number.isFinite(i.waitedDays) ? `khách đã chờ ${Math.floor(i.waitedDays)} ngày kể từ lúc lên đơn` : "chưa đọc được ngày lên đơn";
  return {
    dedupeKey: i.orderId ? `sales-chat:delay:${i.orderId}` : `sales-chat:delay:conv:${i.conversationId}`,
    orderId: i.orderId,
    kind: "URGE_DELIVERY",
    status: "OPEN",
    source: CHAT_DELAY_CASE_SOURCE,
    title: `Khách than giao chậm${i.shortCode ? ` · đơn #${i.shortCode}` : ""}`,
    detail: [waited, i.shipInfo, "Bot đã chuyển hội thoại cho nhân viên — kiểm POS / ĐVVC rồi báo khách tình trạng THẬT, không hứa mốc chưa có căn cứ."].filter(Boolean).join(" · "),
    customerName: i.customer?.name ?? "",
    customerPhone: i.customer?.phone ?? "",
    conversationId: i.conversationId,
    createdBy: "sales-chatbot",
  };
}

/** Mở ca (hoặc không làm gì nếu đơn đã có ca này). Trả `true` khi vừa tạo. */
export async function openChatDelayCase(i: ChatDelayCaseInput): Promise<boolean> {
  const db = await getDb();
  const rows = await db.insert(schema.csCases).values(chatDelayCaseRow(i)).onConflictDoNothing({ target: schema.csCases.dedupeKey }).returning({ id: schema.csCases.id });
  return rows.length > 0;
}
