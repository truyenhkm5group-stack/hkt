import { and, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  PAYROLL_EMPLOYEES_KEY,
  type Employee,
  type PayrollBasis,
} from "@/lib/constants/payroll";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import {
  getNominalProfitReport,
  type NominalReport,
} from "@/lib/queries/profit-nominal";
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
  adSpend: number;
  share: number;
  attributedRevenue: number;
  attributedProfitBeforeAds: number;
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
  personalProfit: number; // = lợi nhuận phân bổ trước QC − QC mã hàng − QC test
  products: MarketerProductLine[];
};

export type MarketerReport = {
  nominal: NominalReport;
  marketers: MarketerProfit[];
  /** Lợi nhuận mã hàng không có quảng cáo (không phân bổ cho ai) */
  unattributedProfit: number;
  unattributedRevenue: number;
};

/**
 * Lợi nhuận cá nhân theo marketer: lợi nhuận danh nghĩa của từng mã (trước chi phí QC) được chia cho các marketer
 * theo tỷ trọng tiền QC mỗi người chạy cho mã đó, rồi trừ tiền QC mã hàng và tiền QC test của chính người đó.
 */
export async function getMarketerReport(
  period: Period,
): Promise<MarketerReport> {
  const db = await getDb();
  const [nominal, employees] = await Promise.all([
    getNominalProfitReport(period),
    listEmployees(),
  ]);
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) conds.push(gte(ads.spendDate, period.from));
  if (period.to) conds.push(lte(ads.spendDate, period.to));
  const spendRows = await db
    .select({
      marketerId: ads.marketerId,
      productId: ads.productId,
      spend: sql<number>`coalesce(sum(${ads.spend}), 0)`,
    })
    .from(ads)
    .where(and(...conds))
    .groupBy(ads.marketerId, ads.productId);

  const byProduct = new Map<
    string,
    { total: number; byMarketer: Map<string | null, number> }
  >();
  const testByMarketer = new Map<string | null, number>();
  for (const r of spendRows) {
    const spend = Number(r.spend);
    if (!r.productId) {
      testByMarketer.set(
        r.marketerId,
        (testByMarketer.get(r.marketerId) ?? 0) + spend,
      );
      continue;
    }
    const entry = byProduct.get(r.productId) ?? {
      total: 0,
      byMarketer: new Map(),
    };
    entry.total += spend;
    entry.byMarketer.set(
      r.marketerId,
      (entry.byMarketer.get(r.marketerId) ?? 0) + spend,
    );
    byProduct.set(r.productId, entry);
  }

  const marketers = new Map<string | null, MarketerProfit>();
  const ensure = (id: string | null) => {
    let m = marketers.get(id);
    if (!m) {
      const emp = id ? employees.find((e) => e.id === id) : null;
      m = {
        marketerId: id,
        name: emp ? emp.shortName || emp.name : "Chưa gán marketer",
        adSpend: 0,
        testSpend: 0,
        totalSpend: 0,
        attributedRevenue: 0,
        attributedOrders: 0,
        attributedProfitBeforeAds: 0,
        personalProfit: 0,
        products: [],
      };
      marketers.set(id, m);
    }
    return m;
  };
  let unattributedProfit = 0;
  let unattributedRevenue = 0;
  for (const row of nominal.rows) {
    const profitBeforeAds = row.expectedProfit + row.adSpend;
    const spend = byProduct.get(row.productId);
    if (!spend || spend.total <= 0) {
      unattributedProfit += profitBeforeAds;
      unattributedRevenue += row.expectedRevenue;
      continue;
    }
    for (const [marketerId, amount] of spend.byMarketer) {
      const share = amount / spend.total;
      const m = ensure(marketerId);
      const line: MarketerProductLine = {
        productId: row.productId,
        productName: row.productName,
        code: row.code,
        adSpend: amount,
        share,
        attributedRevenue: Math.round(row.expectedRevenue * share),
        attributedProfitBeforeAds: Math.round(profitBeforeAds * share),
        personalProfit: Math.round(profitBeforeAds * share - amount),
        orders: Math.round(row.orders * share),
      };
      m.products.push(line);
      m.adSpend += amount;
      m.attributedRevenue += line.attributedRevenue;
      m.attributedOrders += line.orders;
      m.attributedProfitBeforeAds += line.attributedProfitBeforeAds;
    }
  }
  for (const [marketerId, amount] of testByMarketer)
    ensure(marketerId).testSpend += amount;
  for (const m of marketers.values()) {
    m.totalSpend = m.adSpend + m.testSpend;
    m.personalProfit = m.attributedProfitBeforeAds - m.adSpend - m.testSpend;
    m.products.sort((a, b) => b.personalProfit - a.personalProfit);
  }
  // Hiển thị cả nhân sự marketing chưa có chi tiêu trong kỳ
  for (const e of employees)
    if (e.active && e.department === "Marketing" && !marketers.has(e.id))
      ensure(e.id);
  const list = [...marketers.values()].sort((a, b) =>
    a.marketerId === null
      ? 1
      : b.marketerId === null
        ? -1
        : b.personalProfit - a.personalProfit,
  );
  return { nominal, marketers: list, unattributedProfit, unattributedRevenue };
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
    getMarketerReport(period),
    listEmployees(),
    basis === "cash" ? getCashProfitReport(period) : Promise.resolve(null),
  ]);
  const totalProfit =
    basis === "cash" && cash
      ? cash.net
      : marketers.nominal.totals.expectedProfit;
  const lines: PayrollLine[] = employees
    .filter((e) => e.active)
    .map((e) => {
      const m = marketers.marketers.find((x) => x.marketerId === e.id);
      const personalProfit = m ? m.personalProfit : null;
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
