import { sql } from "drizzle-orm";
import { schema } from "@/db";

const o = schema.orders;

/**
 * NGUỒN ĐƠN — khách đến từ đâu.
 *
 * Hai kênh shop đang chạy:
 *   · FACEBOOK — khách nhắn tin qua fanpage rồi nhân viên chốt đơn trong hội thoại;
 *   · LANDING  — khách tự điền form trên landing page, ERP đẩy sang Pancake thành đơn.
 *
 * ĐƠN CÓ MẶT Ở CẢ HAI NGUỒN thì ghi cho nơi khách đặt TRƯỚC (quy tắc chủ shop chốt 08/09/2026).
 * Mốc so sánh:
 *   · landing  = lúc khách bấm gửi form (`landing_orders.submitted_at`);
 *   · facebook = lúc đơn được tạo từ hội thoại (`orders.inserted_at`).
 * Đơn đẩy từ landing luôn được tạo SAU khi khách gửi form nên mặc nhiên thuộc landing; ngược lại
 * khách đã chốt đơn qua chat rồi mới điền form thì đơn vẫn thuộc facebook.
 *
 * Đây là MỘT CHỖ DUY NHẤT định nghĩa nguồn đơn. Báo cáo nào cần chia theo nguồn thì dùng lại
 * `ORDER_SOURCE`, không tự viết điều kiện riêng.
 *
 * Lưu ý kỹ thuật: dùng `exists` / subquery chứ KHÔNG join `landing_orders`, vì một đơn Pancake có
 * thể được nhiều dòng landing trỏ tới (khách gửi form hai lần) — join sẽ nhân đôi số đơn.
 */
export type OrderSourceKey = "FACEBOOK" | "LANDING" | "OTHER";

export const ORDER_SOURCE_LABEL: Record<OrderSourceKey, string> = {
  FACEBOOK: "Chat fanpage Facebook",
  LANDING: "Landing page",
  OTHER: "Nguồn khác",
};

export const ORDER_SOURCE_HINT: Record<OrderSourceKey, string> = {
  FACEBOOK: "Khách nhắn tin qua fanpage, nhân viên chốt đơn trong hội thoại.",
  LANDING: "Khách tự điền form trên landing page; ERP đẩy sang Pancake thành đơn.",
  OTHER: "Đơn không có dấu vết của hai kênh trên — nhập tay, sàn TMĐT hoặc nguồn chưa khai báo.",
};

export const ORDER_SOURCE_TONE: Record<OrderSourceKey, string> = {
  FACEBOOK: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  LANDING: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  OTHER: "bg-muted text-muted-foreground",
};

/** Đơn này có dòng landing nào trỏ tới không. */
export const HAS_LANDING = sql`exists (select 1 from landing_orders lo where lo.order_id = ${o.id})`;

/** Lúc khách gửi form landing sớm nhất cho đơn này. */
const LANDING_AT = sql`(select min(lo.submitted_at) from landing_orders lo where lo.order_id = ${o.id})`;

/**
 * Dấu vết fanpage: có hội thoại, có page/post, hoặc chính Pancake ghi nguồn là Facebook.
 * Chỉ một trong số đó là đủ — đơn chốt trong chat luôn mang ít nhất một dấu.
 */
export const HAS_FACEBOOK = sql`(coalesce(${o.conversationId}, '') <> ''
  or coalesce(${o.pageId}, '') <> ''
  or coalesce(${o.postId}, '') <> ''
  or ${o.source} = 'Facebook')`;

export const ORDER_SOURCE = sql<OrderSourceKey>`case
  when ${HAS_LANDING} and ${HAS_FACEBOOK}
    then (case when coalesce(${LANDING_AT}, ${o.insertedAt}) <= ${o.insertedAt} then 'LANDING' else 'FACEBOOK' end)
  when ${HAS_LANDING} then 'LANDING'
  when ${HAS_FACEBOOK} then 'FACEBOOK'
  else 'OTHER' end`;
