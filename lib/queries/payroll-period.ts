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
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  PAYROLL_BASIS_ELIGIBILITY,
  PAYROLL_CALC_VERSION,
  payrollPeriodKey,
  type PayrollBasis,
} from "@/lib/constants/payroll";
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
  }[];
};

/** Rút ảnh chụp từ một bản tính SỐNG. Hàm THUẦN: không đọc CSDL, không đọc đồng hồ. */
export function buildPayrollSnapshot(report: PayrollReport, period: Period, key: string): PayrollSnapshot {
  return {
    calcVersion: PAYROLL_CALC_VERSION,
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
    })),
  };
}

export type PayrollPeriodState = {
  /** `null` = kỳ không có mốc đầu/cuối ⇒ không có danh tính kỳ ⇒ không chốt được. */
  key: string | null;
  status: "NONE" | "DRAFT" | "FINAL";
  finalizedAt: Date | null;
  finalizedByEmail: string | null;
  note: string;
  /** Chỉ có khi `FINAL`. */
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
    finalizedAt: null,
    finalizedByEmail: null,
    note: "",
    snapshot: null,
    calcVersion: null,
    basisEligible: PAYROLL_BASIS_ELIGIBILITY[basis].eligible,
  };
  if (!key) return base;
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db
    .select({
      status: p.status,
      snapshot: p.snapshot,
      calcVersion: p.calcVersion,
      note: p.note,
      finalizedAt: p.finalizedAt,
      finalizedByEmail: schema.users.email,
    })
    .from(p)
    .leftJoin(schema.users, eq(schema.users.id, p.finalizedBy))
    .where(and(eq(p.periodKey, key), eq(p.basis, basis)))
    .limit(1);
  if (!row) return base;
  const isFinal = row.status === "FINAL" && row.snapshot !== null;
  return {
    ...base,
    status: isFinal ? "FINAL" : "DRAFT",
    finalizedAt: row.finalizedAt ?? null,
    finalizedByEmail: row.finalizedByEmail ?? null,
    note: row.note ?? "",
    snapshot: isFinal ? (row.snapshot as PayrollSnapshot) : null,
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
    .where(eq(p.status, "FINAL"))
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
    .where(and(eq(p.status, "FINAL"), lte(p.periodStart, to), gte(p.periodEnd, from)));
}
