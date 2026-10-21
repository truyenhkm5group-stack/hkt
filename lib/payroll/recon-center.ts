/**
 * ═══════════ TRUNG TÂM ĐỐI SOÁT LƯƠNG — HÀM THUẦN ═══════════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §10. Chủ shop giao 20/10/2026: "Xây dựng Payroll Reconciliation
 * Center liệt kê toàn bộ khoản chưa đối soát, kèm người chịu trách nhiệm, nguyên nhân và hành động xử lý
 * … tự đối soát những khoản đã có dữ liệu nguồn, không yêu cầu chủ shop nhập lại dữ liệu ERP đã có …
 * gom các quyết định nghiệp vụ còn lại thành MỘT danh sách phê duyệt."
 *
 * Ba thứ đứng ở đây, không đọc CSDL, không đọc đồng hồ, chạy hai lần ra cùng kết quả:
 *  · `buildOpeningProposal` — ĐỀ XUẤT số dư lũy kế mở sổ từ chuỗi số ĐO ĐƯỢC từng tháng (doanh thu đã
 *    ghi nhận − chi phí máy chi phí đã ghi nhận − lương cứng CÓ CĂN CỨ chưa ghi nhận). KHÔNG cộng giả
 *    định (chi phí cố định khai tay, định mức theo đơn, lương người chưa khai ngày vào làm). Tháng nào
 *    thiếu căn cứ thì nói ra thiếu gì; còn thiếu thì đề xuất là "CHƯA ĐỦ CĂN CỨ" và không ai được dùng nó
 *    như một con số đã duyệt. Đề xuất KHÔNG BAO GIỜ tự khai vào quy chế cổng — người có quyền khai tay.
 *  · `buildApprovalList` — gom MỌI quyết định nghiệp vụ còn lại thành một danh sách, mỗi mục có PHÒNG
 *    chịu trách nhiệm (không bao giờ một cá nhân — AGENTS mục 22), nguyên nhân, hành động và đường dẫn.
 *  · `codGapCause` — nguyên nhân của một khoản phải thu COD chưa có chứng từ tiền.
 */
import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * KHOÁ + PHÒNG CHỊU TRÁCH NHIỆM của từng mục DANH SÁCH PHÊ DUYỆT — MỘT bảng. Trang Trung tâm đối soát và nguồn
 * việc `PAYROLL_RECON` trên `/work` (luật sở hữu `PAYROLL_RECON:<khoá>`) cùng đọc bảng này: hai nơi khai phòng
 * là hai nơi nói hai phòng khác nhau (AGENTS.md mục 22). Khoá đã nằm trong `work_key` của lớp ghi chú — KHÔNG đổi.
 */
export const APPROVAL_ITEM_OWNER = {
  "opening-balance": "MANAGEMENT",
  "undated-employees": "HR",
  "pending-code-rows": "MANAGEMENT",
  "codes-without-owner": "MARKETING",
  "months-signoff": "FINANCE",
  "cogs-gaps": "WAREHOUSE",
  "cod-receivable": "FINANCE",
  "duplicate-source": "FINANCE",
} as const satisfies Record<string, DepartmentCode>;
export type ApprovalItemKey = keyof typeof APPROVAL_ITEM_OWNER;
export const APPROVAL_ITEM_KEYS = Object.keys(APPROVAL_ITEM_OWNER) as ApprovalItemKey[];

/** Nhãn ngắn của từng loại mục — cho màn hình cấu hình hạn / phòng của `/work`. */
export const APPROVAL_ITEM_LABEL: Record<ApprovalItemKey, string> = {
  "opening-balance": "Lương · khai số dư lũy kế mở sổ (quy chế cổng)",
  "undated-employees": "Lương · nhân sự chưa khai ngày vào làm",
  "pending-code-rows": "Lương · phân công / điều khoản thưởng theo mã chờ duyệt",
  "codes-without-owner": "Lương · mã có doanh thu chưa có người phụ trách đã duyệt",
  "months-signoff": "Lương · tháng chờ ký đối soát cấp 1",
  "cogs-gaps": "Lương · dòng đã giao chưa có giá vốn",
  "cod-receivable": "Lương · đơn đã giao chưa có chứng từ tiền (bảng kê COD)",
  "duplicate-source": "Lương · khoản chi gõ tay trùng nguồn",
};

/** Khoảng tháng mặc định của Trung tâm đối soát: tháng hiện tại và 4 tháng trước. Trang và `/work` cùng dùng. */
export const RECON_CENTER_DEFAULT_BACK_MONTHS = 4;
export function shiftMonthKey(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export function reconCenterDefaultRange(toMonth: string): { fromMonth: string; toMonth: string } {
  return { fromMonth: shiftMonthKey(toMonth, -RECON_CENTER_DEFAULT_BACK_MONTHS), toMonth };
}

/** Một tháng của chuỗi số đo. `null` = CHƯA BIẾT (không phải 0). */
export type OpeningMonthInput = {
  monthKey: string;
  /** Doanh thu đã giao, ĐÃ GHI NHẬN (cùng điều kiện cơ sở lương). */
  revenue: number;
  /** Tổng chi phí đã ghi nhận của máy chi phí (giá vốn · QC · cước · phí hoàn · vận hành). */
  recognizedCost: number;
  /** Lương cứng CÓ CĂN CỨ mà bảng Chi phí chưa ghi nhận (cảnh báo `PAYROLL_OBLIGATION_NOT_RECOGNIZED`). */
  salaryGapEvidenced: number;
  /** Lương cứng của người chưa khai ngày vào làm — CHƯA BIẾT có thuộc tháng. */
  salaryUndated: number;
  /** Dòng đã giao chưa có giá vốn (giá vốn = 0 ⇒ lợi nhuận tháng CAO hơn sự thật). */
  unknownCostLines: number;
  unknownCostRevenue: number;
  /** Doanh thu đã giao mà chưa có chứng từ tiền. */
  revenueWithoutMoney: number;
  /** Giá trị đơn chưa có kết quả. */
  openValue: number;
  /** Tháng nằm TRƯỚC khoản chi phí đầu tiên từng được nhập ⇒ chi phí vận hành CHƯA BIẾT. */
  beforeFirstExpense: boolean;
};

export type OpeningMonthRow = OpeningMonthInput & { measuredProfit: number; gaps: string[] };

export type OpeningProposal = {
  openingMonth: string;
  dataStart: string | null;
  months: OpeningMonthRow[];
  /** Σ lợi nhuận đo được của các tháng TRƯỚC `openingMonth`. */
  measuredCumulative: number;
  /** Mốc cao nhất của lũy kế đo được (đỉnh của đường lũy kế, sàn 0). */
  measuredHighWater: number;
  /** `true` chỉ khi MỌI tháng đều không thiếu căn cứ. */
  complete: boolean;
  /** Tháng thiếu căn cứ (tóm tắt). */
  incompleteMonths: string[];
};

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")} ₫`;

export function openingMonthGaps(m: OpeningMonthInput): string[] {
  const g: string[] = [];
  if (m.beforeFirstExpense) g.push("chưa có chứng từ chi phí vận hành nào (tháng trước khoản chi đầu tiên được nhập) — chi phí vận hành CHƯA BIẾT, không phải 0");
  if (m.unknownCostLines > 0) g.push(`${m.unknownCostLines} dòng đã giao chưa có giá vốn (${vnd(m.unknownCostRevenue)} doanh thu) — lợi nhuận đang cao hơn sự thật`);
  if (m.salaryUndated > 0) g.push(`${vnd(m.salaryUndated)} lương cứng của người chưa khai ngày vào làm — chưa biết có thuộc tháng`);
  if (m.revenueWithoutMoney > 0) g.push(`${vnd(m.revenueWithoutMoney)} doanh thu đã giao chưa có chứng từ tiền`);
  if (m.openValue > 0) g.push(`${vnd(m.openValue)} giá trị đơn chưa có kết quả`);
  return g;
}

/**
 * LƯƠNG CỨNG KHI DỰNG LẠI LỊCH SỬ (chủ shop 20/10/2026: "không tự nhân 8 triệu cho mọi tháng"). Máy chi phí
 * coi người chưa khai ngày vào làm là có mặt MỌI kỳ — đúng cho lá chắn chốt lương, sai cho số dư lũy kế. Ở đây
 * phần lương của họ là CHƯA BIẾT: không trừ, nêu thành chỗ thiếu căn cứ.
 *  · bảng Lương cầm nguồn ⇒ nhóm lương ghi nhận = max(lương cứng, chứng từ lương) (`splitPayrollComponents`).
 *    Bỏ người chưa khai ngày thì còn max(lương cứng có ngày, chứng từ) ⇒ chỉ trừ NGƯỢC phần chênh — tiền lương
 *    đã có chứng từ KHÔNG bao giờ rơi khỏi chi phí;
 *  · bảng Chi phí cầm nguồn mà chưa có khoản lương ⇒ cảnh báo nghĩa vụ mang cả phần ấy ⇒ chỉ lấy phần có ngày;
 *  · bảng Chi phí có khoản lương thật ⇒ đó là chứng từ, không có gì chưa biết.
 */
export function historicalSalary(x: { payrollCovered: boolean; obligation: number | null; undated: number; fixedSalary: number; salaryExpenseDocs: number; recognizedCost: number }): { recognizedCost: number; salaryGapEvidenced: number; salaryUndated: number } {
  if (x.payrollCovered) {
    const coNgay = Math.max(0, x.fixedSalary - x.undated);
    const tru = Math.max(x.fixedSalary, x.salaryExpenseDocs) - Math.max(coNgay, x.salaryExpenseDocs);
    return { recognizedCost: x.recognizedCost - tru, salaryGapEvidenced: 0, salaryUndated: tru };
  }
  if (x.obligation !== null) return { recognizedCost: x.recognizedCost, salaryGapEvidenced: Math.max(0, x.obligation - x.undated), salaryUndated: x.undated };
  return { recognizedCost: x.recognizedCost, salaryGapEvidenced: 0, salaryUndated: 0 };
}

/** Đề xuất số dư mở sổ cho `openingMonth` từ các tháng TRƯỚC nó. Không bao giờ tự chốt. */
export function buildOpeningProposal(openingMonth: string, dataStart: string | null, months: readonly OpeningMonthInput[]): OpeningProposal {
  const truoc = months.filter((m) => m.monthKey < openingMonth).sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1));
  let luyKe = 0;
  let dinh = 0;
  const rows: OpeningMonthRow[] = truoc.map((m) => {
    const measuredProfit = Math.round(m.revenue - m.recognizedCost - m.salaryGapEvidenced);
    luyKe += measuredProfit;
    dinh = Math.max(dinh, luyKe);
    return { ...m, measuredProfit, gaps: openingMonthGaps(m) };
  });
  const thieu = rows.filter((r) => r.gaps.length > 0).map((r) => r.monthKey);
  return { openingMonth, dataStart, months: rows, measuredCumulative: luyKe, measuredHighWater: dinh, complete: rows.length > 0 && thieu.length === 0, incompleteMonths: thieu };
}

/** Một mục của DANH SÁCH PHÊ DUYỆT DUY NHẤT. */
export type ApprovalItem = {
  key: ApprovalItemKey;
  /** `DECIDE` = chủ shop / người có quyền phải quyết · `SUPPLY` = phòng phải bổ sung chứng từ / dữ liệu. */
  kind: "DECIDE" | "SUPPLY";
  title: string;
  cause: string;
  action: string;
  owner: DepartmentCode;
  amount: number | null;
  count: number | null;
  href: string;
};

export type ApprovalInput = {
  opening: OpeningProposal;
  /** Quy chế cổng đã khai chưa (số dư mở sổ đã có người duyệt). */
  gatePolicyDeclared: boolean;
  undatedEmployees: readonly { id: string; name: string; monthlyFixed: number }[];
  pendingAssignments: number;
  pendingTerms: number;
  /** Mã có doanh thu trong kỳ đo mà chưa có phân công OWNER đã duyệt. */
  codesWithoutOwner: number;
  /** Tháng có thưởng % LN đủ điều kiện mà chưa có chữ ký đối soát cấp 1 còn hiệu lực. */
  monthsNeedingSignoff: readonly string[];
  cogsGaps: { variants: number; lines: number; revenue: number };
  codReceivable: { orders: number; revenue: number; over30Orders: number };
  /** Khoản bị loại vì trùng nguồn — người đối soát kiểm tay phần chênh. */
  duplicateSourceWarnings: number;
};

/**
 * DANH SÁCH PHÊ DUYỆT DUY NHẤT. Mục nào dữ liệu đã đủ để máy tự kết luận thì KHÔNG có ở đây (nó nằm ở
 * phần "tự đối soát") — đây chỉ là việc mà CHỈ con người làm được: quyết một chính sách, hoặc bổ sung một
 * chứng từ ERP chưa có.
 */
export function buildApprovalList(x: ApprovalInput): ApprovalItem[] {
  const out: ApprovalItem[] = [];
  if (!x.gatePolicyDeclared) {
    out.push({
      key: "opening-balance",
      kind: "DECIDE",
      title: `Số dư lỗ / lãi lũy kế mở sổ tại tháng ${x.opening.openingMonth}`,
      cause: x.opening.complete
        ? `Chuỗi số đo từ ${x.opening.dataStart ?? "—"} đủ căn cứ: lũy kế đo được ${vnd(x.opening.measuredCumulative)} (đỉnh ${vnd(x.opening.measuredHighWater)}).`
        : `Đề xuất ${vnd(x.opening.measuredCumulative)} CHƯA ĐỦ CĂN CỨ — ${x.opening.incompleteMonths.length} tháng còn thiếu (${x.opening.incompleteMonths.join(", ")}). Không dùng số này như số đã duyệt.`,
      action: "Người có quyền duyệt lương đối chiếu đề xuất rồi KHAI quy chế cổng (số dư, mốc cao nhất, lý do). ERP không tự khai.",
      owner: APPROVAL_ITEM_OWNER["opening-balance"],
      amount: x.opening.measuredCumulative,
      count: x.opening.months.length,
      href: "/payroll/settings",
    });
  }
  if (x.undatedEmployees.length) {
    out.push({
      key: "undated-employees",
      kind: "SUPPLY",
      title: `${x.undatedEmployees.length} nhân sự chưa khai ngày vào làm`,
      cause: `Lương cứng khai hôm nay (${x.undatedEmployees.map((e) => `${e.name} ${vnd(e.monthlyFixed)}/tháng`).join(", ")}) không chứng minh được người ấy đã làm ở các tháng trước — đề xuất số dư mở sổ KHÔNG nhân lương ấy cho mọi tháng, nên các tháng ấy còn thiếu căn cứ. (Kỳ đang trả lương vẫn trừ đủ lương cứng như cũ.)`,
      action: "Khai ngày vào làm theo hợp đồng lao động ở Lương → nhân sự. Khai xong, các tháng có căn cứ tự vào đề xuất mở sổ.",
      owner: APPROVAL_ITEM_OWNER["undated-employees"],
      amount: x.undatedEmployees.reduce((t, e) => t + e.monthlyFixed, 0),
      count: x.undatedEmployees.length,
      href: "/payroll",
    });
  }
  if (x.pendingAssignments + x.pendingTerms > 0) {
    out.push({
      key: "pending-code-rows",
      kind: "DECIDE",
      title: `${x.pendingAssignments} phân công MKTer ↔ mã và ${x.pendingTerms} điều khoản thưởng đang CHỜ DUYỆT`,
      cause: "Dòng chờ duyệt KHÔNG vào bảng lương — không có tỷ lệ mặc định nào được áp thay.",
      action: "Người duyệt (khác người khai, hoặc chủ shop) bấm Duyệt / Từ chối từng dòng.",
      owner: APPROVAL_ITEM_OWNER["pending-code-rows"],
      amount: null,
      count: x.pendingAssignments + x.pendingTerms,
      href: "/payroll/codes/assignments",
    });
  }
  if (x.codesWithoutOwner > 0) {
    out.push({
      key: "codes-without-owner",
      kind: "DECIDE",
      title: `${x.codesWithoutOwner} mã có doanh thu chưa có OWNER đã duyệt`,
      cause: "Lợi nhuận của mã chưa phân công không chia cho ai — thưởng theo mã của mã ấy là 0 cho tới khi có phân công đã duyệt.",
      action: "Khai OWNER / SUPPORT kèm X% / Y% theo quy chế (gợi ý theo chi phí quảng cáo có sẵn ở trang phân công), rồi duyệt.",
      owner: APPROVAL_ITEM_OWNER["codes-without-owner"],
      amount: null,
      count: x.codesWithoutOwner,
      href: "/payroll/codes/assignments",
    });
  }
  if (x.monthsNeedingSignoff.length) {
    out.push({
      key: "months-signoff",
      kind: "DECIDE",
      title: `${x.monthsNeedingSignoff.length} tháng có thưởng % lợi nhuận đủ điều kiện chờ ký đối soát cấp 1`,
      cause: `Tháng ${x.monthsNeedingSignoff.join(", ")}: kỳ lương không duyệt / khoá được khi chưa có chữ ký trên ảnh chụp kỳ.`,
      action: "Người quản trị lương ký bảng đối soát của tháng; một người KHÁC duyệt kỳ.",
      owner: APPROVAL_ITEM_OWNER["months-signoff"],
      amount: null,
      count: x.monthsNeedingSignoff.length,
      href: "/payroll/reconciliation",
    });
  }
  if (x.cogsGaps.lines > 0) {
    out.push({
      key: "cogs-gaps",
      kind: "SUPPLY",
      title: `${x.cogsGaps.lines} dòng đã giao chưa có giá vốn (${x.cogsGaps.variants} mẫu mã)`,
      cause: `${vnd(x.cogsGaps.revenue)} doanh thu đang tính với giá vốn 0 — lợi nhuận ảo. ERP KHÔNG tự đặt giá vốn.`,
      action: "Nhập giá trên phiếu nhập kho của đúng mẫu mã (hoặc nối dòng đơn vào mẫu mã). Bảng truy từng mẫu mã ở dưới.",
      owner: APPROVAL_ITEM_OWNER["cogs-gaps"],
      amount: x.cogsGaps.revenue,
      count: x.cogsGaps.lines,
      href: "/inventory/cost-center",
    });
  }
  if (x.codReceivable.orders > 0) {
    out.push({
      key: "cod-receivable",
      kind: "SUPPLY",
      title: `${x.codReceivable.orders} đơn đã giao chưa có chứng từ tiền`,
      cause: `${vnd(x.codReceivable.revenue)} là doanh thu KẾ TOÁN (đã giao) nhưng chưa phải tiền thực nhận — ${x.codReceivable.over30Orders} đơn đã giao quá 30 ngày.`,
      action: "Tải «Chi tiết bảng kê COD» của các kỳ thiếu từ viettelpost.vn (.xlsx / .csv) rồi nạp ở Nhập Viettel Post — bảng kê đối soát CẢ tiền thu hộ lẫn cước đã tính tiền. Đơn quá 30 ngày đối chiếu thẳng với ĐVVC.",
      owner: APPROVAL_ITEM_OWNER["cod-receivable"],
      amount: x.codReceivable.revenue,
      count: x.codReceivable.orders,
      href: "/import-vtp",
    });
  }
  if (x.duplicateSourceWarnings > 0) {
    out.push({
      key: "duplicate-source",
      kind: "SUPPLY",
      title: `${x.duplicateSourceWarnings} khoản chi gõ tay trùng nguồn đang bị loại`,
      cause: "Đã có nguồn thẩm quyền (vận đơn / tài khoản QC) cho cùng khoản — cộng thêm là ghi trùng.",
      action: "Kiểm tay phần chênh; khoản thật sự là điều chỉnh thì khai lý do (`MANUAL_ADJUSTMENT`).",
      owner: APPROVAL_ITEM_OWNER["duplicate-source"],
      amount: null,
      count: x.duplicateSourceWarnings,
      href: "/expenses",
    });
  }
  return out;
}

export type CodGapCause = "NO_STATEMENT" | "STATEMENT_NO_CASH" | "DISPUTED" | "COLLECTED_NOT_PAID";
export const COD_GAP_CAUSE_LABEL: Record<CodGapCause, string> = {
  NO_STATEMENT: "Chưa có bảng kê COD nào nhắc tới vận đơn",
  STATEMENT_NO_CASH: "Có bảng kê nhưng không ghi số thực thu",
  DISPUTED: "Đang tranh chấp với ĐVVC",
  COLLECTED_NOT_PAID: "ĐVVC báo đã thu, chưa ghi tiền về",
};

/** Nguyên nhân của một khoản phải thu (đơn đã giao, chưa có chứng từ tiền) — từ trạng thái COD của vận đơn. */
export function codGapCause(codStatus: string | null, hasStatement: boolean): CodGapCause {
  if (codStatus === "DISPUTED") return "DISPUTED";
  if (codStatus === "COLLECTED" || codStatus === "RECONCILED" || codStatus === "PAID_TO_BANK") return "COLLECTED_NOT_PAID";
  return hasStatement ? "STATEMENT_NO_CASH" : "NO_STATEMENT";
}

/**
 * PHÒNG chịu trách nhiệm cho một khoản chưa đối soát của bảng tháng (`MonthReconciliation.issues[].code`).
 * Phòng ban, không bao giờ một người (AGENTS mục 22). Khoá lạ ⇒ Kế toán (người giữ sổ đối soát).
 */
export function issueOwner(code: string): DepartmentCode {
  if (code === "cogs") return "WAREHOUSE";
  if (code === "revenue" || code === "open-orders" || code === "shipping" || code === "return-cost") return "LOGISTICS";
  if (code === "revenue-no-product" || code === "code-no-custom-id") return "WAREHOUSE";
  if (code.startsWith("ads")) return "MARKETING";
  if (code === "warn:PAYROLL_OBLIGATION_NOT_RECOGNIZED") return "HR";
  return "FINANCE";
}
