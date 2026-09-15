/**
 * ═══════════ CỔNG ĐỐI CHIẾU: PHÂN LOẠI KẾT QUẢ, VÀ TỪ CHỐI KẾT QUẢ RỖNG ═══════════
 *
 * ─── VẤN ĐỀ TỆP NÀY SINH RA ĐỂ GIẢI ───
 *
 * Lượt đối chiếu đầu tiên trên production trả về "4/4 khớp, lệch 0đ" và nghe như một cổng đã qua.
 * Nó không phải: bảng lương trên production RỖNG, chưa ai được gán chính sách, nên cả hai đường
 * tính đều trả về cùng một thứ *không có gì*. Hai phép tính cùng ra 0 trên dữ liệu rỗng không
 * chứng minh chúng đồng ý — chúng chỉ chứng minh không có gì để bất đồng.
 *
 * Đó là một kết quả **RỖNG NGHĨA** (vacuous). Nguy hiểm vì nó trông y hệt một kết quả tốt, và nó
 * xuất hiện đúng lúc người ta muốn nghe điều đó nhất: ngay trước khi phát hành.
 *
 * Nên "khớp" ở đây phải chứng minh được là có thứ để khớp. Một kỳ mà mọi nguồn số đều bằng 0
 * KHÔNG được đi qua cổng — nó trả về `INSUFFICIENT_DATA`, và đó là một câu trả lời trung thực chứ
 * không phải một lỗi.
 *
 * ─── HÀM THUẦN ───
 *
 * Không đọc CSDL, không đọc đồng hồ. Phân loại là một hàm của những con số đã đo, nên nó kiểm được
 * bằng bảng chân lý thay vì phải dựng một kỳ lương thật.
 */

/** Kết quả đối chiếu của MỘT nhân sự. Thứ tự ở đây là thứ tự ưu tiên khi tổng hợp. */
export const RECON_STATUSES = ["BUG", "INSUFFICIENT_DATA", "NEEDS_CONFIG", "EXPECTED_CHANGE", "MATCH"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const RECON_STATUS_LABEL: Record<ReconStatus, string> = {
  MATCH: "Khớp",
  EXPECTED_CHANGE: "Lệch có lý do",
  NEEDS_CONFIG: "Thiếu khai báo",
  INSUFFICIENT_DATA: "Không đủ dữ liệu để kết luận",
  BUG: "LỆCH KHÔNG GIẢI THÍCH ĐƯỢC",
};

export const RECON_STATUS_HINT: Record<ReconStatus, string> = {
  MATCH: "Hai đường tính ra cùng một con số trên dữ liệu CÓ THẬT.",
  EXPECTED_CHANGE: "Hai đường ra số khác nhau, và phần lệch được giải thích bằng một quy tắc đã khai (khoản điều chỉnh, sửa đúng có chủ ý).",
  NEEDS_CONFIG: "Chưa dựng được chính sách ứng viên vì hồ sơ cũ thiếu thứ cần thiết. Không phải lệch — là chưa tính được.",
  INSUFFICIENT_DATA: "Kỳ này không có hoạt động nguồn nào cho người này, nên hai con số 0 bằng nhau KHÔNG chứng minh điều gì.",
  BUG: "Lệch mà không quy tắc nào giải thích được. Đây là thứ phải đọc trước khi phát hành.",
};

/**
 * CÁC NGUỒN SỐ ĐƯỢC COI LÀ "KỲ NÀY CÓ HOẠT ĐỘNG".
 *
 * Danh sách ĐÓNG và cố ý rộng: một kỳ chỉ có chi phí mà không có đơn vẫn là một kỳ tính lương được
 * (lương cứng vẫn phải trả). Ngược lại, kỳ mà MỌI con số dưới đây bằng 0 thì không có gì để hai
 * đường tính bất đồng.
 */
export const ACTIVITY_SOURCES = ["orders", "deliveredOrders", "revenue", "adSpend", "expenses", "shipments", "fixedSalaryDeclared"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export type PeriodActivity = Readonly<Record<ActivitySource, number>>;

export const ACTIVITY_LABEL: Record<ActivitySource, string> = {
  orders: "Đơn phát sinh",
  deliveredOrders: "Đơn giao thành công",
  revenue: "Doanh thu giao thành công",
  adSpend: "Chi tiêu quảng cáo",
  expenses: "Dòng chi phí",
  shipments: "Vận đơn",
  fixedSalaryDeclared: "Lương cứng khai trong hồ sơ",
};

/**
 * KỲ NÀY CÓ ĐỦ THỨ ĐỂ ĐỐI CHIẾU KHÔNG.
 *
 * `false` ⇒ mọi kết luận "khớp" trên kỳ ấy là RỖNG NGHĨA và không được dùng làm căn cứ phát hành.
 */
export function hasActivity(a: PeriodActivity): boolean {
  return ACTIVITY_SOURCES.some((k) => (a[k] ?? 0) > 0);
}

/** Những nguồn thật sự có số — in ra cạnh kết luận để người đọc tự thấy căn cứ. */
export function activeSources(a: PeriodActivity): ActivitySource[] {
  return ACTIVITY_SOURCES.filter((k) => (a[k] ?? 0) > 0);
}

export type EmployeeReconInput = {
  employeeId: string;
  employeeName: string;
  /** Hồ sơ cũ thiếu thứ gì để dựng chính sách ứng viên. Rỗng = dựng được. */
  missingConfig: readonly string[];
  /** Người này có số liệu nguồn nào trong kỳ không (doanh thu / đơn / lương cứng khai…). */
  hasOwnActivity: boolean;
  /** Đường cũ có ra được một dòng lương cho người này không. */
  hasLegacyLine: boolean;
  /** Chênh lệch thực nhận. `null` = một trong hai bên CHƯA BIẾT. */
  netDiff: number | null;
  /** Còn khoản lệch nào KHÔNG quy tắc nào giải thích được không. */
  hasUnexplainedDiff: boolean;
};

/**
 * ═══ PHÂN LOẠI MỘT NHÂN SỰ ═══
 *
 * Thứ tự dưới đây là một quyết định, không phải ngẫu nhiên:
 *
 *  1. `BUG` thắng tất cả. Một khoản lệch không giải thích được không được che bởi bất kỳ nhãn dễ
 *     nghe nào — kể cả khi người ấy cũng thiếu khai báo.
 *  2. `NEEDS_CONFIG` trước `INSUFFICIENT_DATA`: thiếu khai báo là việc CÓ NGƯỜI LÀM ĐƯỢC ngay, còn
 *     thiếu dữ liệu nguồn thì phải đợi kỳ sau. Nói cái làm được trước.
 *  3. `INSUFFICIENT_DATA` trước `MATCH` — đây là mấu chốt của cả tệp này. Không có hoạt động nguồn
 *     thì hai con số 0 bằng nhau KHÔNG phải một phép khớp, và gọi nó là `MATCH` là biến một chỗ
 *     trống thành một lời bảo đảm.
 *  4. `EXPECTED_CHANGE` khi có lệch nhưng mọi phần lệch đều có quy tắc giải thích.
 */
export function classifyEmployee(input: EmployeeReconInput): ReconStatus {
  if (input.hasUnexplainedDiff) return "BUG";
  if (input.missingConfig.length > 0) return "NEEDS_CONFIG";
  if (!input.hasLegacyLine) return "INSUFFICIENT_DATA";
  if (!input.hasOwnActivity) return "INSUFFICIENT_DATA";
  if (input.netDiff === null) return "INSUFFICIENT_DATA";
  if (input.netDiff !== 0) return "EXPECTED_CHANGE";
  return "MATCH";
}

export type GateVerdict = "RECONCILIATION_PASS" | "RECONCILIATION_BLOCKED_BY_CONFIG" | "RECONCILIATION_BLOCKED_BY_ENVIRONMENT" | "NOT_READY_BUG_FOUND";

export type GateInput = {
  /** Chạy được mã ứng dụng trên CSDL mục tiêu ở chế độ chỉ đọc không. */
  environmentOk: boolean;
  /** Kỳ được chọn có hoạt động nguồn không. */
  periodHasActivity: boolean;
  /** Kết quả từng người. */
  statuses: readonly ReconStatus[];
};

/**
 * ═══ KẾT LUẬN CỔNG ═══
 *
 * Bốn kết quả, và KHÔNG có kết quả thứ năm kiểu "tạm được". Một cổng có ô "tạm được" là một cổng
 * ai cũng đi qua.
 */
export function gateVerdict(input: GateInput): { verdict: GateVerdict; why: string } {
  if (!input.environmentOk) {
    return {
      verdict: "RECONCILIATION_BLOCKED_BY_ENVIRONMENT",
      why: "Không chạy được mã ứng dụng trên CSDL mục tiêu ở chế độ CHỈ ĐỌC an toàn. Không hạ chuẩn để chạy cho xong.",
    };
  }
  if (input.statuses.some((s) => s === "BUG")) {
    const n = input.statuses.filter((s) => s === "BUG").length;
    return { verdict: "NOT_READY_BUG_FOUND", why: `${n} nhân sự có khoản lệch KHÔNG quy tắc nào giải thích được.` };
  }
  if (!input.periodHasActivity) {
    return {
      verdict: "RECONCILIATION_BLOCKED_BY_CONFIG",
      why: "Kỳ được chọn không có một nguồn số nào khác 0. Mọi kết luận “khớp” trên kỳ ấy là RỖNG NGHĨA — hai phép tính cùng ra 0 trên dữ liệu rỗng không chứng minh chúng đồng ý.",
    };
  }
  const ketLuanDuoc = input.statuses.filter((s) => s === "MATCH" || s === "EXPECTED_CHANGE").length;
  if (ketLuanDuoc === 0) {
    const thieuKhai = input.statuses.filter((s) => s === "NEEDS_CONFIG").length;
    return {
      verdict: "RECONCILIATION_BLOCKED_BY_CONFIG",
      why:
        thieuKhai > 0
          ? `Kỳ có dữ liệu nguồn, nhưng KHÔNG nhân sự nào tính được cả hai đường: ${thieuKhai} người còn thiếu khai báo để dựng chính sách ứng viên.`
          : "Kỳ có dữ liệu nguồn, nhưng không nhân sự nào đủ căn cứ để so hai đường tính.",
    };
  }
  return {
    verdict: "RECONCILIATION_PASS",
    why: `${ketLuanDuoc} nhân sự đối chiếu được trên kỳ CÓ dữ liệu nguồn; không ai có khoản lệch không giải thích được.`,
  };
}

/** Đếm theo nhãn, giữ đủ cả năm khoá kể cả khoá bằng 0 — bảng tổng hợp thiếu một dòng là một bảng nói dối. */
export function tallyStatuses(statuses: readonly ReconStatus[]): Record<ReconStatus, number> {
  const out = Object.fromEntries(RECON_STATUSES.map((s) => [s, 0])) as Record<ReconStatus, number>;
  for (const s of statuses) out[s] += 1;
  return out;
}
