/**
 * MỨC NGHIÊM TRỌNG CỦA MỘT LỖI — VÌ KHÔNG PHẢI LỖI NÀO CŨNG NHƯ NHAU.
 *
 * ═══ MỘT TỶ LỆ ĐÚNG/SAI CHUNG LÀ MỘT CON SỐ NÓI DỐI ═══
 *
 * Một mô hình sai 10% ở chỗ "câu hơi dài" và một mô hình sai 10% ở chỗ "chốt đơn khi khách chưa
 * đồng ý" có cùng một con số chính xác, và chúng KHÔNG cùng một chất lượng. Chọn mô hình theo con
 * số ấy là chọn theo một phép đo đã xoá mất phần đáng quan tâm nhất.
 *
 * Nên bộ định tuyến về sau phải tối ưu KỲ VỌNG THIỆT HẠI, không phải tỷ lệ đúng. Tệp này là phần
 * "thiệt hại" của phép nhân ấy.
 *
 * ═══ TRỌNG SỐ KHÔNG PHẢI TIỀN, VÀ KHÔNG ĐƯỢC GIẢ VỜ LÀ TIỀN ═══
 *
 * `weight` là một thang TƯƠNG ĐỐI để xếp hạng, không phải số tiền thiệt hại. ERP không đo được
 * "một lần chốt nhầm đơn tốn bao nhiêu đồng" — nó phụ thuộc giá trị đơn, tỷ lệ hoàn, công xử lý,
 * và cả việc khách có quay lại không. Gán một con số VND ở đây là bịa một con số tiền, đúng thứ
 * luật của kho mã cấm. Khi nào chủ shop khai được thiệt hại thật thì nhân thêm; tới lúc ấy thang
 * này vẫn dùng để XẾP HẠNG.
 */

/** Bốn mức, xếp NẶNG DẦN. Thứ tự này là dữ liệu — bài kiểm và phép so đều dựa vào nó. */
export const ERROR_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

export const SEVERITY_LABEL: Record<ErrorSeverity, string> = {
  LOW: "Nhẹ — câu chữ",
  MEDIUM: "Vừa — làm khách phải lặp lại",
  HIGH: "Nặng — sai dữ kiện của đơn",
  CRITICAL: "Nghiêm trọng — sai đơn, sai tiền, hoặc hành động không được phép",
};

/**
 * Trọng số tương đối. Khoảng cách giữa các mức CỐ Ý lớn dần, không đều nhau.
 *
 * Nếu để đều (1·2·3·4) thì ba lỗi câu-chữ sẽ "nặng bằng" một lỗi chốt nhầm đơn, và một mô hình
 * viết văn vụng nhưng không bao giờ chốt bừa sẽ thua một mô hình viết mượt mà thỉnh thoảng tạo
 * đơn sai. Đó là xếp hạng ngược đúng chiều nguy hiểm nhất.
 */
export const SEVERITY_WEIGHT: Record<ErrorSeverity, number> = { LOW: 1, MEDIUM: 4, HIGH: 20, CRITICAL: 100 };

/** Từ mức nào trở lên thì gọi là LỖI NGHIÊM TRỌNG — dùng cho "tỷ lệ lỗi nghiêm trọng". */
export const SERIOUS_FROM: ErrorSeverity = "HIGH";

export function isSerious(s: ErrorSeverity): boolean {
  return ERROR_SEVERITIES.indexOf(s) >= ERROR_SEVERITIES.indexOf(SERIOUS_FROM);
}

/**
 * SỔ CÁC KIỂU LỖI. Tập ĐÓNG: một ô chữ tự do ở đây sẽ thành mười cách viết cho cùng một lỗi, và
 * mọi phép đếm sau đó đều sai.
 *
 * Mức của mỗi lỗi khai theo HẬU QUẢ, không theo mức khó chịu khi đọc.
 */
export const EVAL_ERROR_KINDS = {
  // ── NHẸ: người đọc thấy chối, nhưng không ai mất gì ──
  WORDING: { severity: "LOW", label: "Câu chữ vụng / quá dài", why: "Khó chịu khi đọc, nhưng không ai mất gì" },
  TONE: { severity: "LOW", label: "Giọng không hợp", why: "Ảnh hưởng cảm nhận, không ảnh hưởng đơn" },

  // ── VỪA: khách phải lặp lại, và một phần khách sẽ bỏ đi ──
  REASKED_KNOWN: { severity: "MEDIUM", label: "Hỏi lại thứ khách đã nói", why: "Khách phải lặp lại; một phần khách bỏ đi ở đây" },
  SUBOPTIMAL_NEXT: { severity: "MEDIUM", label: "Việc tiếp theo chưa tối ưu", why: "Cuộc bán dài thêm chứ chưa sai" },
  STATE_NOT_ADVANCED: { severity: "MEDIUM", label: "Không đẩy được trạng thái đi tiếp", why: "Máy trả lời mà cuộc bán đứng yên" },

  // ── NẶNG: dữ kiện của đơn đã sai, dù đơn chưa lên ──
  WRONG_COLOR: { severity: "HIGH", label: "Sai màu", why: "Giao sai thứ khách chọn" },
  WRONG_SIZE: { severity: "HIGH", label: "Sai size", why: "Kiện hàng không vừa, và khách phải đổi" },
  WRONG_QUANTITY: { severity: "HIGH", label: "Sai số lượng", why: "Giao thiếu hoặc thừa" },
  WRONG_PRODUCT: { severity: "HIGH", label: "Sai sản phẩm", why: "Giao hẳn một mẫu khác" },
  MISSED_PURCHASE_INTENT: { severity: "HIGH", label: "Bỏ lỡ ý muốn mua", why: "Khách đã muốn mua mà máy không đi tiếp — mất đơn" },
  MISSED_COMPLAINT: { severity: "HIGH", label: "Không nhận ra khiếu nại", why: "Khách đang bức xúc mà máy vẫn chào bán" },

  // ── NGHIÊM TRỌNG: đơn sai, tiền sai, hoặc máy làm thứ nó không được phép ──
  WRONG_SKU_ORDERED: { severity: "CRITICAL", label: "Sai mã mẫu mã dẫn tới đơn sai", why: "Một kiện hàng sai đã rời kho" },
  WRONG_PRICE: { severity: "CRITICAL", label: "Sai giá", why: "Hứa một con số shop không bán" },
  HALLUCINATED_STOCK: { severity: "CRITICAL", label: "Bịa tồn kho / bịa sản phẩm", why: "Hẹn giao một thứ có thể không tồn tại" },
  CONFIRMED_WITHOUT_CUSTOMER: { severity: "CRITICAL", label: "Xác nhận đơn khi khách chưa đặt", why: "Đơn sinh ra từ một lời đồng ý không có thật" },
  WRONG_ACTION_SENT: { severity: "CRITICAL", label: "Gửi / tạo nhầm một hành động", why: "Máy đã chạm vào thế giới thật, và không rút lại được" },
  IGNORED_CANCELLATION: { severity: "CRITICAL", label: "Bỏ qua lời huỷ / lời từ chối", why: "Khách đã nói không mà đơn vẫn chạy" },
} as const satisfies Record<string, { severity: ErrorSeverity; label: string; why: string }>;

export type EvalErrorKind = keyof typeof EVAL_ERROR_KINDS;
export const EVAL_ERROR_KEYS = Object.keys(EVAL_ERROR_KINDS) as EvalErrorKind[];

export function severityOf(kind: EvalErrorKind): ErrorSeverity {
  return EVAL_ERROR_KINDS[kind].severity;
}

/** Mức NẶNG NHẤT trong một tập lỗi. Không lỗi nào ⇒ `null` (không phải "LOW"). */
export function worstSeverity(kinds: EvalErrorKind[]): ErrorSeverity | null {
  if (!kinds.length) return null;
  return kinds.reduce<ErrorSeverity>((max, k) => {
    const s = severityOf(k);
    return ERROR_SEVERITIES.indexOf(s) > ERROR_SEVERITIES.indexOf(max) ? s : max;
  }, "LOW");
}

/**
 * KỲ VỌNG THIỆT HẠI trên một ca — con số mà bộ định tuyến về sau phải tối ưu.
 *
 * Một ca có NHIỀU lỗi thì CỘNG, không lấy lỗi nặng nhất: sai cả màu lẫn size tệ hơn sai mỗi màu,
 * và lấy `max` sẽ nói hai ca ấy như nhau.
 */
export function expectedHarm(kinds: EvalErrorKind[]): number {
  return kinds.reduce((t, k) => t + SEVERITY_WEIGHT[severityOf(k)], 0);
}

/**
 * Tổng hợp một mẻ đã chấm.
 *
 * `null` ở `seriousRate` khi CHƯA CÓ ca nào được chấm — không phải 0. Một bảng in "0% lỗi nghiêm
 * trọng" từ số không ca là lời khẳng định mạnh nhất có thể, dựa trên bằng chứng yếu nhất có thể.
 */
export function summarizeHarm(cases: { errors: EvalErrorKind[] }[]): {
  evaluated: number;
  withError: number;
  serious: number;
  seriousRate: number | null;
  totalHarm: number;
  harmPerCase: number | null;
} {
  const evaluated = cases.length;
  const withError = cases.filter((c) => c.errors.length > 0).length;
  const serious = cases.filter((c) => c.errors.some((k) => isSerious(severityOf(k)))).length;
  const totalHarm = cases.reduce((t, c) => t + expectedHarm(c.errors), 0);
  return {
    evaluated,
    withError,
    serious,
    seriousRate: evaluated === 0 ? null : serious / evaluated,
    totalHarm,
    harmPerCase: evaluated === 0 ? null : totalHarm / evaluated,
  };
}
