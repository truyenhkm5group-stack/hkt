/** Quy tắc nhận diện đơn hoàn theo dữ liệu vận đơn (do shop quy định). */
export const RETURN_RULE = {
  /**
   * Vận đơn "Giao thành công" nhưng COD = 0 và cước < ngưỡng này thực chất là đơn hoàn
   * (khách không nhận / khách chỉ trả tiền ship). Đơn giao thành công thật có cước ≥ ngưỡng.
   */
  maxFeeForFakeDelivery: 10_000,
  /**
   * ĐƠN GIAO THÀNH CÔNG = đơn có doanh thu COD THỰC (tiền thu hộ thực thu / đã về theo bảng kê) > ngưỡng này; chưa có số thực thu
   * thì lấy COD trên vận đơn / đơn khi vận đơn báo giao thành công. COD ≤ ngưỡng (khách không nhận, chỉ trả tiền ship / phí xem
   * hàng 20–50K) → KHÔNG thành công (tính như hoàn) trên mọi báo cáo; trừ đơn khách đã chuyển khoản trước (prepaid > ngưỡng).
   * Tỷ lệ giao thành công = giao thành công / (giao thành công + không thành công) trên đơn đã kết thúc.
   */
  maxCodForFakeDelivery: 100_000,
  /**
   * ĐƠN HOÀN: vận đơn báo "giao thành công" nhưng doanh thu COD thực < ngưỡng này thực chất là ĐƠN HOÀN — khách trả hàng,
   * shop không thu được tiền, Viettel Post vẫn ghi nhận "giao thành công" cho chiều hoàn (giao thành công hàng hoàn).
   * Khoảng giữa hai ngưỡng (50K–100K) là đơn thu thiếu / chỉ thu phí: cũng KHÔNG tính là giao thành công.
   */
  maxCodForReturn: 50_000,
};

/**
 * `UNKNOWN` = ERP KHÔNG có bất kỳ dấu vết nào của ĐVVC cho vận đơn này (không mã, không sự kiện).
 * Cố ý tách khỏi `IN_TRANSIT`: "đang giao" là một khẳng định về vị trí gói hàng, phải có chứng từ
 * mới nói được. Cũng khác `NOT_SHIPPED` — chỗ đó là đơn chưa hề tạo vận đơn.
 *
 * `AWAITING_PICKUP` (chủ shop chốt 13/09/2026) = ĐÃ tạo vận đơn, ĐVVC ĐÃ biết đến kiện — nhưng
 * CHƯA CÓ MỘT CHỨNG TỪ NÀO nói họ đã cầm hàng. Đây là bước thứ ba của cùng một nguyên tắc mà
 * `UNKNOWN` đã dựng lên: **"đang giao" là khẳng định về VỊ TRÍ gói hàng, phải có chứng từ mới nói
 * được.** Kiện ở đây nằm trong kho của shop, hoặc đang chờ bưu tá tới lấy.
 *
 * Vì sao KHÔNG dùng lại `NOT_SHIPPED`: chỗ đó dành cho đơn **chưa hề tạo vận đơn** — không có gì để
 * theo dõi, không có ai để giục. Kiện `AWAITING_PICKUP` thì có mã, có đối tác, và có người phải đi
 * hỏi. Gộp hai thứ lại là mất đúng cái phân biệt khiến việc này làm được.
 *
 * Đo production 13/09/2026: 106 đơn, 61.451.999đ COD treo, tuổi trung bình 3,2 ngày (cao nhất 9
 * ngày, 16 đơn quá 7 ngày). Trước đó chúng mang nhãn `IN_TRANSIT` — chủ shop tưởng 106 gói đang
 * trên đường tới khách trong khi chúng chưa rời kho.
 */
export type OrderOutcome = "NOT_SHIPPED" | "UNKNOWN" | "AWAITING_PICKUP" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "RETURNED_BY_RULE" | "CANCELLED";

export const OUTCOME_LABEL: Record<OrderOutcome, string> = {
  NOT_SHIPPED: "Chưa gửi",
  UNKNOWN: "Chưa có chứng từ ĐVVC",
  AWAITING_PICKUP: "Chờ ĐVVC lấy hàng",
  IN_TRANSIT: "Đang giao",
  DELIVERED: "Giao thành công (thu > 100K)",
  RETURNED: "Hoàn · hàng về kho (thu < 50K)",
  RETURNED_BY_RULE: "Không thành công (thu 50K–100K)",
  CANCELLED: "Huỷ",
};

export const OUTCOME_TONE: Record<OrderOutcome, string> = {
  NOT_SHIPPED: "bg-muted text-muted-foreground",
  UNKNOWN: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  // Tím: KHÔNG phải xanh của "đang giao" (kiện chưa đi), cũng KHÔNG phải xám của "chưa gửi"
  // (kiện này có mã và có người phải đi giục). Một màu riêng cho một tình trạng riêng.
  AWAITING_PICKUP: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  IN_TRANSIT: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  DELIVERED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  RETURNED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  RETURNED_BY_RULE: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export const RETURNED_OUTCOMES: OrderOutcome[] = ["RETURNED", "RETURNED_BY_RULE"];

/**
 * ═══════════ "ĐÃ GỬI" (ELIGIBLE SENT) — MỘT DANH SÁCH, KHAI ĐÚNG MỘT CHỖ ═══════════
 *
 * **Đã gửi = có CHỨNG TỪ ĐVVC nói họ đã cầm kiện hàng này.** Đây là chỉ số TÍCH LUỸ ("kỳ này đã
 * gửi đi tổng bao nhiêu đơn"), khác hẳn rổ `IN_FLIGHT` của `lib/constants/fulfillment-bucket.ts`
 * — chỗ đó đếm "ngay lúc này có bao nhiêu kiện đang đi". Hai chỉ số, hai cái tên, hai chỗ khai.
 *
 * Bốn kết quả dưới đây đều hàm ý kiện ĐÃ rời kho: đang đi, đã tới tay khách, đã quay đầu về, hoặc
 * đã về mà thu không đủ. Hàng không thể quay về nếu chưa từng được lấy đi.
 *
 * ─── BỐN THỨ CỐ Ý KHÔNG CÓ TRONG DANH SÁCH ───
 *
 *  · `AWAITING_PICKUP` — đã có mã vận đơn, ĐVVC đã biết tới kiện, nhưng CHƯA có một chứng từ nào
 *    nói họ đã cầm hàng. Đo production 14/09/2026: **106 kiện**, 61.451.999đ COD treo. Trước bản
 *    13/09 chúng mang nhãn `IN_TRANSIT` và đi thẳng vào mẫu số của mọi báo cáo "đã gửi".
 *  · `NOT_SHIPPED` — chưa hề tạo vận đơn.
 *  · `UNKNOWN` — có vận đơn nhưng ERP chưa nhận được tin nào.
 *  · `CANCELLED` — huỷ.
 *
 * Ai thấy danh sách "thiếu" một giá trị và định thêm cho đủ thì đọc lại đoạn trên: thêm một kết
 * quả chưa có chứng từ bàn giao vào đây là nhét kiện chưa rời kho vào lô hàng đã gửi của kỳ đó.
 *
 * ─── VÌ SAO PHẢI LÀ HẰNG SỐ, KHÔNG PHẢI BỐN CHUỖI GIỐNG NHAU ───
 *
 * Trước 14/09/2026 danh sách này được gõ NGUYÊN VĂN ở bốn chỗ: `IS_SHIPPED`, cột `shipped` của
 * bảng theo mẫu mã, cột `shipped` của dòng tổng hợp, và vị ngữ `shipped` của báo cáo lợi nhuận.
 * Bốn bản sao đang đồng ý với nhau — nhưng thêm `AWAITING_PICKUP` là một lượt sửa bốn chỗ, và cả
 * lớp lỗi P1 sinh ra từ đúng chuyện đó: sửa ba, quên một, không có gì đỏ lên.
 *
 * `tests/contract-order-outcome.test.ts` quét mã nguồn để không ai gõ lại danh sách này lần nữa.
 */
export const ELIGIBLE_SENT_OUTCOMES = ["IN_TRANSIT", "DELIVERED", "RETURNED", "RETURNED_BY_RULE"] as const satisfies readonly OrderOutcome[];

/**
 * Cùng danh sách, dạng dùng được trong `in (...)` của SQL. SINH RA từ mảng trên — không gõ lại,
 * vì hai bản chép tay là đúng thứ hằng số này tồn tại để loại bỏ.
 */
export const ELIGIBLE_SENT_SQL = ELIGIBLE_SENT_OUTCOMES.map((x) => `'${x}'`).join(",");

/** Câu giải thích hiện trên tooltip của mọi cột mang tên "Đã gửi". Một chỗ viết, mọi màn dùng lại. */
export const ELIGIBLE_SENT_HINT =
  "Đã gửi = vận đơn đã có bằng chứng ĐVVC nhận hàng. KHÔNG tính đơn đang đóng gói, đang chờ bưu tá tới lấy, bưu tá lấy không thành công, shop huỷ lấy, hay vận đơn mới tạo mã mà chưa bàn giao.";

/** Các cột bảng tỷ lệ giao thành công được phép sắp xếp (dùng chung máy chủ + bảng phía trình duyệt) */
export const RETURN_RATE_SORTABLE = ["successRate", "expectedSuccessRate", "rate", "expectedRate", "returned", "delivered", "shipped", "inTransit", "failed", "lostRevenue", "sku"];

/** Ngưỡng tỷ lệ giao thành công (%): ≥ tốt = xanh, ≥ khá = vàng, dưới = đỏ */
export const SUCCESS_RATE_GOOD = 70;
export const SUCCESS_RATE_OK = 55;

/** Màu chữ theo mức tỷ lệ GIAO THÀNH CÔNG (dùng chung server/client) */
export function successTone(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= SUCCESS_RATE_GOOD) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= SUCCESS_RATE_OK) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

/** Màu chữ theo mức tỷ lệ hoàn (dùng chung server/client) */
export function rateTone(rate: number | null) {
  if (rate === null) return "text-muted-foreground";
  if (rate >= 30) return "text-rose-600 dark:text-rose-400";
  if (rate >= 15) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

