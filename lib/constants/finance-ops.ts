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
import type { MatchConfidence } from "@/lib/integrations/bank/match";
import type { Employee } from "@/lib/constants/payroll";

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
