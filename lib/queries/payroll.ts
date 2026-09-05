import { and, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { DEFAULT_PAYROLL_CONFIG, PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY, type Employee, type PayrollBasis, type PayrollConfig } from "@/lib/constants/payroll";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import {
  getNominalProfitReport,
  rescuedOrdersByProduct,
  resolveAssumptions,
  type NominalReport,
} from "@/lib/queries/profit-nominal";
import { fixedCostForPeriod, opsCosts, periodMonths } from "@/lib/constants/profit";
import type { Period } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

export async function listEmployees(): Promise<Employee[]> {
  const list = await getSettingJson<{ list: Employee[] }>(
    PAYROLL_EMPLOYEES_KEY,
    { list: [] },
  );
  const defaults = (): Omit<Employee, "id" | "name"> => ({
    aliases: [],
    accountIds: [],
    fixed: 0,
    percentTotal: 0,
    percentPersonal: 0,
    percentRevenue: 0,
    active: true,
    note: "",
    department: "Marketing",
    shortName: "",
  });
  return (list.list ?? []).map(
    (e) => ({ ...defaults(), ...(e as Partial<Employee>) }) as Employee,
  );
}

export type MarketerProductLine = {
  productId: string;
  productName: string;
  code: string;
  /** owner: mã mình phụ trách · cross: đẩy chéo mã của người khác */
  role: "owner" | "cross";
  adSpend: number;
  share: number;
  attributedRevenue: number;
  attributedProfitBeforeAds: number;
  /** Giá vốn bị trừ trên dòng này (LN1: theo hàng giao TC × tỷ trọng; LN2: toàn bộ hàng nhập, chỉ chủ mã) */
  cogsCharged: number;
  /** % chủ mã: dương = nhận từ người đẩy chéo, âm = chia cho chủ mã */
  ownerBonus: number;
  personalProfit: number;
  orders: number;
};

export type MarketerProfit = {
  marketerId: string | null; // null = không xác định marketer
  name: string;
  adSpend: number; // QC đã ghép mã hàng
  testSpend: number; // QC chưa thuộc mã nào (test)
  totalSpend: number;
  attributedRevenue: number;
  attributedOrders: number;
  attributedProfitBeforeAds: number;
  cogsCharged: number;
  ownerBonusReceived: number;
  ownerBonusPaid: number;
  ownedProducts: string[];
  personalProfit: number; // = LN phân bổ − QC của mình − giá vốn chịu trách nhiệm ± % chủ mã − QC test
  products: MarketerProductLine[];
};

/** Kinh tế từng mã trong kỳ theo công thức đang chọn */
export type ProductProfitLine = {
  productId: string;
  productName: string;
  code: string;
  ownerId: string | null;
  ownerName: string;
  deliveredOrders: number;
  revenue: number;
  adSpend: number;
  cogsDelivered: number;
  purchaseCost: number;
  cogs: number;
  shipping: number;
  operatingAlloc: number;
  profit: number;
};

export type MarketerReport = {
  basis: PayrollBasis;
  config: PayrollConfig;
  nominal: NominalReport;
  products: ProductProfitLine[];
  totals: { revenue: number; adSpend: number; cogs: number; shipping: number; operating: number; operatingEntered: number; fixedCost: number; perOrderOps: number; months: number; testSpend: number; profit: number };
  marketers: MarketerProfit[];
  /** Lợi nhuận mã hàng không có quảng cáo và không có người phụ trách (không phân bổ cho ai) */
  unattributedProfit: number;
  unattributedRevenue: number;
};

export async function loadPayrollConfig(): Promise<PayrollConfig> {
  const cfg = await getSettingJson<Partial<PayrollConfig>>(PAYROLL_CONFIG_KEY, DEFAULT_PAYROLL_CONFIG);
  return { productOwners: cfg.productOwners ?? {}, ownerSharePct: Number.isFinite(Number(cfg.ownerSharePct)) ? Number(cfg.ownerSharePct) : 5 };
}

function periodConds(column: AnyPgColumn, period: Period): SQL[] {
  const conds: SQL[] = [];
  if (period.from) conds.push(gte(column, period.from));
  if (period.to) conds.push(lte(column, period.to));
  return conds;
}

/**
 * Kinh tế từng mã trong kỳ (theo ngày lên đơn): doanh thu giao thành công, giá vốn hàng giao TC, cước vận chuyển phân bổ theo dòng đơn,
 * giá vốn hàng nhập trong kỳ (phiếu nhập), chi phí cố định/vận hành/khác phân bổ theo tỷ trọng doanh thu.
 */
async function productEconomics(period: Period) {
  const db = await getDb();
  const i = schema.orderItems;
  const o = schema.orders;
  const s = schema.shipments;
  const pv = schema.productVariants;
  const p = schema.products;
  const productKey = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const orderTotal = sql`nullif(${o.totalPriceAfterDiscount}, 0)`;
  const shipFee = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
  const [sales, receipts, [exp], assumptions, rescued] = await Promise.all([
    db
      .select({
        productId: productKey,
        productName: sql<string>`max(coalesce(${p.name}, ${i.productName}))`,
        code: sql<string>`max(coalesce(${p.customId}, ''))`,
        // đơn đã gửi đi (có vận đơn, không huỷ) — cơ sở tính đóng hàng & nhân viên vận đơn
        sentOrders: sql<number>`count(distinct ${o.id}) filter (where ${s.id} is not null and ${o.stage} not in ('CANCELLED','DELETED') and coalesce(${s.stage}, '') not in ('CANCELLED','PENDING'))`,
        firstAt: sql<string | null>`min(${o.insertedAt})`,
        lastAt: sql<string | null>`max(${o.insertedAt})`,
        deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
        revenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
        cogsDelivered: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
        shipping: sql<number>`coalesce(sum(${shipFee} * ${i.lineTotal} / ${orderTotal}) filter (where ${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE','IN_TRANSIT')), 0)`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, eq(s.orderId, o.id))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, eq(p.id, sql`coalesce(${pv.productId}, ${i.productId})`))
      .where(and(eq(i.isBonus, false), ...periodConds(o.insertedAt, period)))
      .groupBy(sql`1`),
    db
      .select({ productId: pv.productId, cost: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity} * ${schema.stockReceiptItems.unitCost}), 0)` })
      .from(schema.stockReceiptItems)
      .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
      .innerJoin(pv, eq(pv.id, schema.stockReceiptItems.variantId))
      .where(and(eq(schema.stockReceipts.kind, "RECEIPT"), sql`${schema.stockReceiptItems.quantity} > 0`, ...periodConds(schema.stockReceipts.receivedAt, period)))
      .groupBy(pv.productId),
    db
      .select({ amount: sql<number>`coalesce(sum(${schema.expenses.amount}), 0)` })
      .from(schema.expenses)
      .where(and(sql`${schema.expenses.category} not in ('ADS','PURCHASE')`, ...periodConds(schema.expenses.occurredAt, period))),
    resolveAssumptions(),
    rescuedOrdersByProduct(period),
  ]);
  const purchase = new Map(receipts.filter((r) => r.productId).map((r) => [r.productId as string, Number(r.cost)]));
  const operatingEntered = Number(exp?.amount ?? 0);
  // chi phí cố định (văn phòng, điện nước…) theo giả định báo cáo lợi nhuận, quy đổi theo số ngày của kỳ
  const dates = (v: (string | null)[]) => v.map((x) => (x ? new Date(x) : null)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  const now = new Date();
  const from = period.from ?? dates(sales.map((r) => r.firstAt)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const lastAt = dates(sales.map((r) => r.lastAt)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const to = period.to ? (period.to.getTime() > now.getTime() ? now : period.to) : lastAt && lastAt.getTime() > now.getTime() ? lastAt : now;
  const months = from ? Math.round(periodMonths(from, to) * 100) / 100 : 0;
  const fixedCost = fixedCostForPeriod(Number(assumptions.fixedCostMonthly ?? 0), months);
  const rows = sales.filter((r) => r.productId).map((r) => {
    const sentOrders = Number(r.sentOrders);
    const ops = opsCosts({ orders: sentOrders, rescued: rescued.get(r.productId) ?? 0 }, assumptions);
    return { productId: r.productId, productName: r.productName ?? "", code: r.code ?? "", deliveredOrders: Number(r.deliveredOrders), sentOrders, rescued: Math.min(rescued.get(r.productId) ?? 0, sentOrders), revenue: Number(r.revenue), cogsDelivered: Math.round(Number(r.cogsDelivered)), shipping: Math.round(Number(r.shipping)), purchaseCost: purchase.get(r.productId) ?? 0, ...ops };
  });
  const revenueTotal = rows.reduce((a, r) => a + r.revenue, 0);
  // mã có nhập hàng nhưng chưa có đơn trong kỳ vẫn cần hiện (LN2 trừ giá vốn hàng nhập)
  for (const [pid, cost] of purchase) if (!rows.some((r) => r.productId === pid)) rows.push({ productId: pid, productName: "", code: "", deliveredOrders: 0, sentOrders: 0, rescued: 0, revenue: 0, cogsDelivered: 0, shipping: 0, purchaseCost: cost, packingCost: 0, opsStaffCost: 0 });
  const perOrderTotal = rows.reduce((a, r) => a + r.packingCost + r.opsStaffCost, 0);
  // CP vận hành phân bổ của mã = (đã nhập + cố định) theo tỷ trọng doanh thu GTC + đóng hàng & NV vận đơn theo đơn của chính mã
  const operating = operatingEntered + fixedCost + perOrderTotal;
  return {
    rows: rows.map((r) => ({ ...r, operatingAlloc: (revenueTotal ? Math.round(((operatingEntered + fixedCost) * r.revenue) / revenueTotal) : 0) + r.packingCost + r.opsStaffCost })),
    operating,
    operatingEntered,
    fixedCost,
    perOrderTotal,
    months,
    revenueTotal,
  };
}

/**
 * Lợi nhuận cá nhân theo marketer:
 *  - Mỗi mã có marketer phụ trách chính (chủ mã): chịu tồn kho & giá vốn mã đó; người khác đẩy chéo được chia doanh thu theo tỷ trọng tiền QC.
 *  - LN1: giá vốn hàng giao thành công đi theo đơn (chia theo tỷ trọng QC). LN2: toàn bộ giá vốn hàng nhập trong kỳ tính cho chủ mã.
 *  - Chủ mã nhận ownerSharePct % lợi nhuận (dương) từ đơn của marketer khác trên mã của mình.
 *  - QC test (không thuộc mã) trừ vào chính người chạy.
 */
export async function getMarketerReport(period: Period, basis: PayrollBasis = "profit1"): Promise<MarketerReport> {
  return memo(`getMarketerReport:${periodKey(period)}:${basis}`, 120_000, () => getMarketerReportUncached(period, basis));
}

async function getMarketerReportUncached(period: Period, basis: PayrollBasis): Promise<MarketerReport> {
  const db = await getDb();
  const [nominal, employees, config, econ] = await Promise.all([getNominalProfitReport(period), listEmployees(), loadPayrollConfig(), productEconomics(period)]);
  const ads = schema.adSpends;
  const spendRows = await db
    .select({ marketerId: ads.marketerId, productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
    .from(ads)
    .where(and(eq(ads.excluded, false), ...periodConds(ads.spendDate, period)))
    .groupBy(ads.marketerId, ads.productId);

  const byProduct = new Map<string, { total: number; byMarketer: Map<string | null, number> }>();
  const testByMarketer = new Map<string | null, number>();
  for (const r of spendRows) {
    const spend = Number(r.spend);
    if (!r.productId) {
      testByMarketer.set(r.marketerId, (testByMarketer.get(r.marketerId) ?? 0) + spend);
      continue;
    }
    const entry = byProduct.get(r.productId) ?? { total: 0, byMarketer: new Map() };
    entry.total += spend;
    entry.byMarketer.set(r.marketerId, (entry.byMarketer.get(r.marketerId) ?? 0) + spend);
    byProduct.set(r.productId, entry);
  }
  const useDeliveredCogs = basis !== "profit2";
  const nameOf = (id: string | null) => (id ? employees.find((e) => e.id === id) : null);
  const marketers = new Map<string | null, MarketerProfit>();
  const ensure = (id: string | null) => {
    let m = marketers.get(id);
    if (!m) {
      const emp = nameOf(id);
      m = { marketerId: id, name: emp ? emp.shortName || emp.name : "Chưa gán marketer", adSpend: 0, testSpend: 0, totalSpend: 0, attributedRevenue: 0, attributedOrders: 0, attributedProfitBeforeAds: 0, cogsCharged: 0, ownerBonusReceived: 0, ownerBonusPaid: 0, ownedProducts: [], personalProfit: 0, products: [] };
      marketers.set(id, m);
    }
    return m;
  };
  const pct = Math.max(0, config.ownerSharePct) / 100;
  const products: ProductProfitLine[] = [];
  const totals = { revenue: 0, adSpend: 0, cogs: 0, shipping: 0, operating: econ.operating, operatingEntered: econ.operatingEntered, fixedCost: econ.fixedCost, perOrderOps: econ.perOrderTotal, months: econ.months, testSpend: 0, profit: 0 };
  let unattributedProfit = 0;
  let unattributedRevenue = 0;

  for (const row of econ.rows) {
    const spend = byProduct.get(row.productId);
    const adSpend = spend?.total ?? 0;
    const cogs = useDeliveredCogs ? row.cogsDelivered : row.purchaseCost;
    const profit = row.revenue - adSpend - cogs - row.shipping - row.operatingAlloc;
    const ownerId = config.productOwners[row.productId] ?? null;
    const owner = nameOf(ownerId);
    products.push({ productId: row.productId, productName: row.productName || nominal.rows.find((n) => n.productId === row.productId)?.productName || row.productId, code: row.code, ownerId, ownerName: owner ? owner.shortName || owner.name : "", deliveredOrders: row.deliveredOrders, revenue: row.revenue, adSpend, cogsDelivered: row.cogsDelivered, purchaseCost: row.purchaseCost, cogs, shipping: row.shipping, operatingAlloc: row.operatingAlloc, profit });
    totals.revenue += row.revenue;
    totals.adSpend += adSpend;
    totals.cogs += cogs;
    totals.shipping += row.shipping;
    totals.profit += profit;

    // phần biến đổi đi theo đơn: doanh thu − vận chuyển − chi phí phân bổ − (LN1: giá vốn hàng giao TC)
    const variable = row.revenue - row.shipping - row.operatingAlloc - (useDeliveredCogs ? row.cogsDelivered : 0);
    const shares = new Map<string | null, number>();
    if (spend && spend.total > 0) for (const [mid, amount] of spend.byMarketer) shares.set(mid, amount / spend.total);
    else if (ownerId) shares.set(ownerId, 1);
    if (!shares.size) {
      unattributedProfit += profit;
      unattributedRevenue += row.revenue;
      continue;
    }
    if (ownerId) ensure(ownerId).ownedProducts.push(row.code || row.productName);
    let ownerBonusTotal = 0;
    for (const [mid, share] of shares) {
      const m = ensure(mid);
      const mySpend = spend?.byMarketer.get(mid) ?? 0;
      const isOwner = ownerId !== null && mid === ownerId;
      const cogsCharged = useDeliveredCogs ? Math.round(row.cogsDelivered * share) : isOwner ? row.purchaseCost : 0;
      const base = Math.round(variable * share) - mySpend - (useDeliveredCogs ? 0 : cogsCharged);
      const bonus = !isOwner && ownerId ? Math.round(Math.max(base, 0) * pct) : 0;
      ownerBonusTotal += bonus;
      const line: MarketerProductLine = {
        productId: row.productId,
        productName: row.productName,
        code: row.code,
        role: isOwner ? "owner" : "cross",
        adSpend: mySpend,
        share,
        attributedRevenue: Math.round(row.revenue * share),
        attributedProfitBeforeAds: Math.round(variable * share),
        cogsCharged,
        ownerBonus: -bonus,
        personalProfit: base - bonus,
        orders: Math.round(row.deliveredOrders * share),
      };
      m.products.push(line);
      m.adSpend += mySpend;
      m.attributedRevenue += line.attributedRevenue;
      m.attributedOrders += line.orders;
      m.attributedProfitBeforeAds += line.attributedProfitBeforeAds;
      m.cogsCharged += cogsCharged;
      m.ownerBonusPaid += bonus;
      m.personalProfit += line.personalProfit;
    }
    if (ownerId) {
      const o = ensure(ownerId);
      if (!shares.has(ownerId)) {
        // chủ mã không chạy QC trong kỳ: vẫn chịu giá vốn hàng nhập (LN2) và nhận % chéo
        const cogsCharged = useDeliveredCogs ? 0 : row.purchaseCost;
        o.products.push({ productId: row.productId, productName: row.productName, code: row.code, role: "owner", adSpend: 0, share: 0, attributedRevenue: 0, attributedProfitBeforeAds: 0, cogsCharged, ownerBonus: ownerBonusTotal, personalProfit: ownerBonusTotal - cogsCharged, orders: 0 });
        o.cogsCharged += cogsCharged;
        o.personalProfit += ownerBonusTotal - cogsCharged;
      } else {
        const line = o.products.find((l) => l.productId === row.productId && l.role === "owner");
        if (line) {
          line.ownerBonus = ownerBonusTotal;
          line.personalProfit += ownerBonusTotal;
        }
        o.personalProfit += ownerBonusTotal;
      }
      o.ownerBonusReceived += ownerBonusTotal;
    }
  }
  for (const [marketerId, amount] of testByMarketer) {
    const m = ensure(marketerId);
    m.testSpend += amount;
    m.personalProfit -= amount;
    totals.testSpend += amount;
  }
  totals.profit -= totals.testSpend;
  for (const m of marketers.values()) {
    m.totalSpend = m.adSpend + m.testSpend;
    m.products.sort((a, b) => b.personalProfit - a.personalProfit);
  }
  for (const e of employees) if (e.active && e.department === "Marketing" && !marketers.has(e.id)) ensure(e.id);
  const list = [...marketers.values()].sort((a, b) => (a.marketerId === null ? 1 : b.marketerId === null ? -1 : b.personalProfit - a.personalProfit));
  products.sort((a, b) => b.profit - a.profit);
  return { basis, config, nominal, products, totals, marketers: list, unattributedProfit, unattributedRevenue };
}

export type PayrollLine = {
  employee: Employee;
  totalProfit: number;
  personalProfit: number | null;
  personalRevenue: number | null;
  fixed: number;
  bonusTotal: number;
  bonusPersonal: number;
  bonusRevenue: number;
  salary: number;
};

export type PayrollReport = {
  basis: PayrollBasis;
  totalProfit: number;
  /** LN danh nghĩa tổng (để đối chiếu) */
  nominalTotal: number;
  /** Hệ số quy đổi LN cá nhân sang dòng tiền thực (= 1 khi cơ sở danh nghĩa) */
  cashRatio: number;
  lines: PayrollLine[];
  totalSalary: number;
  marketers: MarketerReport;
};

/** Bảng lương theo kỳ: lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân + % doanh thu cá nhân (thưởng chỉ tính khi số dương) */
export async function getPayrollReport(
  period: Period,
  basis: PayrollBasis,
): Promise<PayrollReport> {
  const [marketers, employees, cash] = await Promise.all([
    getMarketerReport(period, basis),
    listEmployees(),
    basis === "cash" ? getCashProfitReport(period) : Promise.resolve(null),
  ]);
  const nominalTotal = marketers.nominal.totals.expectedProfit;
  const modelTotal = marketers.totals.profit;
  const totalProfit = basis === "cash" && cash ? cash.net : basis === "nominal" ? nominalTotal : modelTotal;
  // Cơ sở dòng tiền: LN cá nhân = LN1 cá nhân × (LN dòng tiền thực ÷ LN1 tổng) — tiền COD về theo bảng kê không tách được theo mã / người
  const cashRatio = basis === "cash" && cash ? (modelTotal > 0 ? cash.net / modelTotal : 0) : 1;
  const lines: PayrollLine[] = employees
    .filter((e) => e.active)
    .map((e) => {
      const m = marketers.marketers.find((x) => x.marketerId === e.id);
      const personalProfit = m ? Math.round(m.personalProfit * cashRatio) : null;
      const personalRevenue = m ? m.attributedRevenue : null;
      const bonusTotal = Math.round(
        Math.max(totalProfit, 0) * (e.percentTotal / 100),
      );
      const bonusPersonal = Math.round(
        Math.max(personalProfit ?? 0, 0) * (e.percentPersonal / 100),
      );
      const bonusRevenue = Math.round(
        Math.max(personalRevenue ?? 0, 0) * (e.percentRevenue / 100),
      );
      return {
        employee: e,
        totalProfit,
        personalProfit,
        personalRevenue,
        fixed: e.fixed,
        bonusTotal,
        bonusPersonal,
        bonusRevenue,
        salary: e.fixed + bonusTotal + bonusPersonal + bonusRevenue,
      };
    });
  return {
    basis,
    totalProfit,
    nominalTotal,
    cashRatio,
    lines,
    totalSalary: lines.reduce((s, l) => s + l.salary, 0),
    marketers,
  };
}

/** Tổng chi tiêu QC chưa gán marketer trong kỳ (để nhắc ghép) */
export async function unassignedMarketerSpend(period: Period) {
  const db = await getDb();
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.excluded, false), isNull(ads.marketerId)];
  if (period.from) conds.push(gte(ads.spendDate, period.from));
  if (period.to) conds.push(lte(ads.spendDate, period.to));
  const [row] = await db
    .select({
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
      campaigns: sql<number>`count(distinct ${ads.campaignId})`,
    })
    .from(ads)
    .where(and(...conds));
  return {
    spend: Number(row?.spend ?? 0),
    campaigns: Number(row?.campaigns ?? 0),
  };
}

export type MarketerPrefixSuggestion = {
  prefix: string;
  spend: number;
  campaigns: number;
  accounts: string[];
  accountIds: string[];
  sample: string;
  suggestedName: string;
};

/** Tiền tố tên chiến dịch (phần trước dấu "_" đầu tiên, vd QA4, HIEU, NHAT_LV) của các chiến dịch chưa có marketer — gợi ý khai báo nhân sự */
export async function detectMarketerPrefixes(
  days = 180,
): Promise<MarketerPrefixSuggestion[]> {
  const db = await getDb();
  const ads = schema.adSpends;
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      campaign: sql<string>`max(${ads.campaign})`,
      campaignId: ads.campaignId,
      accountName: sql<string>`max(coalesce(${ads.accountName}, ''))`,
      accountId: sql<string>`max(coalesce(${ads.accountId}, ''))`,
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
    })
    .from(ads)
    .where(
      and(
        eq(ads.excluded, false),
        isNull(ads.marketerId),
        gte(ads.spendDate, since),
        sql`${ads.campaignId} is not null`,
      ),
    )
    .groupBy(ads.campaignId);
  const groups = new Map<string, MarketerPrefixSuggestion>();
  for (const r of rows) {
    const name = (r.campaign ?? "").trim();
    // Tiền tố: 1–2 khối chữ/số viết hoa nối bằng "_" hoặc "." trước dấu "_" tiếp theo, vd "QA4", "HIEU_HM", "NHAT_LV", "HIEU.HM"
    const m = name.match(
      /^([A-ZĐÀ-Ỹ][A-Z0-9ĐÀ-Ỹ]{0,9}(?:[_.][A-Z][A-Z0-9]{0,6})?)(?=[_\s-])/u,
    );
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    if (/^(TEST|CĐ|CD|LM|TN|W\d|VID|Q\d{3}|X\d{3})$/.test(prefix)) continue;
    const g = groups.get(prefix) ?? {
      prefix,
      spend: 0,
      campaigns: 0,
      accounts: [],
      accountIds: [],
      sample: name,
      suggestedName: "",
    };
    g.spend += Number(r.spend);
    g.campaigns += 1;
    if (r.accountName && !g.accounts.includes(r.accountName))
      g.accounts.push(r.accountName);
    if (r.accountId && !g.accountIds.includes(r.accountId))
      g.accountIds.push(r.accountId);
    groups.set(prefix, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      suggestedName: g.accounts[0]
        ? g.accounts[0].replace(/\s*\d+$/, "").replace(/\./g, " ")
        : g.prefix,
    }))
    .sort((a, b) => b.spend - a.spend);
}

/** Các tài khoản quảng cáo đã có dữ liệu chi tiêu (để chọn tài khoản mặc định cho marketer) */
export async function listAdAccounts() {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.adSpends.accountId, name: sql<string>`max(${schema.adSpends.accountName})` })
    .from(schema.adSpends)
    .where(sql`${schema.adSpends.accountId} is not null`)
    .groupBy(schema.adSpends.accountId);
  return rows.filter((r) => r.id).map((r) => ({ id: r.id as string, name: r.name ?? (r.id as string) }));
}

export type NominalMarketerRow = {
  marketerId: string | null;
  name: string;
  ownedProducts: string[];
  adSpend: number;
  testSpend: number;
  otherCost: number;
  attributedOrders: number;
  attributedRevenue: number;
  /** LN danh nghĩa ròng phân bổ trước QC (đã trừ giá vốn, VC, vận hành, rủi ro TK, thuế) */
  profitBeforeAds: number;
  ownerBonusReceived: number;
  ownerBonusPaid: number;
  /** LN danh nghĩa ròng cá nhân = phân bổ − QC của mình − CP khác − QC test ± % chủ mã */
  personalNet: number;
  products: NominalMarketerProduct[];
};

/** Một mã hàng trong phần chi tiết của marketer (chỉ mã có số liệu: QC, đơn, doanh thu hoặc % chủ mã) */
export type NominalMarketerProduct = {
  productId: string;
  code: string;
  productName: string;
  /** owner = mã mình phụ trách; cross = đẩy chéo mã của người khác */
  role: "owner" | "cross";
  /** Tỷ trọng tiền QC của marketer trên mã (0–1) → tỷ lệ đơn / doanh thu / LN được ghi nhận */
  share: number;
  /** Đơn & DT GTC ước tính của mã × tỷ trọng */
  orders: number;
  revenue: number;
  /** LN ròng danh nghĩa của mã trước QC × tỷ trọng */
  profitBeforeAds: number;
  /** QC của chính marketer trên mã + chi phí khác theo QC */
  adSpend: number;
  otherCost: number;
  /** % chủ mã: dương = nhận từ người đẩy chéo (chủ mã), âm = trích cho chủ mã (đẩy chéo) */
  ownerBonus: number;
  /** LN ròng cá nhân từ mã = profitBeforeAds − adSpend − otherCost ± ownerBonus */
  personalNet: number;
};

/** Lợi nhuận danh nghĩa (ước tính theo đơn lên trong kỳ) chia theo marketer — cùng quy tắc chủ mã / đẩy chéo với bảng lương */
export async function getNominalMarketerBreakdown(period: Period): Promise<{ rows: NominalMarketerRow[]; unattributed: number; ownerSharePct: number }> {
  return memo(`nominalByMarketer:${periodKey(period)}`, 120_000, async () => {
    const db = await getDb();
    const [nominal, employees, config] = await Promise.all([getNominalProfitReport(period), listEmployees(), loadPayrollConfig()]);
    const ads = schema.adSpends;
    const spendRows = await db
      .select({ marketerId: ads.marketerId, productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(eq(ads.excluded, false), ...periodConds(ads.spendDate, period)))
      .groupBy(ads.marketerId, ads.productId);
    const otherPct = Math.max(0, Number(nominal.assumptions.otherCostPercentOfAds ?? 0)) / 100;
    const byProduct = new Map<string, { total: number; byMarketer: Map<string | null, number> }>();
    const testByMarketer = new Map<string | null, number>();
    for (const r of spendRows) {
      const spend = Number(r.spend);
      if (!r.productId) {
        testByMarketer.set(r.marketerId, (testByMarketer.get(r.marketerId) ?? 0) + spend);
        continue;
      }
      const e = byProduct.get(r.productId) ?? { total: 0, byMarketer: new Map() };
      e.total += spend;
      e.byMarketer.set(r.marketerId, (e.byMarketer.get(r.marketerId) ?? 0) + spend);
      byProduct.set(r.productId, e);
    }
    const rows = new Map<string | null, NominalMarketerRow>();
    const ensure = (id: string | null) => {
      let m = rows.get(id);
      if (!m) {
        const emp = id ? employees.find((e) => e.id === id) : null;
        m = { marketerId: id, name: emp ? emp.shortName || emp.name : "Chưa gán marketer", ownedProducts: [], adSpend: 0, testSpend: 0, otherCost: 0, attributedOrders: 0, attributedRevenue: 0, profitBeforeAds: 0, ownerBonusReceived: 0, ownerBonusPaid: 0, personalNet: 0, products: [] };
        rows.set(id, m);
      }
      return m;
    };
    const pct = Math.max(0, config.ownerSharePct) / 100;
    let unattributed = 0;
    for (const r of nominal.rows) {
      const spend = byProduct.get(r.productId);
      const ownerId = config.productOwners[r.productId] ?? null;
      // LN ròng danh nghĩa trước QC của mã = LN ròng + QC + chi phí khác theo QC
      const netBeforeAds = r.netProfit + r.adSpend + r.otherCost;
      const shares = new Map<string | null, number>();
      if (spend && spend.total > 0) for (const [mid, amount] of spend.byMarketer) shares.set(mid, amount / spend.total);
      else if (ownerId) shares.set(ownerId, 1);
      if (!shares.size) {
        unattributed += netBeforeAds;
        continue;
      }
      if (ownerId) ensure(ownerId).ownedProducts.push(r.code || r.productName);
      let bonusTotal = 0;
      for (const [mid, share] of shares) {
        const m = ensure(mid);
        const mySpend = spend?.byMarketer.get(mid) ?? 0;
        const other = Math.round(mySpend * otherPct);
        const isOwner = ownerId !== null && mid === ownerId;
        const base = Math.round(netBeforeAds * share) - mySpend - other;
        const bonus = !isOwner && ownerId ? Math.round(Math.max(base, 0) * pct) : 0;
        bonusTotal += bonus;
        m.adSpend += mySpend;
        m.otherCost += other;
        m.attributedOrders += Math.round(r.orders * share);
        m.attributedRevenue += Math.round(r.expectedRevenue * share);
        m.profitBeforeAds += Math.round(netBeforeAds * share);
        m.ownerBonusPaid += bonus;
        m.personalNet += base - bonus;
        m.products.push({ productId: r.productId, code: r.code, productName: r.productName, role: isOwner ? "owner" : "cross", share, orders: Math.round(r.orders * share), revenue: Math.round(r.expectedRevenue * share), profitBeforeAds: Math.round(netBeforeAds * share), adSpend: mySpend, otherCost: other, ownerBonus: -bonus, personalNet: base - bonus });
      }
      if (ownerId) {
        const o = ensure(ownerId);
        o.ownerBonusReceived += bonusTotal;
        o.personalNet += bonusTotal;
        if (bonusTotal) {
          const line = o.products.find((x) => x.productId === r.productId);
          if (line) {
            line.ownerBonus += bonusTotal;
            line.personalNet += bonusTotal;
          } else o.products.push({ productId: r.productId, code: r.code, productName: r.productName, role: "owner", share: 0, orders: 0, revenue: 0, profitBeforeAds: 0, adSpend: 0, otherCost: 0, ownerBonus: bonusTotal, personalNet: bonusTotal });
        }
      }
    }
    for (const [mid, amount] of testByMarketer) {
      const m = ensure(mid);
      m.testSpend += amount;
      m.otherCost += Math.round(amount * otherPct);
      m.personalNet -= amount + Math.round(amount * otherPct);
    }
    for (const e of employees) if (e.active && e.department === "Marketing" && !rows.has(e.id)) ensure(e.id);
    const list = [...rows.values()].sort((a, b) => (a.marketerId === null ? 1 : b.marketerId === null ? -1 : b.personalNet - a.personalNet));
    for (const m of list) m.products = m.products.filter((x) => x.adSpend || x.orders || x.revenue || x.ownerBonus || x.personalNet).sort((a, b) => b.personalNet - a.personalNet);
    return { rows: list, unattributed, ownerSharePct: config.ownerSharePct };
  });
}
