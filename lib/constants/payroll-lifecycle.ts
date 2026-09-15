/**
 * ═══════════ VÒNG ĐỜI MỘT KỲ LƯƠNG ═══════════
 *
 * ─── VÌ SAO SÁU TRẠNG THÁI CHỨ KHÔNG PHẢI HAI ───
 *
 * Bản trước chỉ có `DRAFT` và `FINAL`, và điều đó đủ để giữ lời hứa quan trọng nhất (kỳ đã chốt là
 * bất biến). Nhưng nó gộp mất bốn câu hỏi khác nhau mà chủ shop thật sự hỏi khi trả lương:
 *
 *   · số đã tính xong chưa?          → `CALCULATED`
 *   · ai đang soát?                  → `UNDER_REVIEW`
 *   · ai đã DUYỆT con số này?        → `APPROVED`
 *   · tiền đã ra khỏi tài khoản chưa?→ `PAID`
 *
 * Gộp cả bốn vào một chữ "FINAL" nghĩa là không trả lời được câu nào. Và câu thứ ba là câu quan
 * trọng nhất: **duyệt là một chữ ký, không phải một lượt bấm**, nên nó phải có người, có mốc, có
 * dấu vết riêng — không lẫn vào lượt chụp ảnh.
 *
 * ─── `LOCKED` KHÁC `APPROVED`, VÀ SỰ KHÁC ẤY LÀ CHUYỆN TIỀN ───
 *
 * `APPROVED` = con số đã được người có thẩm quyền đồng ý. `LOCKED` = ảnh chụp đã đóng băng, không
 * truy vấn lại nữa. Tách ra vì giữa hai mốc ấy vẫn có thể phát hiện sai và sửa; sau `LOCKED` thì
 * không, và mọi chứng từ về sau đi bằng ĐIỀU CHỈNH ở kỳ kế tiếp.
 *
 * ─── TƯƠNG THÍCH NGƯỢC: `FINAL` CŨ LÀ `LOCKED` ───
 *
 * `payroll_periods.status` đang có giá trị `FINAL` trên production. KHÔNG đổi dữ liệu đã ghi —
 * `FINAL` được ĐỌC như `LOCKED` (xem `normalizePayrollStatus`). Viết lại một cột trạng thái của
 * những kỳ đã trả tiền để "cho sạch bảng" là đúng thứ mà AGENTS.md mục 21 cấm.
 */

export const PAYROLL_RUN_STATUSES = ["DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED", "LOCKED", "PAID"] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const PAYROLL_RUN_STATUS_LABEL: Record<PayrollRunStatus, string> = {
  DRAFT: "Nháp — tính sống mỗi lần mở",
  CALCULATED: "Đã tính — có ảnh chụp, chưa ai soát",
  UNDER_REVIEW: "Đang soát",
  APPROVED: "Đã duyệt",
  LOCKED: "Đã khoá — bất biến",
  PAID: "Đã trả",
};

export const PAYROLL_RUN_STATUS_HINT: Record<PayrollRunStatus, string> = {
  DRAFT: "Chưa có ảnh chụp. Mọi con số tính lại mỗi lần mở, nên chúng còn đổi khi dữ liệu nguồn đổi.",
  CALCULATED: "Đã chụp lại toàn bộ số và căn cứ. Từ đây màn hình đọc ảnh chụp; tính lại được, nhưng mỗi lượt tính lại là một lượt ghi đè có dấu vết.",
  UNDER_REVIEW: "Đang có người soát. Vẫn tính lại được — đây là lúc để phát hiện sai.",
  APPROVED: "Người có thẩm quyền đã đồng ý con số này. Chưa khoá, nên vẫn sửa được nếu phát hiện sai, và mỗi lần sửa sẽ xoá chữ ký duyệt.",
  LOCKED: "Bất biến. Chứng từ về sau xử lý bằng khoản ĐIỀU CHỈNH ở kỳ kế tiếp, không sửa vào đây.",
  PAID: "Tiền đã ra khỏi tài khoản. Vẫn bất biến như khi khoá.",
};

/**
 * CHUYỂN TRẠNG THÁI NÀO ĐI ĐƯỢC TỚI ĐÂU.
 *
 * Danh sách ĐÓNG. Một bảng chuyển trạng thái viết rời rạc bằng `if` ở từng action là cách để hai
 * action cho phép hai đường khác nhau, và rồi một kỳ đã khoá quay về nháp bằng một lối không ai
 * biết là có.
 *
 * `LOCKED → APPROVED` (mở khoá) CÓ trong bảng, và cố ý: giấu hẳn đường mở khoá không làm ai an
 * toàn hơn — nó chỉ đẩy người ta đi sửa thẳng CSDL, nơi không có dấu vết nào. Có đường, nhưng
 * đường ấy cần quyền riêng, cần lý do, và ghi nhật ký.
 */
export const PAYROLL_RUN_TRANSITIONS: Record<PayrollRunStatus, readonly PayrollRunStatus[]> = {
  DRAFT: ["CALCULATED"],
  CALCULATED: ["CALCULATED", "UNDER_REVIEW"],
  UNDER_REVIEW: ["CALCULATED", "APPROVED"],
  /*
    `APPROVED → CALCULATED` là đường RÚT LẠI CHỮ KÝ.

    Phát hiện sai sau khi đã duyệt là chuyện thường; không có đường rút thì người ta hoặc khoá đại
    rồi mở khoá (tốn một lượt "mở khoá" vô nghĩa trong nhật ký), hoặc đi sửa thẳng CSDL. Cả hai đều
    tệ hơn một đường có tên, có quyền riêng và có lý do bắt buộc.

    `APPROVED → UNDER_REVIEW` giữ lại cho trường hợp chỉ muốn soát thêm mà chưa kết luận là sai.
  */
  APPROVED: ["CALCULATED", "UNDER_REVIEW", "LOCKED"],
  LOCKED: ["APPROVED", "PAID"],
  PAID: [],
};

/** Việc người bấm, tách khỏi trạng thái đích — một việc có thể tới cùng đích bằng hai ý nghĩa khác nhau. */
export const PAYROLL_RUN_ACTIONS = ["CALCULATE", "SUBMIT_REVIEW", "APPROVE", "REJECT", "LOCK", "UNLOCK", "MARK_PAID"] as const;
export type PayrollRunAction = (typeof PAYROLL_RUN_ACTIONS)[number];

export type PayrollActionSpec = {
  label: string;
  from: readonly PayrollRunStatus[];
  to: PayrollRunStatus;
  /** Quyền tối thiểu. Không có quyền thì nút KHÔNG hiện và server vẫn từ chối. */
  permission: "payroll:manage" | "payroll:approve";
  /** Có cần người thứ hai duyệt không (`guardSecondApproval`). */
  secondApproval: boolean;
  /** Có bắt buộc nhập LÝ DO không. */
  requiresReason: boolean;
  /** Khoá hành động trong nhật ký. */
  auditAction: string;
  hint: string;
};

/**
 * ═══ NĂM VIỆC NGUY HIỂM, VÀ MỖI VIỆC NGUY HIỂM MỘT KIỂU ═══
 *
 * `APPROVE` · `UNLOCK` · `MARK_PAID` đều đi qua người thứ hai, nhưng vì ba lý do khác nhau:
 *   · duyệt      — người duyệt có thể chính là người được hưởng;
 *   · mở khoá    — nó làm một kỳ ĐÃ TRẢ TIỀN đổi số được;
 *   · đánh dấu trả — nó là lời khẳng định tiền đã ra khỏi tài khoản, và không ai kiểm lại nếu sai.
 *
 * `CALCULATE` và `SUBMIT_REVIEW` KHÔNG cần: chúng không làm đổi một đồng nào đã trả.
 */
export const PAYROLL_ACTION_SPEC: Record<PayrollRunAction, PayrollActionSpec> = {
  CALCULATE: {
    label: "Tính & chụp ảnh kỳ",
    from: ["DRAFT", "CALCULATED", "UNDER_REVIEW"],
    to: "CALCULATED",
    permission: "payroll:manage",
    secondApproval: false,
    requiresReason: false,
    auditAction: "PAYROLL_RUN_CALCULATE",
    hint: "Chụp lại toàn bộ số và căn cứ của kỳ. Chạy lại được — mỗi lượt ghi đè ảnh cũ và để lại dấu vết.",
  },
  SUBMIT_REVIEW: {
    label: "Chuyển soát",
    from: ["CALCULATED"],
    to: "UNDER_REVIEW",
    permission: "payroll:manage",
    secondApproval: false,
    requiresReason: false,
    auditAction: "PAYROLL_RUN_SUBMIT_REVIEW",
    hint: "Báo rằng số đã tính xong và đang chờ người soát.",
  },
  APPROVE: {
    label: "Duyệt",
    from: ["UNDER_REVIEW"],
    to: "APPROVED",
    permission: "payroll:approve",
    secondApproval: true,
    requiresReason: false,
    auditAction: "PAYROLL_RUN_APPROVE",
    hint: "Một chữ ký, không phải một lượt bấm: người duyệt có thể chính là người được hưởng.",
  },
  REJECT: {
    label: "Trả lại để sửa",
    from: ["UNDER_REVIEW", "APPROVED"],
    to: "CALCULATED",
    permission: "payroll:approve",
    secondApproval: false,
    requiresReason: true,
    auditAction: "PAYROLL_RUN_REJECT",
    hint: "Trả về để tính lại. Phải nói rõ sai ở đâu, nếu không người sửa chỉ biết là “có gì đó sai”.",
  },
  LOCK: {
    label: "Khoá kỳ",
    from: ["APPROVED"],
    to: "LOCKED",
    permission: "payroll:approve",
    secondApproval: false,
    requiresReason: false,
    auditAction: "PAYROLL_RUN_LOCK",
    hint: "Từ đây ảnh chụp là bất biến; chứng từ về sau đi bằng khoản điều chỉnh ở kỳ kế tiếp.",
  },
  UNLOCK: {
    label: "Mở khoá",
    from: ["LOCKED"],
    to: "APPROVED",
    permission: "payroll:approve",
    secondApproval: true,
    requiresReason: true,
    auditAction: "PAYROLL_RUN_UNLOCK",
    hint: "Làm một kỳ ĐÃ TRẢ TIỀN đổi số được. Bắt buộc có lý do và người thứ hai duyệt.",
  },
  MARK_PAID: {
    label: "Đánh dấu đã trả",
    from: ["LOCKED"],
    to: "PAID",
    permission: "payroll:approve",
    secondApproval: true,
    requiresReason: false,
    auditAction: "PAYROLL_RUN_MARK_PAID",
    hint: "Lời khẳng định tiền đã ra khỏi tài khoản. Không ai kiểm lại nếu nó sai, nên nó cần người thứ hai.",
  },
};

/**
 * `FINAL` CŨ ĐỌC THÀNH `LOCKED`.
 *
 * Production đang có `status = 'FINAL'` từ trước bản sáu trạng thái. Không viết lại cột ấy: đó là
 * dữ liệu của những kỳ đã trả tiền. Đọc nó đúng nghĩa thì không mất gì; viết đè lên nó thì mất
 * chính cái mà `payroll_periods` sinh ra để giữ.
 */
export function normalizePayrollStatus(raw: string | null | undefined): PayrollRunStatus {
  if (!raw) return "DRAFT";
  if (raw === "FINAL") return "LOCKED";
  return (PAYROLL_RUN_STATUSES as readonly string[]).includes(raw) ? (raw as PayrollRunStatus) : "DRAFT";
}

/** Kỳ ở trạng thái này có còn tính lại được không. `false` ⇒ ảnh chụp là câu trả lời cuối. */
export function isMutable(status: PayrollRunStatus): boolean {
  return status === "DRAFT" || status === "CALCULATED" || status === "UNDER_REVIEW" || status === "APPROVED";
}

/** Kỳ đã đóng băng: không nhập đầu vào, không thêm điều chỉnh, không tính lại. */
export function isFrozen(status: PayrollRunStatus): boolean {
  return status === "LOCKED" || status === "PAID";
}

/** Việc nào bấm được từ trạng thái hiện tại — màn hình và server dùng CHUNG hàm này. */
export function availableActions(status: PayrollRunStatus): PayrollRunAction[] {
  return PAYROLL_RUN_ACTIONS.filter((a) => PAYROLL_ACTION_SPEC[a].from.includes(status));
}

/** Chuyển trạng thái có hợp lệ không — kiểm ở CẢ màn hình lẫn server, cùng một bảng. */
export function canTransition(from: PayrollRunStatus, action: PayrollRunAction): boolean {
  const spec = PAYROLL_ACTION_SPEC[action];
  if (!spec.from.includes(from)) return false;
  return PAYROLL_RUN_TRANSITIONS[from].includes(spec.to);
}
