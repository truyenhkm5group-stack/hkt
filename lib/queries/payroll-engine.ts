/**
 * ═══════ NỐI MÁY TÍNH LƯƠNG CHUNG VÀO NGUỒN SỐ THẬT CỦA ERP ═══════
 *
 * Ba tầng, và ranh giới giữa chúng là cố ý:
 *   · `lib/payroll/engine.ts`        — PHÉP TÍNH. Hàm thuần, không biết CSDL.
 *   · `lib/queries/payroll-policies.ts` — LỜI KHAI. Đọc chính sách, phân công, đầu vào tay.
 *   · file này                        — NGUỒN SỐ. Lấy lợi nhuận / doanh thu / số đơn đã đo được và
 *     dựng đầu vào cho từng đoạn.
 *
 * Không phép nhân tiền nào ở đây. Nếu có ngày một tỷ lệ xuất hiện trong tệp này thì đó là dấu hiệu
 * một thành phần chưa khai được ở sổ chính sách, không phải dấu hiệu máy thiếu tính năng.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { LEGACY_CARRY_COMPONENT, monthKeyOf } from "@/lib/constants/payroll-carryover";
import { payrollPeriodKey } from "@/lib/constants/payroll";
import type { PolicyComponent } from "@/lib/constants/payroll-components";
import { calculatePayrollItem, type AdjustmentInput, type PayrollItemResult, type SegmentInput } from "@/lib/payroll/engine";
import { isWorkingSegment, resolveSegments, type PayrollSegment } from "@/lib/payroll/policy-resolve";
import { loadAdjustments, loadAssignmentBook, loadManualInputs } from "@/lib/queries/payroll-policies";
import type { Period } from "@/lib/search-params";

/** Số đo ở mức TỪNG NGƯỜI mà ERP tính được cho cả kỳ. `null` = chưa tính được. */
export type MeasuredPerPerson = {
  profitPersonal: number | null;
  revenuePersonal: number | null;
  ordersPersonal: number | null;
};

export type EngineInputs = {
  /** Lợi nhuận toàn shop của kỳ (cùng con số với báo cáo lợi nhuận). */
  profitShop: number;
  /** Số đo cá nhân theo khoá nhân sự. */
  perPerson: Map<string, MeasuredPerPerson>;
};

/**
 * ═══ CHIA MỘT SỐ ĐO CỦA CẢ KỲ XUỐNG CÁC ĐOẠN ═══
 *
 * Doanh thu, lợi nhuận, số đơn và mọi đại lượng nhập tay đều được đo cho CẢ KỲ, không đo theo đoạn.
 * Khi kỳ chỉ có MỘT đoạn làm việc — trường hợp áp đảo — không có phép chia nào cả: đoạn ấy nhận
 * trọn con số.
 *
 * Kỳ có NHIỀU đoạn (đổi chính sách giữa tháng, vào làm giữa tháng rồi đổi phòng) thì phải chia, và
 * căn cứ duy nhất sẵn có là SỐ NGÀY. Đó là một phép ƯỚC TÍNH, nên nó KHÔNG được đi im lặng: mỗi
 * thành phần dùng số đã chia sẽ mang một dòng trong vết giải thích nói rõ nó là ước tính theo ngày
 * (xem `noteChiaTheoNgay`). AGENTS.md mục 8.6 — dữ liệu suy đoán phải mang nhãn.
 *
 * Chia theo PHẦN DƯ LỚN NHẤT để tổng các phần bằng đúng số gốc: nhân phân số rồi làm tròn từng
 * đoạn có thể hụt hoặc dư một đồng, và một đồng hụt ở đây là một đồng lệch giữa bảng lương và báo
 * cáo lợi nhuận.
 */
function splitByDays(total: number, days: number[]): number[] {
  const sum = days.reduce((t, d) => t + d, 0);
  if (sum <= 0) return days.map(() => 0);
  const raw = days.map((d) => (total * d) / sum);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = Math.round(total - floors.reduce((t, v) => t + v, 0));
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

/** Đại lượng nào của người này được chia cho đoạn nào. */
function basisForSegments(
  segments: PayrollSegment[],
  measured: MeasuredPerPerson,
  profitShop: number,
  manual: Map<string, number>,
): Record<string, number | null>[] {
  const working = segments.map(isWorkingSegment);
  const days = segments.map((s, i) => (working[i] ? s.days : 0));
  const chia = (v: number | null): (number | null)[] => {
    if (v === null) return segments.map(() => null);
    const parts = splitByDays(v, days);
    return segments.map((_, i) => (working[i] ? parts[i] : null));
  };
  const profit = chia(measured.profitPersonal);
  const revenue = chia(measured.revenuePersonal);
  const orders = chia(measured.ordersPersonal);
  const shop = chia(profitShop);
  const manualSplit = new Map<string, (number | null)[]>();
  for (const [k, v] of manual) manualSplit.set(k, chia(v));
  return segments.map((s, i) => {
    const row: Record<string, number | null> = {
      PROFIT_PERSONAL: profit[i],
      PROFIT_SHOP: shop[i],
      REVENUE_PERSONAL: revenue[i],
      ORDERS_PERSONAL: orders[i],
      PERIOD_DAYS: working[i] ? s.days : null,
    };
    for (const [k, parts] of manualSplit) row[k] = parts[i];
    return row;
  });
}

export type EmployeeEngineResult = {
  employeeId: string;
  result: PayrollItemResult;
  /** Kỳ có nhiều hơn một đoạn làm việc ⇒ số đo của kỳ đã bị CHIA THEO NGÀY (ước tính). */
  splitAcrossSegments: boolean;
  /** Đoạn nào áp chính sách nào — màn hình in ra để người đọc thấy đường phân chia. */
  segments: PayrollSegment[];
};

/**
 * TÍNH LƯƠNG BẰNG MÁY CHUNG CHO MỌI NGƯỜI ĐÃ ĐƯỢC GÁN CHÍNH SÁCH.
 *
 * Người CHƯA gán chính sách không xuất hiện trong kết quả — họ vẫn đi đường tính cũ ở
 * `getPayrollReport`. Đây là điều làm bản này không đổi một con số nào của ai vào ngày phát hành:
 * chuyển một người sang máy mới là một lần chủ shop bấm, có mốc hiệu lực, có dấu vết.
 */
export async function computeEngineLines(
  period: Period,
  inputs: EngineInputs,
  employeeIds: readonly string[],
): Promise<Map<string, EmployeeEngineResult>> {
  const out = new Map<string, EmployeeEngineResult>();
  const key = payrollPeriodKey(period.from, period.to);
  if (!period.from || !period.to || !key || !employeeIds.length) return out;

  const [book, manualInputs, adjustments] = await Promise.all([
    loadAssignmentBook(),
    loadManualInputs(key),
    loadAdjustments(key),
  ]);

  const coChinhSach = new Set(book.policyAssignments.map((a) => a.employeeId));
  const canTinh = employeeIds.filter((id) => coChinhSach.has(id));
  if (!canTinh.length) return out;

  /*
    SỐ DƯ LỖ ĐẦU KỲ ĐỌC THEO TỪNG THÀNH PHẦN.

    Một lượt đọc cho cả shop thay vì mỗi người một lượt. Chỉ đọc khi thật sự có thành phần bật bù
    lỗ — phần lớn chính sách (kho, sản xuất, CSKH) không có khoản nào bù lỗ, và đi hỏi CSDL cho
    một câu không ai hỏi là chi phí không đổi lấy gì.
  */
  const thangTruoc = monthKeyOf(period.from);
  const carryCodes = new Set<string>();
  for (const list of book.componentsByVersion.values()) for (const c of list) if (c.carryForward) carryCodes.add(c.code);
  const carryOpenings = carryCodes.size ? await readCarryOpenings(canTinh, thangTruoc, [...carryCodes]) : new Map<string, Map<string, number | null>>();

  for (const employeeId of canTinh) {
    const segments = resolveSegments({
      from: period.from,
      to: period.to,
      employments: book.employments.filter((e) => e.employeeId === employeeId),
      policyAssignments: book.policyAssignments.filter((a) => a.employeeId === employeeId),
      policyVersions: book.policyVersions,
    });
    if (!segments.length) continue;
    const measured = inputs.perPerson.get(employeeId) ?? { profitPersonal: null, revenuePersonal: null, ordersPersonal: null };
    const manual = manualInputs.values.get(employeeId) ?? new Map<string, number>();
    const basisRows = basisForSegments(segments, measured, inputs.profitShop, manual);
    const segmentInputs: SegmentInput[] = segments.map((segment, i) => ({
      segment,
      components: (segment.policyVersionId ? book.componentsByVersion.get(segment.policyVersionId) : undefined) ?? ([] as PolicyComponent[]),
      basis: basisRows[i],
    }));
    const adjRows = adjustments.byEmployee.get(employeeId) ?? [];
    const adj: AdjustmentInput[] = adjRows.map((r) => ({
      id: r.id,
      kind: r.kind as AdjustmentInput["kind"],
      label: r.label,
      amount: r.amount,
      reason: r.reason,
    }));
    const carryOpening: Record<string, number | null> = {};
    for (const code of carryCodes) carryOpening[code] = carryOpenings.get(employeeId)?.get(code) ?? null;

    const result = calculatePayrollItem({
      employeeId,
      employeeName: employeeId,
      segments: segmentInputs,
      adjustments: adj,
      carryOpening,
    });
    out.set(employeeId, {
      employeeId,
      result,
      splitAcrossSegments: segments.filter(isWorkingSegment).length > 1,
      segments,
    });
  }
  return out;
}

/**
 * SỐ DƯ LỖ ĐẦU KỲ CỦA TỪNG (người, thành phần).
 *
 * Đọc dòng của CHÍNH tháng đang hỏi trước (nó đã ghi số dư đầu và nguồn của số dư ấy), rồi mới tới
 * tháng trước — cùng thứ tự với `lib/queries/payroll-carryover.ts`, và vì cùng lý do: làm ngược lại
 * thì một tháng đã chốt bị tính lại số dư đầu theo dữ liệu hôm nay.
 *
 * `null` = CHƯA XÁC LẬP. Máy tính sẽ trả CHƯA BIẾT cho thành phần ấy chứ không coi là 0 — "chưa
 * biết còn lỗ bao nhiêu" khác hẳn "đã xác minh là hết lỗ".
 */
async function readCarryOpenings(
  employeeIds: readonly string[],
  monthKey: string,
  componentCodes: readonly string[],
): Promise<Map<string, Map<string, number | null>>> {
  const db = await getDb();
  const t = schema.marketerProfitCarryover;
  const rows = await db
    .select()
    .from(t)
    .where(and(inArray(t.employeeId, [...employeeIds]), inArray(t.componentCode, [...componentCodes, LEGACY_CARRY_COMPONENT])));
  const out = new Map<string, Map<string, number | null>>();
  const prev = prevMonth(monthKey);
  for (const id of employeeIds) {
    const m = new Map<string, number | null>();
    for (const code of componentCodes) {
      const here = rows.find((r) => r.employeeId === id && r.componentCode === code && r.monthKey === monthKey);
      if (here) {
        m.set(code, here.openingBalance);
        continue;
      }
      const before = rows.find((r) => r.employeeId === id && r.componentCode === code && r.monthKey === prev);
      // Tháng trước MỚI LÀ NHÁP thì số dư là mô phỏng — xem được, nhưng không đủ căn cứ; và ở đây
      // "không đủ căn cứ" phải là CHƯA BIẾT, vì chốt lương trên một số dư mô phỏng là trả tiền theo
      // một con số sẽ đổi.
      m.set(code, before && before.status === "FINAL" ? before.closingBalance : null);
    }
    out.set(id, m);
  }
  return out;
}

function prevMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Kỳ này đã có ai được tính bằng máy chung chưa — màn hình dùng để quyết định hiện cột nào. */
export async function anyEmployeeOnEngine(): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: schema.employeePolicyAssignments.id }).from(schema.employeePolicyAssignments).limit(1);
  return Boolean(row);
}

/** Kỳ đã chốt chưa (bất kỳ cơ sở nào) — để màn hình khoá ô nhập. */
export async function periodFinalized(periodKey: string): Promise<boolean> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db.select({ id: p.id }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.status, "FINAL"))).limit(1);
  return Boolean(row);
}
