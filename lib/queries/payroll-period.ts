/**
 * ═══════════ KỲ LƯƠNG: NHÁP TÍNH SỐNG, ĐÃ CHỐT ĐỌC ẢNH CHỤP ═══════════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * `getPayrollReport` tính lại từ đầu mỗi lần mở. Nên mọi thứ đứng sau con số đều trôi: đổi một tỷ
 * lệ thưởng, đổi người phụ trách một fanpage, nhập thêm một phiếu kho — và bảng lương THÁNG TRƯỚC
 * đổi theo, SAU KHI tiền đã trả. Không chỗ nào ghi shop đã trả bao nhiêu, theo cơ sở nào, với tỷ
 * lệ nào.
 *
 * `payroll_periods` giữ ẢNH CHỤP. `DRAFT` tính sống; `FINAL` đọc ảnh, KHÔNG truy vấn lại
 * (AGENTS.md mục 21, cùng hợp đồng với `review_cycles`).
 *
 * ─── KỲ ĐÃ CHỐT KHÔNG ĐƯỢC VIẾT LẠI, NHƯNG CŨNG KHÔNG ĐƯỢC NÓI DỐI ───
 *
 * Chứng từ vẫn về sau ngày chốt: một bảng kê COD, một phiếu kho, một lần sửa tỷ lệ. Hai cách xử lý
 * đều sai:
 *   · tính lại đè lên ảnh chụp ⇒ viết lại một kỳ đã trả tiền, im lặng;
 *   · giấu hẳn phần chênh ⇒ chủ shop không bao giờ biết có gì đã đổi.
 *
 * Nên ở đây làm cách thứ ba: ảnh chụp VẪN là con số của kỳ, và phần tính lại hôm nay đứng CẠNH nó
 * như một ĐỀ XUẤT ĐIỀU CHỈNH có dấu vết. Người quyết có sửa hay không; máy không tự sửa.
 */
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { alias } from "drizzle-orm/pg-core";
import {
  PAYROLL_BASIS_ELIGIBILITY,
  PAYROLL_CALC_VERSION,
  payrollPeriodKey,
  type PayrollBasis,
} from "@/lib/constants/payroll";
import { PAYROLL_ENGINE_VERSION } from "@/lib/payroll/engine";
import { isFrozen, normalizePayrollStatus, type PayrollRunStatus } from "@/lib/constants/payroll-lifecycle";
import type { Period } from "@/lib/search-params";
import type { PayrollReport } from "@/lib/queries/payroll";

/**
 * ẢNH CHỤP PHẢI ĐỦ ĐỂ DỰNG LẠI CÂU TRẢ LỜI, KHÔNG CHỈ ĐỦ ĐỂ IN MỘT CON SỐ.
 *
 * Cố ý KHÔNG chụp `marketers.products` (chi tiết từng mã của từng người): nó là phần nặng nhất và
 * nó DẪN XUẤT từ những con số đã có ở đây. Chụp nó vào sẽ làm mỗi kỳ nặng vài trăm KB mà không trả
 * lời thêm được câu hỏi nào của người đọc bảng lương.
 */
export type PayrollSnapshot = {
  calcVersion: number;
  /**
   * PHIÊN BẢN MÁY TÍNH LƯƠNG CHUNG (`PAYROLL_ENGINE_VERSION`) — tách hẳn khỏi `calcVersion`.
   *
   * `calcVersion` là phiên bản của ĐƯỜNG TÍNH CŨ (bốn ô trên hồ sơ nhân sự). Hai đường có thể đổi
   * độc lập nhau, nên hai số. Gộp lại thì một lần sửa máy chung sẽ làm mọi kỳ cũ trông như tính
   * bằng một luật khác, và ngược lại.
   */
  engineVersion: number;
  basis: PayrollBasis;
  period: { key: string; from: string; to: string; label: string };
  totalProfit: number;
  nominalTotal: number;
  cashRatio: number | null;
  cashRatioReason: string | null;
  totalSalary: number | null;
  fixedBasis: PayrollReport["fixedBasis"];
  paid: PayrollReport["paid"];
  attributionCoverage: PayrollReport["marketers"]["attributionCoverage"];
  costWarnings: PayrollReport["marketers"]["costWarnings"];
  payrollCovered: boolean;
  lines: {
    employeeId: string;
    name: string;
    shortName: string;
    department: string;
    /** TỶ LỆ TẠI LÚC CHỐT — đổi tỷ lệ sau này không được làm đổi kỳ đã chốt. */
    percentTotal: number;
    percentPersonal: number;
    percentRevenue: number;
    fixedMonthly: number;
    fixed: number | null;
    totalProfit: number;
    personalProfit: number | null;
    personalRevenue: number | null;
    bonusTotal: number;
    bonusPersonal: number | null;
    bonusRevenue: number;
    salary: number | null;
    /**
     * ═══ CHI TIẾT TỪNG THÀNH PHẦN CỦA MÁY TÍNH LƯƠNG CHUNG ═══
     *
     * `null` = người này tính bằng đường cũ (bốn ô trên hồ sơ nhân sự).
     *
     * Ở đây CÓ chụp vết giải thích, khác với `marketers.products` cố ý bỏ ra. Lý do khác nhau: chi
     * tiết từng mã DẪN XUẤT được từ những con số đã chụp, còn vết giải thích thì KHÔNG — nó là câu
     * trả lời cho "vì sao tháng ấy trả chừng này", và nó phải đứng yên cùng con số. Dựng lại nó
     * bằng chính sách hôm nay là dựng lại bằng một luật có thể đã đổi.
     */
    engine: {
      policy: { code: string; name: string; version: number | null }[];
      components: {
        code: string;
        label: string;
        kind: string;
        amount: number | null;
        basisKey: string | null;
        basisValue: number | null;
        explain: { label: string; value: number | null; unit?: string; note?: string }[];
        carry: { openingBalance: number; lossApplied: number; commissionBase: number; closingBalance: number } | null;
      }[];
      adjustments: { code: string; label: string; kind: string; amount: number | null; explain: { label: string; value: number | null; unit?: string; note?: string }[] }[];
      grossEarnings: number | null;
      totalDeductions: number | null;
      netPay: number | null;
      segments: { from: string; to: string; days: number; policyCode: string; policyVersion: number | null; working: boolean }[];
    } | null;
  }[];
};

/** Rút ảnh chụp từ một bản tính SỐNG. Hàm THUẦN: không đọc CSDL, không đọc đồng hồ. */
export function buildPayrollSnapshot(report: PayrollReport, period: Period, key: string): PayrollSnapshot {
  return {
    calcVersion: PAYROLL_CALC_VERSION,
    engineVersion: PAYROLL_ENGINE_VERSION,
    basis: report.basis,
    period: { key, from: period.fromKey ?? "", to: period.toKey ?? "", label: period.label },
    totalProfit: report.totalProfit,
    nominalTotal: report.nominalTotal,
    cashRatio: report.cashRatio,
    cashRatioReason: report.cashRatioReason,
    totalSalary: report.totalSalary,
    fixedBasis: report.fixedBasis,
    paid: report.paid,
    attributionCoverage: report.marketers.attributionCoverage,
    costWarnings: report.marketers.costWarnings,
    payrollCovered: report.marketers.payrollCovered,
    lines: report.lines.map((l) => ({
      employeeId: l.employee.id,
      name: l.employee.name,
      shortName: l.employee.shortName,
      department: l.employee.department,
      percentTotal: l.employee.percentTotal,
      percentPersonal: l.employee.percentPersonal,
      percentRevenue: l.employee.percentRevenue,
      fixedMonthly: l.fixedMonthly,
      fixed: l.fixed,
      totalProfit: l.totalProfit,
      personalProfit: l.personalProfit,
      personalRevenue: l.personalRevenue,
      bonusTotal: l.bonusTotal,
      bonusPersonal: l.bonusPersonal,
      bonusRevenue: l.bonusRevenue,
      salary: l.salary,
      engine: l.engine
        ? {
            policy: [...new Map(l.engine.segments.filter((sg) => sg.policyId).map((sg) => [`${sg.policyCode}:${sg.policyVersion}`, { code: sg.policyCode, name: sg.policyName, version: sg.policyVersion }])).values()],
            components: l.engine.result.components.map((c) => ({
              code: c.code,
              label: c.label,
              kind: c.kind,
              amount: c.amount,
              basisKey: c.basisKey,
              basisValue: c.basisValue,
              explain: c.explain,
              carry: c.carry,
            })),
            adjustments: l.engine.result.adjustments.map((c) => ({ code: c.code, label: c.label, kind: c.kind, amount: c.amount, explain: c.explain })),
            grossEarnings: l.engine.result.grossEarnings,
            totalDeductions: l.engine.result.totalDeductions,
            netPay: l.engine.result.netPay,
            segments: l.engine.result.segments.map((sg) => ({
              from: sg.from.toISOString(),
              to: sg.to.toISOString(),
              days: sg.days,
              policyCode: sg.policyCode,
              policyVersion: sg.policyVersion,
              working: sg.working,
            })),
          }
        : null,
    })),
  };
}

export type PayrollPeriodState = {
  /** `null` = kỳ không có mốc đầu/cuối ⇒ không có danh tính kỳ ⇒ không chốt được. */
  key: string | null;
  /**
   * `NONE` = chưa ai bấm gì cho kỳ này. Còn lại là sáu trạng thái của
   * `lib/constants/payroll-lifecycle.ts`; giá trị `FINAL` cũ trên production đọc thành `LOCKED`.
   */
  status: "NONE" | PayrollRunStatus;
  /** Ảnh chụp đã đóng băng chưa (`LOCKED` / `PAID`) — không tính lại, không nhập thêm. */
  frozen: boolean;
  finalizedAt: Date | null;
  finalizedByEmail: string | null;
  approvedAt: Date | null;
  approvedByEmail: string | null;
  lockedAt: Date | null;
  paidAt: Date | null;
  statusReason: string;
  calcRuns: number;
  note: string;
  /** Có từ `CALCULATED` trở đi — mọi trạng thái sau `DRAFT` đều phải có ảnh chụp. */
  snapshot: PayrollSnapshot | null;
  /** Phiên bản phép tính lúc chụp — khác `PAYROLL_CALC_VERSION` nghĩa là ảnh dựng bằng luật cũ. */
  calcVersion: number | null;
  /** Cơ sở này có được phép chốt lương không (`PAYROLL_BASIS_ELIGIBILITY`). */
  basisEligible: boolean;
};

/** Trạng thái kỳ lương cho (kỳ, cơ sở). KHÔNG tính lại gì — chỉ đọc một dòng. */
export async function getPayrollPeriodState(period: Period, basis: PayrollBasis): Promise<PayrollPeriodState> {
  const key = payrollPeriodKey(period.from, period.to);
  const base: PayrollPeriodState = {
    key,
    status: "NONE",
    frozen: false,
    finalizedAt: null,
    finalizedByEmail: null,
    approvedAt: null,
    approvedByEmail: null,
    lockedAt: null,
    paidAt: null,
    statusReason: "",
    calcRuns: 0,
    note: "",
    snapshot: null,
    calcVersion: null,
    basisEligible: PAYROLL_BASIS_ELIGIBILITY[basis].eligible,
  };
  if (!key) return base;
  const db = await getDb();
  const p = schema.payrollPeriods;
  const nguoiDuyet = alias(schema.users, "nguoi_duyet");
  const [row] = await db
    .select({
      status: p.status,
      snapshot: p.snapshot,
      calcVersion: p.calcVersion,
      note: p.note,
      finalizedAt: p.finalizedAt,
      finalizedByEmail: schema.users.email,
      approvedAt: p.approvedAt,
      approvedByEmail: nguoiDuyet.email,
      lockedAt: p.lockedAt,
      paidAt: p.paidAt,
      statusReason: p.statusReason,
      calcRuns: p.calcRuns,
    })
    .from(p)
    .leftJoin(schema.users, eq(schema.users.id, p.finalizedBy))
    .leftJoin(nguoiDuyet, eq(nguoiDuyet.id, p.approvedBy))
    .where(and(eq(p.periodKey, key), eq(p.basis, basis)))
    .limit(1);
  if (!row) return base;
  /*
    ẢNH CHỤP LÀ ĐIỀU KIỆN ĐỂ MỘT TRẠNG THÁI CÓ NGHĨA.

    Một dòng mang trạng thái `CALCULATED` mà `snapshot` rỗng là một dòng nói dối: lần mở sau vẫn
    tính lại và số sẽ khác. Ràng buộc CSDL đã chặn, nhưng ở đây vẫn hạ về `DRAFT` thay vì tin —
    dữ liệu cũ từ trước ràng buộc ấy vẫn có thể tồn tại.
  */
  const trangThai = row.snapshot === null ? "DRAFT" : normalizePayrollStatus(row.status);
  return {
    ...base,
    status: trangThai,
    frozen: isFrozen(trangThai),
    finalizedAt: row.finalizedAt ?? null,
    finalizedByEmail: row.finalizedByEmail ?? null,
    approvedAt: row.approvedAt ?? null,
    approvedByEmail: row.approvedByEmail ?? null,
    lockedAt: row.lockedAt ?? null,
    paidAt: row.paidAt ?? null,
    statusReason: row.statusReason ?? "",
    calcRuns: row.calcRuns ?? 0,
    note: row.note ?? "",
    snapshot: trangThai === "DRAFT" ? null : (row.snapshot as PayrollSnapshot),
    calcVersion: row.calcVersion ?? null,
  };
}

/**
 * CHÊNH LỆCH PHÁT SINH SAU KHI CHỐT — đề xuất điều chỉnh, KHÔNG phải một lượt ghi đè.
 *
 * So ảnh chụp với bản tính SỐNG hôm nay. Chỉ nêu những con số người đọc bảng lương thật sự hành
 * động theo; `null` ở một trong hai bên nghĩa là CHƯA BIẾT nên không so được, và ở đây nói thế
 * thay vì quy về 0 rồi báo một khoản chênh không có thật.
 */
export type PayrollDrift = { field: string; label: string; snapshot: number | null; live: number | null; diff: number | null };

export function payrollDrift(snapshot: PayrollSnapshot, live: PayrollReport): PayrollDrift[] {
  const out: PayrollDrift[] = [];
  const add = (field: string, label: string, a: number | null, b: number | null) => {
    if (a === b) return;
    out.push({ field, label, snapshot: a, live: b, diff: a === null || b === null ? null : b - a });
  };
  add("totalProfit", "Lợi nhuận tổng kỳ", snapshot.totalProfit, live.totalProfit);
  add("totalSalary", "Tổng lương phải trả", snapshot.totalSalary, live.totalSalary);
  add("paid", "Đã trả trong kỳ", snapshot.paid.amount, live.paid.amount);
  const liveById = new Map(live.lines.map((l) => [l.employee.id, l]));
  for (const s of snapshot.lines) {
    const l = liveById.get(s.employeeId);
    if (!l) {
      out.push({ field: `line:${s.employeeId}`, label: `${s.shortName || s.name} — không còn trong sổ nhân sự`, snapshot: s.salary, live: null, diff: null });
      continue;
    }
    add(`line:${s.employeeId}`, `${s.shortName || s.name} — tổng lương`, s.salary, l.salary);
  }
  for (const l of live.lines) {
    if (snapshot.lines.some((s) => s.employeeId === l.employee.id)) continue;
    out.push({ field: `line:${l.employee.id}`, label: `${l.employee.shortName || l.employee.name} — mới có sau khi chốt`, snapshot: null, live: l.salary, diff: null });
  }
  return out;
}

/** Các kỳ đã chốt gần đây — để màn hình liệt kê và mở lại. */
export async function listPayrollPeriods(limit = 12) {
  const db = await getDb();
  const p = schema.payrollPeriods;
  return db
    .select({
      periodKey: p.periodKey,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      basis: p.basis,
      status: p.status,
      calcVersion: p.calcVersion,
      note: p.note,
      finalizedAt: p.finalizedAt,
    })
    .from(p)
    // Kỳ đã ĐÓNG BĂNG (`FINAL` cũ đọc như `LOCKED`). Kỳ mới tính xong chưa phải lịch sử — nó còn
    // đổi được, nên liệt nó vào đây là gọi một bản nháp là quá khứ.
    .where(inArray(p.status, ["FINAL", "LOCKED", "PAID"]))
    .orderBy(desc(p.periodStart))
    .limit(limit);
}

/** Kỳ đã chốt nào TRÙM một mốc thời gian — dùng để cảnh báo khi có người định chốt chồng lấn. */
export async function finalizedPeriodsOverlapping(from: Date, to: Date) {
  const db = await getDb();
  const p = schema.payrollPeriods;
  return db
    .select({ periodKey: p.periodKey, basis: p.basis, finalizedAt: p.finalizedAt })
    .from(p)
    .where(and(inArray(p.status, ["FINAL", "LOCKED", "PAID"]), lte(p.periodStart, to), gte(p.periodEnd, from)));
}

/**
 * MỌI KỲ CÓ BẢN GHI — kể cả bản nháp và kỳ đang soát.
 *
 * Khác `listPayrollPeriods` (chỉ kỳ đã đóng băng, dùng cho phần "lịch sử đã trả"): một kỳ đang chờ
 * duyệt mà không hiện ở đâu là một kỳ không ai nhớ ra để đi duyệt.
 *
 * Tổng lương và số người đọc THẲNG từ ảnh chụp, không tính lại: đây là danh sách lịch sử, và tính
 * lại ở đây là để con số của một kỳ đã trả tiền đổi theo dữ liệu hôm nay.
 */
export async function listPayrollRuns(limit = 60) {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const nguoiDuyet = alias(schema.users, "run_approver");
  const rows = await db
    .select({
      periodKey: p.periodKey,
      basis: p.basis,
      status: p.status,
      snapshot: p.snapshot,
      note: p.note,
      statusReason: p.statusReason,
      calcRuns: p.calcRuns,
      approvedAt: p.approvedAt,
      approvedByEmail: nguoiDuyet.email,
      lockedAt: p.lockedAt,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
    })
    .from(p)
    .leftJoin(nguoiDuyet, eq(nguoiDuyet.id, p.approvedBy))
    .orderBy(desc(p.periodStart))
    .limit(limit);
  return rows.map((r) => {
    const snap = r.snapshot as PayrollSnapshot | null;
    return {
      ...r,
      totalSalary: snap?.totalSalary ?? null,
      people: snap?.lines.length ?? null,
    };
  });
}
