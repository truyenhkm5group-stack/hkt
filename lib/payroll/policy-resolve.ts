/**
 * ═══════════ PHÂN ĐOẠN MỘT KỲ LƯƠNG THEO HIỆU LỰC — HÀM THUẦN ═══════════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Người vào làm ngày 15, người nghỉ ngày 20, người đổi chính sách giữa tháng, người chuyển phòng
 * ban ngày 10. Cách hỏng phổ biến là lấy cấu hình **HÔM NAY** rồi áp cho cả kỳ: chuyển An sang
 * chính sách mới ngày 15/09 thì bảng lương tháng 9 tính cả tháng theo chính sách mới, và — tệ hơn
 * — bảng lương tháng 8 cũng đổi theo, dù tiền tháng 8 đã trả.
 *
 * Nên cấu hình nhân sự là một chuỗi dòng CÓ MỐC HIỆU LỰC, và một kỳ lương được cắt thành các ĐOẠN
 * mà trong mỗi đoạn mọi thứ đứng yên. Tiền của kỳ = tổng tiền của các đoạn.
 *
 * ─── HÀM THUẦN, VÀ VÌ SAO ───
 *
 * Không đọc CSDL, không đọc đồng hồ. Chạy hai lần trên cùng đầu vào ra đúng một kết quả — điều
 * kiện để `payroll_periods.snapshot` có nghĩa, và để kiểm thử được 30 tình huống bằng số viết tay
 * thay vì bằng một cơ sở dữ liệu dựng sẵn.
 *
 * ─── MỐC MỞ (`effectiveTo = null`) NGHĨA LÀ "CÒN HIỆU LỰC", KHÔNG PHẢI "CHƯA BIẾT" ───
 *
 * Một phân công chưa có ngày kết thúc là một phân công đang chạy. Khác hẳn `effectiveFrom = null`,
 * thứ KHÔNG hợp lệ ở đây: không biết bắt đầu từ ngày nào thì không cắt đoạn được, và đoán một mốc
 * bắt đầu là đoán xem tháng nào người ta được trả lương.
 */
import { inclusiveDays } from "@/lib/constants/cost-allocation";
import type { EmploymentStatus, EmploymentType, WorkMode } from "@/lib/constants/payroll-components";

/** Một dòng phân công lao động có mốc hiệu lực. `effectiveTo = null` = còn hiệu lực. */
export type EmploymentRow = {
  id: string;
  employeeId: string;
  departmentId: string | null;
  departmentName: string;
  positionId: string | null;
  positionName: string;
  managerUserId: string | null;
  employmentType: EmploymentType;
  workMode: WorkMode;
  status: EmploymentStatus;
  /** Số ngày công chuẩn của một tháng theo hợp đồng (`null` = chưa khai ⇒ dùng số ngày thật của tháng). */
  standardWorkDays: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/** Một dòng gán chính sách lương có mốc hiệu lực. */
export type PolicyAssignmentRow = {
  id: string;
  employeeId: string;
  policyId: string;
  policyCode: string;
  policyName: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

/** Một phiên bản chính sách có mốc hiệu lực riêng. */
export type PolicyVersionRow = {
  id: string;
  policyId: string;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
};

/**
 * ĐOẠN: một khoảng trong kỳ mà phân công lao động VÀ phiên bản chính sách đều đứng yên.
 * `policyVersionId = null` nghĩa là đoạn ấy KHÔNG có chính sách nào phủ — nói thẳng ra như vậy
 * thay vì lặng lẽ tính 0 đồng (yêu cầu mục 29.30).
 */
export type PayrollSegment = {
  from: Date;
  to: Date;
  days: number;
  employment: EmploymentRow | null;
  /**
   * NGƯỜI NÀY CÓ DÒNG PHÂN CÔNG LAO ĐỘNG NÀO KHÔNG — bất kể nó có phủ đoạn này hay không.
   *
   * `employment = null` gộp hai tình huống KHÁC HẲN nhau, và gộp chúng là chỗ một người bị trả 0đ:
   *
   *  · CÓ dòng phân công nhưng nó không phủ đoạn này (chưa vào làm, đã nghỉ) ⇒ 0 đồng cho đoạn ấy
   *    là câu trả lời ĐÚNG. Người ta thật sự không làm việc những ngày đó.
   *  · KHÔNG có dòng phân công nào ⇒ ERP KHÔNG BIẾT người ấy đi làm hay không. Trả 0 ở đây là
   *    khẳng định họ không làm ngày nào — một khẳng định không có căn cứ, và nó trông y hệt câu
   *    trả lời đúng ở trên.
   */
  hasEmploymentRecord: boolean;
  policyId: string | null;
  policyCode: string;
  policyName: string;
  policyVersionId: string | null;
  policyVersion: number | null;
};

const VN_OFFSET_MS = 7 * 3_600_000;

/** Đầu ngày lịch Việt Nam KẾ TIẾP, hoặc chính nó nếu đã ở đúng 00:00. */
function ceilVnDay(ms: number): number {
  const shifted = ms + VN_OFFSET_MS;
  const day = Math.ceil(shifted / 86_400_000) * 86_400_000;
  return day - VN_OFFSET_MS;
}

const startOf = (r: { effectiveFrom: Date }) => r.effectiveFrom.getTime();
const endOf = (r: { effectiveTo: Date | null }) => (r.effectiveTo ? r.effectiveTo.getTime() : Number.POSITIVE_INFINITY);

/** Dòng còn hiệu lực TẠI một mốc. Trùng mốc thì lấy dòng có `effectiveFrom` MUỘN NHẤT. */
function rowAt<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rows: readonly T[], at: number): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (startOf(r) > at || endOf(r) < at) continue;
    if (!best || startOf(r) > startOf(best)) best = r;
  }
  return best;
}

/**
 * CẮT KỲ THÀNH CÁC ĐOẠN ĐỨNG YÊN.
 *
 * Mốc cắt = mọi điểm mà một thứ gì đó đổi: đầu kỳ, cuối kỳ, mỗi `effectiveFrom`, và mỗi
 * `effectiveTo + 1ms` (vì `effectiveTo` là mốc CUỐI CÙNG còn hiệu lực, nên đoạn mới bắt đầu ngay
 * sau nó, không phải tại nó).
 *
 * Đoạn mà người đã nghỉ (`TERMINATED`) hoặc chưa vào làm KHÔNG bị bỏ đi — nó vẫn được trả về với
 * `employment = null`, vì màn hình cần nói được "14 ngày đầu tháng người này chưa vào làm" thay vì
 * im lặng bớt đi một phần kỳ.
 */
export function resolveSegments(input: {
  from: Date;
  to: Date;
  employments: readonly EmploymentRow[];
  policyAssignments: readonly PolicyAssignmentRow[];
  policyVersions: readonly PolicyVersionRow[];
}): PayrollSegment[] {
  const { from, to } = input;
  if (to < from) return [];
  const lo = from.getTime();
  const hi = to.getTime();
  const cuts = new Set<number>([lo]);
  const consider = (rows: readonly { effectiveFrom: Date; effectiveTo: Date | null }[]) => {
    for (const r of rows) {
      const s = startOf(r);
      if (s > lo && s <= hi) cuts.add(s);
      const e = endOf(r);
      if (Number.isFinite(e) && e + 1 > lo && e + 1 <= hi) cuts.add(e + 1);
    }
  };
  consider(input.employments);
  consider(input.policyAssignments);
  consider(input.policyVersions);

  /*
    ═══ MỌI MỐC CẮT PHẢI RƠI VÀO ĐẦU MỘT NGÀY LỊCH VIỆT NAM ═══

    Mốc hiệu lực trong ERP là NGÀY, không phải thời điểm: `vnStartOfDay` cho 00:00:00.000 và
    `vnEndOfDay` cho 23:59:59.999. Nhưng một dòng ghi bằng đường khác (script chạy tay, dữ liệu
    nhập từ nơi khác) có thể mang 23:59:59 KHÔNG có phần mili giây — và lúc ấy `effectiveTo + 1ms`
    rơi vào 23:59:59.001, tức GIỮA một ngày.

    Hậu quả không phải một chi tiết hiển thị: mẩu 999 mili giây ấy thành một ĐOẠN RIÊNG, không có
    chính sách nào phủ (nên bảng lương báo "chưa gán chính sách" cho một người đã gán đầy đủ), và
    `inclusiveDays` đếm nó là MỘT NGÀY — một ngày công không có thật, cộng vào phép chia lương cứng.

    Nên mọi mốc cắt được LÀM TRÒN LÊN đầu ngày kế tiếp. Mốc đã ở đúng 00:00 thì giữ nguyên, nên
    dòng ghi đúng chuẩn không đổi hành vi một chút nào.
  */
  const marks = [...new Set([...cuts].map((m) => (m === lo ? m : ceilVnDay(m))))].filter((m) => m >= lo && m <= hi).sort((a, b) => a - b);
  const out: PayrollSegment[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const segFrom = marks[i];
    const segTo = i + 1 < marks.length ? marks[i + 1] - 1 : hi;
    if (segTo < segFrom) continue;
    const employment = rowAt(input.employments, segFrom);
    const assignment = rowAt(input.policyAssignments, segFrom);
    /*
      PHIÊN BẢN PHẢI THUỘC ĐÚNG CHÍNH SÁCH ĐÃ GÁN, và phải ở trạng thái dùng được.

      `DRAFT` là bản đang soạn — đem tính lương là trả tiền theo một luật chưa ai duyệt. `RETIRED`
      là bản đã rút; nó vẫn phủ được các đoạn TRONG khoảng hiệu lực cũ của nó, vì kỳ lương của
      tháng ấy phải tiếp tục ra đúng con số cũ (yêu cầu mục 25).
    */
    const version = assignment
      ? rowAt(
          input.policyVersions.filter((v) => v.policyId === assignment.policyId && v.status !== "DRAFT"),
          segFrom,
        )
      : null;
    out.push({
      from: new Date(segFrom),
      to: new Date(segTo),
      days: inclusiveDays(new Date(segFrom), new Date(segTo)),
      employment,
      hasEmploymentRecord: input.employments.length > 0,
      policyId: assignment?.policyId ?? null,
      policyCode: assignment?.policyCode ?? "",
      policyName: assignment?.policyName ?? "",
      policyVersionId: version?.id ?? null,
      policyVersion: version?.version ?? null,
    });
  }
  /*
    GỘP CÁC ĐOẠN LIỀN NHAU KHÔNG KHÁC GÌ NHAU.

    Một `effectiveTo` rơi đúng vào một `effectiveFrom` của dòng khác sinh ra mốc cắt nhưng không
    đổi gì cả. Để nguyên thì phiếu lương in ra hai dòng y hệt nhau cho một tháng liền mạch, và
    lương cứng chia theo ngày của hai đoạn cộng lại có thể lệch một đồng so với một đoạn duy nhất.
  */
  const merged: PayrollSegment[] = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    const same =
      prev &&
      prev.employment?.id === seg.employment?.id &&
      prev.policyVersionId === seg.policyVersionId &&
      prev.policyId === seg.policyId;
    if (same) {
      prev.to = seg.to;
      prev.days = inclusiveDays(prev.from, prev.to);
      continue;
    }
    merged.push({ ...seg });
  }
  return merged;
}

/** Đoạn mà người này THẬT SỰ đang làm việc — dùng để chia lương cứng theo ngày. */
export function isWorkingSegment(seg: PayrollSegment): boolean {
  return seg.employment !== null && seg.employment.status !== "TERMINATED";
}
