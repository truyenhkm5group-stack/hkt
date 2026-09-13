/**
 * ═══════════ LÝ DO HOÀN: PHÂN LOẠI THEO CHỨNG TỪ, KHÔNG THEO TIỀN ═══════════
 *
 * ─── ĐO TRƯỚC KHI ĐẶT LUẬT (production, 13/09/2026) ───
 *
 *   956 vận đơn hoàn
 *     · `shipments.vtp_reason_code` NULL ở **cả 956** — cột mã lý do chưa từng được ghi
 *     · 208 (21,8%) có sự kiện `Tồn - …` mang lý do thật
 *     · 7 có ghi chú care
 *     · 0 có phiếu kiểm hàng hoàn
 *
 * Nghĩa là: **gần 4/5 vận đơn hoàn không có chứng từ nào nói vì sao.** Đó là một sự thật về dữ
 * liệu, không phải một lỗ hổng cần lấp bằng suy đoán. `UNKNOWN` là một câu trả lời hợp lệ và sẽ
 * là câu trả lời phổ biến nhất cho tới khi ĐVVC gửi mã lý do hoặc người xử lý tự ghi lại.
 *
 * ─── VÌ SAO KHÔNG SUY LÝ DO TỪ TIỀN ───
 *
 * Cám dỗ lớn nhất: đơn `RETURNED` do doanh thu dưới ngưỡng thì gán "khách từ chối". Sai hai lần.
 * Thứ nhất, tiền là chiều ĐỘC LẬP với logistics (`docs/business-rules/ORDER_OUTCOME.md`) — suy
 * chiều này từ chiều kia là đúng thứ đặc tả cấm. Thứ hai, "doanh thu thấp" có ít nhất bốn nguyên
 * nhân khác nhau (giao một phần, nhập sai, khách trả bớt món, chưa đối soát) và gộp cả bốn vào
 * một nhãn sẽ tạo ra một cột số trông đầy đủ mà không nói được điều gì.
 *
 * Với những đơn đó, `reason = UNKNOWN` và `outcomeBasis` ghi rõ kết quả đến từ luật doanh thu —
 * hai thông tin khác nhau, để cạnh nhau, không trộn.
 */

/**
 * ═══════════ TAXONOMY CỦA SHOP, KHÔNG PHẢI CỦA ĐVVC ═══════════
 *
 * Bảng lý do dưới đây chép đúng bảng Excel chủ shop đang dùng (13/09/2026). Điểm quan trọng nhất
 * về NGUỒN, phải đọc trước khi sửa bất cứ gì:
 *
 *   "Vải xấu", "Chật", "Không giống mẫu", "Vải nóng" — Viettel Post KHÔNG BAO GIỜ nói những câu
 *   này. ĐVVC không biết vải nóng hay dày. Đây là lý do do NGƯỜI CỦA SHOP hỏi khách rồi ghi lại.
 *
 * Hệ quả thiết kế: nhóm lý do chi tiết CHỈ có thể đến từ `shipment_return_reasons` (người xác
 * định). Máy suy từ chữ trạng thái ĐVVC chỉ với tới được những lý do THÔ (không liên lạc được,
 * sai địa chỉ, từ chối nhận) — và đó là lý do bảng báo cáo phải hiện độ phủ thật, không được để
 * người đọc tưởng cột 0 nghĩa là "không có ca nào".
 *
 * Đo production 13/09/2026: 854 vận đơn hoàn, 128 có chữ lý do từ ĐVVC, 0 có người xác định.
 * Bảng Excel của shop có 454 dòng với lý do chi tiết — tức là dữ liệu đó đang sống NGOÀI ERP.
 */
export const RETURN_REASONS = [
  /* ─── Chất lượng kém ─── */
  "QUALITY_POOR",
  "QUALITY_COLOR_BAD",
  "QUALITY_FABRIC_BAD",
  "QUALITY_SEWING_BAD",
  "QUALITY_NOT_AS_PICTURED",
  "QUALITY_FABRIC_HOT",
  "QUALITY_TOO_THICK",
  "QUALITY_FABRIC_THIN",
  "QUALITY_DEFECT",
  "QUALITY_LOOKS_BAD_ON",
  /* ─── Sai kích thước ─── */
  "SIZE_TIGHT",
  "SIZE_TIGHT_TOP",
  "SIZE_TIGHT_BOTTOM",
  "SIZE_LOOSE",
  "SIZE_LOOSE_TOP",
  "SIZE_LOOSE_BOTTOM",
  "SIZE_SALES_ADVICE_WRONG",
  "SIZE_DOES_NOT_FIT",
  /* ─── Giao lâu ─── */
  "SLOW_DELIVERY",
  "CUSTOMER_AWAY",
  /* ─── Cố ý boom hàng ─── */
  "BOOM_NO_REASON",
  "BOOM_MULTIPLE_ATTEMPTS",
  "CARRIER_NO_SUPPORT",
  /* ─── Lý do khác ─── */
  "WAREHOUSE_PACKED_WRONG",
  "SALES_CONFIRMED_WRONG",
  "CANCELLED_BEFORE_SHIP",
  "DUPLICATE_ORDER",
  /* ─── Lý do có từ trước: GIỮ NGUYÊN KHOÁ ───
     Chúng đã được máy suy ra và có thể đã nằm trong CSDL. Đổi tên khoá là làm mồ côi dữ liệu cũ. */
  "CUSTOMER_REFUSED",
  "CUSTOMER_UNREACHABLE",
  "WRONG_PHONE",
  "WRONG_ADDRESS",
  "CUSTOMER_RESCHEDULE_FAILED",
  "CUSTOMER_CHANGED_MIND",
  "DELIVERY_ATTEMPTS_EXHAUSTED",
  "SHOP_REQUESTED_RETURN",
  "DAMAGED",
  "WRONG_ITEM",
  "CARRIER_EXCEPTION",
  "OTHER",
  "UNKNOWN",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  QUALITY_POOR: "Chất lượng kém",
  QUALITY_COLOR_BAD: "Màu xấu",
  QUALITY_FABRIC_BAD: "Vải xấu",
  QUALITY_SEWING_BAD: "May xấu",
  QUALITY_NOT_AS_PICTURED: "Không giống mẫu",
  QUALITY_FABRIC_HOT: "Vải nóng",
  QUALITY_TOO_THICK: "Dày quá",
  QUALITY_FABRIC_THIN: "Vải mỏng",
  QUALITY_DEFECT: "Sản phẩm lỗi",
  QUALITY_LOOKS_BAD_ON: "Khách mặc xấu",
  SIZE_TIGHT: "Chật",
  SIZE_TIGHT_TOP: "Chật áo",
  SIZE_TIGHT_BOTTOM: "Chật quần",
  SIZE_LOOSE: "Rộng",
  SIZE_LOOSE_TOP: "Rộng áo",
  SIZE_LOOSE_BOTTOM: "Rộng quần",
  SIZE_SALES_ADVICE_WRONG: "SALE tư vấn sai size",
  SIZE_DOES_NOT_FIT: "Mặc không vừa",
  SLOW_DELIVERY: "Giao hàng quá lâu",
  CUSTOMER_AWAY: "Khách đi vắng",
  BOOM_NO_REASON: "Trả hàng không lí do / cố ý boom hàng",
  BOOM_MULTIPLE_ATTEMPTS: "Giao nhiều lần không nhận / bưu cục tự hoàn",
  CARRIER_NO_SUPPORT: "Bưu tá không hỗ trợ giao hàng",
  WAREHOUSE_PACKED_WRONG: "Kho đóng sai",
  SALES_CONFIRMED_WRONG: "Sale chốt sai",
  CANCELLED_BEFORE_SHIP: "Huỷ trước khi ship",
  DUPLICATE_ORDER: "Trùng đơn",
  CUSTOMER_REFUSED: "Khách từ chối nhận",
  CUSTOMER_UNREACHABLE: "Không liên lạc được khách",
  WRONG_PHONE: "Sai số điện thoại",
  WRONG_ADDRESS: "Sai địa chỉ",
  CUSTOMER_RESCHEDULE_FAILED: "Hẹn lại rồi vẫn không giao được",
  CUSTOMER_CHANGED_MIND: "Khách đổi ý, không còn nhu cầu",
  DELIVERY_ATTEMPTS_EXHAUSTED: "Phát nhiều lần không thành",
  SHOP_REQUESTED_RETURN: "Shop yêu cầu chuyển hoàn",
  DAMAGED: "Hàng hỏng / bể vỡ",
  WRONG_ITEM: "Giao sai hàng",
  CARRIER_EXCEPTION: "Sự cố phía đơn vị vận chuyển",
  OTHER: "Lý do khác (có ghi chú)",
  UNKNOWN: "Chưa xác định được",
};

/** Ai chịu trách nhiệm chính — để báo cáo nói được "sửa ở đâu", không chỉ "hỏng ở đâu". */
export const RETURN_REASON_OWNER: Record<ReturnReason, "SALES" | "LOGISTICS" | "WAREHOUSE" | "CUSTOMER" | "CARRIER" | "UNKNOWN"> = {
  // Chất lượng là việc của NGƯỜI MUA HÀNG / sản xuất, không phải của người bán hay người giao.
  QUALITY_POOR: "WAREHOUSE",
  QUALITY_COLOR_BAD: "WAREHOUSE",
  QUALITY_FABRIC_BAD: "WAREHOUSE",
  QUALITY_SEWING_BAD: "WAREHOUSE",
  QUALITY_NOT_AS_PICTURED: "SALES",
  QUALITY_FABRIC_HOT: "WAREHOUSE",
  QUALITY_TOO_THICK: "WAREHOUSE",
  QUALITY_FABRIC_THIN: "WAREHOUSE",
  QUALITY_DEFECT: "WAREHOUSE",
  QUALITY_LOOKS_BAD_ON: "CUSTOMER",
  // Sai size: phần lớn là tư vấn, nên thuộc KINH DOANH — trừ khi khách tự chọn sai.
  SIZE_TIGHT: "SALES",
  SIZE_TIGHT_TOP: "SALES",
  SIZE_TIGHT_BOTTOM: "SALES",
  SIZE_LOOSE: "SALES",
  SIZE_LOOSE_TOP: "SALES",
  SIZE_LOOSE_BOTTOM: "SALES",
  SIZE_SALES_ADVICE_WRONG: "SALES",
  SIZE_DOES_NOT_FIT: "CUSTOMER",
  SLOW_DELIVERY: "CARRIER",
  CUSTOMER_AWAY: "CUSTOMER",
  BOOM_NO_REASON: "CUSTOMER",
  BOOM_MULTIPLE_ATTEMPTS: "CUSTOMER",
  CARRIER_NO_SUPPORT: "CARRIER",
  WAREHOUSE_PACKED_WRONG: "WAREHOUSE",
  SALES_CONFIRMED_WRONG: "SALES",
  CANCELLED_BEFORE_SHIP: "SALES",
  DUPLICATE_ORDER: "SALES",
  CUSTOMER_REFUSED: "CUSTOMER",
  CUSTOMER_UNREACHABLE: "SALES",
  WRONG_PHONE: "SALES",
  WRONG_ADDRESS: "SALES",
  CUSTOMER_RESCHEDULE_FAILED: "CUSTOMER",
  CUSTOMER_CHANGED_MIND: "CUSTOMER",
  DELIVERY_ATTEMPTS_EXHAUSTED: "CARRIER",
  SHOP_REQUESTED_RETURN: "SALES",
  DAMAGED: "WAREHOUSE",
  WRONG_ITEM: "WAREHOUSE",
  CARRIER_EXCEPTION: "CARRIER",
  OTHER: "UNKNOWN",
  UNKNOWN: "UNKNOWN",
};

/**
 * ═══════════ NHÓM LÝ DO LỚN — ĐỌC ĐỂ RA QUYẾT ĐỊNH, KHÔNG PHẢI ĐỂ ĐẾM ═══════════
 *
 * Ba mươi lý do chi tiết là thứ NGƯỜI XỬ LÝ cần khi ghi một ca. Chủ shop đọc báo cáo thì không
 * quyết định gì được từ ba mươi dòng — quyết định nằm ở tầng nhóm: "hoàn vì chất lượng" đi tới
 * xưởng, "hoàn vì sai size" đi tới bảng size và cách tư vấn, "hoàn vì giao lâu" đi tới ĐVVC.
 *
 * Nên báo cáo có HAI TẦNG, và tầng nhóm là tầng mặc định mở.
 *
 * `UNKNOWN` CỐ Ý đứng riêng, KHÔNG nằm trong "Lý do khác": "lý do khác" nghĩa là đã hỏi và biết,
 * chỉ không thuộc nhóm nào; "chưa xác định được" nghĩa là CHƯA AI HỎI. Gộp hai thứ đó lại thì
 * một khoảng trống dữ liệu trông như một nhóm nguyên nhân đã hiểu rõ.
 */
/** Lý do mà chứng từ ĐVVC (mã hoặc chữ trạng thái) với tới được. Mọi lý do khác cần NGƯỜI ghi. */
const MACHINE_READABLE_REASONS = new Set<ReturnReason>([
  "CUSTOMER_REFUSED",
  "CUSTOMER_UNREACHABLE",
  "WRONG_PHONE",
  "WRONG_ADDRESS",
  "CUSTOMER_RESCHEDULE_FAILED",
  "CUSTOMER_CHANGED_MIND",
  "DELIVERY_ATTEMPTS_EXHAUSTED",
  "SHOP_REQUESTED_RETURN",
  "DAMAGED",
  "WRONG_ITEM",
  "CARRIER_EXCEPTION",
  "SLOW_DELIVERY",
  "CUSTOMER_AWAY",
  "UNKNOWN",
]);

export const RETURN_REASON_GROUPS = ["QUALITY", "SIZE", "SLOW", "BOOM", "OTHER", "UNKNOWN"] as const;
export type ReturnReasonGroup = (typeof RETURN_REASON_GROUPS)[number];

export const RETURN_REASON_GROUP_LABEL: Record<ReturnReasonGroup, string> = {
  QUALITY: "Chất lượng kém",
  SIZE: "Sai kích thước",
  SLOW: "Giao lâu",
  BOOM: "Cố ý boom hàng",
  OTHER: "Lý do khác",
  UNKNOWN: "Chưa xác định được",
};

/** Một câu: nhóm này hỏng ở đâu thì sửa ở đâu. Hiện trên tooltip của dòng nhóm. */
export const RETURN_REASON_GROUP_ACTION: Record<ReturnReasonGroup, string> = {
  QUALITY: "Đi tới nguồn hàng và khâu kiểm trước khi đóng gói — không sửa được bằng cách chăm khách kỹ hơn.",
  SIZE: "Đi tới bảng size trên trang bán và cách tư vấn chốt đơn. Nhóm này thường sửa được bằng thông tin, không bằng đổi hàng.",
  SLOW: "Đi tới đơn vị vận chuyển và mốc bàn giao của kho. Khách không đổi ý, họ chỉ đợi quá lâu.",
  BOOM: "Đi tới khâu xác nhận đơn: gọi xác nhận trước khi gửi, hoặc yêu cầu đặt cọc với khách có lịch sử boom.",
  OTHER: "Mỗi lý do trong nhóm này có chỗ sửa riêng — xổ nhóm ra để thấy.",
  UNKNOWN: "KHÔNG phải một nguyên nhân. Đây là số ca chưa ai hỏi vì sao; sửa bằng cách ghi lý do khi xử lý ca hoàn.",
};

export const RETURN_REASON_GROUP_OF: Record<ReturnReason, ReturnReasonGroup> = {
  QUALITY_POOR: "QUALITY",
  QUALITY_COLOR_BAD: "QUALITY",
  QUALITY_FABRIC_BAD: "QUALITY",
  QUALITY_SEWING_BAD: "QUALITY",
  QUALITY_NOT_AS_PICTURED: "QUALITY",
  QUALITY_FABRIC_HOT: "QUALITY",
  QUALITY_TOO_THICK: "QUALITY",
  QUALITY_FABRIC_THIN: "QUALITY",
  QUALITY_DEFECT: "QUALITY",
  QUALITY_LOOKS_BAD_ON: "QUALITY",
  SIZE_TIGHT: "SIZE",
  SIZE_TIGHT_TOP: "SIZE",
  SIZE_TIGHT_BOTTOM: "SIZE",
  SIZE_LOOSE: "SIZE",
  SIZE_LOOSE_TOP: "SIZE",
  SIZE_LOOSE_BOTTOM: "SIZE",
  SIZE_SALES_ADVICE_WRONG: "SIZE",
  SIZE_DOES_NOT_FIT: "SIZE",
  SLOW_DELIVERY: "SLOW",
  CUSTOMER_AWAY: "SLOW",
  BOOM_NO_REASON: "BOOM",
  BOOM_MULTIPLE_ATTEMPTS: "BOOM",
  CARRIER_NO_SUPPORT: "BOOM",
  WAREHOUSE_PACKED_WRONG: "OTHER",
  SALES_CONFIRMED_WRONG: "OTHER",
  CANCELLED_BEFORE_SHIP: "OTHER",
  DUPLICATE_ORDER: "OTHER",
  /* ─── Lý do máy suy ra được từ chữ của ĐVVC ─── */
  CUSTOMER_UNREACHABLE: "SLOW",
  CUSTOMER_RESCHEDULE_FAILED: "SLOW",
  CUSTOMER_REFUSED: "BOOM",
  CUSTOMER_CHANGED_MIND: "BOOM",
  DELIVERY_ATTEMPTS_EXHAUSTED: "BOOM",
  DAMAGED: "QUALITY",
  WRONG_ITEM: "OTHER",
  WRONG_PHONE: "OTHER",
  WRONG_ADDRESS: "OTHER",
  SHOP_REQUESTED_RETURN: "OTHER",
  CARRIER_EXCEPTION: "SLOW",
  OTHER: "OTHER",
  UNKNOWN: "UNKNOWN",
};

/**
 * LÝ DO NÀO MÁY SUY RA ĐƯỢC, LÝ DO NÀO BẮT BUỘC PHẢI CÓ NGƯỜI GHI.
 *
 * Đây là ranh giới quan trọng nhất của cả taxonomy này, và nó quyết định con số nào trong báo cáo
 * đáng tin. Viettel Post biết kiện đi tới đâu và vì sao không phát được; ĐVVC KHÔNG biết vải nóng,
 * không biết khách mặc có vừa không. Những lý do đó chỉ có nếu người của shop hỏi khách rồi ghi.
 *
 * Báo cáo dùng bảng này để nói thẳng: nhóm lý do nào đang ở 0 vì THẬT SỰ không có ca nào, và nhóm
 * nào đang ở 0 vì CHƯA AI GHI. Hai chuyện khác hẳn nhau.
 */
export const REASON_NEEDS_HUMAN: Record<ReturnReason, boolean> = Object.fromEntries(
  RETURN_REASONS.map((r) => [r, !MACHINE_READABLE_REASONS.has(r)]),
) as Record<ReturnReason, boolean>;

/**
 * MÃ LÝ DO CỦA ĐVVC → phân loại của shop.
 *
 * Dải 20–47 là bảng webhook chính thức, dải 1–17 là bảng đối tác V2 cũ (xem
 * `lib/constants/viettelpost.ts::VTP_REASON_CODES`). Cả hai được khai ở đây vì vận đơn lịch sử
 * dùng bảng cũ.
 *
 * LƯU Ý QUAN TRỌNG: tính tới 13/09/2026, `shipments.vtp_reason_code` NULL trên toàn bộ dữ liệu
 * production — bảng này **chưa từng khớp một dòng nào**. Nó được khai sẵn và đúng, để ngày ĐVVC
 * bắt đầu gửi mã thì độ phủ tự tăng mà không phải sửa gì. Đừng nhầm "đã khai" với "đang chạy".
 */
export const VTP_REASON_TO_RETURN_REASON: Record<number, ReturnReason> = {
  20: "WRONG_ITEM",
  21: "WRONG_ITEM",
  22: "WRONG_ITEM",
  23: "DAMAGED",
  24: "CUSTOMER_REFUSED",
  25: "WRONG_ITEM",
  26: "CUSTOMER_REFUSED",
  27: "WRONG_PHONE",
  30: "CUSTOMER_CHANGED_MIND",
  31: "CUSTOMER_CHANGED_MIND",
  32: "WRONG_ADDRESS",
  35: "CUSTOMER_RESCHEDULE_FAILED",
  36: "CUSTOMER_UNREACHABLE",
  37: "CARRIER_EXCEPTION",
  38: "CUSTOMER_RESCHEDULE_FAILED",
  43: "SHOP_REQUESTED_RETURN",
  46: "CUSTOMER_RESCHEDULE_FAILED",
  47: "CUSTOMER_UNREACHABLE",
  1: "CUSTOMER_RESCHEDULE_FAILED",
  2: "CUSTOMER_UNREACHABLE",
  3: "CUSTOMER_RESCHEDULE_FAILED",
  4: "CUSTOMER_REFUSED",
  5: "WRONG_ITEM",
  6: "WRONG_ITEM",
  7: "WRONG_ITEM",
  8: "WRONG_ITEM",
  9: "CUSTOMER_REFUSED",
  10: "WRONG_ADDRESS",
  11: "DAMAGED",
  12: "CUSTOMER_REFUSED",
  13: "CUSTOMER_CHANGED_MIND",
  14: "CUSTOMER_CHANGED_MIND",
  15: "WRONG_PHONE",
  16: "DELIVERY_ATTEMPTS_EXHAUSTED",
  17: "SHOP_REQUESTED_RETURN",
};

/**
 * CHUỖI TRẠNG THÁI "Tồn - …" → phân loại.
 *
 * Đây là nguồn lý do DUY NHẤT đang thật sự chạy (208/956 vận đơn hoàn). Viettel Post đẩy lý do
 * vào phần tên trạng thái chứ không vào mã, nên phải đọc chữ.
 *
 * So khớp trên chuỗi ĐÃ BỎ DẤU và hạ chữ, vì cùng một lý do xuất hiện với vài cách viết dấu khác
 * nhau giữa webhook và bản nhập Excel. Thứ tự trong mảng là thứ tự ưu tiên: mẫu cụ thể đứng trước
 * mẫu chung, để "khách hàng nghỉ, không có nhà" không bị nuốt bởi một mẫu "khách hàng" rộng hơn.
 */
export const RETURN_REASON_TEXT_RULES: { match: string; reason: ReturnReason }[] = [
  { match: "khach hang nghi, khong co nha", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khong co nha", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khong lien lac", reason: "CUSTOMER_UNREACHABLE" },
  { match: "khach hang den buu cuc nhan", reason: "CUSTOMER_RESCHEDULE_FAILED" },
  { match: "hen phat lai", reason: "CUSTOMER_RESCHEDULE_FAILED" },
  { match: "tu choi", reason: "CUSTOMER_REFUSED" },
  { match: "khong cho xem hang", reason: "CUSTOMER_REFUSED" },
  { match: "khong co nhu cau", reason: "CUSTOMER_CHANGED_MIND" },
  { match: "khong dat don", reason: "CUSTOMER_CHANGED_MIND" },
  { match: "sai dia chi", reason: "WRONG_ADDRESS" },
  { match: "sai so dien thoai", reason: "WRONG_PHONE" },
  { match: "sai dinh dang so dien thoai", reason: "WRONG_PHONE" },
  { match: "chat luong kem", reason: "DAMAGED" },
  { match: "hu hong", reason: "DAMAGED" },
  { match: "sai mau", reason: "WRONG_ITEM" },
  { match: "sai kich thuoc", reason: "WRONG_ITEM" },
  { match: "sai kieu dang", reason: "WRONG_ITEM" },
  { match: "sai so luong", reason: "WRONG_ITEM" },
  { match: "phat that bai nhieu lan", reason: "DELIVERY_ATTEMPTS_EXHAUSTED" },
  { match: "nguoi gui yeu cau chuyen hoan", reason: "SHOP_REQUESTED_RETURN" },
  { match: "shop yeu cau", reason: "SHOP_REQUESTED_RETURN" },
];

/**
 * Chuỗi trạng thái là BƯỚC ĐI, không phải LÝ DO.
 *
 * "Tồn - Thông báo chuyển hoàn bưu cục gốc" (178 vận đơn) trông như một lý do vì nó bắt đầu bằng
 * "Tồn -", nhưng nó chỉ nói kiện đang trên đường về — chưa nói vì sao. Nhận nhầm nhóm này thành
 * lý do sẽ tạo ra một nhãn chiếm 18% báo cáo mà không hành động được gì với nó.
 */
export const RETURN_STEP_NOT_REASON = ["thong bao chuyen hoan", "chuyen hoan buu cuc goc", "chuyen tra nguoi gui"];

/** Bỏ dấu tiếng Việt + hạ chữ, để so khớp không phụ thuộc cách gõ dấu. */
export function boDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/** Độ tin cậy của một lần phân loại — đi kèm từng dòng, không phải một ghi chú ở cuối trang. */
export type ReasonConfidence = "CONFIRMED" | "CARRIER_CODE" | "CARRIER_TEXT" | "NONE";

export const REASON_CONFIDENCE_LABEL: Record<ReasonConfidence, string> = {
  CONFIRMED: "Người xác nhận",
  CARRIER_CODE: "Mã lý do ĐVVC",
  CARRIER_TEXT: "Suy từ trạng thái ĐVVC",
  NONE: "Không có chứng từ",
};
