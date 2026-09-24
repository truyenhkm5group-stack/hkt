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
import { and, count, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { chayKhongJit, getDb, schema, type Db } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import type { ExpenseCategory } from "@/db/schema";
import { distributeProportionally, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import {
  COST_AUTHORITY_REGISTRY,
  COST_COMPONENTS,
  COVERAGE_GATED_EXPENSE_CATEGORIES,
  HARD_EXCLUDED_EXPENSE_CATEGORIES,
  type CostComponent,
  type CoverageState,
} from "@/lib/constants/cost-authority";
import { COMPENSATION_PROFIT_LABEL } from "@/lib/constants/compensation-profit";
import { COST_SOURCE_LABEL } from "@/lib/constants/cost-sources";
import { allocatedExpenseSum, expenseInRange, logisticsDuplicateCond, spreadExpenseByDay, vnDaysOfRange } from "@/lib/queries/cost-allocation";
import { orderCogsFast } from "@/lib/queries/cogs";
import { getRecognizedPayrollCost, type PayrollRecognition } from "@/lib/queries/payroll-cost";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";
import { FINISHED_OUTCOMES_SQL, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";

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
  rule:
    | "PAYROLL_COST_COVERAGE_INCOMPLETE"
    | "PAYROLL_OBLIGATION_NOT_RECOGNIZED"
    | "DUPLICATE_PAYROLL_EXPENSE_SOURCE"
    | "COMMISSION_BASIS_NEEDS_REVIEW"
    | "DUPLICATE_LOGISTICS_COST_SOURCE";
  severity: "high" | "medium";
  title: string;
  detail: string;
  action: string;
  amount: number;
  count: number;
};

/**
 * Cước / phí hoàn gõ tay khai `MANUAL_ADJUSTMENT` (CSDL bắt buộc kèm lý do) — tiền THẬT không gắn
 * được vận đơn nào (đền bù, phí ngoại lệ, cước chuyến gom hàng). Engine đã cộng nó vào thành phần
 * Cước / Phí hoàn; con số này đi kèm để báo cáo nào tự lấy cước từ vận đơn thì cộng đúng khoản này
 * từ ĐÂY, không tự đọc bảng Chi phí lần thứ hai (AGENTS.md mục 18).
 */
export type LogisticsAdjustmentTotal = {
  /** Phần thuộc thành phần Cước (`SHIPPING`) */
  shipping: number;
  /** Phần thuộc thành phần Phí hoàn (`RETURN_COST`) */
  returnFee: number;
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
  /** Đã nằm TRONG `components.SHIPPING` / `components.RETURN_COST` — nêu riêng để báo cáo khác dùng lại. */
  logisticsAdjustment: LogisticsAdjustmentTotal;
};

/** Khối "chi phí vận hành theo kỳ" — phần engine là nguồn DUY NHẤT */
export const OPERATING_COMPONENTS: CostComponent[] = ["SALARY", "COMMISSION", "RENT", "SOFTWARE", "UTILITIES", "OTHER_OPERATING"];

/** Nhóm ở bảng Chi phí mà một thành phần đọc — DẪN XUẤT từ sổ thẩm quyền, không gõ lại ở đây. */
function expenseCategoriesOf(component: CostComponent): ExpenseCategory[] {
  return COST_AUTHORITY_REGISTRY[component].expenseCategories;
}

/**
 * Mọi nhóm ở bảng Chi phí có thể góp vào khối vận hành. Nhóm Lương nằm ở đây kể cả khi bảng Lương
 * đang cầm quyền: phần vượt lương cứng vẫn vào thành phần Hoa hồng (xem `splitPayrollComponents`).
 */
const OPERATING_EXPENSE_CATEGORIES: ExpenseCategory[] = [...new Set(OPERATING_COMPONENTS.flatMap(expenseCategoriesOf))];

/**
 * ═══ LƯƠNG CỐ ĐỊNH VÀ HOA HỒNG: MỘT CÔNG THỨC, HAI NƠI DÙNG ═══
 *
 * Tổng của kỳ (`build`) và bản rải theo ngày (`getOperatingCostByDay`) phải cắt nhóm "Lương" ở
 * bảng Chi phí theo CÙNG một cách, nếu không cộng các ngày sẽ không ra tổng kỳ. Chép phép cắt sang
 * nơi thứ hai là mở đường cho hai bản trôi xa nhau — nên nó là một hàm.
 *
 *  · Bảng Lương CHƯA cầm quyền ⇒ cả nhóm "Lương" là lương (gồm cả hoa hồng nằm lẫn), hoa hồng 0.
 *  · ĐÃ cầm quyền ⇒ lương cứng lấy từ bảng Lương; phần nhóm cũ VƯỢT lương cứng là tiền thật đã chi,
 *    nó vào thành phần Hoa hồng thay vì bị vứt đi.
 */
export function splitPayrollComponents(payrollCovered: boolean, fixedSalary: number, legacySalaryExpenses: number): { salary: number; commission: number } {
  return payrollCovered
    ? { salary: fixedSalary, commission: Math.max(0, legacySalaryExpenses - fixedSalary) }
    : { salary: legacySalaryExpenses, commission: 0 };
}

/**
 * ═══ CƯỚC / PHÍ HOÀN GÕ TAY NÀO ĐƯỢC TÍNH — MỘT MỆNH ĐỀ, HAI NƠI DÙNG ═══
 *
 * Tổng kỳ (`build`) và bản rải theo ngày (`getOperatingCostByDay`) phải chọn CÙNG một tập khoản,
 * nếu không cộng các ngày sẽ không ra tổng kỳ. Nhóm của từng thành phần DẪN XUẤT từ sổ thẩm quyền.
 * Khoản cùng nhóm KHÔNG khai điều chỉnh là trùng vận đơn (`logisticsDuplicateCond`) — bị loại và nêu ra.
 */
const LOGISTICS_COMPONENTS = ["SHIPPING", "RETURN_COST"] as const;
type LogisticsComponent = (typeof LOGISTICS_COMPONENTS)[number];
function logisticsAdjustmentCond(component: LogisticsComponent): SQL {
  return sql`(${e.category} in ${expenseCategoriesOf(component)} and ${e.costSource} = 'MANUAL_ADJUSTMENT')`;
}
const LOGISTICS_ADJUSTMENT_ANY = sql`(${sql.join(LOGISTICS_COMPONENTS.map(logisticsAdjustmentCond), sql` or `)})`;

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

  /*
    ═══ PHÍ HOÀN NẰM TRÊN VẬN ĐƠN CHIỀU VỀ, KHÔNG NẰM Ở `orders.return_fee` ═══

    Thành phần `RETURN_COST` đang đọc `sum(orders.return_fee)`. Đo trên production 15/09/2026: cột
    ấy bằng **0 trên toàn bảng** — trong khi có **268 vận đơn chiều hoàn** mang **2.120.600 ₫ cước
    thật**. Báo cáo in "phí hoàn = 0" nên đọc thành "shop không tốn phí hoàn", còn sự thật là ĐỌC
    NHẦM CỘT.

    Vận đơn chiều về là một dòng `shipments` RIÊNG (`order_id` NULL, `order_reference` = mã gốc —
    AGENTS.md mục 7), nên nó không nằm trong phép nối `PRIMARY_ATTEMPT` của mọi truy vấn khác. Cước
    của nó vì thế không được tính ở BẤT CỨ ĐÂU.

    `lib/constants/cost-sources.ts` đã khai đúng thẩm quyền từ đầu: cước và phí hoàn thuộc về VẬN
    ĐƠN / BẢNG KÊ ĐVVC. Đây chỉ là đọc đúng cái nguồn đã khai.

    MỐC KỲ là ngày chiều hoàn thật sự xảy ra, theo thứ tự chứng cứ giảm dần — không dùng ngày tạo
    đơn gốc, vì một đơn tháng trước có thể hoàn về tháng này và chi phí ấy thuộc tháng này.
  */
  const chieuHoanAt = sql`coalesce(${s.deliveredAt}, ${s.returnedAt}, ${s.pickedUpAt}, ${s.createdAt})`;

  const [rent, software, otherOperating, salaryLegacy, shipAdjust, returnAdjust, logisticsDup, adSpend, returnLeg, [cogsRow, shipRow]] = await Promise.all([
    categorySum(expenseCategoriesOf("RENT")),
    categorySum(expenseCategoriesOf("SOFTWARE")),
    categorySum(expenseCategoriesOf("OTHER_OPERATING")),
    categorySum(COVERAGE_GATED_EXPENSE_CATEGORIES),
    // Khoản ĐIỀU CHỈNH có lý do đi vào ĐÚNG thành phần của nhóm nó: cước → Cước, phí hoàn → Phí hoàn.
    categorySum(expenseCategoriesOf("SHIPPING"), logisticsAdjustmentCond("SHIPPING")),
    categorySum(expenseCategoriesOf("RETURN_COST"), logisticsAdjustmentCond("RETURN_COST")),
    // Khoản cước gõ tay KHÔNG khai là điều chỉnh ⇒ trùng với cước theo vận đơn, bị loại.
    db.select({ amount: allocatedExpenseSum(period.from, period.to), n: count() }).from(e).where(and(logisticsDuplicateCond(), inRange)),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), ...periodConds(schema.adSpends.spendDate, period.from, period.to))),
    db
      .select({ amount: sql<number>`coalesce(sum(${s.shippingFee}), 0)`, n: count() })
      .from(s)
      .where(and(isNull(s.orderId), isNotNull(s.orderReference), ...periodConds(chieuHoanAt, period.from, period.to))),
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
          shipping: sql<number>`coalesce(sum(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(FINISHED_OUTCOMES_SQL)})), 0)`,
          returnFee: sql<number>`coalesce(sum(${o.returnFee}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)})), 0)`,
        })
        .from(o)
        .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
        .where(and(...periodConds(o.insertedAt, period.from, period.to)));
      return [cogs, ship] as const;
    }),
  ]);

  const warnings: CostEngineWarning[] = [];
  const returnLegFee = { amount: Number(returnLeg[0]?.amount ?? 0), n: Number(returnLeg[0]?.n ?? 0) };

  // ── LƯƠNG: bảng Lương chỉ cầm quyền khi đã phủ đủ; chưa đủ thì lùi về bảng Chi phí, KHÔNG im lặng ──
  const tachLuong = splitPayrollComponents(payrollCovered, payroll.fixedSalary, salaryLegacy.amount);
  const salaryAmount = tachLuong.salary;
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
  /*
    ═══ CHUYỂN QUYỀN THEO TỪNG THÀNH PHẦN, KHÔNG THEO CẢ CỤM ═══

    Bản cũ: `payrollCovered` bật thì TOÀN BỘ nhóm "Lương" ở bảng Chi phí bị loại. Nhóm ấy chứa cả
    lương cứng LẪN hoa hồng, còn nguồn mới chỉ góp được lương cứng — nên đổi một ô cấu hình là hoa
    hồng rơi khỏi lợi nhuận, và lợi nhuận tăng lên đúng bằng khoản ấy. Cảnh báo cũ có nói ra, nhưng
    nói ra một khoản tiền đã biến mất không làm nó quay lại.

    Nay: lương cứng lấy từ bảng Lương (nguồn có thẩm quyền cho THÀNH PHẦN ấy), và phần nhóm cũ
    KHÔNG giải thích được bằng lương cứng vẫn được TÍNH, ở thành phần Hoa hồng, kèm lời khai rằng
    nó chưa đối chiếu được. Không mất đồng nào, cũng không cộng hai lần: thành phần Lương lấy đúng
    con số của bảng Lương, thành phần Hoa hồng chỉ lấy phần DƯ.

    Vì sao phần dư mặc định coi là hoa hồng: nhóm "Lương" ở bảng Chi phí là nơi shop đang ghi cả
    lương lẫn hoa hồng, và lương cứng đã được nguồn mới nhận. Phần còn lại là tiền THẬT đã chi —
    gọi tên nó là "chưa đối chiếu" thì đúng hơn là vứt đi.
  */
  const legacyChuaDoiChieu = tachLuong.commission;
  /*
    ═══ NGHĨA VỤ LƯƠNG CÓ THẬT, MÀ LỢI NHUẬN KHÔNG TRỪ ĐỒNG NÀO ═══

    Cảnh báo ngay trên chỉ bật khi `salaryLegacy.amount > 0`. Nên khi bảng Chi phí KHÔNG có khoản
    lương nào, thành phần SALARY bằng 0 và **không cảnh báo nào bật**: lợi nhuận đọc như thể shop
    không trả lương cho ai, một cách hoàn toàn im lặng.

    Đo trên production 15/09/2026: 4 nhân sự, **5.000.000 ₫/tháng** lương cứng đã khai ở bảng
    Lương, **0 khoản chi** nhóm "Lương" ở bảng Chi phí, nguồn ghi nhận chưa khai (mặc định
    LEGACY_EXPENSES). Lợi nhuận đang cao hơn sự thật ít nhất bằng khoản ấy, mỗi tháng.

    ERP **KHÔNG tự cộng** con số từ bảng Lương vào lợi nhuận: chuyển thẩm quyền phải là một quyết
    định tường minh của chủ shop (AGENTS.md mục 18), và tự cộng là mở đường cho ngày mai có người
    nhập khoản chi lương rồi bị trừ hai lần. Nhưng ERP cũng không được im lặng — nên đây là cảnh
    báo mức `high`, và cổng chốt kỳ (`payrollFinalizeBlockers`) chặn trên mức ấy: không ai chốt
    được một kỳ lương trên con số lợi nhuận chưa trừ lương.
  */
  if (!payrollCovered && salaryLegacy.amount === 0 && payroll.monthlyFixedTotal > 0) {
    warnings.push({
      rule: "PAYROLL_OBLIGATION_NOT_RECOGNIZED",
      severity: "high",
      title: `Lợi nhuận KHÔNG trừ đồng lương nào, trong khi bảng Lương đã khai ${payroll.monthlyFixedTotal.toLocaleString("vi-VN")} ₫/tháng`,
      detail: `${payroll.activeEmployees} nhân sự đang làm việc có lương cứng khai ở bảng Lương (${payroll.fixedSalaryDue.toLocaleString("vi-VN")} ₫ thuộc kỳ này), nhưng bảng Chi phí — nguồn đang có thẩm quyền — KHÔNG có khoản chi nhóm “Lương” nào. Chi phí lương ghi nhận được là 0 ₫, nên lợi nhuận đang CAO HƠN sự thật ít nhất bằng khoản ấy. Chưa có khoản nhập KHÔNG có nghĩa là không phát sinh chi phí.`,
      action: "Chọn MỘT trong hai: nhập khoản chi lương vào bảng Chi phí cho kỳ này, HOẶC bật bảng Lương làm nguồn ghi nhận (Cấu hình → Nguồn ghi nhận chi phí nhân sự). ERP cố ý không tự cộng — chuyển thẩm quyền là quyết định của chủ shop, và tự cộng là mở đường cho việc trừ hai lần về sau.",
      amount: payroll.fixedSalaryDue,
      count: payroll.activeEmployees,
    });
  }
  if (payrollCovered && salaryLegacy.amount > 0) {
    warnings.push({
      rule: "DUPLICATE_PAYROLL_EXPENSE_SOURCE",
      severity: legacyChuaDoiChieu > 0 ? "high" : "medium",
      title:
        legacyChuaDoiChieu > 0
          ? `Bảng Lương cầm quyền phần LƯƠNG CỨNG — còn ${legacyChuaDoiChieu.toLocaleString("vi-VN")} ₫ ở bảng Chi phí chưa đối chiếu được`
          : `Bảng Lương đang cầm quyền — ${salaryLegacy.n} khoản “Lương” ở bảng Chi phí đã được thay thế`,
      detail:
        legacyChuaDoiChieu > 0
          ? `Lương cứng lấy từ bảng Lương (${salaryAmount.toLocaleString("vi-VN")} ₫). ${salaryLegacy.n} khoản nhóm “Lương” ở bảng Chi phí cộng lại ${salaryLegacy.amount.toLocaleString("vi-VN")} ₫, nhiều hơn phần lương cứng ${legacyChuaDoiChieu.toLocaleString("vi-VN")} ₫ — nhiều khả năng là HOA HỒNG nằm lẫn trong đó. Phần dư ấy VẪN ĐƯỢC TÍNH vào lợi nhuận (thành phần “Hoa hồng”), không bị bỏ đi; nhưng nó chưa đối chiếu được về từng khoản.`
          : `Lương cứng lấy từ bảng Lương (${salaryAmount.toLocaleString("vi-VN")} ₫), vừa đúng bằng ${salaryLegacy.amount.toLocaleString("vi-VN")} ₫ đã ghi ở bảng Chi phí nên không còn phần dư nào. Không trừ hai lần, cũng không mất khoản nào.`,
      action:
        legacyChuaDoiChieu > 0
          ? "Tách các khoản HOA HỒNG khỏi nhóm “Lương” ở bảng Chi phí (hoặc ghi rõ ở ô mô tả) để đối chiếu được về từng người. Không xoá chứng từ — phần dư đang được tính, xoá đi là làm mất chi phí thật."
          : "Không cần làm gì. Muốn dừng thì tắt chế độ ghi nhận từ bảng Lương.",
      amount: legacyChuaDoiChieu > 0 ? legacyChuaDoiChieu : salaryLegacy.amount,
      count: salaryLegacy.n,
    });
  }
  /*
    ═══ HOA HỒNG: CƠ SỞ NAY ĐÃ CÓ TÊN, NÊN CẢNH BÁO THÔI LÀ MỘT CÂU HỎI TREO ═══

    Bản trước đẩy một cảnh báo VÔ ĐIỀU KIỆN nói "chưa chốt cơ sở ghi nhận hoa hồng". Nó đúng lúc
    ấy, nhưng nó không bao giờ tắt được: câu hỏi nó đặt ra không có đường nào để trả lời trong ERP,
    nên nó nằm đó mãi mãi — và một cảnh báo không bao giờ tắt là một cảnh báo người ta học cách
    bỏ qua.

    `lib/constants/compensation-profit.ts` nay khai dứt khoát:

        LỢI NHUẬN TRƯỚC THÙ LAO BIẾN ĐỔI = doanh thu − mọi chi phí TRỪ hoa hồng
        hoa hồng                          = r × (cơ sở ấy, sau bù lỗ)
        LỢI NHUẬN KẾ TOÁN                 = cơ sở − hoa hồng

    Vòng lặp biến mất vì cơ sở và lợi nhuận kế toán là HAI con số mang HAI cái tên, không phải một.

    ─── NHƯNG CÒN MỘT LỖ HỔNG THẬT, VÀ NÓ ĐO ĐƯỢC ───

    Hoa hồng đã trả được ghi ở bảng Chi phí nhóm "Lương", và nhóm ấy nằm TRONG chi phí vận hành —
    tức nằm trong chính cơ sở mà lời khai vừa nói là phải loại nó ra. Khi điều đó xảy ra, cơ sở
    tính hoa hồng tháng này bị trừ đi khoản hoa hồng của tháng TRƯỚC.

    Nên cảnh báo nay CÓ ĐIỀU KIỆN: chỉ bật khi thật sự có khoản nhóm "Lương" vượt quá phần lương
    cứng đối chiếu được — tức khi có thứ nhiều khả năng là hoa hồng đang nằm trong cơ sở. Không có
    thì không cảnh báo, vì không có gì sai.
  */
  const hoaHongCoTheNamTrongCoSo = payrollCovered ? legacyChuaDoiChieu : Math.max(0, salaryLegacy.amount - payroll.fixedSalaryDue);
  if (hoaHongCoTheNamTrongCoSo > 0) {
    warnings.push({
      rule: "COMMISSION_BASIS_NEEDS_REVIEW",
      severity: "medium",
      title: `${hoaHongCoTheNamTrongCoSo.toLocaleString("vi-VN")} ₫ nhiều khả năng là hoa hồng đang nằm TRONG cơ sở tính lương`,
      detail: `Cơ sở tính thù lao đã có tên và đã khai rõ: “${COMPENSATION_PROFIT_LABEL}” — hoa hồng bị loại khỏi chính cơ sở của nó, rồi trừ ở bước SAU để ra lợi nhuận kế toán. Nhưng ${salaryLegacy.n} khoản nhóm “Lương” ở bảng Chi phí cộng lại nhiều hơn phần lương cứng ${hoaHongCoTheNamTrongCoSo.toLocaleString("vi-VN")} ₫, và phần dư ấy nằm trong chi phí vận hành — tức trong cơ sở. Hệ quả: cơ sở tính hoa hồng kỳ này bị trừ đi khoản hoa hồng của kỳ TRƯỚC.`,
      action:
        "Tách khoản HOA HỒNG khỏi nhóm “Lương” ở bảng Chi phí (đổi nhóm hoặc ghi rõ ở ô mô tả) để chúng thôi nằm trong cơ sở. Không xoá chứng từ — tiền đã trả là tiền thật, nó chỉ cần đứng đúng bước.",
      amount: hoaHongCoTheNamTrongCoSo,
      count: salaryLegacy.n,
    });
  }

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
    SHIPPING: mk("SHIPPING", Number(shipRow?.shipping ?? 0) + shipAdjust.amount, {
      note: `Cước theo vận đơn${shipAdjust.amount ? ` + ${shipAdjust.amount.toLocaleString("vi-VN")} ₫ điều chỉnh có lý do (${shipAdjust.n} khoản)` : ""}. Khoản gõ tay không khai điều chỉnh bị loại.`,
    }),
    RETURN_COST: mk("RETURN_COST", Number(shipRow?.returnFee ?? 0) + returnLegFee.amount + returnAdjust.amount, {
      note: `Cước trên VẬN ĐƠN CHIỀU HOÀN theo chứng từ ĐVVC${returnLegFee.n ? ` (${returnLegFee.n} vận đơn)` : ""}${Number(shipRow?.returnFee ?? 0) ? ` + phí hoàn ghi trên đơn` : ""}${returnAdjust.amount ? ` + ${returnAdjust.amount.toLocaleString("vi-VN")} ₫ điều chỉnh có lý do (${returnAdjust.n} khoản)` : ""}. Vận đơn chiều về là dòng riêng (order_id NULL) nên nó không nằm trong phép nối vận đơn chính của các truy vấn khác.`,
    }),
    SALARY: mk("SALARY", salaryAmount, {
      coverage: payroll.coverage,
      usedFallback: !payrollCovered,
      sourceUsed: payrollCovered ? COST_SOURCE_LABEL.PAYROLL : COST_SOURCE_LABEL.EXPENSES,
      recognitionMethod: payrollCovered ? "PERIOD_PRORATA" : "EVENT_DATE",
      note: payrollCovered ? "Lương cứng chia theo số ngày thật của từng tháng." : "Đang dùng nguồn dự phòng: khoản chi nhóm “Lương” ở bảng Chi phí (gồm cả hoa hồng).",
    }),
    /*
      HOA HỒNG: hai tình huống, hai con số — và gộp chúng lại là chỗ tiền biến mất.

      · Bảng Lương CHƯA cầm quyền ⇒ cả nhóm "Lương" (gồm hoa hồng) đã nằm trọn ở thành phần SALARY.
        Cộng thêm ở đây chính là trừ hai lần, nên để 0.
      · Bảng Lương ĐÃ cầm quyền phần lương cứng ⇒ thành phần SALARY chỉ còn lương cứng. Phần nhóm cũ
        vượt quá lương cứng là tiền THẬT đã chi mà nguồn mới không nhận — nó vào đây, chứ không bị
        vứt đi như bản trước.
    */
    COMMISSION: mk("COMMISSION", legacyChuaDoiChieu, {
      coverage: payroll.componentCoverage.commission,
      usedFallback: true,
      sourceUsed: COST_SOURCE_LABEL.EXPENSES,
      note: payrollCovered
        ? legacyChuaDoiChieu > 0
          ? "Phần nhóm “Lương” ở bảng Chi phí vượt quá lương cứng — nhiều khả năng là hoa hồng. ĐƯỢC TÍNH, nhưng chưa đối chiếu được về từng khoản."
          : "Nhóm “Lương” ở bảng Chi phí vừa đúng bằng lương cứng, không còn phần dư nào."
        : "Chưa tách khỏi nhóm “Lương”. Đã nằm trong thành phần Lương cố định, không cộng thêm ở đây.",
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

  const logisticsAdjustment: LogisticsAdjustmentTotal = {
    shipping: shipAdjust.amount,
    returnFee: returnAdjust.amount,
    amount: shipAdjust.amount + returnAdjust.amount,
    count: shipAdjust.n + returnAdjust.n,
  };
  return { period, components, operatingTotal, operatingCount, total, warnings, payroll, logisticsAdjustment };
}

/**
 * Tổng khối chi phí vận hành theo kỳ — hàm mà mọi báo cáo gọi thay cho phép cộng riêng.
 * Trả kèm cờ `payrollCovered` để truy vấn theo mã hàng dùng đúng điều kiện lọc.
 */
export async function getOperatingCost(period: Period): Promise<{
  amount: number;
  count: number;
  payrollCovered: boolean;
  warnings: CostEngineWarning[];
  /**
   * Cước / phí hoàn gõ tay khai ĐIỀU CHỈNH có lý do. KHÔNG thuộc khối vận hành (`amount`). Báo cáo
   * tự lấy cước từ vận đơn thì cộng khoản này vào dòng Cước / Phí hoàn của mình — lấy từ ĐÂY, không
   * tự đọc bảng Chi phí. Báo cáo đọc `getRecognizedCosts().components` thì nó đã nằm sẵn trong đó.
   */
  logisticsAdjustment: LogisticsAdjustmentTotal;
}> {
  const costs = await getRecognizedCosts(period);
  return {
    amount: costs.operatingTotal,
    count: costs.operatingCount,
    payrollCovered: costs.payroll.coverage === "COMPLETE",
    warnings: costs.warnings,
    logisticsAdjustment: costs.logisticsAdjustment,
  };
}

/** Một phần cước / phí hoàn điều chỉnh rải theo ngày. Σ `byDay` = `amount`. */
export type LogisticsAdjustmentByDay = { amount: number; byDay: Map<string, number> };

export type OperatingCostByDay = {
  /** Chi phí vận hành của từng ngày (khoá `YYYY-MM-DD` giờ Việt Nam). Σ = `getOperatingCost().amount`. */
  byDay: Map<string, number>;
  total: number;
  payrollCovered: boolean;
  /**
   * Khoản gõ tay trong kỳ KHÔNG vào chi phí vận hành vì nguồn khác có thẩm quyền. Nêu ra để màn
   * hình nói được vì sao, không để chúng biến mất im lặng.
   */
  excluded: { category: ExpenseCategory; rule: "EXCLUDED_BY_AUTHORITY" | "DUPLICATE_LOGISTICS_COST_SOURCE"; amount: number; count: number }[];
  /**
   * Cước / phí hoàn gõ tay khai ĐIỀU CHỈNH có lý do: engine tính vào thành phần Cước / Phí hoàn,
   * KHÔNG vào khối vận hành. Rải theo ngày bằng ĐÚNG phương thức phân bổ của từng khoản (khoản một
   * lần vào ngày phát sinh, khoản theo kỳ chia theo số ngày) — bảng theo ngày cộng nó vào cột cước,
   * và Σ các ngày = `getOperatingCost().logisticsAdjustment` của cùng kỳ tới từng đồng.
   */
  logisticsAdjustment: { amount: number; count: number; shipping: LogisticsAdjustmentByDay; returnFee: LogisticsAdjustmentByDay };
};

/**
 * ═══════════ CHI PHÍ VẬN HÀNH RẢI THEO NGÀY — CÙNG MỘT SỔ THẨM QUYỀN VỚI TỔNG KỲ ═══════════
 *
 * Biểu đồ / bảng theo ngày (Báo cáo lợi nhuận tổng hợp, Hiệu quả marketing theo ngày) từng đọc
 * THẲNG bảng Chi phí qua `allocatedExpenseByDay`, không qua sổ thẩm quyền. Ba hậu quả:
 *
 *  · khoản ADS gõ tay bị cộng CHỒNG lên chi tiêu thật của tài khoản quảng cáo (luật 15);
 *  · PURCHASE, cước / phí hoàn gõ tay không khai điều chỉnh lọt vào chi phí vận hành;
 *  · bảng Lương đã cầm quyền mà nhóm "Lương" ở bảng Chi phí vẫn được cộng nguyên.
 *
 * Tổng kỳ (`getOperatingCost`) loại đúng những khoản ấy, nên cộng các cột ngày KHÔNG ra tổng kỳ —
 * và bài kiểm đối soát của trang marketing so với `getDailyBreakdown`, tức tự so với chính nó.
 *
 * Nay hàm này đọc ĐÚNG những nhóm mà `build()` đọc (dẫn xuất từ sổ thẩm quyền), cắt nhóm Lương
 * bằng ĐÚNG `splitPayrollComponents`, nên Σ các ngày = `getOperatingCost(period).amount` tới từng
 * đồng. Hai phần không đến từ một khoản chi có ngày riêng được rải bằng largest remainder:
 *
 *  · lương cứng của bảng Lương — theo SỐ NGÀY THẬT của tháng chứa ngày (cùng tinh thần
 *    `prorateMonthlyAmount`: một ngày tháng Hai đắt hơn một ngày tháng Tư);
 *  · phần nhóm "Lương" vượt lương cứng (thành phần Hoa hồng) — theo đúng NGÀY của các khoản chi đã
 *    ghi, KHÔNG chia đều theo lịch (luật 16: hoa hồng đi theo đơn, không theo thời gian).
 *
 * Cước / phí hoàn ĐIỀU CHỈNH có lý do cũng được rải ở đây (`logisticsAdjustment`), tách khỏi khối
 * vận hành: bảng theo ngày cộng chúng vào cột CƯỚC / PHÍ HOÀN của mình, để Σ các ngày của cột ấy
 * bằng đúng cột ấy của tổng kỳ. Trước đây cả `pnl()` lẫn bảng theo ngày đều bỏ sót khoản này trong
 * khi engine tính nó vào thành phần Cước — hai báo cáo khớp nhau vì CÙNG thiếu.
 *
 * `db` là tuỳ chọn để nơi gọi đang ở trong một giao dịch (tắt JIT) dùng lại chính kết nối ấy.
 */
export async function getOperatingCostByDay(period: Period, db?: Db): Promise<OperatingCostByDay> {
  const conn = db ?? (await getDb());
  const inRange = expenseInRange(period.from, period.to);
  const [payroll, rows, adjustments, others] = await Promise.all([
    getRecognizedPayrollCost(period),
    conn
      .select({
        category: e.category,
        amount: e.amount,
        occurredAt: e.occurredAt,
        allocationMethod: e.allocationMethod,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
      })
      .from(e)
      .where(and(inArray(e.category, OPERATING_EXPENSE_CATEGORIES), inRange)),
    // Cước / phí hoàn ĐIỀU CHỈNH có lý do — CÙNG mệnh đề với tổng kỳ, đọc từng khoản để rải theo ngày.
    conn
      .select({
        category: e.category,
        amount: e.amount,
        occurredAt: e.occurredAt,
        allocationMethod: e.allocationMethod,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
      })
      .from(e)
      .where(and(LOGISTICS_ADJUSTMENT_ANY, inRange)),
    // Phần KHÔNG vào khối vận hành, cũng KHÔNG phải điều chỉnh cước — đọc ra để NÓI, không để cộng.
    conn
      .select({ category: e.category, costSource: e.costSource, amount: allocatedExpenseSum(period.from, period.to), n: count() })
      .from(e)
      .where(and(notInArray(e.category, OPERATING_EXPENSE_CATEGORIES), sql`not ${LOGISTICS_ADJUSTMENT_ANY}`, inRange))
      .groupBy(e.category, e.costSource),
  ]);

  const payrollCovered = payroll.coverage === "COMPLETE";
  const byDay = new Map<string, number>();
  const legacy = new Map<string, number>();
  const into = (map: Map<string, number>) => (day: string, amount: number) => {
    if (amount) map.set(day, (map.get(day) ?? 0) + amount);
  };
  const asItem = (row: (typeof rows)[number]): AllocatableExpense => ({
    amount: Number(row.amount),
    occurredAt: row.occurredAt,
    allocationMethod: row.allocationMethod as AllocatableExpense["allocationMethod"],
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  });
  for (const row of rows) {
    spreadExpenseByDay(asItem(row), period.from, period.to, into(COVERAGE_GATED_EXPENSE_CATEGORIES.includes(row.category) ? legacy : byDay));
  }

  const legacyTotal = [...legacy.values()].reduce((t, v) => t + v, 0);
  const tach = splitPayrollComponents(payrollCovered, payroll.fixedSalary, legacyTotal);
  if (payrollCovered && period.from && period.to) {
    const days = vnDaysOfRange(period.from, period.to);
    const fixed = distributeProportionally(tach.salary, days.map((d) => 1 / d.daysInMonth));
    days.forEach((d, i) => into(byDay)(d.day, fixed[i]));
    const legacyDays = [...legacy.keys()];
    const commission = distributeProportionally(tach.commission, legacyDays.map((d) => legacy.get(d) ?? 0));
    legacyDays.forEach((d, i) => into(byDay)(d, commission[i]));
  } else {
    for (const [day, amount] of legacy) into(byDay)(day, amount);
  }

  // Nhóm phí hoàn KHÔNG trùng nhóm cước (sổ thẩm quyền khai mỗi nhóm cho đúng một thành phần).
  const shipCategories = expenseCategoriesOf("SHIPPING");
  const adjShipping = new Map<string, number>();
  const adjReturn = new Map<string, number>();
  for (const row of adjustments) {
    spreadExpenseByDay(asItem(row), period.from, period.to, into(shipCategories.includes(row.category) ? adjShipping : adjReturn));
  }
  const sumOf = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + v, 0);
  const logisticsAdjustment: OperatingCostByDay["logisticsAdjustment"] = {
    amount: sumOf(adjShipping) + sumOf(adjReturn),
    // Đếm như `count()` của tổng kỳ: mọi khoản thuộc khoảng, kể cả khi phần của khoảng làm tròn ra 0.
    count: adjustments.length,
    shipping: { amount: sumOf(adjShipping), byDay: adjShipping },
    returnFee: { amount: sumOf(adjReturn), byDay: adjReturn },
  };

  const excluded: OperatingCostByDay["excluded"] = [];
  for (const r of others) {
    const amount = Number(r.amount ?? 0);
    const n = Number(r.n ?? 0);
    const rule = HARD_EXCLUDED_EXPENSE_CATEGORIES.includes(r.category) ? "EXCLUDED_BY_AUTHORITY" : "DUPLICATE_LOGISTICS_COST_SOURCE";
    const cur = excluded.find((x) => x.category === r.category && x.rule === rule);
    if (cur) {
      cur.amount += amount;
      cur.count += n;
    } else excluded.push({ category: r.category, rule, amount, count: n });
  }

  const total = [...byDay.values()].reduce((t, v) => t + v, 0);
  return { byDay, total, payrollCovered, excluded: excluded.filter((x) => x.amount > 0), logisticsAdjustment };
}
