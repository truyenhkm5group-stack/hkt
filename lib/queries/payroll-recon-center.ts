/**
 * ═══════════ TRUNG TÂM ĐỐI SOÁT LƯƠNG — LỚP ĐỌC ═══════════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §10. Phép dựng thuần ở `lib/payroll/recon-center.ts`.
 *
 * CHỈ ĐỌC. Mọi luật kết quả đơn / chứng từ tiền / giá vốn đi qua đúng biểu thức của cơ sở lương
 * (`DELIVERED_RECOGNIZED_SQL`, `MONEY_EVIDENCE_SQL`, `LINE_UNIT_COST`, `PRIMARY_ATTEMPT`) — không viết lại.
 * Chi phí đã ghi nhận lấy từ máy chi phí (`getRecognizedCosts`), không tự cộng bảng Chi phí.
 *
 * Ba lượt đo:
 *  · `cogsGapsByVariant` — dòng đã giao có giá vốn 0, gom theo mẫu mã, kèm NGUYÊN NHÂN đo được (dòng
 *    không nối mẫu mã · phiếu nhập có mà thiếu giá · chưa có phiếu nhập nào) và vài mã đơn để tra.
 *  · `codSplit` — một tháng tách BA con số: doanh thu kế toán (đã giao, đã ghi nhận) · khoản phải thu
 *    (đã giao, chưa chứng từ tiền — theo nguyên nhân và tuổi) · tiền thực nhận (trả trước + COD ĐVVC
 *    đã trả về) và COD ĐVVC báo đã thu nhưng chưa ghi tiền về.
 *  · `openingSeries` — chuỗi số đo từng tháng từ đầu kỳ dữ liệu cho đề xuất số dư mở sổ.
 */
import { withSettingsScope } from "@/lib/settings";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { monthReportPeriod } from "@/lib/queries/payroll";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { DELIVERED_RECOGNIZED_SQL, MONEY_EVIDENCE_SQL, orderFacts } from "@/lib/queries/payroll-reconciliation";
import { buildApprovalList, buildOpeningProposal, codGapCause, historicalSalary, personalShareWithoutCode, type ApprovalItem, type CodGapCause, type OpeningMonthInput, type OpeningProposal } from "@/lib/payroll/recon-center";
import type { MonthReconciliation } from "@/lib/payroll/profit-reconciliation";
import { getPayrollReport, listEmployees } from "@/lib/queries/payroll";
import { getMonthReconciliation, loadProfitSignoffs } from "@/lib/queries/payroll-reconciliation";
import { getProfitGateConfig } from "@/lib/queries/payroll-profit-gate";
import { listCodeBook, loadCodeBook } from "@/lib/queries/payroll-code-ledger";

export type CogsGapCause = "NO_VARIANT" | "RECEIPT_NO_PRICE" | "NO_RECEIPT";
export const COGS_GAP_CAUSE_LABEL: Record<CogsGapCause, string> = {
  NO_VARIANT: "Dòng đơn không nối được mẫu mã ERP",
  RECEIPT_NO_PRICE: "Có phiếu nhập nhưng phiếu không ghi giá",
  NO_RECEIPT: "Chưa có phiếu nhập · Pancake cũng không có giá vốn",
};

export type CogsGapRow = {
  productId: string;
  code: string;
  productName: string;
  variantId: string | null;
  sku: string;
  lines: number;
  quantity: number;
  revenue: number;
  receiptLines: number;
  cause: CogsGapCause;
  sampleOrderIds: string[];
};

/** Dòng ĐÃ GIAO (đã ghi nhận) có giá vốn 0, gom theo mẫu mã. Không tự điền giá. */
export async function cogsGapsByVariant(from: Date, to: Date): Promise<CogsGapRow[]> {
  const db = await getDb();
  const i = schema.orderItems;
  const o = schema.orders;
  const s = schema.shipments;
  const pv = schema.productVariants;
  const p = schema.products;
  const productKey = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        productId: productKey,
        code: sql<string>`max(coalesce(${p.customId}, ''))`,
        productName: sql<string>`max(coalesce(${p.name}, ${i.productName}, ''))`,
        variantId: i.variantId,
        sku: sql<string>`max(coalesce(${pv.customId}, ${pv.sku}, ''))`,
        lines: sql<number>`count(*)`,
        quantity: sql<number>`coalesce(sum(${i.quantity}), 0)`,
        revenue: sql<number>`coalesce(sum(${i.lineTotal}), 0)`,
        receiptLines: sql<number>`(select count(*) from stock_receipt_items ri where ri.variant_id = ${i.variantId})`,
        pricedLines: sql<number>`(select count(*) from stock_receipt_items ri where ri.variant_id = ${i.variantId} and coalesce(ri.unit_cost, 0) > 0)`,
        samples: sql<string[]>`(array_agg(${o.id} order by ${o.insertedAt}))[1:5]`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, sql`${p.id} = ${productKey}`)
      .where(and(gte(o.insertedAt, from), lte(o.insertedAt, to), DELIVERED_RECOGNIZED_SQL, sql`${productKey} <> ''`, sql`${LINE_UNIT_COST} = 0`))
      .groupBy(productKey, i.variantId),
  );
  return rows
    .map((r) => ({
      productId: r.productId,
      code: r.code,
      productName: r.productName,
      variantId: r.variantId,
      sku: r.sku,
      lines: Number(r.lines),
      quantity: Number(r.quantity),
      revenue: Number(r.revenue),
      receiptLines: Number(r.receiptLines),
      cause: (!r.variantId ? "NO_VARIANT" : Number(r.receiptLines) > 0 && Number(r.pricedLines) === 0 ? "RECEIPT_NO_PRICE" : "NO_RECEIPT") as CogsGapCause,
      sampleOrderIds: (r.samples ?? []).map(String),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export type CodBucket = { orders: number; revenue: number };
export type CodSplit = {
  monthKey: string;
  /** Doanh thu KẾ TOÁN: đơn đã giao, đã ghi nhận doanh thu (cùng điều kiện cơ sở lương). */
  accounting: CodBucket;
  /** Phần của doanh thu kế toán ĐÃ có chứng từ tiền. */
  withMoney: CodBucket;
  /** KHOẢN PHẢI THU chưa xác minh: đã giao, chưa có chứng từ tiền. */
  receivable: CodBucket & { byCause: Record<CodGapCause, CodBucket>; age: { le7: CodBucket; d8to30: CodBucket; over30: CodBucket; unknown: CodBucket } };
  /** TIỀN THỰC NHẬN: trả trước / chuyển khoản / tiền mặt trên đơn + COD ĐVVC đã trả về ngân hàng. */
  cashReceived: number;
  /** COD ĐVVC báo đã thu nhưng chưa ghi đã trả về — tiền ở ĐVVC, chưa phải tiền của shop. */
  codHeldByCarrier: number;
};

const rong = (): CodBucket => ({ orders: 0, revenue: 0 });

/** Tách doanh thu kế toán · phải thu · tiền thực nhận của các đơn LÊN trong một tháng (cùng mốc cơ sở lương). */
export async function codSplit(monthKey: string): Promise<CodSplit> {
  const period = monthReportPeriod(monthKey);
  const db = await getDb();
  const o = schema.orders;
  const s = schema.shipments;
  const doanhThu = sql`(select coalesce(sum(oi.line_total), 0) from order_items oi where oi.order_id = ${o.id} and oi.is_bonus = false)`;
  const tuoi = sql<string>`case when ${s.deliveredAt} is null then 'unknown' when now() - ${s.deliveredAt} <= interval '7 days' then 'le7' when now() - ${s.deliveredAt} <= interval '30 days' then 'd8to30' else 'over30' end`;
  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        coTien: sql<boolean>`${MONEY_EVIDENCE_SQL}`,
        codStatus: sql<string | null>`${s.codStatus}::text`,
        coBangKe: sql<boolean>`${s.codStatementRef} is not null`,
        tuoi,
        orders: sql<number>`count(*)`,
        revenue: sql<number>`coalesce(sum(${doanhThu}), 0)`,
        traTruoc: sql<number>`coalesce(sum(coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0) + coalesce(${o.cash}, 0)), 0)`,
        codVe: sql<number>`coalesce(sum((select coalesce(sum(sh.cod_collected), 0) from shipments sh where sh.order_id = ${o.id} and sh.cod_status::text = 'PAID_TO_BANK')), 0)`,
        codGiu: sql<number>`coalesce(sum((select coalesce(sum(sh.cod_collected), 0) from shipments sh where sh.order_id = ${o.id} and sh.cod_status::text in ('COLLECTED', 'RECONCILED'))), 0)`,
      })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(and(gte(o.insertedAt, period.from as Date), lte(o.insertedAt, period.to as Date), DELIVERED_RECOGNIZED_SQL))
      .groupBy(sql`1`, sql`2`, sql`3`, sql`4`),
  );
  const out: CodSplit = {
    monthKey,
    accounting: rong(),
    withMoney: rong(),
    receivable: { ...rong(), byCause: { NO_STATEMENT: rong(), STATEMENT_NO_CASH: rong(), DISPUTED: rong(), COLLECTED_NOT_PAID: rong() }, age: { le7: rong(), d8to30: rong(), over30: rong(), unknown: rong() } },
    cashReceived: 0,
    codHeldByCarrier: 0,
  };
  const cong = (b: CodBucket, n: number, v: number) => {
    b.orders += n;
    b.revenue += v;
  };
  for (const r of rows) {
    const n = Number(r.orders);
    const v = Number(r.revenue);
    cong(out.accounting, n, v);
    out.cashReceived += Number(r.traTruoc) + Number(r.codVe);
    out.codHeldByCarrier += Number(r.codGiu);
    if (r.coTien) {
      cong(out.withMoney, n, v);
      continue;
    }
    cong(out.receivable, n, v);
    cong(out.receivable.byCause[codGapCause(r.codStatus, Boolean(r.coBangKe))], n, v);
    const k = (["le7", "d8to30", "over30"] as const).find((x) => x === r.tuoi) ?? "unknown";
    cong(out.receivable.age[k], n, v);
  }
  return out;
}

/** Chạy `fn` trên từng phần tử, tối đa `n` lượt cùng lúc; kết quả giữ ĐÚNG thứ tự đầu vào. */
async function theoCap<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Tháng sớm nhất có đơn / QC / chi phí (giờ VN). `null` = chưa có gì. */
export async function dataStartMonths(): Promise<{ orders: string | null; ads: string | null; expenses: string | null; earliest: string | null }> {
  const db = await getDb();
  const r = (await db.execute(sql`select
      (select to_char(min(inserted_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from orders) as don,
      (select to_char(min(spend_date) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from ad_spends) as qc,
      (select to_char(min(occurred_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from expenses) as chi`)) as unknown as { rows?: { don: string | null; qc: string | null; chi: string | null }[] };
  const d = r.rows?.[0] ?? { don: null, qc: null, chi: null };
  const earliest = [d.don, d.qc, d.chi].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  return { orders: d.don, ads: d.qc, expenses: d.chi, earliest };
}

/** Chuỗi số đo một tháng cho đề xuất mở sổ. */
async function openingMonth(monthKey: string, firstExpenseMonth: string | null): Promise<OpeningMonthInput> {
  const period = monthReportPeriod(monthKey);
  const [facts, costs] = await Promise.all([orderFacts(period.from as Date, period.to as Date), getRecognizedCosts(period)]);
  const f = facts.total;
  const luong = historicalSalary({
    payrollCovered: costs.payroll.coverage === "COMPLETE",
    obligation: costs.warnings.find((w) => w.rule === "PAYROLL_OBLIGATION_NOT_RECOGNIZED")?.amount ?? null,
    undated: costs.payroll.fixedSalaryDueUndated,
    fixedSalary: costs.payroll.fixedSalary,
    salaryExpenseDocs: costs.salaryExpenseDocs,
    recognizedCost: costs.total,
  });
  return {
    monthKey,
    revenue: f.deliveredRevenue + f.deliveredRevenueNoProduct,
    ...luong,
    unknownCostLines: f.unknownCostLines,
    unknownCostRevenue: f.unknownCostRevenue,
    revenueWithoutMoney: Math.max(0, f.deliveredRevenue - f.deliveredRevenueWithMoney),
    openValue: f.openValue,
    beforeFirstExpense: firstExpenseMonth === null || monthKey < firstExpenseMonth,
  };
}

/** Chuỗi số đo từ đầu kỳ dữ liệu tới tháng liền trước `openingMonth`. Memo 120 giây theo mốc mở sổ. */
export async function openingSeries(openingMonth_: string): Promise<{ dataStart: string | null; months: OpeningMonthInput[] }> {
  return memo(`payroll-recon-center:opening:${openingMonth_}`, 120_000, async () => {
    const start = await dataStartMonths();
    if (!start.earliest || start.earliest >= openingMonth_) return { dataStart: start.earliest, months: [] };
    const thang = monthsBetween(start.earliest, openingMonth_).filter((m) => m < openingMonth_);
    // Hai tháng một lúc — cùng lý do với `getReconCenter`.
    const months = await theoCap(thang, 2, (m) => openingMonth(m, start.expenses));
    return { dataStart: start.earliest, months };
  });
}

export type ReconCenterMonth = {
  monthKey: string;
  recon: MonthReconciliation;
  cod: CodSplit;
  /** Thưởng % LN đủ điều kiện của tháng (số sống) — > 0 thì tháng cần chữ ký cấp 1. */
  eligibleBonus: number;
  signed: boolean;
};

export type ReconCenter = {
  fromMonth: string;
  toMonth: string;
  months: ReconCenterMonth[];
  cogsGaps: CogsGapRow[];
  opening: OpeningProposal;
  approvals: ApprovalItem[];
  dataStart: Awaited<ReturnType<typeof dataStartMonths>>;
};

/** Toàn bộ Trung tâm cho khoảng tháng `[fromMonth, toMonth]`. Memo 120 giây theo khoảng. */
export async function getReconCenter(fromMonth: string, toMonth: string): Promise<ReconCenter> {
  // OD-UX-05 mục 3b (24/10/2026, perf-probe «ĐỌC CẤU HÌNH TRONG TỪNG HÀM»): 202 lượt đọc settings / 10 khoá mỗi lượt tính (profit.assumptions ×83 · payroll.employees ×48 ·
  // payroll.recognition ×34…) — mỗi lượt là một lần xin kết nối trong lúc job giữ 3–4/5 kết nối của bể. Một phạm vi cho cả lượt.
  return memo(`payroll-recon-center:${fromMonth}:${toMonth}`, 120_000, () => withSettingsScope(async () => {
    const thang = monthsBetween(fromMonth, toMonth);
    const undated = new Map<string, { id: string; name: string; monthlyFixed: number }>();
    const coDoanhThu = new Set<string>();
    let trungNguon = 0;
    // HAI tháng một lúc: mỗi tháng là một bảng lương đầy đủ; mở cả năm tháng cùng lúc là chiếm hết bể
    // năm kết nối của mọi trang khác, chạy tuần tự thì trang chậm gấp đôi.
    const motThang = async (m: string): Promise<ReconCenterMonth> => {
      const period = monthReportPeriod(m);
      const report = await getPayrollReport(period, "profit1");
      const [recon, cod, signoffs, costs] = await Promise.all([getMonthReconciliation(m, { report }), codSplit(m), loadProfitSignoffs(m), getRecognizedCosts(period)]);
      for (const e of costs.payroll.undatedEmployees) undated.set(e.id, e);
      for (const p of report.marketers.products) if (p.revenue > 0) coDoanhThu.add(p.productId);
      trungNguon += recon.issues.filter((i) => i.code.startsWith("warn:") && i.code !== "warn:PAYROLL_OBLIGATION_NOT_RECOGNIZED").length;
      const eligibleBonus = report.profitGate.result.allocatedTotal ?? 0;
      return { monthKey: m, recon, cod, eligibleBonus, signed: signoffs.some((s) => !s.revokedAt) };
    };
    const months = await theoCap(thang, 2, motThang);
    const first = monthReportPeriod(thang[0] ?? fromMonth);
    const last = monthReportPeriod(thang[thang.length - 1] ?? toMonth);
    const [gaps, cfg, book, sobo, start, nhanSu] = await Promise.all([
      cogsGapsByVariant(first.from as Date, last.to as Date),
      getProfitGateConfig(),
      listCodeBook(),
      loadCodeBook(first.from, last.to),
      dataStartMonths(),
      listEmployees(),
    ]);
    const openingMonthKey = cfg.active?.openingMonth ?? fromMonth;
    const series = await openingSeries(openingMonthKey);
    const opening = buildOpeningProposal(openingMonthKey, series.dataStart, series.months);
    const owners = new Set(sobo.assignments.filter((a) => a.role === "OWNER").map((a) => a.productId));
    const approvals = buildApprovalList({
      opening,
      gatePolicyDeclared: Boolean(cfg.active),
      undatedEmployees: [...undated.values()],
      pendingAssignments: book.filter((r) => r.kind === "ASSIGNMENT" && r.status === "PENDING").length,
      pendingTerms: book.filter((r) => r.kind === "TERMS" && r.status === "PENDING").length,
      codesWithoutOwner: [...coDoanhThu].filter((id) => !owners.has(id)).length,
      monthsNeedingSignoff: months.filter((x) => x.eligibleBonus > 0 && !x.signed).map((x) => x.monthKey),
      cogsGaps: { variants: gaps.length, lines: gaps.reduce((t, g) => t + g.lines, 0), revenue: gaps.reduce((t, g) => t + g.revenue, 0) },
      codReceivable: {
        orders: months.reduce((t, x) => t + x.cod.receivable.orders, 0),
        revenue: months.reduce((t, x) => t + x.cod.receivable.revenue, 0),
        over30Orders: months.reduce((t, x) => t + x.cod.receivable.age.over30.orders, 0),
      },
      duplicateSourceWarnings: trungNguon,
      personalShareWithoutCode: personalShareWithoutCode(
        nhanSu.map((e) => ({ id: e.id, name: e.shortName || e.name, active: e.active, percentPersonal: Number(e.percentPersonal) || 0 })),
        new Set(sobo.assignments.map((a) => a.employeeId)),
        cfg.active?.residualClaimant?.employeeId ?? null,
      ),
    });
    return { fromMonth, toMonth, months, cogsGaps: gaps, opening, approvals, dataStart: start };
  }));
}
