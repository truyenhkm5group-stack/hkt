/**
 * ═══════ CHẤT LƯỢNG DỮ LIỆU CHI PHÍ ═══════
 *
 * Bốn cách một con số chi phí có thể sai mà nhìn vào vẫn "hợp lý" — nên phải nêu ra bằng chữ, không
 * để người đọc tự phát hiện:
 *
 *  1. `DUPLICATE_COST_SOURCE` — cùng một đồng có hai đường vào lợi nhuận.
 *  2. `COMMISSION_BASIS_NEEDS_REVIEW` — không phân biệt được lương cố định với hoa hồng theo đơn,
 *     mà hai thứ đó phân bổ theo hai cách hoàn toàn khác nhau.
 *  3. `PERIOD_COST_WITHOUT_PERIOD` — khoản bản chất theo kỳ nhưng chưa khai kỳ hiệu lực.
 *  4. `EXCLUDED_BY_AUTHORITY` — khoản đã gõ tay nhưng KHÔNG được tính vì nguồn khác có thẩm quyền.
 *
 * ERP KHÔNG tự xoá, không tự sửa, không tự đoán. Chọn nguồn nào là quyết định của chủ shop; việc
 * của ERP là chỉ đúng chỗ và nói rõ hậu quả.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { PERIOD_LIKE_CATEGORIES } from "@/lib/constants/cost-allocation";
import { EXPENSE_CATEGORY_ECONOMIC, COST_AUTHORITY, COST_SOURCE_LABEL } from "@/lib/constants/cost-sources";
import { HARD_EXCLUDED_EXPENSE_CATEGORIES } from "@/lib/constants/cost-authority";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { EXPENSE_CATEGORY_LABEL } from "@/lib/constants/expenses";
import { DEFAULT_PROFIT_ASSUMPTIONS, PROFIT_ASSUMPTIONS_KEY, type ProfitAssumptions } from "@/lib/constants/profit";
import { allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";
import type { Period } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

export const COST_QUALITY_RULES = [
  "DUPLICATE_COST_SOURCE",
  "COMMISSION_BASIS_NEEDS_REVIEW",
  "PERIOD_COST_WITHOUT_PERIOD",
  "EXCLUDED_BY_AUTHORITY",
  "PAYROLL_COST_COVERAGE_INCOMPLETE",
  "DUPLICATE_PAYROLL_EXPENSE_SOURCE",
  "DUPLICATE_LOGISTICS_COST_SOURCE",
] as const;
export type CostQualityRule = (typeof COST_QUALITY_RULES)[number];

export type CostQualityIssue = {
  rule: CostQualityRule;
  /** `high` = con số lợi nhuận đang sai ngay bây giờ; `medium` = sẽ sai khi xem kỳ ngắn */
  severity: "high" | "medium";
  title: string;
  /** Vì sao đây là vấn đề — viết cho chủ shop đọc, không viết cho lập trình viên */
  detail: string;
  /** Việc cần làm, cụ thể */
  action: string;
  amount: number;
  count: number;
};

const e = schema.expenses;

export async function costQualityIssues(period: Period): Promise<CostQualityIssue[]> {
  return memo(`cost-quality:${periodKey(period)}`, 90_000, () => build(period));
}

async function build(period: Period): Promise<CostQualityIssue[]> {
  const db = await getDb();
  const assumptions = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
  const inRange = expenseInRange(period.from, period.to);
  const issues: CostQualityIssue[] = [];

  // ── 1. Khoản đã gõ tay nhưng nguồn khác có thẩm quyền ⇒ KHÔNG được tính vào lợi nhuận ──
  const excluded = await db
    .select({ category: e.category, amount: allocatedExpenseSum(period.from, period.to), n: count() })
    .from(e)
    .where(and(inArray(e.category, HARD_EXCLUDED_EXPENSE_CATEGORIES), inRange))
    .groupBy(e.category);
  for (const row of excluded) {
    const amount = Number(row.amount ?? 0);
    if (amount <= 0) continue;
    const owner = COST_SOURCE_LABEL[COST_AUTHORITY[EXPENSE_CATEGORY_ECONOMIC[row.category]]];
    issues.push({
      rule: "EXCLUDED_BY_AUTHORITY",
      severity: "medium",
      title: `${EXPENSE_CATEGORY_LABEL[row.category]}: ${Number(row.n)} khoản gõ tay không vào lợi nhuận`,
      detail: `Nhóm này đã được đưa vào lợi nhuận từ ${owner}. Nếu cộng thêm các khoản gõ tay thì cùng một đồng bị trừ hai lần, nên ERP bỏ chúng ra khỏi phép tính.`,
      action: `Giữ để đối chiếu dòng tiền là được. Nếu ${owner} đang THIẾU khoản này thì bổ sung ở đúng nguồn đó, đừng gõ vào bảng Chi phí.`,
      amount,
      count: Number(row.n),
    });
  }

  // ── 2. Giả định chồng lấn với chứng từ thật ──
  // Cùng một loại chi phí có hai đường vào: một bên là con số giả định, một bên là khoản chi có
  // chứng từ. Không bên nào sai, nhưng cộng cả hai thì lợi nhuận thấp giả.
  const overlaps: { assumption: string; active: boolean; categories: (typeof PERIOD_LIKE_CATEGORIES)[number][] | ("PACKAGING" | "SALARY")[] ; note: string }[] = [
    {
      assumption: `Chi phí cố định ${fmt(assumptions.fixedCostMonthly)}/tháng`,
      active: Number(assumptions.fixedCostMonthly ?? 0) > 0,
      categories: [...PERIOD_LIKE_CATEGORIES],
      note: "mặt bằng, lương, phần mềm",
    },
    {
      assumption: `Đóng hàng ${fmt(assumptions.packingFeePerOrder)}/đơn`,
      active: Number(assumptions.packingFeePerOrder ?? 0) > 0,
      categories: ["PACKAGING"],
      note: "đóng gói",
    },
    {
      assumption: `Nhân viên vận đơn ${fmt(assumptions.opsStaffPerOrder)}/đơn`,
      active: Number(assumptions.opsStaffPerOrder ?? 0) > 0,
      categories: ["SALARY"],
      note: "lương",
    },
  ];
  for (const o of overlaps) {
    if (!o.active) continue;
    const [row] = await db
      .select({ amount: allocatedExpenseSum(period.from, period.to), n: count() })
      .from(e)
      .where(and(inArray(e.category, o.categories as never), inRange));
    const amount = Number(row?.amount ?? 0);
    if (amount <= 0) continue;
    issues.push({
      rule: "DUPLICATE_COST_SOURCE",
      severity: "high",
      title: `Có thể trừ hai lần: ${o.assumption}`,
      detail: `Kỳ này vừa dùng giả định “${o.assumption}”, vừa có ${fmt(amount)} khoản chi ${o.note} đã ghi ở bảng Chi phí. Hai nguồn này là CÙNG một loại chi phí, cộng cả hai làm lợi nhuận thấp hơn thực tế.`,
      action: "Chọn MỘT nguồn: đã ghi đủ chứng từ thì đặt giả định về 0; còn muốn dùng giả định thì đừng nhập lại các khoản đó ở bảng Chi phí.",
      amount,
      count: Number(row?.n ?? 0),
    });
  }

  // ── 4. Khoản bản chất theo kỳ nhưng chưa khai kỳ ──
  const [needsPeriod] = await db
    .select({ amount: allocatedExpenseSum(period.from, period.to), n: count() })
    .from(e)
    .where(and(eq(e.needsAllocationReview, true), inRange));
  if (Number(needsPeriod?.n ?? 0) > 0) {
    issues.push({
      rule: "PERIOD_COST_WITHOUT_PERIOD",
      severity: "medium",
      title: `${Number(needsPeriod?.n)} khoản theo kỳ chưa khai kỳ hiệu lực`,
      detail:
        "Mặt bằng, phần mềm, lương là chi phí của MỘT KHOẢNG THỜI GIAN. Chưa khai kỳ thì cả khoản rơi trọn vào ngày ghi sổ: xem tuần chứa ngày đó thì lợi nhuận thấp giả, xem tuần khác thì cao giả.",
      action: "Mở từng khoản, chọn “Chia theo số ngày trong kỳ” và khai từ ngày – đến ngày thật. ERP không tự đoán kỳ vì gói phần mềm có thể là tháng, quý hay năm.",
      amount: Number(needsPeriod?.amount ?? 0),
      count: Number(needsPeriod?.n ?? 0),
    });
  }

  // Cảnh báo của Profit Engine (độ phủ bảng Lương, trùng nguồn lương / cước, cơ sở hoa hồng) hiện
  // CÙNG một chỗ với các luật ở đây: chủ shop không phải đi tìm ở hai nơi để hiểu một con số.
  const engine = await getRecognizedCosts(period);
  for (const w of engine.warnings) {
    issues.push({ rule: w.rule as CostQualityRule, severity: w.severity, title: w.title, detail: w.detail, action: w.action, amount: w.amount, count: w.count });
  }
  return issues.sort((a, x) => (a.severity === x.severity ? x.amount - a.amount : a.severity === "high" ? -1 : 1));
}

function fmt(value: number | undefined | null): string {
  return `${Math.round(Number(value) || 0).toLocaleString("vi-VN")} ₫`;
}

/** Dùng cho thẻ tổng hợp: có vấn đề nghiêm trọng nào đang làm sai lợi nhuận ngay lúc này không */
export function hasHighSeverity(issues: CostQualityIssue[]): boolean {
  return issues.some((i) => i.severity === "high");
}

