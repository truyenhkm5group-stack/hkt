/**
 * ═══════ PHÊ DUYỆT HAI BƯỚC — MỘT SỔ ĐĂNG KÝ DUY NHẤT ═══════
 *
 * Chủ shop chốt 09/09/2026: có những việc một người không được tự làm một mình. Nhưng ranh giới đó
 * phải nằm ở ĐÚNG MỘT chỗ, nếu không mỗi trang lại tự nghĩ ra một luật và ba tháng sau không ai trả
 * lời nổi "việc này có cần duyệt không".
 *
 * ─── HAI CÂU HỎI KHÁC NHAU, ĐỪNG TRỘN ───
 *
 *  1. **AI ĐƯỢC LÀM** — thuộc về quyền (`lib/auth/session.ts::can`). Không có quyền thì không thấy
 *     nút, và câu chuyện dừng ở đó.
 *  2. **CÓ CẦN NGƯỜI THỨ HAI KHÔNG** — thuộc về file này. Có quyền vẫn có thể cần người khác gật.
 *
 * Trộn hai thứ đó lại là cách nhanh nhất để vừa chặn nhầm người có quyền, vừa cho lọt việc rủi ro.
 *
 * ─── VÌ SAO MẶC ĐỊNH TẮT, VÀ KHÔNG PHẢI VÌ NGẠI LÀM ───
 *
 * Đo trên production 10/09/2026: hệ thống có **đúng 2 tài khoản** (1 ADMIN, 1 MANAGER). Bật cưỡng
 * chế "người yêu cầu ≠ người duyệt" ngay hôm nay nghĩa là chủ shop tự chặn mình khỏi việc điều chỉnh
 * kho, sửa chi phí hay chốt lương — những việc đang làm hằng ngày, một mình.
 *
 * Một cơ chế kiểm soát làm dừng việc thật sẽ bị vô hiệu hoá trong tuần đầu, và cùng với nó là cả
 * niềm tin vào mọi cơ chế kiểm soát khác. Nên: máy móc dựng đủ, GHI NHẬN đầy đủ ngay từ đầu, còn
 * CƯỠNG CHẾ bật theo từng nhóm khi shop có người thứ hai thật sự.
 *
 * Bật ở `settings` khoá `approval.enforce` — xem `APPROVAL_ENFORCE_KEY`.
 */

/** Nhóm việc rủi ro. Bật / tắt cưỡng chế theo NHÓM, không theo từng nút. */
export const APPROVAL_GROUPS = [
  "INVENTORY_ADJUSTMENT",
  "INVENTORY_WRITE_OFF",
  "COD_CORRECTION",
  "EXPENSE_EDIT",
  "PAYROLL_EDIT",
  "LOGISTICS_OVERRIDE",
  "PURCHASING_LARGE",
  "BUSINESS_RULE_CHANGE",
  "ADS_BUDGET_MUTATION",
] as const;
export type ApprovalGroup = (typeof APPROVAL_GROUPS)[number];

export const APPROVAL_GROUP_LABEL: Record<ApprovalGroup, string> = {
  INVENTORY_ADJUSTMENT: "Điều chỉnh tồn kho bằng tay",
  INVENTORY_WRITE_OFF: "Ghi giảm / huỷ hàng",
  COD_CORRECTION: "Sửa tiền COD",
  EXPENSE_EDIT: "Sửa / xoá khoản chi",
  PAYROLL_EDIT: "Sửa lương & cơ chế trả công",
  LOGISTICS_OVERRIDE: "Ghi đè kết luận của đơn vị vận chuyển",
  PURCHASING_LARGE: "Đặt hàng vượt ngưỡng",
  BUSINESS_RULE_CHANGE: "Đổi luật nghiệp vụ / ngưỡng",
  ADS_BUDGET_MUTATION: "Thay đổi ngân sách quảng cáo",
};

/**
 * Vì sao mỗi nhóm cần người thứ hai. Không phải trang trí: người bị chặn có quyền biết lý do, và
 * người thêm nhóm mới buộc phải nói được lý do trước khi thêm.
 */
export const APPROVAL_GROUP_REASON: Record<ApprovalGroup, string> = {
  INVENTORY_ADJUSTMENT: "Một dòng điều chỉnh có thể tạo ra hàng không tồn tại, và không có chứng từ nào ở ngoài để đối chiếu lại.",
  INVENTORY_WRITE_OFF: "Ghi giảm là mất hàng thật; nó cũng là cách che một vụ thất thoát dễ nhất.",
  COD_CORRECTION: "Sửa tiền thu hộ là sửa TIỀN, và bảng kê ĐVVC là bằng chứng duy nhất còn lại để đối chiếu.",
  EXPENSE_EDIT: "Khoản chi đi thẳng vào lợi nhuận; sửa một dòng là đổi kết quả kinh doanh của cả kỳ.",
  PAYROLL_EDIT: "Lương và hoa hồng là tiền trả cho người, và người đó có thể chính là người đang sửa.",
  LOGISTICS_OVERRIDE: "Ghi đè kết luận ĐVVC là nói ngược lại chứng từ — chỉ đúng khi có bằng chứng khác, và bằng chứng đó cần người thứ hai nhìn.",
  PURCHASING_LARGE: "Vượt ngưỡng thì một quyết định sai khoá vốn của shop trong nhiều tháng.",
  BUSINESS_RULE_CHANGE: "Đổi ngưỡng nghiệp vụ là đổi cách ĐỌC mọi số liệu lịch sử cùng lúc.",
  ADS_BUDGET_MUTATION: "Ngân sách quảng cáo đốt tiền theo giờ; một con số gõ nhầm không có phanh.",
};

/**
 * Nhóm KHÔNG cần người thứ hai, và nói rõ vì sao — để không ai âm thầm thêm chúng vào sau này.
 *
 * Chủ shop chốt: việc vận hành thường ngày phải chạy được một mình. Bắt duyệt những việc này chỉ tạo
 * ra thói quen bấm duyệt cho xong, và thói quen đó sẽ đi theo sang cả những việc thật sự rủi ro.
 */
export const NO_SECOND_APPROVAL: Record<string, string> = {
  QUEUE_TRIAGE: "phân loại / nhận / đóng việc trong hàng đợi là vận hành thường ngày",
  CS_REPLY: "trả lời khách phải nhanh; chờ duyệt là mất khách",
  RETURN_INSPECTION: "kiểm đếm hàng hoàn đã có số đếm thực tế làm chứng",
  RESTOCK_AT_INSPECTED_QTY: "tái nhập ĐÚNG BẰNG số đã kiểm đếm thì không có gì để quyết thêm",
};

/** Ngưỡng tiền của các nhóm có ngưỡng. Đổi chỉ khi chủ shop yêu cầu (AGENTS.md mục 7). */
export const APPROVAL_THRESHOLD: Partial<Record<ApprovalGroup, number>> = {
  PURCHASING_LARGE: 20_000_000,
  INVENTORY_WRITE_OFF: 1_000_000,
  EXPENSE_EDIT: 5_000_000,
};

/** Khoá `settings` bật cưỡng chế theo nhóm: `{ "INVENTORY_ADJUSTMENT": true, ... }` */
export const APPROVAL_ENFORCE_KEY = "approval.enforce";

export type ApprovalDecision =
  /** Làm luôn — nhóm này không cần người thứ hai, hoặc chưa bật cưỡng chế. */
  | { mode: "PROCEED"; recorded: boolean; group: ApprovalGroup | null }
  /** Phải chờ người khác duyệt. */
  | { mode: "NEEDS_APPROVAL"; group: ApprovalGroup; reason: string }
  /**
   * Cần duyệt NHƯNG không có ai đủ tư cách duyệt (chỉ có mình người yêu cầu).
   *
   * KHÔNG được tự chuyển thành PROCEED. Một cơ chế kiểm soát tự bỏ qua chính mình khi bất tiện thì
   * không phải cơ chế kiểm soát — và nó sẽ im lặng đúng lúc bị lợi dụng.
   */
  | { mode: "BLOCKED_NO_APPROVER"; group: ApprovalGroup; reason: string };

/** Cưỡng chế đang bật cho nhóm nào — đọc từ `settings`, thiếu thì coi như TẮT. */
export function isEnforced(config: unknown, group: ApprovalGroup): boolean {
  if (!config || typeof config !== "object") return false;
  return (config as Record<string, unknown>)[group] === true;
}

/** Số tiền có vượt ngưỡng của nhóm không. Nhóm không có ngưỡng thì mọi việc đều tính. */
export function overThreshold(group: ApprovalGroup, amount: number | null | undefined): boolean {
  const nguong = APPROVAL_THRESHOLD[group];
  if (nguong === undefined) return true;
  // CHƯA BIẾT số tiền thì coi như VƯỢT ngưỡng: đoán thấp ở đây là bỏ lọt đúng việc cần canh.
  if (amount === null || amount === undefined) return true;
  return Math.abs(amount) >= nguong;
}
