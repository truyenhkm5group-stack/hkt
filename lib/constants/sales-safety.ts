/**
 * ═══════════════ BẢNG AN TOÀN — GOM LẠI, KHÔNG PHÁT HIỆN THÊM ═══════════════
 *
 * Tệp này KHÔNG soi câu, KHÔNG chấm điểm, KHÔNG thêm một luật an toàn nào. Nó chỉ khai: mỗi loại
 * vi phạm mà chủ shop muốn theo dõi ĐANG được đo bằng tín hiệu nào đã có sẵn trong hệ thống — hoặc
 * thành thật rằng CHƯA CÓ GÌ ĐO ĐƯỢC.
 *
 * ─── VÌ SAO KHÔNG IN TẤT CẢ THÀNH 0 ───
 *
 * Một bảng an toàn in "0 vi phạm" cho mười hai loại, trong khi chỉ tám loại có người đo, là bảng
 * nguy hiểm hơn hẳn việc không có bảng nào: nó nói PASS bằng giọng của một hệ thống đã kiểm, còn
 * sự thật là bốn loại kia không ai nhìn. Luật 42 và luật 45 của kho mã này nói cùng một câu —
 * CHƯA BIẾT không được in ra thành 0. Nên mỗi mục mang cờ `measured`, và mục chưa đo được phải
 * khai `missingWhat` cụ thể tới mức sửa được.
 *
 * ─── HAI CỘT, VÌ "CHẶN ĐƯỢC" KHÔNG PHẢI "VI PHẠM" ───
 *
 *   ĐÃ CHẶN  — chốt an toàn nổ trước khi câu ra khỏi máy. Đây là thứ ta trả tiền để có; đếm nó vào
 *              số vi phạm là biến một hệ thống đang làm đúng việc thành một báo động đỏ, và sau
 *              vài lần như thế thì không ai đọc bảng này nữa.
 *   ĐÃ LỌT   — đã tới khách hoặc đã ghi dữ liệu. ĐÂY mới là vi phạm.
 *
 * Con số lớn trên đầu thẻ là ĐÃ LỌT. Số ĐÃ CHẶN đứng cạnh như một dòng tin tốt.
 */

/** Mười hai loại chủ shop nêu. Thứ tự này là thứ tự hiển thị. */
export const SAFETY_VIOLATION_KINDS = [
  "AUTO_SEND_WITHOUT_HUMAN_CLICK",
  "DUPLICATE_SEND",
  "AI_CREATED_ORDER",
  "WRONG_PRODUCT",
  "TEST_TO_WIN_LEAKAGE",
  "INVENTED_PRICE",
  "INVENTED_PROMOTION",
  "INVENTED_SIZE",
  "INVENTED_INVENTORY",
  "INVENTED_POLICY",
  "FALSE_ORDER_CONFIRMATION",
  "AUTH_PERMISSION_VIOLATION",
] as const;
export type SafetyViolationKind = (typeof SAFETY_VIOLATION_KINDS)[number];

export type SafetyKindSpec = {
  label: string;
  /**
   * CÓ tín hiệu thật để đếm không. `false` ⇒ ô hiện "CHƯA ĐO ĐƯỢC", KHÔNG hiện 0, và thẻ không
   * được kết luận PASS tuyệt đối — chỉ PASS TRONG PHẠM VI ĐO ĐƯỢC.
   */
  measured: boolean;
  /** Đếm từ đâu — viết ra để người đọc kiểm lại được, không phải tin lời thẻ. Rỗng khi chưa đo được. */
  source?: string;
  /** Chưa đo được thì THIẾU CHÍNH XÁC CÁI GÌ. Phải cụ thể tới mức làm được. */
  missingWhat?: string;
};

export const SAFETY_KIND_SPEC: Record<SafetyViolationKind, SafetyKindSpec> = {
  AUTO_SEND_WITHOUT_HUMAN_CLICK: {
    label: "Máy gửi mà không có người bấm",
    measured: true,
    source: "sales_copilot_actions: dòng đã GỬI nhưng ô khoá tài khoản người bấm rỗng",
  },
  DUPLICATE_SEND: {
    label: "Gửi trùng (đọc lại thấy nhiều hơn một bản)",
    measured: true,
    source: "sales_copilot_actions.verified = false — máy tự đọc lại Pancake sau khi gửi",
  },
  AI_CREATED_ORDER: {
    label: "Máy tự tạo đơn",
    measured: true,
    source: "ai_tool_calls: công cụ order.create_draft / order.confirm chạy THÀNH CÔNG",
  },
  WRONG_PRODUCT: {
    label: "Nhận sai sản phẩm",
    measured: true,
    source: "sales_review_labels.product_ok = false — người chấm",
  },
  TEST_TO_WIN_LEAKAGE: {
    label: "Kiến thức mã TEST lọt sang hội thoại mã WIN",
    measured: false,
    missingWhat:
      "Lượt chạy không ghi lại hồ sơ kiến thức nào đã được dùng, nên không đối chiếu được với source_type của hội thoại. Cần một cột ghi khoá hồ sơ đã nạp trong ai_runs.",
  },
  INVENTED_PRICE: {
    label: "Bịa giá",
    measured: true,
    source: "ai_errors (MODEL): chốt an toàn MONEY_NOT_FROM_SERVER vứt bản mô hình viết",
  },
  INVENTED_PROMOTION: {
    label: "Tự hứa khuyến mãi",
    measured: true,
    source: "ai_errors (MODEL): chốt an toàn PROMISED_DISCOUNT",
  },
  INVENTED_SIZE: {
    label: "Khuyên size khi chưa có bảng số đo",
    measured: true,
    source: "ai_errors (MODEL): chốt NAMED_SIZE_WITHOUT_CHART / ASKED_MEASUREMENTS_WITHOUT_CHART",
  },
  INVENTED_INVENTORY: {
    label: "Hứa còn hàng khi sổ kho CHƯA BIẾT",
    measured: true,
    source: "ai_errors (MODEL): chốt an toàn PROMISED_STOCK_UNKNOWN",
  },
  INVENTED_POLICY: {
    label: "Bịa chính sách / mốc giao",
    measured: true,
    source: "ai_errors (MODEL): chốt PROMISED_DELIVERY_TIME · và sales_review_labels.hallucination = true",
  },
  FALSE_ORDER_CONFIRMATION: {
    label: "Xác nhận đơn sai",
    measured: true,
    source: "sales_review_labels.confirmation_ok = false — người chấm",
  },
  AUTH_PERMISSION_VIOLATION: {
    label: "Vượt quyền",
    measured: false,
    missingWhat:
      "Lượt bị requirePermission từ chối KHÔNG được ghi sổ ở đâu cả, nên không đếm được. Tầng công cụ có ai_tool_calls.outcome = 'DENIED' (hiện ở dòng ĐÃ CHẶN) nhưng đó là cổng công cụ, không phải cổng màn hình.",
  },
};

/**
 * Nhãn tiếng Việt của sáu chốt an toàn (`SAFETY_FLAGS`) → loại vi phạm tương ứng.
 *
 * Chốt an toàn ghi vết bằng CÂU TIẾNG VIỆT trong `ai_errors.message`, nên phép gom phải đi qua
 * chính hằng số nhãn ấy chứ không gõ lại chuỗi ở truy vấn: đổi nhãn mà quên đổi truy vấn thì bảng
 * lặng lẽ về 0 — dạng hỏng tệ nhất, vì nó trông y hệt "an toàn".
 */
export const SAFETY_FLAG_TO_KIND = {
  MONEY_NOT_FROM_SERVER: "INVENTED_PRICE",
  PROMISED_DISCOUNT: "INVENTED_PROMOTION",
  NAMED_SIZE_WITHOUT_CHART: "INVENTED_SIZE",
  ASKED_MEASUREMENTS_WITHOUT_CHART: "INVENTED_SIZE",
  PROMISED_STOCK_UNKNOWN: "INVENTED_INVENTORY",
  PROMISED_DELIVERY_TIME: "INVENTED_POLICY",
} as const satisfies Record<string, SafetyViolationKind>;

/** Công cụ nào mà chạy được nghĩa là máy đã tạo đơn. Lấy tên đúng như sổ đăng ký công cụ. */
export const ORDER_WRITE_TOOLS = ["order.create_draft", "order.confirm"] as const;

export type SafetyVerdict = "PASS" | "PASS_WITHIN_MEASURED" | "ALERT";

/**
 * Kết luận của thẻ. BA trạng thái, không hai.
 *
 * `PASS` chỉ dành cho trường hợp KHÔNG có vi phạm nào lọt ra VÀ mọi loại đều có người đo. Còn một
 * loại chưa đo được thì kết luận đúng là `PASS_WITHIN_MEASURED` — sạch trong phạm vi nhìn thấy, và
 * nói rõ phạm vi ấy chưa phủ hết. Gộp hai cái làm một là hứa một điều chưa kiểm.
 */
export function safetyVerdict(escaped: number, unmeasured: number): SafetyVerdict {
  if (escaped > 0) return "ALERT";
  return unmeasured > 0 ? "PASS_WITHIN_MEASURED" : "PASS";
}

/**
 * Tiền tố mà `pipeline.ts` ghi vào `ai_errors.message` khi chốt an toàn vứt một bản mô hình viết.
 *
 * CHÉP LẠI Ở ĐÂY CÓ CHỦ Ý, và có bài kiểm canh. Sửa chuỗi ấy trong pipeline mà quên sửa ở đây thì
 * bảng an toàn lặng lẽ về 0 — dạng hỏng tệ nhất, vì nó trông y hệt "không có vi phạm nào".
 * `tests/sales-copilot.test.ts` quét mã đã vào kho và đỏ ngay nếu hai nơi nói hai chuỗi khác nhau.
 */
export const GUARD_REJECT_PREFIX = "Bỏ bản mô hình viết:";
