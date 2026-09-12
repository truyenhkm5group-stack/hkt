import type { CaseTeam } from "@/lib/constants/action-queue";
import { FRESHNESS_BY_STAGE } from "@/lib/constants/logistics-freshness";

/**
 * ═══════════ NÚT THẮT FULFILLMENT NỘI BỘ: TỪ "ĐÃ CHỐT" TỚI "RỜI KHO" ═══════════
 *
 * Phạm vi CỐ Ý hẹp: chỉ đoạn `order confirmed → ready to fulfill → shipment created →
 * carrier accepted/picked up → left warehouse`. Khách đã đồng ý mua (Sales Funnel/CS đã xong việc
 * của họ) và hàng CHƯA rời kho (Giao vận chưa bắt đầu việc của họ) — khoảng giữa này KHÔNG có luật
 * cảnh báo chuyên biệt: `ORDER_CONFIRMATION_STALE` (lib/alerts/rules.ts) gộp chung "chưa có vận đơn"
 * VÀ "vận đơn còn PENDING" làm một, và chỉ xem NGƯỠNG CHUNG staleDays chứ không tách được "ĐVVC
 * chưa xác nhận nhận đơn" khỏi "ĐVVC đã nhận, bưu tá chưa tới lấy" — hai sự cố cần hai hành động
 * khác nhau (tạo lại vận đơn ↔ giục bưu tá).
 *
 * BỐN LÝ DO, LOẠI TRỪ LẪN NHAU, THEO ĐÚNG THỨ TỰ CHẶN (xét từ trên xuống, dừng ở lý do đầu tiên
 * đúng — xem lib/queries/fulfillment-bottleneck.ts::classifyRow):
 *
 *   1. DATA_BLOCKED            — đơn đã chốt nhưng thiếu SĐT/địa chỉ hoặc địa chỉ chưa chuẩn hoá,
 *                                 nên KHÔNG THỂ tạo vận đơn được (đây là "lỗi data khiến fulfillment
 *                                 không tiếp tục được").
 *   2. NOT_YET_SHIPPED         — đơn đã chốt, dữ liệu đủ, nhưng CHƯA có vận đơn nào ("confirmed
 *                                 nhưng chưa xử lý" / "chưa có shipment" — cùng một trạng thái CSDL).
 *   3. AWAITING_CARRIER_ACCEPT — đã tạo vận đơn (có mã) nhưng CHƯA thấy một sự kiện nào của Viettel
 *                                 Post xác nhận đã nhận đơn ("có shipment nhưng chưa carrier accept").
 *   4. AWAITING_PICKUP         — Viettel Post đã xác nhận nhận đơn nhưng bưu tá CHƯA tới lấy hàng
 *                                 ("label/tracking có nhưng hàng chưa rời kho").
 *
 * "Chờ quá SLA" KHÔNG phải một lý do thứ năm — mỗi lý do trên đều có hạn riêng (`BOTTLENECK_SLA_HOURS`)
 * và mỗi case tự khai `sla.breached`; lọc/đếm theo cờ đó trả lời đúng câu "đơn nào đang chờ quá SLA"
 * mà không cần một nhánh phân loại giả song song với ba nhánh còn lại.
 */
export const FULFILLMENT_BLOCK_REASONS = ["DATA_BLOCKED", "NOT_YET_SHIPPED", "AWAITING_CARRIER_ACCEPT", "AWAITING_PICKUP"] as const;
export type FulfillmentBlockReason = (typeof FULFILLMENT_BLOCK_REASONS)[number];

export const BOTTLENECK_REASON_LABEL: Record<FulfillmentBlockReason, string> = {
  DATA_BLOCKED: "Thiếu dữ liệu · chưa tạo được vận đơn",
  NOT_YET_SHIPPED: "Đã chốt · chưa có vận đơn",
  AWAITING_CARRIER_ACCEPT: "Đã tạo vận đơn · ĐVVC chưa xác nhận nhận đơn",
  AWAITING_PICKUP: "ĐVVC đã nhận đơn · bưu tá chưa tới lấy hàng",
};

export const BOTTLENECK_NEXT_ACTION: Record<FulfillmentBlockReason, string> = {
  DATA_BLOCKED: "Gọi khách xác nhận lại SĐT / địa chỉ, chọn TAY tỉnh-xã trên Pancake rồi mới tạo vận đơn. Không đoán hộ khách.",
  NOT_YET_SHIPPED: "Đóng gói và tạo vận đơn Viettel Post ngay — đơn đã chốt, hàng còn nguyên trong kho, chỉ thiếu thao tác.",
  AWAITING_CARRIER_ACCEPT: "Kiểm tra lại trên Viettel Post xem đơn đã vào hệ thống chưa; nếu không thấy, tạo lại vận đơn hoặc gọi tổng đài ĐVVC.",
  AWAITING_PICKUP: "Giục bưu tá tới lấy hàng, hoặc tự mang ra bưu cục gần nhất — vận đơn đã có mã nhưng hàng vẫn đang nằm trong kho.",
};

/** Bộ phận chịu trách nhiệm — dùng lại đúng phân loại chung (`lib/constants/action-queue.ts`), không đặt tên riêng. */
export const BOTTLENECK_TEAM: Record<FulfillmentBlockReason, CaseTeam> = {
  // Cần gọi khách xác nhận lại thông tin — việc của CSKH, giống ORDER_INCOMPLETE / ORDER_ADDRESS_NOT_NORMALIZED.
  DATA_BLOCKED: "CS",
  // Hàng còn nguyên trong kho, chỉ thiếu thao tác đóng gói / tạo vận đơn — việc của kho.
  NOT_YET_SHIPPED: "WAREHOUSE",
  AWAITING_CARRIER_ACCEPT: "WAREHOUSE",
  AWAITING_PICKUP: "WAREHOUSE",
};

/**
 * HẠN XỬ LÝ, TÁI DÙNG NGƯỠNG ĐÃ CÓ — không hard-code thêm một bộ số giờ mới.
 *
 *  · DATA_BLOCKED / NOT_YET_SHIPPED dùng chung 24 giờ với `ORDER_CONFIRMATION_STALE` (đặc tả tại
 *    `lib/constants/action-queue.ts::CASE_SLA_HOURS`) — đúng khâu READY_TO_SHIP của phễu vận hành.
 *  · AWAITING_CARRIER_ACCEPT dùng ngưỡng "bắt đầu cũ" của chặng PENDING (`FRESHNESS_BY_STAGE.PENDING.aging`,
 *    24 giờ) — quá một ngày mà Viettel Post còn chưa xác nhận nhận đơn là bất thường, cần kiểm tra lại.
 *  · AWAITING_PICKUP dùng ngưỡng "cũ" của cùng chặng (`.stale`, 48 giờ) — rộng hơn một chút vì bưu tá
 *    chậm vài ngày ở giờ cao điểm là chuyện thường (xem chú thích gốc trong logistics-freshness.ts).
 */
const NOT_YET_SHIPPED_SLA_HOURS = 24;
export const BOTTLENECK_SLA_HOURS: Record<FulfillmentBlockReason, number> = {
  DATA_BLOCKED: NOT_YET_SHIPPED_SLA_HOURS,
  NOT_YET_SHIPPED: NOT_YET_SHIPPED_SLA_HOURS,
  AWAITING_CARRIER_ACCEPT: FRESHNESS_BY_STAGE.PENDING.aging,
  AWAITING_PICKUP: FRESHNESS_BY_STAGE.PENDING.stale,
};
