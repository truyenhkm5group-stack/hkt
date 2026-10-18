/**
 * ═══════════ SỔ LŨY KẾ CỦA CỔNG LỢI NHUẬN TOÀN CÔNG TY — LỚP ĐỌC ═══════════
 *
 * Đặc tả: `docs/payroll-profit-gate.md`. Phép tính: `lib/payroll/profit-gate.ts` (hàm thuần).
 *
 * Tệp này chỉ trả lời MỘT câu: "số dư lũy kế đầu tháng M là bao nhiêu, và đã đủ căn cứ để trả tiền
 * chưa". Nó KHÔNG import `getPayrollReport` — bảng lương truyền vào một hàm mô phỏng — để không có
 * vòng module (`payroll.ts` → tệp này → `payroll.ts`).
 *
 * ─── BA NGUỒN SỐ DƯ, THEO THỨ TỰ ───
 *
 *  1. Khai báo mở sổ của quy chế (`settings: payroll.profit-gate`) — có người duyệt, có lý do.
 *  2. Các tháng ĐÃ KHOÁ từ mốc mở sổ tới tháng trước: đọc ẢNH CHỤP, không tính lại.
 *  3. Tháng chưa khoá ở giữa: MÔ PHỎNG bằng bản tính sống — xem được, KHÔNG đủ để chốt.
 *
 * Tháng đã khoá KHÔNG được đo lại: chứng từ đến muộn của nó đi vào lũy kế bằng điều chỉnh tường minh
 * (`ProfitGateConfig.adjustments`), xem `lib/constants/payroll-profit-gate.ts`.
 *
 * ─── PHẠM VI PHÁP NHÂN ───
 *
 * Mọi lượt đọc đi qua `getDb()`, tức CSDL của ĐÚNG tổ chức đang xem (mô hình SILO). Không có đường
 * nào cộng P&L của một tổ chức khách SaaS vào lũy kế của VNXcommerce, và tệp này không được thêm
 * đường ấy: lỗ/lãi của khách là của pháp nhân khác (`tests/payroll-profit-gate.test.ts` quét mã nguồn).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { compareMonthKey, prevMonthKey } from "@/lib/constants/payroll-carryover";
import {
  DEFAULT_PROFIT_GATE_CONFIG,
  isProfitLinked,
  isRegularVariable,
  PAYROLL_PROFIT_GATE_KEY,
  PROFIT_GATE_MAX_SIMULATED_MONTHS,
  type ProfitGateConfig,
  type ProfitGatePolicy,
} from "@/lib/constants/payroll-profit-gate";
import { lockedMonthStep, nextOpening, type LateAdjustment, type ProfitGateOpening, type ProfitGateResult } from "@/lib/payroll/profit-gate";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { getSettingJson } from "@/lib/settings";
import { monthPeriod } from "@/lib/constants/payroll-autopilot";

export async function getProfitGateConfig(): Promise<ProfitGateConfig> {
  const raw = await getSettingJson<ProfitGateConfig>(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
  return { active: raw.active ?? null, history: Array.isArray(raw.history) ? raw.history : [], adjustments: Array.isArray(raw.adjustments) ? raw.adjustments : [] };
}

/** `2026-09` ⇒ khoá kỳ lương của trọn tháng ấy (`2026-09-01..2026-09-30`). */
export function monthPeriodKey(monthKey: string): string {
  return monthPeriod(monthKey).periodKey;
}

/** Các tháng từ `from` tới `to` (cả hai đầu), theo lịch. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  if (compareMonthKey(from, to) > 0) return out;
  let cur = to;
  while (compareMonthKey(cur, from) >= 0) {
    out.unshift(cur);
    cur = prevMonthKey(cur);
  }
  return out;
}

/**
 * HAI CON SỐ CỦA MỘT THÁNG ĐÃ KHOÁ: lợi nhuận đem xét cổng, và thưởng lợi nhuận đã chốt.
 *
 * Ảnh chụp có khối `profitGate` ⇒ đọc thẳng. Ảnh chụp ĐỜI CŨ (khoá trước khi có cổng) ⇒ dựng từ
 * CHÍNH những con số đã chụp: lợi nhuận tính lương − hoa hồng thông thường, và thưởng lợi nhuận là
 * đúng các khoản % lợi nhuận đã chốt để trả. Không tính lại bằng dữ liệu hôm nay.
 */
export function lockedMonthFigures(
  snap: PayrollSnapshot,
): { base: number; ownBase: number; allocated: number; booked: LateAdjustment[]; source: "GATE" | "DERIVED" } | null {
  const g = snap.profitGate;
  if (g && g.periodBase !== null && g.allocatedTotal !== null) {
    const booked = Array.isArray(g.lateAdjustments) ? g.lateAdjustments : [];
    return {
      base: g.periodBase + booked.reduce((t, a) => t + (Number(a.amount) || 0), 0),
      ownBase: g.periodBase,
      allocated: g.allocatedTotal,
      booked,
      source: "GATE",
    };
  }
  if (snap.basis !== "profit1") return null;
  let regular = 0;
  let allocated = 0;
  for (const l of snap.lines) {
    if (l.engine) {
      for (const c of l.engine.components) {
        if (c.amount === null) return null;
        if (isProfitLinked(c.kind, c.basisKey)) allocated += c.amount;
        else if (isRegularVariable(c.kind, c.basisKey)) regular += c.amount;
      }
    } else {
      if (l.bonusPersonal === null) return null;
      allocated += l.bonusTotal + l.bonusPersonal;
      regular += l.bonusRevenue;
    }
  }
  const ownBase = g?.periodBase ?? snap.totalProfit - regular;
  // Ảnh chụp có cổng nhưng chưa kết luận (không ai có thưởng % LN): điều chỉnh đã chụp vẫn phải vào sổ.
  const booked = g?.lateAdjustments ?? [];
  return { base: ownBase + booked.reduce((t, a) => t + (Number(a.amount) || 0), 0), ownBase, allocated, booked, source: "DERIVED" };
}

/** Đọc ảnh chụp các tháng ĐÃ KHOÁ trong danh sách (cơ sở "Lợi nhuận tính lương"). */
async function lockedSnapshots(monthKeys: readonly string[]): Promise<Map<string, PayrollSnapshot>> {
  const out = new Map<string, PayrollSnapshot>();
  if (!monthKeys.length) return out;
  const db = await getDb();
  const p = schema.payrollPeriods;
  const keyToMonth = new Map(monthKeys.map((m) => [monthPeriodKey(m), m] as const));
  const rows = await db
    .select({ periodKey: p.periodKey, status: p.status, snapshot: p.snapshot })
    .from(p)
    .where(and(eq(p.basis, "profit1"), inArray(p.periodKey, [...keyToMonth.keys()]), inArray(p.status, ["LOCKED", "PAID", "FINAL"])));
  for (const r of rows) {
    const m = keyToMonth.get(r.periodKey);
    if (m && r.snapshot) out.set(m, r.snapshot as PayrollSnapshot);
  }
  return out;
}

/**
 * Mô phỏng MỘT tháng chưa khoá trên số dư đầu đã cho. Bảng lương truyền hàm này vào — nó chạy
 * đúng phép tính của màn hình cho tháng ấy, với cổng ở chế độ "đã cho số dư".
 */
export type SimulateMonth = (monthKey: string, opening: ProfitGateOpening) => Promise<ProfitGateResult>;

export type GateOpeningResolution = {
  policy: ProfitGatePolicy | null;
  opening: ProfitGateOpening | null;
  problem: string | null;
  /** Những tháng đã dùng số MÔ PHỎNG — để màn hình nói thẳng tháng nào cần khoá. */
  simulatedMonths: string[];
};

export async function resolveGateOpening(monthKey: string, deps: { simulate: SimulateMonth }): Promise<GateOpeningResolution> {
  const config = await getProfitGateConfig();
  const policy = config.active;
  const none = (problem: string): GateOpeningResolution => ({ policy, opening: null, problem, simulatedMonths: [] });
  if (!policy) return none("Chưa khai quy chế chia thưởng lợi nhuận.");
  if (compareMonthKey(monthKey, policy.openingMonth) < 0) {
    return none(
      `Tháng ${monthKey} nằm TRƯỚC mốc mở sổ lũy kế (${policy.openingMonth}) của quy chế v${policy.version}, nên không có số dư lũy kế đã duyệt cho tháng này. Thưởng % lợi nhuận của tháng này chưa đủ điều kiện duyệt; muốn xét thì khai lại quy chế với mốc mở sổ sớm hơn kèm số dư đã đối soát.`,
    );
  }
  let opening: ProfitGateOpening = {
    cumulative: policy.openingCumulative,
    highWater: policy.openingHighWater,
    paidToDate: policy.openingPaidBonus,
    established: true,
    basis: "DECLARATION",
    reason: `Số dư mở sổ khai theo quy chế v${policy.version} (${policy.regulationRef}), duyệt bởi ${policy.approvedByEmail}.`,
  };
  const before = monthsBetween(policy.openingMonth, prevMonthKey(monthKey));
  const locked = await lockedSnapshots(before);
  const simulatedMonths: string[] = [];
  for (const m of before) {
    const snap = locked.get(m);
    const fig = snap ? lockedMonthFigures(snap) : null;
    if (fig) {
      opening = lockedMonthStep(opening, fig.base, fig.allocated);
      continue;
    }
    if (snap) {
      return { ...none(`Tháng ${m} đã khoá nhưng ảnh chụp không đủ số để dựng lũy kế (một khoản thưởng CHƯA BIẾT hoặc cơ sở khác). Cần người đối soát và khai lại số dư mở sổ.`), simulatedMonths };
    }
    if (simulatedMonths.length >= PROFIT_GATE_MAX_SIMULATED_MONTHS) {
      return { ...none(`Quá ${PROFIT_GATE_MAX_SIMULATED_MONTHS} tháng chưa khoá kể từ mốc mở sổ — khoá các tháng cũ hoặc khai lại mốc mở sổ.`), simulatedMonths };
    }
    simulatedMonths.push(m);
    const r = await deps.simulate(m, opening);
    const next = nextOpening(opening, r, false, `MÔ PHỎNG: tháng ${simulatedMonths.join(", ")} chưa khoá — số dư sẽ đổi khi các tháng ấy được chốt.`);
    if (!next) return { ...none(`Tháng ${m} chưa khoá và không mô phỏng được: ${r.message}`), simulatedMonths };
    opening = next;
  }

  return { policy, opening, problem: null, simulatedMonths };
}
