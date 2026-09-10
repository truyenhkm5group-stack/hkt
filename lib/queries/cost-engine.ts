/**
 * ═══════════ MỘT ĐƯỜNG DUY NHẤT ĐỂ HỎI "KỲ NÀY CHI PHÍ LÀ BAO NHIÊU" ═══════════
 *
 * Trước đây mỗi báo cáo tự đi hỏi từng nguồn rồi cộng theo cách riêng. Sáu trang, sáu phép cộng, và
 * không trang nào biết trang kia loại/không loại cái gì — đó là cách hai khoản (cước, phí hoàn) bị
 * trừ hai lần suốt một thời gian dài mà không ai thấy.
 *
 * Engine này quyết định MỘT lần: khoản nào thuộc thành phần nào, nguồn nào có thẩm quyền, nguồn
 * chính đã phủ đủ chưa, và nếu chưa thì lùi về đâu. Mọi báo cáo đọc lại kết quả đó.
 *
 * ─── PHẠM VI, NÓI THẲNG ───
 *
 * Engine là nguồn DUY NHẤT cho **khối chi phí vận hành theo kỳ** (lương, hoa hồng, mặt bằng, phần
 * mềm, vận hành khác) — đúng chỗ mà việc trừ hai lần xảy ra.
 *
 * Các thành phần còn lại (giá vốn, quảng cáo, cước, phí hoàn, dự phòng rủi ro) được engine đọc từ
 * **chứng từ thật** để mọi trang cùng nhìn một con số. Nhưng Báo cáo lợi nhuận danh nghĩa vẫn ƯỚC
 * TÍNH giá vốn và cước theo tỷ lệ giao thành công dự kiến — hai con số đó khác nhau vì **ước tính
 * khác thực tế**, KHÔNG phải vì trừ hai lần. Hợp nhất hẳn hai cơ sở đó là việc riêng, chưa làm, và
 * ở đây ghi rõ ra thay vì để người đọc tưởng đã xong.
 */
import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import {
  COST_AUTHORITY_REGISTRY,
  COST_COMPONENTS,
  type CostComponent,
  type CoverageState,
} from "@/lib/constants/cost-authority";
import { COST_SOURCE_LABEL } from "@/lib/constants/cost-sources";
import { allocatedExpenseSum, expenseInRange, logisticsDuplicateCond } from "@/lib/queries/cost-allocation";
import { orderCogsFast } from "@/lib/queries/cogs";
import { getRecognizedPayrollCost, type PayrollRecognition } from "@/lib/queries/payroll-cost";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const e = schema.expenses;
const o = schema.orders;
const s = schema.shipments;

export type RecognizedComponent = {
  component: CostComponent;
  label: string;
  amount: number;
  /** Nguồn THỰC SỰ đã cung cấp con số này (có thể là nguồn dự phòng) */
  sourceUsed: string;
  recognitionMethod: string;
  coverage: CoverageState;
  /** Đang dùng nguồn dự phòng thay cho nguồn có thẩm quyền */
  usedFallback: boolean;
  note: string;
};

export type CostEngineWarning = {
  rule: "PAYROLL_COST_COVERAGE_INCOMPLETE" | "DUPLICATE_PAYROLL_EXPENSE_SOURCE" | "COMMISSION_BASIS_NEEDS_REVIEW" | "DUPLICATE_LOGISTICS_COST_SOURCE";
  severity: "high" | "medium";
  title: string;
  detail: string;
  action: string;
  amount: number;
  count: number;
};

export type RecognizedCosts = {
  period: Period;
  components: Record<CostComponent, RecognizedComponent>;
  /** Tổng khối chi phí vận hành theo kỳ — con số mà mọi báo cáo phải dùng chung */
  operatingTotal: number;
  /** Số khoản chi có chứng từ đã được tính vào khối vận hành */
  operatingCount: number;
  /** Tổng mọi thành phần engine ghi nhận (gồm cả giá vốn / quảng cáo / cước theo chứng từ) */
  total: number;
  warnings: CostEngineWarning[];
  payroll: PayrollRecognition;
};

/** Khối "chi phí vận hành theo kỳ" — phần engine là nguồn DUY NHẤT */
export const OPERATING_COMPONENTS: CostComponent[] = ["SALARY", "COMMISSION", "RENT", "SOFTWARE", "UTILITIES", "OTHER_OPERATING"];

function periodConds(column: AnyPgColumn | SQL, from: Date | null, to: Date | null): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(sql`${column} >= ${from}`);
  if (to) conds.push(sql`${column} <= ${to}`);
  return conds;
}

export async function getRecognizedCosts(period: Period): Promise<RecognizedCosts> {
  return memo(`cost-engine:${periodKey(period)}`, 90_000, () => build(period));
}

async function build(period: Period): Promise<RecognizedCosts> {
  const db = await getDb();
  const payroll = await getRecognizedPayrollCost(period);
  const payrollCovered = payroll.coverage === "COMPLETE";
  const inRange = expenseInRange(period.from, period.to);

  const categorySum = async (categories: readonly string[], extra?: SQL) => {
    if (!categories.length) return { amount: 0, n: 0 };
    const conds: SQL[] = [sql`${e.category} in ${categories}`, inRange];
    if (extra) conds.push(extra);
    const [row] = await db
      .select({ amount: allocatedExpenseSum(period.from, period.to), n: count() })
      .from(e)
      .where(and(...conds));
    return { amount: Number(row?.amount ?? 0), n: Number(row?.n ?? 0) };
  };

  const [rent, software, otherOperating, salaryLegacy, logisticsAdjust, logisticsDup, adSpend, [cogsRow, shipRow]] = await Promise.all([
    categorySum(["RENT"]),
    categorySum(["SOFTWARE"]),
    categorySum(["PACKAGING", "OTHER"]),
    categorySum(["SALARY"]),
    categorySum(["SHIPPING", "RETURN_FEE"], sql`${e.costSource} = 'MANUAL_ADJUSTMENT'`),
    // Khoản cước gõ tay KHÔNG khai là điều chỉnh ⇒ trùng với cước theo vận đơn, bị loại.
    db.select({ amount: allocatedExpenseSum(period.from, period.to), n: count() }).from(e).where(and(logisticsDuplicateCond(), inRange)),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), ...periodConds(schema.adSpends.spendDate, period.from, period.to))),
    // JIT tat: hai cau nay la cau cham nhat con lai cua probe — 10.525ms va 10.305ms. Chung mang
    // nhanh du phong tinh truc tiep cua ORDER_OUTCOME nen chi phi uoc luong rat cao va JIT bat.
    /*
      MỘT GIAO DỊCH CHO CẢ HAI CÂU, KHÔNG PHẢI HAI.

      Mỗi giao dịch giữ MỘT kết nối của bể (chỉ có 5). Mở hai giao dịch song song ngay trong cùng
      một `Promise.all` là tự lấy mất 2/5 bể cho một hàm — mà hàm này được gọi từ Bảng điều khiển,
      Sổ ngân hàng, Báo cáo lợi nhuận cùng lúc. Hai câu này chạy tuần tự bên trong một giao dịch:
      chậm hơn không đáng kể (cùng nhau chưa tới 1 giây sau khi tắt JIT), mà chỉ tốn một kết nối.

      Chúng là hai câu chậm nhất còn lại của probe — 10.525ms và 10.305ms trước khi tắt JIT.
    */
    chayKhongJit(db, async (tx) => {
      const [cogs] = await tx
        .select({ amount: sql<number>`coalesce(sum(${orderCogsFast()}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED'), 0)` })
        .from(o)
        .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
        .where(and(...periodConds(o.insertedAt, period.from, period.to)));
      const [ship] = await tx
        .select({
          shipping: sql<number>`coalesce(sum(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)) filter (where ${ORDER_OUTCOME_FAST} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')), 0)`,
          returnFee: sql<number>`coalesce(sum(${o.returnFee}) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
        })
        .from(o)
        .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
        .where(and(...periodConds(o.insertedAt, period.from, period.to)));
      return [cogs, ship] as const;
    }),
  ]);

  const warnings: CostEngineWarning[] = [];

  // ── LƯƠNG: bảng Lương chỉ cầm quyền khi đã phủ đủ; chưa đủ thì lùi về bảng Chi phí, KHÔNG im lặng ──
  const salaryAmount = payrollCovered ? payroll.fixedSalary : salaryLegacy.amount;
  if (!payrollCovered && salaryLegacy.amount > 0) {
    warnings.push({
      rule: "PAYROLL_COST_COVERAGE_INCOMPLETE",
      severity: "medium",
      title: "Chi phí lương đang lấy từ bảng Chi phí, không phải bảng Lương",
      detail: `Bảng Lương chưa đủ điều kiện cầm quyền nên lợi nhuận vẫn dùng ${salaryLegacy.n} khoản chi nhóm “Lương”. Lý do: ${payroll.reasons.join(" ")}`,
      action: "Giữ nguyên là an toàn. Muốn chuyển sang bảng Lương thì khai đủ nhân sự + lương cứng, bật chế độ ghi nhận, và ngừng ghi lương ở bảng Chi phí.",
      amount: salaryLegacy.amount,
      count: salaryLegacy.n,
    });
  }
  if (payrollCovered && salaryLegacy.amount > 0) {
    warnings.push({
      rule: "DUPLICATE_PAYROLL_EXPENSE_SOURCE",
      severity: "high",
      title: `Bảng Lương đang cầm quyền — ${salaryLegacy.n} khoản “Lương” ở bảng Chi phí bị BỎ QUA`,
      detail: `Để không trừ hai lần, lợi nhuận chỉ nhận lương từ bảng Lương (${salaryAmount.toLocaleString("vi-VN")} ₫). ${salaryLegacy.amount.toLocaleString("vi-VN")} ₫ đã ghi ở bảng Chi phí KHÔNG được tính — kể cả phần hoa hồng nằm lẫn trong đó.`,
      action: "Xoá / chuyển các khoản lương trùng ở bảng Chi phí, hoặc tắt chế độ ghi nhận từ bảng Lương nếu chưa sẵn sàng.",
      amount: salaryLegacy.amount,
      count: salaryLegacy.n,
    });
  }
  // Hoa hồng: xem `lib/queries/payroll-cost.ts` — không thể vừa là đầu vào vừa là đầu ra của lợi nhuận.
  warnings.push({
    rule: "COMMISSION_BASIS_NEEDS_REVIEW",
    severity: "medium",
    title: "Chưa chốt cơ sở ghi nhận hoa hồng",
    detail:
      "Cả bốn cơ sở tính hoa hồng hiện có đều là % của LỢI NHUẬN, nên hoa hồng không thể đồng thời là chi phí nằm trong lợi nhuận. ERP không đoán: hoa hồng vẫn đi đường cũ (khoản chi nhóm “Lương”).",
    action: "Chốt một cơ sở KHÔNG dẫn xuất từ lợi nhuận (vd % doanh thu thuần), hoặc coi hoa hồng là phân phối lợi nhuận sau khi đã có lợi nhuận.",
    amount: 0,
    count: 0,
  });

  // ── CƯỚC / PHÍ HOÀN: khoản gõ tay không khai là điều chỉnh ⇒ trùng nguồn ──
  const dupLogistics = { amount: Number(logisticsDup[0]?.amount ?? 0), n: Number(logisticsDup[0]?.n ?? 0) };
  if (dupLogistics.amount > 0) {
    warnings.push({
      rule: "DUPLICATE_LOGISTICS_COST_SOURCE",
      severity: "high",
      title: `${dupLogistics.n} khoản cước / phí hoàn gõ tay bị loại vì trùng với vận đơn`,
      detail: `Cước từng đơn đã được tính theo vận đơn / bảng kê ĐVVC. ${dupLogistics.amount.toLocaleString("vi-VN")} ₫ gõ tay không được cộng thêm, nếu không cùng một đồng bị trừ hai lần.`,
      action: "Nếu đây là khoản NGOẠI LỆ (đền bù, phí phát sinh, cước chuyến gom hàng không thuộc vận đơn nào) thì mở khoản chi, đổi nguồn thành “Điều chỉnh thủ công” và ghi rõ lý do — khi đó nó sẽ được tính.",
      amount: dupLogistics.amount,
      count: dupLogistics.n,
    });
  }

  const mk = (component: CostComponent, amount: number, over: Partial<RecognizedComponent> = {}): RecognizedComponent => {
    const spec = COST_AUTHORITY_REGISTRY[component];
    return {
      component,
      label: spec.label,
      amount,
      sourceUsed: COST_SOURCE_LABEL[spec.source],
      recognitionMethod: spec.recognitionMethod,
      coverage: "NOT_APPLICABLE",
      usedFallback: false,
      note: spec.note,
      ...over,
    };
  };

  const components: Record<CostComponent, RecognizedComponent> = {
    COGS: mk("COGS", Number(cogsRow?.amount ?? 0), { note: "Giá vốn đơn GIAO THÀNH CÔNG theo chứng từ. Báo cáo danh nghĩa dùng bản ƯỚC TÍNH theo tỷ lệ giao thành công — khác cơ sở, không phải trừ hai lần." }),
    ADS: mk("ADS", Number(adSpend[0]?.amount ?? 0)),
    SHIPPING: mk("SHIPPING", Number(shipRow?.shipping ?? 0) + logisticsAdjust.amount, {
      note: `Cước theo vận đơn${logisticsAdjust.amount ? ` + ${logisticsAdjust.amount.toLocaleString("vi-VN")} ₫ điều chỉnh có lý do` : ""}. Khoản gõ tay không khai điều chỉnh bị loại.`,
    }),
    RETURN_COST: mk("RETURN_COST", Number(shipRow?.returnFee ?? 0)),
    SALARY: mk("SALARY", salaryAmount, {
      coverage: payroll.coverage,
      usedFallback: !payrollCovered,
      sourceUsed: payrollCovered ? COST_SOURCE_LABEL.PAYROLL : COST_SOURCE_LABEL.EXPENSES,
      recognitionMethod: payrollCovered ? "PERIOD_PRORATA" : "EVENT_DATE",
      note: payrollCovered ? "Lương cứng chia theo số ngày thật của từng tháng." : "Đang dùng nguồn dự phòng: khoản chi nhóm “Lương” ở bảng Chi phí (gồm cả hoa hồng).",
    }),
    // Hoa hồng nằm LẪN trong nhóm "Lương" ở bảng Chi phí, đã tính ở thành phần SALARY.
    // Để 0 ở đây thay vì cộng lại — cộng lại chính là trừ hai lần.
    COMMISSION: mk("COMMISSION", 0, {
      coverage: "NOT_APPLICABLE",
      usedFallback: true,
      sourceUsed: COST_SOURCE_LABEL.EXPENSES,
      note: "Chưa tách khỏi nhóm “Lương”. Đã nằm trong thành phần Lương cố định, không cộng thêm ở đây.",
    }),
    RENT: mk("RENT", rent.amount),
    SOFTWARE: mk("SOFTWARE", software.amount),
    UTILITIES: mk("UTILITIES", 0),
    INVENTORY_RISK: mk("INVENTORY_RISK", 0, { note: "Tính theo giá vốn hàng bán của từng mã ở Báo cáo lợi nhuận; engine không nhân lại ở mức kỳ để tránh hai con số." }),
    OTHER_OPERATING: mk("OTHER_OPERATING", otherOperating.amount),
  };

  const operatingTotal = OPERATING_COMPONENTS.reduce((t, c) => t + components[c].amount, 0);
  const operatingCount = rent.n + software.n + otherOperating.n + (payrollCovered ? payroll.activeEmployees : salaryLegacy.n);
  const total = COST_COMPONENTS.reduce((t, c) => t + components[c].amount, 0);

  return { period, components, operatingTotal, operatingCount, total, warnings, payroll };
}

/**
 * Tổng khối chi phí vận hành theo kỳ — hàm mà mọi báo cáo gọi thay cho phép cộng riêng.
 * Trả kèm cờ `payrollCovered` để truy vấn theo mã hàng dùng đúng điều kiện lọc.
 */
export async function getOperatingCost(period: Period): Promise<{ amount: number; count: number; payrollCovered: boolean; warnings: CostEngineWarning[] }> {
  const costs = await getRecognizedCosts(period);
  return {
    amount: costs.operatingTotal,
    count: costs.operatingCount,
    payrollCovered: costs.payroll.coverage === "COMPLETE",
    warnings: costs.warnings,
  };
}
