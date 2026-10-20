/**
 * ═══════════ BẢNG NGUYÊN NHÂN HOÀN THEO CHỨNG CỨ — HÀM THUẦN, KHÔNG ĐỌC CSDL ═══════════
 *
 * Dựng từ ĐÚNG báo cáo lý do hoàn đang hiện (`getReturnReasonReport`, cách xếp `EVIDENCE`) và báo cáo cùng bộ lọc của KỲ TRƯỚC cùng độ
 * dài — không truy vấn lại, nên mỗi ô của bảng này trùng một ô của bảng nhóm ngay trên trang.
 *
 * ─── BA LUẬT GIỮ BẢNG KHỎI THÀNH LỜI BUỘC TỘI ───
 *
 *   1. PHÒNG XỬ LÝ, không phải «lỗi của» (AGENTS.md mục 24): nhóm chỉ được giao phòng khi đủ cỡ mẫu (`ALERT_MIN_SAMPLE.minReasonCases`
 *      — cùng ngưỡng «nguyên nhân chính» của khối Cần chú ý, không đặt số mới) VÀ cùng một bảng ánh xạ chỉ ra đúng MỘT phòng
 *      (`evidenceGroupDepartment`). «Khách từ chối — chưa rõ vì sao» không bao giờ có phòng: chưa ai biết vì sao.
 *   2. GIẢI PHÁP là câu cố định của nhóm (`EVIDENCE_GROUP_ACTION`) — không sinh bằng AI, không đổi theo con số.
 *   3. ƯU TIÊN xếp theo GIÁ TRỊ ĐƠN HOÀN đã biết (từ đơn — không phải tiền mất, không phải phí hoàn ĐVVC), rồi số đơn. Nhóm mà mọi đơn
 *      đều chưa có giá trị ⇒ in «—» và đứng theo số đơn. Căn cứ xếp được trả về để màn hình in ra. Nhóm dưới cỡ mẫu không mang thứ hạng.
 */
import type { DepartmentCode } from "@/lib/constants/departments";
import { ALERT_MIN_SAMPLE } from "@/lib/constants/return-intelligence";
import { EVIDENCE_GROUP_ACTION, isReasonGroupKey, type EvidenceGroup, type EvidenceTier, type ReasonGroupKey } from "@/lib/constants/return-reason-evidence";

/** Phần báo cáo bảng này đọc — để kiểm thử dựng được mà không cần cả báo cáo. */
export type CauseBoardInput = {
  returned: number;
  eligibleSent: number;
  ungrouped: number;
  evidenceTiers: Record<EvidenceTier, number>;
  groups: readonly { group: ReasonGroupKey; label: string; count: number; incidence: number | null; lostRevenue: number; lostRevenueUnknown: number; department: DepartmentCode | null; tiers: Record<EvidenceTier, number> }[];
};

export type CauseRow = {
  group: EvidenceGroup;
  label: string;
  count: number;
  /** Trên TỔNG ca hoàn của tập (kể cả chưa xếp nhóm) — «bao nhiêu phần ca hoàn là vì nhóm này». `null` khi không có ca hoàn. */
  shareOfReturns: number | null;
  /** Trên ĐÃ GỬI — «cứ 100 kiện gửi đi thì bao nhiêu kiện hoàn vì nhóm này». */
  incidence: number | null;
  /** Giá trị đơn hoàn ĐÃ BIẾT; `null` khi mọi đơn của nhóm đều chưa có giá trị. */
  lostValue: number | null;
  lostValueUnknown: number;
  /** Kỳ trước cùng độ dài: số ca + chênh tỷ trọng (điểm %). `null` = không có kỳ trước hoặc kỳ trước dưới cỡ mẫu. */
  trend: { prevCount: number; deltaPoints: number } | null;
  action: string;
  /** Phòng xử lý — `null` kèm `departmentWhy` khi chưa đủ căn cứ giao. */
  department: DepartmentCode | null;
  departmentWhy: string | null;
  /** Thứ hạng ưu tiên 1..n; `null` = dưới cỡ mẫu, không xếp hạng. */
  rank: number | null;
  sample: number;
  /** Bậc chứng cứ của chính nhóm — độ tin của dòng. */
  tiers: Record<EvidenceTier, number>;
};

export type CauseBoard = {
  rows: CauseRow[];
  /** Câu căn cứ xếp — màn hình in nguyên văn. */
  sortBasis: string;
  minSample: number;
  /** Ca đã có NGƯỜI của shop xác nhận / ca hoàn. `null` khi không có ca hoàn. */
  verificationRate: number | null;
  /** Ca mà các nguồn nói khác nhau / ca hoàn. */
  conflictRate: number | null;
  ungrouped: number;
  returned: number;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function buildCauseBoard(cur: CauseBoardInput, prev: CauseBoardInput | null): CauseBoard {
  const minSample = ALERT_MIN_SAMPLE.minReasonCases;
  const truoc = new Map((prev?.groups ?? []).map((g) => [g.group, g]));
  const rows: CauseRow[] = cur.groups
    .filter((g) => g.count > 0 && isReasonGroupKey(g.group) && g.group in EVIDENCE_GROUP_ACTION)
    .map((g) => {
      const group = g.group as EvidenceGroup;
      const p = truoc.get(group);
      const share = pct(g.count, cur.returned);
      const prevShare = p && prev ? pct(p.count, prev.returned) : null;
      const enough = g.count >= minSample;
      const department = enough ? g.department : null;
      const departmentWhy = department ? null : !enough ? `dưới ${minSample} ca — chưa đủ để giao phòng` : "chưa đủ căn cứ chỉ một phòng — đi hỏi khách / xác nhận lý do trước";
      return {
        group,
        label: g.label,
        count: g.count,
        shareOfReturns: share,
        incidence: g.incidence,
        lostValue: g.lostRevenueUnknown >= g.count ? null : g.lostRevenue,
        lostValueUnknown: g.lostRevenueUnknown,
        trend: p && prev && p.count >= minSample && share !== null && prevShare !== null ? { prevCount: p.count, deltaPoints: Math.round((share - prevShare) * 10) / 10 } : null,
        action: EVIDENCE_GROUP_ACTION[group],
        department,
        departmentWhy,
        rank: null,
        sample: g.count,
        tiers: g.tiers,
      };
    })
    .sort((a, b) => (b.lostValue ?? -1) - (a.lostValue ?? -1) || b.count - a.count || a.label.localeCompare(b.label, "vi"));
  let r = 0;
  for (const row of rows) if (row.sample >= minSample) row.rank = ++r;
  return {
    rows,
    sortBasis: "Xếp theo giá trị đơn hoàn đã biết (từ đơn — không phải tiền mất, không phải phí hoàn ĐVVC), rồi số đơn; nhóm mà mọi đơn chưa có giá trị («—») đứng sau, theo số đơn.",
    minSample,
    verificationRate: pct(cur.evidenceTiers.HUMAN_CONFIRMED, cur.returned),
    conflictRate: pct(cur.evidenceTiers.CONFLICTED, cur.returned),
    ungrouped: cur.ungrouped,
    returned: cur.returned,
  };
}
