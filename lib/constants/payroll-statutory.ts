/**
 * ═══════════ KHẤU TRỪ THEO LUẬT — CHỖ ĐỂ DÀNH, CỐ Ý ĐỂ TRỐNG ═══════════
 *
 * Thuế thu nhập cá nhân, BHXH, BHYT, BHTN. ERP hôm nay KHÔNG tính chúng, và đó là một quyết định
 * chứ không phải một thiếu sót.
 *
 * ─── VÌ SAO KHÔNG GHI SẴN TỶ LỆ ───
 *
 * Tỷ lệ pháp lý đổi theo năm, theo mức lương cơ sở, theo vùng, và theo loại hợp đồng. Ghi cứng một
 * con số chưa được chủ shop xác nhận thì mỗi phiếu lương in ra một khoản khấu trừ SAI mà trông hoàn
 * toàn hợp lệ — và người lao động là bên chịu. So với việc không có gì cả, cái đó tệ hơn: không có
 * gì thì người ta biết là chưa có; một con số sai thì không ai đi kiểm.
 *
 * ─── NHƯNG "CHƯA CẤU HÌNH" PHẢI KHÁC "0 ĐỒNG" ───
 *
 * Đây là toàn bộ lý do tệp này tồn tại. Một phiếu lương không có dòng khấu trừ nào trông y hệt một
 * phiếu lương mà khấu trừ đã tính ra 0 — và hai thứ ấy khác hẳn nhau. Cùng luật với AGENTS.md mục
 * 42: CHƯA BIẾT không được in ra thành 0.
 *
 * ─── KIẾN TRÚC ĐỂ SAU NÀY THÊM ĐƯỢC ───
 *
 * Khấu trừ theo luật sẽ là một THÀNH PHẦN như mọi thành phần khác (`kind: "DEDUCTION"`), không phải
 * một nhánh `if` trong máy tính. Khi chủ shop khai xong luật, nó vào máy bằng đúng cửa mà lương
 * cứng và hoa hồng đi — không có đường riêng, không có lõi nào phải sửa.
 */

export const STATUTORY_DEDUCTION_KEY = "payroll.statutory";

/** Các khoản khấu trừ theo luật mà một shop Việt Nam thường phải tính. Danh sách để THAM CHIẾU. */
export const STATUTORY_DEDUCTION_KINDS = ["PIT", "SOCIAL_INSURANCE", "HEALTH_INSURANCE", "UNEMPLOYMENT_INSURANCE"] as const;
export type StatutoryDeductionKind = (typeof STATUTORY_DEDUCTION_KINDS)[number];

export const STATUTORY_DEDUCTION_LABEL: Record<StatutoryDeductionKind, string> = {
  PIT: "Thuế thu nhập cá nhân",
  SOCIAL_INSURANCE: "Bảo hiểm xã hội",
  HEALTH_INSURANCE: "Bảo hiểm y tế",
  UNEMPLOYMENT_INSURANCE: "Bảo hiểm thất nghiệp",
};

/**
 * BA TRẠNG THÁI, VÀ SỰ KHÁC NHAU GIỮA CHÚNG LÀ TOÀN BỘ VẤN ĐỀ:
 *
 *  · `NOT_CONFIGURED` — chủ shop chưa khai luật. Phiếu lương in "Chưa cấu hình", KHÔNG in "0 ₫".
 *  · `EXEMPT`         — chủ shop đã khai rằng khoản này KHÔNG áp dụng (vd cộng tác viên khoán).
 *    Đây là một khẳng định CÓ CHỦ, khác hẳn chưa khai.
 *  · `CONFIGURED`     — đã khai đủ, có thành phần tính.
 */
export const STATUTORY_STATES = ["NOT_CONFIGURED", "EXEMPT", "CONFIGURED"] as const;
export type StatutoryState = (typeof STATUTORY_STATES)[number];

export const STATUTORY_STATE_LABEL: Record<StatutoryState, string> = {
  NOT_CONFIGURED: "Chưa cấu hình",
  EXEMPT: "Không áp dụng (đã khai)",
  CONFIGURED: "Đã cấu hình",
};

export const STATUTORY_STATE_HINT: Record<StatutoryState, string> = {
  NOT_CONFIGURED:
    "Chưa ai khai luật thuế / bảo hiểm cho ERP. Phiếu lương KHÔNG in “0 ₫” ở đây — in 0 là khẳng định khoản khấu trừ bằng không, trong khi sự thật là chưa ai tính. Người trả lương vẫn phải tự tính bên ngoài.",
  EXEMPT: "Chủ shop đã khai rằng khoản này không áp dụng cho nhóm nhân sự ấy. Đây là một khẳng định CÓ CHỦ, truy nguyên được — khác hẳn chưa khai.",
  CONFIGURED: "Đã khai đủ luật và có thành phần tính trong chính sách lương.",
};

export type StatutoryConfig = {
  /** Trạng thái chung. Mặc định CHƯA CẤU HÌNH — và nó ở đó cho tới khi có người khai. */
  state: StatutoryState;
  /** Ai khai, khi nào, dựa trên văn bản nào. Rỗng khi chưa khai. */
  declaredBy: string;
  declaredAt: string | null;
  /** Căn cứ pháp lý — bắt buộc khi rời khỏi `NOT_CONFIGURED`. */
  legalBasis: string;
  note: string;
};

export const DEFAULT_STATUTORY: StatutoryConfig = {
  state: "NOT_CONFIGURED",
  declaredBy: "",
  declaredAt: null,
  legalBasis: "",
  note: "",
};

/**
 * Phiếu lương in gì ở dòng khấu trừ theo luật.
 *
 * Trả về `null` cho SỐ TIỀN khi chưa cấu hình — để chỗ gọi buộc phải xử lý nhánh CHƯA BIẾT thay vì
 * nhận một số 0 rồi cộng nó vào tổng như một con số đã xác minh.
 */
export function statutoryDisplay(config: StatutoryConfig): { amount: number | null; label: string; hint: string } {
  if (config.state === "CONFIGURED") {
    // Có cấu hình nhưng số tiền vẫn do THÀNH PHẦN trong chính sách tính ra, không phải hàm này.
    return { amount: null, label: "Theo chính sách đã khai", hint: STATUTORY_STATE_HINT.CONFIGURED };
  }
  if (config.state === "EXEMPT") {
    return { amount: 0, label: STATUTORY_STATE_LABEL.EXEMPT, hint: `${STATUTORY_STATE_HINT.EXEMPT}${config.legalBasis ? ` Căn cứ: ${config.legalBasis}` : ""}` };
  }
  return { amount: null, label: STATUTORY_STATE_LABEL.NOT_CONFIGURED, hint: STATUTORY_STATE_HINT.NOT_CONFIGURED };
}
