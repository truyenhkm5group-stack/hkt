/**
 * ═══════ HÀNG ĐỢI TÁC VỤ TÀI CHÍNH — HÀM THUẦN ═══════
 *
 * Hai việc đọc dữ liệu KHÔNG cần chạm CSDL, tách riêng để kiểm thử không phải dựng dữ liệu:
 *
 *  1. Quy đổi mức tin cậy đối khớp (`MatchConfidence` ở lib/integrations/bank/match.ts) sang bốn
 *     trạng thái nghiệp vụ mà màn hình Bank → COD cần: MATCHED / PARTIAL / UNMATCHED / REVIEW.
 *  2. Gợi ý một dòng sao kê có thể là lương/hoa hồng của NHÂN SỰ nào, dựa trên tên/bí danh đã khai ở
 *     trang Lương — evidence có sẵn, không đoán ngoài dữ liệu đã khai.
 *
 * KHÔNG viết lại luật đối khớp hay luật lương ở đây — chỉ đọc lại kết quả của nơi có thẩm quyền.
 */
import { normalize } from "@/lib/text";
import { caseScore } from "@/lib/constants/action-queue";
import type { MatchConfidence } from "@/lib/integrations/bank/match";
import type { Employee } from "@/lib/constants/payroll";

/**
 * ═══════ DÒNG TIỀN CHƯA PHÂN LOẠI: XẾP THEO TIỀN ĐANG TREO × SỐ NGÀY TREO ═══════
 *
 * Trước 24/09/2026 hàng đợi Kế toán xếp dòng chưa phân loại theo NGÀY GIAO DỊCH MỚI NHẤT, nên một
 * khoản 50 triệu chưa ai gán nhóm nằm cùng thứ tự với một khoản 50 nghìn — và khi số dòng tồn vượt
 * 300 thì `/work` cắt ĐÚNG những khoản cũ nhất (thường là khoản khó, lớn, bị né) ra khỏi hàng đợi.
 *
 * Đây là MỘT công thức cho cả `/finance-ops` lẫn `/work` (`adaptBank`): điểm ưu tiên chung của ERP
 * (`caseScore`) — tiền bão hoà ở 5 triệu, tuổi bão hoà ở 7 ngày — rồi phá thế hoà bằng SỐ TIỀN
 * TUYỆT ĐỐI. Phá thế hoà là phần quan trọng: hai khoản 5 triệu và 50 triệu cùng tuổi có CÙNG điểm
 * (cả hai đã chạm trần), và không có bước này thì thứ tự giữa chúng là ngẫu nhiên.
 *
 * Số tiền là SỰ THẬT trên sao kê, không phải "tiền sắp mất": phân loại xong không thu thêm đồng nào,
 * nó chỉ làm báo cáo đúng. Nên đây là thứ tự ĐỌC, không phải một con số giá trị của việc.
 */
export function bankExceptionScore(amount: number, txnAt: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - txnAt.getTime()) / 3_600_000);
  return caseScore({ severity: "warning", ageHours, amount: Math.abs(amount), type: "DATA_ERROR" });
}

/**
 * Xếp dòng tiền chưa phân loại: điểm cao trước → tiền lớn trước → giao dịch cũ trước → `id`.
 *
 * Bước cuối theo `id` để thứ tự ỔN ĐỊNH: hai lần mở trang ra cùng một danh sách, nếu không người
 * đang làm dở dòng thứ 7 bấm làm mới thì thấy nó nhảy sang vị trí khác.
 */
export function rankBankExceptions<T extends { id: string; amount: number; txnAt: Date }>(rows: T[], now: Date): T[] {
  return rows
    .map((r) => ({ r, score: bankExceptionScore(r.amount, r.txnAt, now) }))
    .sort((a, b) => b.score - a.score || Math.abs(b.r.amount) - Math.abs(a.r.amount) || a.r.txnAt.getTime() - b.r.txnAt.getTime() || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0))
    .map((x) => x.r);
}

export const FINANCE_OPS_COD_STATUSES = ["MATCHED", "PARTIAL", "UNMATCHED", "REVIEW"] as const;
export type FinanceOpsCodStatus = (typeof FINANCE_OPS_COD_STATUSES)[number];

export const FINANCE_OPS_COD_STATUS_LABEL: Record<FinanceOpsCodStatus, string> = {
  MATCHED: "Đã khớp",
  PARTIAL: "Khớp một phần",
  UNMATCHED: "Chưa khớp",
  REVIEW: "Cần xem lại",
};

export const FINANCE_OPS_COD_STATUS_HINT: Record<FinanceOpsCodStatus, string> = {
  MATCHED: "Có đúng một đợt COD khớp mã hoặc khớp tiền + ngày. Vẫn cần người bấm xác nhận, trừ khi đã có mã chứng từ trùng khớp (tự nối được ở tab Đối khớp).",
  PARTIAL: "Có đúng một đợt COD cùng mã nhưng SỐ TIỀN LỆCH — có thể ĐVVC đã trừ cước/phí hoàn vào tiền trả về, hoặc trả thiếu/trả thừa.",
  UNMATCHED: "Không có đợt COD nào trong cửa sổ ±30 ngày khớp số tiền hoặc mã.",
  REVIEW: "Nhiều đợt COD cùng khớp — máy không được chọn hộ, cần người xem và chọn đúng đợt.",
};

export type CodMatchInput = {
  confidence: MatchConfidence;
  /** Chứng từ được đề xuất duy nhất, nếu có */
  target: { amount: number } | null;
  /** Chứng từ bị loại vì nhập nhằng, hoặc chứng từ duy nhất nhưng lệch tiền */
  others: { amount: number }[];
};

export type CodMatchResult = {
  status: FinanceOpsCodStatus;
  /** Chênh lệch = tiền sao kê − tiền chứng từ đối chiếu. `null` khi không có đúng một chứng từ để so. */
  difference: number | null;
};

/**
 * `EXACT` / `HIGH_CONFIDENCE` đã có đúng MỘT chứng từ nên là MATCHED. `AMBIGUOUS` với ĐÚNG MỘT
 * chứng từ bị loại (vì lệch tiền — xem lib/integrations/bank/match.ts mục 1) là PARTIAL: có bằng
 * chứng nối đúng đợt, chỉ là thu thiếu/thu thừa so với bảng kê. `AMBIGUOUS` với NHIỀU chứng từ là
 * REVIEW thật sự — không đoán được đợt nào. `UNMATCHED` giữ nguyên.
 */
export function codMatchStatus(bankAmount: number, r: CodMatchInput): CodMatchResult {
  if (r.confidence === "EXACT" || r.confidence === "HIGH_CONFIDENCE") {
    return { status: "MATCHED", difference: r.target ? bankAmount - r.target.amount : null };
  }
  if (r.confidence === "AMBIGUOUS") {
    if (r.others.length === 1) return { status: "PARTIAL", difference: bankAmount - r.others[0].amount };
    return { status: "REVIEW", difference: null };
  }
  return { status: "UNMATCHED", difference: null };
}

/**
 * Nhân sự có TÊN / BÍ DANH xuất hiện TRỌN TỪ trong nội dung chuyển khoản hoặc tên đối tác.
 *
 * Chỉ dùng để GỢI Ý phân loại Lương ở hàng đợi — người vẫn phải bấm xác nhận. Bí danh/tên ngắn hơn 3
 * ký tự bị bỏ qua, cùng lý do với mã chứng từ ngắn ở `lib/integrations/bank/match.ts`: chuỗi càng
 * ngắn càng dễ khớp ngẫu nhiên, và khớp ngẫu nhiên tệ hơn không khớp vì nó đội lốt bằng chứng.
 */
export function matchEmployeeByText(text: string, employees: Pick<Employee, "id" | "name" | "shortName" | "aliases" | "active">[]): { id: string; name: string } | null {
  const hay = normalize(text);
  for (const e of employees) {
    if (!e.active) continue;
    const needles = [e.name, e.shortName, ...e.aliases].filter((s) => (s ?? "").trim().length >= 3);
    for (const needle of needles) {
      if (hay.includes(normalize(needle).trim())) return { id: e.id, name: e.shortName || e.name };
    }
  }
  return null;
}
