import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { attributionShares, DEFAULT_PAYROLL_CONFIG, PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY, shareFor, splitProfit, type AttributionMode, type Employee, type PageBucket, type PayrollBasis, type PayrollConfig } from "@/lib/constants/payroll";
import { CONFIRMED_STAGES } from "@/lib/queries/expenses";
import { adMarketerMap } from "@/lib/integrations/facebook/ads-index";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import {
  getNominalProfitReport,
  resolveAssumptions,
  type NominalReport,
} from "@/lib/queries/profit-nominal";
import { fixedCostForPeriod, opsCosts, periodMonths, rescuedFromRate } from "@/lib/constants/profit";
import { getOperatingCost, type CostEngineWarning } from "@/lib/queries/cost-engine";
import { distributeProportionally, inclusiveDays, prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import { wholeMonthKey } from "@/lib/constants/payroll-carryover";
import { carryoverMonth } from "@/lib/payroll/profit-carryover";
import { getCarryoverConfig, resolveOpeningMany, type OpeningBasis, type OpeningResolution } from "@/lib/queries/payroll-carryover";
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
    userEmail: "",
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
  /** Cách ghi nhận đơn / doanh thu: page = theo fanpage phát sinh đơn, ads = theo tỷ trọng QC, owner = về chủ mã */
  attributionMode: AttributionMode;
  attributedRevenue: number;
  attributedProfitBeforeAds: number;
  /** Giá vốn bị trừ trên dòng này (LN1: theo hàng giao TC × tỷ trọng; LN2: toàn bộ hàng nhập, chỉ chủ mã) */
  cogsCharged: number;
  /** % chủ mã: dương = nhận từ người đẩy chéo, âm = chia cho chủ mã */
  ownerBonus: number;
  /** Phần shop giữ lại khi chủ mã chỉ hưởng < 100% LN đơn của mình */
  shopRetained: number;
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
  totals: {
    revenue: number;
    adSpend: number;
    cogs: number;
    shipping: number;
    operating: number;
    operatingEntered: number;
    fixedCost: number;
    perOrderOps: number;
    /**
     * CHI PHÍ CHUNG KHÔNG CHIA ĐƯỢC XUỐNG MÃ NÀO — vẫn trừ khỏi `profit`, và hiện riêng ở đây.
     *
     * Chia theo tỷ trọng doanh thu thì kỳ không có doanh thu không có căn cứ chia. Bỏ khoản ấy đi
     * là làm lợi nhuận cao hơn sự thật; chia bừa cho marketer là ném chi phí lên đầu người không
     * liên quan. Nên nó ở lại cấp shop, đọc được, và có bất biến:
     * `Σ operatingAlloc của các mã + sharedUnallocated = operatingEntered + fixedCost + perOrderOps`.
     */
    sharedUnallocated: number;
    months: number;
    testSpend: number;
    profit: number;
  };
  marketers: MarketerProfit[];
  /** Lợi nhuận mã hàng không có quảng cáo và không có người phụ trách (không phân bổ cho ai) */
  unattributedProfit: number;
  unattributedRevenue: number;
  /** Phần LN shop giữ lại khi chủ mã chỉ hưởng ownerPct < 100% đơn của mình */
  shopRetained: number;
  /**
   * LỜI KHAI VỀ NGUỒN CHI PHÍ, nguyên văn từ `lib/queries/cost-engine.ts` — không diễn giải lại.
   * Đây là thứ trả lời câu "lợi nhuận này đã trừ đủ chi phí chưa", nên nó phải đi cùng bảng lương.
   */
  costWarnings: CostEngineWarning[];
  /** Bảng Lương có đang cầm quyền ghi nhận chi phí nhân sự không (xem `lib/queries/payroll-cost.ts`). */
  payrollCovered: boolean;
  /**
   * ĐỘ PHỦ CỦA NGUỒN QUY KẾT — doanh thu giao thành công đã chia cho marketer BẰNG CĂN CỨ NÀO.
   *
   * Một con số lương không nói được nó dựa trên căn cứ nào là một con số không ai kiểm lại được.
   * Bốn nhóm cộng lại đúng bằng tổng doanh thu đem chia.
   */
  attributionCoverage: {
    /** Ảnh chụp người phụ trách fanpage tại MỐC ĐƠN LÊN — nguồn có thẩm quyền. */
    snapshot: number;
    /** Bảng gán PHẲNG `payroll.config.pageMarketers` (không có mốc hiệu lực) — nguồn lấp chỗ. */
    legacyPage: number;
    /** `ad_id` → chiến dịch → marketer, chỉ khi fanpage im lặng. */
    ads: number;
    /** Không căn cứ nào nói được ai: chia theo tỷ trọng QC / về chủ mã / không ai. */
    unmapped: number;
    total: number;
  };
};

export async function loadPayrollConfig(): Promise<PayrollConfig> {
  const cfg = await getSettingJson<Partial<PayrollConfig>>(PAYROLL_CONFIG_KEY, DEFAULT_PAYROLL_CONFIG);
  const productShares: PayrollConfig["productShares"] = {};
  for (const [pid, v] of Object.entries(cfg.productShares ?? {})) {
    if (!v || typeof v !== "object") continue;
    const ownerPct = Number((v as { ownerPct?: unknown }).ownerPct);
    const crossPct = Number((v as { crossPct?: unknown }).crossPct);
    productShares[pid] = { ownerPct: Number.isFinite(ownerPct) ? ownerPct : 100, crossPct: Number.isFinite(crossPct) ? crossPct : 95 };
  }
  return {
    productOwners: cfg.productOwners ?? {},
    ownerSharePct: Number.isFinite(Number(cfg.ownerSharePct)) ? Number(cfg.ownerSharePct) : 5,
    pageMarketers: Object.fromEntries(Object.entries(cfg.pageMarketers ?? {}).filter(([k, v]) => k && typeof v === "string" && v)),
    productShares,
  };
}

/** Doanh số (đơn đã xác nhận, không huỷ) hoặc doanh thu giao thành công của từng mã theo fanpage phát sinh đơn */
export async function salesByProductPage(period: Period, mode: "confirmed" | "delivered"): Promise<Map<string, PageBucket[]>> {
  return memo(`salesByProductPage:${periodKey(period)}:${mode}`, 120_000, async () => {
    const db = await getDb();
    const i = schema.orderItems;
    const o = schema.orders;
    const s = schema.shipments;
    const pv = schema.productVariants;
    const productKey = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
    const cond = mode === "delivered" ? sql`${ORDER_OUTCOME_FAST} = 'DELIVERED'` : sql`${o.stage} not in ('CANCELLED','DELETED')`;
    /*
      ẢNH CHỤP NGƯỜI PHỤ TRÁCH FANPAGE TẠI MỐC ĐƠN LÊN.

      `order_attributions` giữ, cho từng đơn, CHÍNH người phụ trách fanpage tại lúc đơn phát sinh
      (và chính dòng phân công đã dùng). Một-một với `orders` (`order_attribution_order_uq`) nên
      phép nối này không nhân dòng.

      Đây là NGUỒN DUY NHẤT (chủ shop chốt 15/09/2026). Bảng gán phẳng `payroll.config.pageMarketers`
      và đường `ad_id` → chiến dịch → marketer đều đã thôi tham gia quyết định ai được tính đơn —
      lý lẽ đầy đủ ở `lib/constants/payroll.ts::attributionShares`. Cột `status` lấy theo để màn
      hình nói được phần chưa quy kết thuộc loại nào (không có page · chưa gán · trùng đơn).
    */
    const oa = schema.orderAttributions;
    const rows = await db
      .select({ productId: productKey, pageId: o.pageId, snapshotMarketerId: oa.marketerId, attributionStatus: oa.status, value: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${cond}), 0)` })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(oa, eq(oa.orderId, o.id))
      .where(and(eq(i.isBonus, false), ...(mode === "confirmed" ? [inArray(o.stage, [...CONFIRMED_STAGES])] : []), ...periodConds(o.insertedAt, period)))
      .groupBy(sql`1`, o.pageId, oa.marketerId, oa.status);
    const map = new Map<string, PageBucket[]>();
    for (const r of rows) {
      if (!r.productId) continue;
      const list = map.get(r.productId) ?? [];
      list.push({
        pageId: r.pageId || null,
        value: Number(r.value),
        snapshotMarketerId: r.snapshotMarketerId || null,
        attributionStatus: (r.attributionStatus as PageBucket["attributionStatus"]) ?? null,
      });
      map.set(r.productId, list);
    }
    return map;
  });
}

export type PageOption = { pageId: string; name: string; orders: number; sales: number; lastAt: Date | null };

/** Fanpage có đơn trong 90 ngày (để gán page → marketer), kèm tên page từ Pancake nếu có token */
export async function listPagesForConfig(): Promise<PageOption[]> {
  return memo("listPagesForConfig", 300_000, async () => {
    const db = await getDb();
    const o = schema.orders;
    const since = new Date(Date.now() - 90 * 86_400_000);
    const rows = await db
      .select({ pageId: o.pageId, orders: sql<number>`count(*)`, sales: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}), 0)`, lastAt: sql<string | null>`max(${o.insertedAt})` })
      .from(o)
      .where(and(gte(o.insertedAt, since), sql`coalesce(${o.pageId}, '') <> ''`, sql`${o.stage} not in ('CANCELLED','DELETED')`))
      .groupBy(o.pageId)
      .orderBy(sql`2 desc`);
    let names = new Map<string, string>();
    try {
      const { getPancakePagesClient } = await import("@/lib/integrations/pancake/pages");
      const pages = await getPancakePagesClient().listPages();
      names = new Map(pages.map((p) => [p.id, p.name]));
    } catch {
      // không có token / lỗi API → chỉ hiện page_id
    }
    return rows.filter((r) => r.pageId).map((r) => ({ pageId: r.pageId as string, name: names.get(r.pageId as string) ?? "", orders: Number(r.orders), sales: Number(r.sales), lastAt: r.lastAt ? new Date(r.lastAt) : null }));
  });
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
  // cast bigint: cước (int4) × tiền hàng (int4) dễ vượt 2,1 tỷ → "integer out of range"
  const shipFee = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)::bigint`;
  /*
    JIT TẮT TRONG ĐÚNG GIAO DỊCH NÀY.

    Cùng họ truy vấn với `vsales` (order_items × orders × shipments kèm tra kết quả đơn), và họ đó
    đã đo được trên production: 8.578ms với JIT, 26ms không JIT, cùng số khối đệm. Trang Lương quá
    hạn 60 giây ở lượt smoke nguội trong khi lượt trước nó 91ms — đúng dấu hiệu chi phí biên dịch
    chỉ phải trả khi đệm rỗng.

    Không đổi một phép tính nào: `set local` chỉ tắt trình biên dịch, kế hoạch và kết quả y nguyên.
  */
  /*
    CHỈ BỌC HAI TRUY VẤN NẶNG, KHÔNG BỌC CẢ `Promise.all`.

    Bản đầu bọc cả `getOperatingCost()` và `resolveAssumptions()` — hai hàm tự mở kết nối RIÊNG.
    Giao dịch giữ một kết nối rồi chờ hai hàm kia, hai hàm kia chờ kết nối: khoá chết. Trên PGlite
    (một kết nối duy nhất) nó treo tuyệt đối, và treo im lặng — Node thoát mã 0, bộ kiểm thử bị cắt
    cụt ở giữa mà vẫn báo thành công.

    Luật rút ra: giao dịch chỉ được ôm những câu lệnh chạy TRÊN CHÍNH nó.
  */
  const [[sales, receipts], exp, assumptions] = await Promise.all([
    chayKhongJit(db, (tx) => Promise.all([
    tx
      .select({
        productId: productKey,
        productName: sql<string>`max(coalesce(${p.name}, ${i.productName}))`,
        code: sql<string>`max(coalesce(${p.customId}, ''))`,
        // đơn đã gửi đi (có vận đơn, không huỷ) — cơ sở tính đóng hàng & nhân viên vận đơn
        sentOrders: sql<number>`count(distinct ${o.id}) filter (where ${s.id} is not null and ${o.stage} not in ('CANCELLED','DELETED') and ${s.stage} not in ('CANCELLED','PENDING'))`,
        firstAt: sql<string | null>`min(${o.insertedAt})`,
        lastAt: sql<string | null>`max(${o.insertedAt})`,
        deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
        /*
          ═══ HÀNG TẶNG: KHÔNG CÓ DOANH THU, NHƯNG CÓ GIÁ VỐN ═══

          Bản cũ loại hàng tặng ngay ở `WHERE` (`is_bonus = false`), nên giá vốn của nó KHÔNG BAO
          GIỜ vào lợi nhuận — trong khi nó vẫn trừ tồn như hàng bán (AGENTS.md mục 10) và vẫn là
          tiền thật đã bỏ ra. Tặng càng nhiều thì lợi nhuận trông càng đẹp, đúng chiều hỏng nguy
          hiểm nhất.

          Đo trên production 15/09/2026: hiện có **0 dòng** hàng tặng, nên bản vá này KHÔNG đổi một
          con số nào hôm nay. Sửa lúc nó chưa tốn gì là rẻ nhất — ngày shop bắt đầu ghi hàng tặng
          thì khoản ấy sẽ biến mất mà không ai thấy.

          Lọc chuyển từ `WHERE` vào TỪNG CỘT, vì hai cột cần hai tập dòng khác nhau:
            · doanh thu  — chỉ dòng BÁN (tặng không sinh doanh thu);
            · giá vốn    — CẢ dòng tặng.
          `deliveredOrders`/`sentOrders` đếm `distinct` theo đơn nên không bị thổi lên; `shipping`
          chia theo `lineTotal` nên dòng tặng (lineTotal = 0) nhận đúng 0 phần cước.
        */
        revenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED' and ${i.isBonus} = false), 0)`,
        cogsDelivered: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED'), 0)`,
        shipping: sql<number>`coalesce(sum(${shipFee} * ${i.lineTotal} / ${orderTotal}) filter (where ${ORDER_OUTCOME_FAST} in ('DELIVERED','RETURNED','RETURNED_BY_RULE','IN_TRANSIT')), 0)`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, eq(p.id, sql`coalesce(${pv.productId}, ${i.productId})`))
      // Hàng tặng KHÔNG bị loại ở đây nữa — xem chú thích ở cột `revenue`. Loại ở `WHERE` là loại
      // luôn cả giá vốn của nó.
      .where(and(...periodConds(o.insertedAt, period)))
      .groupBy(sql`1`),
    tx
      .select({ productId: pv.productId, cost: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity} * ${schema.stockReceiptItems.unitCost}), 0)` })
      .from(schema.stockReceiptItems)
      .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
      .innerJoin(pv, eq(pv.id, schema.stockReceiptItems.variantId))
      .where(and(eq(schema.stockReceipts.kind, "RECEIPT"), sql`${schema.stockReceiptItems.quantity} > 0`, ...periodConds(schema.stockReceipts.receivedAt, period)))
      .groupBy(pv.productId),
    ])),
    // Nền chi phí của bảng lương phải là CÙNG con số với báo cáo lợi nhuận, nên đi chung engine.
    getOperatingCost(period),
    resolveAssumptions(),
  ]);
  const purchase = new Map(receipts.filter((r) => r.productId).map((r) => [r.productId as string, Number(r.cost)]));
  const operatingEntered = exp.amount;
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
    const rescued = rescuedFromRate(sentOrders, Number(assumptions.rescueRatePercent ?? 10));
    const ops = opsCosts({ orders: sentOrders, rescued }, assumptions);
    return { productId: r.productId, productName: r.productName ?? "", code: r.code ?? "", deliveredOrders: Number(r.deliveredOrders), sentOrders, rescued, revenue: Number(r.revenue), cogsDelivered: Math.round(Number(r.cogsDelivered)), shipping: Math.round(Number(r.shipping)), purchaseCost: purchase.get(r.productId) ?? 0, ...ops };
  });
  const revenueTotal = rows.reduce((a, r) => a + r.revenue, 0);
  // mã có nhập hàng nhưng chưa có đơn trong kỳ vẫn cần hiện (LN2 trừ giá vốn hàng nhập)
  for (const [pid, cost] of purchase) if (!rows.some((r) => r.productId === pid)) rows.push({ productId: pid, productName: "", code: "", deliveredOrders: 0, sentOrders: 0, rescued: 0, revenue: 0, cogsDelivered: 0, shipping: 0, purchaseCost: cost, packingCost: 0, opsStaffCost: 0 });
  const perOrderTotal = rows.reduce((a, r) => a + r.packingCost + r.opsStaffCost, 0);
  // CP vận hành phân bổ của mã = (đã nhập + cố định) theo tỷ trọng doanh thu GTC + đóng hàng & NV vận đơn theo đơn của chính mã
  const operating = operatingEntered + fixedCost + perOrderTotal;
  // Chia bằng largest remainder ⇒ Σ phần phân bổ của các mã = ĐÚNG (đã nhập + cố định), không lệch
  // vì làm tròn từng dòng; lương/hoa hồng cộng lại phải khớp tổng chi phí của shop.
  const sharedParts = distributeProportionally(operatingEntered + fixedCost, rows.map((r) => r.revenue));
  /*
    ═══ CHI PHÍ KHÔNG PHÂN BỔ ĐƯỢC VẪN LÀ CHI PHÍ ═══

    `distributeProportionally` chia theo TỶ TRỌNG DOANH THU. Khi mọi dòng có doanh thu bằng 0 —
    kỳ chưa có đơn giao thành công, kỳ mới mở, hay một kỳ ngắn toàn đơn hoàn — tổng trọng số bằng
    0 nên hàm trả về toàn số 0 và KHÔNG chia gì cả. Bản thân hàm không sai: không có căn cứ nào để
    chia một triệu đồng cho những dòng đều bằng 0.

    Chỗ sai là ở ĐÂY, phía gọi. Lợi nhuận shop được cộng từ các dòng ĐÃ PHÂN BỔ, nên một triệu
    đồng tiền thuê nhà không chia được sẽ lặng lẽ biến mất khỏi lợi nhuận — bảng vẫn cân, không
    cảnh báo nào, chỉ là lợi nhuận cao hơn sự thật đúng một triệu. Và đó là con số dùng để trả
    lương.

    Nên phần không chia được KHÔNG bị bỏ: nó ở lại CẤP SHOP như một dòng đối soát đọc được, và vẫn
    bị trừ khỏi lợi nhuận shop. Bất biến phải giữ: Σ phần phân bổ + phần còn ở cấp shop = tổng chi
    phí nguồn. Chia bừa cho các marketer là cách hỏng còn tệ hơn — nó ném chi phí lên đầu người
    không liên quan.
  */
  const sharedAllocated = sharedParts.reduce((t, v) => t + v, 0);
  const sharedUnallocated = operatingEntered + fixedCost - sharedAllocated;
  return {
    rows: rows.map((r, idx) => ({ ...r, operatingAlloc: sharedParts[idx] + r.packingCost + r.opsStaffCost })),
    operating,
    operatingEntered,
    fixedCost,
    perOrderTotal,
    /** Phần chi phí chung KHÔNG chia được xuống mã nào (không có căn cứ chia) — vẫn trừ ở cấp shop. */
    sharedUnallocated,
    months,
    revenueTotal,
    /*
      CẢNH BÁO CỦA MÁY CHI PHÍ ĐI CÙNG CON SỐ, KHÔNG BỊ BỎ LẠI.

      `getOperatingCost` trả về cả con số LẪN lời khai về nguồn: lương đang lấy từ bảng Chi phí hay
      bảng Lương, khoản nào bị loại vì trùng nguồn, cơ sở hoa hồng đã chốt chưa. Trước đây chỗ này
      chỉ lấy `.amount` rồi vứt `.warnings` — nên `/expenses` biết chi phí đang thiếu gì, còn
      `/payroll` thì không, dù /payroll mới là nơi con số ấy biến thành tiền trả cho người thật.
    */
    costWarnings: exp.warnings,
    payrollCovered: exp.payrollCovered,
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
  const [nominal, employees, config, econ, byPage] = await Promise.all([getNominalProfitReport(period), listEmployees(), loadPayrollConfig(), productEconomics(period), salesByProductPage(period, "delivered")]);
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
  /*
    BA THỨ KHÁC NHAU, BA CÁI TÊN KHÁC NHAU.

    `id = null`  ⇒ KHÔNG AI nhận phần này — "Chưa gán marketer".
    `id` có mà không tìm thấy trong sổ nhân sự ⇒ dòng phân công còn trỏ tới một người ĐÃ GỠ khỏi
    sổ lương. Gọi nó là "Chưa gán marketer" thì hai (hoặc ba) id lạ khác nhau cùng mang một cái
    tên trên màn hình, và phần doanh thu ấy trông như chưa thuộc về ai trong khi nó ĐANG thuộc về
    một khoá cụ thể — chỉ là khoá ấy mồ côi. Nêu thẳng id để chủ shop tra được và khai lại.
  */
  const labelOf = (id: string | null, emp: Employee | null | undefined) =>
    emp ? emp.shortName || emp.name : id ? `Nhân sự đã gỡ khỏi sổ lương (${id})` : "Chưa gán marketer";
  const marketers = new Map<string | null, MarketerProfit>();
  const ensure = (id: string | null) => {
    let m = marketers.get(id);
    if (!m) {
      const emp = nameOf(id);
      m = { marketerId: id, name: labelOf(id, emp), adSpend: 0, testSpend: 0, totalSpend: 0, attributedRevenue: 0, attributedOrders: 0, attributedProfitBeforeAds: 0, cogsCharged: 0, ownerBonusReceived: 0, ownerBonusPaid: 0, ownedProducts: [], personalProfit: 0, products: [] };
      marketers.set(id, m);
    }
    return m;
  };
  const products: ProductProfitLine[] = [];
  let shopRetained = 0;
  const totals = { revenue: 0, adSpend: 0, cogs: 0, shipping: 0, operating: econ.operating, operatingEntered: econ.operatingEntered, fixedCost: econ.fixedCost, perOrderOps: econ.perOrderTotal, sharedUnallocated: econ.sharedUnallocated, months: econ.months, testSpend: 0, profit: 0 };
  let unattributedProfit = 0;
  let unattributedRevenue = 0;
  const coverage = { snapshot: 0, unmapped: 0, total: 0, byGap: { NO_PAGE: 0, NO_ASSIGNMENT: 0, DUPLICATE: 0, MISSING: 0 } as Record<AttributionGapReason, number> };

  /*
    ═══ MÃ CHỈ CÓ TIỀN QUẢNG CÁO, CHƯA CÓ ĐƠN — VẪN LÀ CHI PHÍ CỦA KỲ ═══

    Vòng lặp dưới đây đi theo `econ.rows`, mà `econ.rows` dựng từ DÒNG HÀNG ĐÃ BÁN và PHIẾU NHẬP.
    Một mã vừa mở chiến dịch, đã tiêu tiền quảng cáo, nhưng chưa có đơn nào và chưa nhập lô nào thì
    KHÔNG có dòng — nên `byProduct.get(row.productId)` không bao giờ được hỏi tới, và toàn bộ tiền
    quảng cáo của mã ấy rơi ra ngoài lợi nhuận.

    Đây đúng là hình dạng chi tiêu của một mã mới: tiêu trước, bán sau. Bỏ nó ra khỏi kỳ làm lợi
    nhuận kỳ CAO HƠN sự thật, và cao đúng bằng khoản đang đốt để thử mã — khoản mà chủ shop cần
    thấy nhất.

    Nên bổ sung một dòng doanh thu 0 cho từng mã như vậy. Phần còn lại của vòng lặp xử lý nó y như
    mọi mã khác: `attributionShares` không có dữ liệu fanpage sẽ rơi về chiều QUẢNG CÁO, tức chi
    phí về đúng người đã chạy chiến dịch đó — không phải chia đều, không phải rơi vào "chưa gán".
  */
  const econRows = [...econ.rows];
  const coMatTrongEcon = new Set(econ.rows.map((r) => r.productId));
  for (const [productId, spend] of byProduct) {
    if (!productId || coMatTrongEcon.has(productId) || spend.total <= 0) continue;
    econRows.push({
      productId,
      productName: "",
      code: "",
      deliveredOrders: 0,
      sentOrders: 0,
      rescued: 0,
      revenue: 0,
      cogsDelivered: 0,
      shipping: 0,
      purchaseCost: 0,
      packingCost: 0,
      opsStaffCost: 0,
      operatingAlloc: 0,
    });
  }

  for (const row of econRows) {
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
    const attribution = attributionShares({ byPage: byPage.get(row.productId) ?? [] });
    coverage.snapshot += attribution.mappedValue;
    coverage.unmapped += attribution.unmappedValue;
    coverage.total += attribution.mappedValue + attribution.unmappedValue;
    for (const reason of ATTRIBUTION_GAP_REASONS) coverage.byGap[reason] += attribution.byGap[reason];
    const shares = attribution.shares;
    if (!shares.size) {
      unattributedProfit += profit;
      unattributedRevenue += row.revenue;
      continue;
    }
    /*
      PHẦN CHƯA QUY KẾT ĐƯỢC KHÔNG BỊ CHIA CHO AI — và cũng không được biến mất.

      `shares` nay cộng lại ≤ 1: phần thiếu chính là phần không nguồn nào nói được ai. Trước bản
      này nó được chia lại theo tỷ trọng tiền quảng cáo / ném về chủ mã, nên doanh thu của một
      kênh khác (landing, đơn nhập tay) nằm trên thẻ điểm một marketer. Nay nó ở lại nhóm
      "Chưa gán marketer", và bất biến Σ marketer + chưa gán = tổng của shop vẫn đúng.
    */
    const sharedPct = [...shares.values()].reduce((t, v) => t + v, 0);
    const gapPct = Math.max(0, 1 - sharedPct);
    if (gapPct > 0) {
      unattributedRevenue += Math.round(row.revenue * gapPct);
      unattributedProfit += Math.round(profit * gapPct);
    }
    const pctShare = shareFor(config, row.productId);
    if (ownerId) ensure(ownerId).ownedProducts.push(row.code || row.productName);
    let ownerBonusTotal = 0;
    for (const [mid, share] of shares) {
      const m = ensure(mid);
      const mySpend = spend?.byMarketer.get(mid) ?? 0;
      const isOwner = ownerId !== null && mid === ownerId;
      const cogsCharged = useDeliveredCogs ? Math.round(row.cogsDelivered * share) : isOwner ? row.purchaseCost : 0;
      const base = Math.round(variable * share) - mySpend - (useDeliveredCogs ? 0 : cogsCharged);
      // chủ mã giữ ownerPct % LN đơn của mình (còn lại shop giữ); người chạy cùng giữ crossPct %, phần còn lại về chủ mã
      const split = splitProfit(base, isOwner || !ownerId ? "owner" : "cross", isOwner || !ownerId ? pctShare : pctShare);
      const bonus = !isOwner && ownerId ? split.toOwner : 0;
      const toShop = isOwner || !ownerId ? split.toShop : 0;
      ownerBonusTotal += bonus;
      shopRetained += toShop;
      const line: MarketerProductLine = {
        productId: row.productId,
        productName: row.productName,
        code: row.code,
        role: isOwner ? "owner" : "cross",
        adSpend: mySpend,
        share,
        attributionMode: attribution.mode,
        attributedRevenue: Math.round(row.revenue * share),
        attributedProfitBeforeAds: Math.round(variable * share),
        cogsCharged,
        ownerBonus: -bonus,
        shopRetained: toShop,
        personalProfit: base - bonus - toShop,
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
        o.products.push({ productId: row.productId, productName: row.productName, code: row.code, role: "owner", adSpend: 0, share: 0, attributionMode: attribution.mode, attributedRevenue: 0, attributedProfitBeforeAds: 0, cogsCharged, ownerBonus: ownerBonusTotal, shopRetained: 0, personalProfit: ownerBonusTotal - cogsCharged, orders: 0 });
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
  /*
    Phần chi phí chung không chia được xuống mã nào (xem `productEconomics`) vẫn phải trừ khỏi lợi
    nhuận shop — nó là tiền đã ra khỏi túi, chỉ là không có căn cứ để gán cho một mã cụ thể. Trừ ở
    ĐÂY, sau vòng lặp, chính là cách giữ bất biến "lợi nhuận shop = doanh thu − TOÀN BỘ chi phí"
    mà không ném khoản ấy lên đầu một marketer nào.
  */
  totals.profit -= totals.sharedUnallocated;
  for (const m of marketers.values()) {
    m.totalSpend = m.adSpend + m.testSpend;
    m.products.sort((a, b) => b.personalProfit - a.personalProfit);
  }
  for (const e of employees) if (e.active && e.department === "Marketing" && !marketers.has(e.id)) ensure(e.id);
  const list = [...marketers.values()].sort((a, b) => (a.marketerId === null ? 1 : b.marketerId === null ? -1 : b.personalProfit - a.personalProfit));
  products.sort((a, b) => b.profit - a.profit);
  return { basis, config, nominal, products, totals, marketers: list, unattributedProfit, unattributedRevenue, shopRetained, costWarnings: econ.costWarnings, payrollCovered: econ.payrollCovered, attributionCoverage: coverage };
}

/**
 * ─────────── NHÂN SỰ NÀY CÓ PHẢI CHÍNH NGƯỜI ĐANG ĐĂNG NHẬP KHÔNG ───────────
 *
 * Đây là CỔNG của quyền "Lương: xem của mình": nó quyết định một người thấy dòng lương nào. Nên nó
 * chỉ được nhận MỘT bằng chứng — LIÊN KẾT TÀI KHOẢN mà quản trị khai đích danh trong hồ sơ nhân sự
 * (ô "Email đăng nhập ERP"), so khớp ĐÚNG với email phiên đăng nhập.
 *
 * VÌ SAO BỎ NHÁNH SO TÊN. Bản cũ, khi email không khớp (hoặc bỏ trống), rơi xuống so TÊN ĐẦY ĐỦ và
 * TÊN NGẮN đã bỏ dấu. Hai người cùng tên — "Nguyễn Văn Nam" và "Nguyen Van Nam", hay hai nhân sự
 * cùng tên ngắn "Nam" — là chuyện bình thường ở một shop; ở đây nó thành một người đọc được bảng
 * lương của người kia. Tên là Ô CHỮ HIỂN THỊ, đổi được bất cứ lúc nào và không ai coi việc đổi tên
 * hiển thị là một lượt cấp quyền. AGENTS.md mục 34: quy kết đi bằng KHOÁ TÀI KHOẢN, không bằng ô
 * chữ; mục 31: mọi nhánh lỗi phải rơi về phía HẸP HƠN.
 *
 * Chưa khai email ⇒ KHÔNG khớp ai. Đó là mất quyền xem, không phải lộ dữ liệu — và màn hình nói
 * thẳng phải làm gì để có lại ("nhờ quản trị khai báo email đăng nhập trong hồ sơ nhân sự").
 */
export function employeeMatchesUser(e: Pick<Employee, "name" | "shortName" | "userEmail">, user: { email: string; name: string }): boolean {
  const declared = (e.userEmail ?? "").trim().toLowerCase();
  const signedIn = (user.email ?? "").trim().toLowerCase();
  return Boolean(declared) && Boolean(signedIn) && declared === signedIn;
}

export type PayrollLine = {
  employee: Employee;
  totalProfit: number;
  personalProfit: number | null;
  personalRevenue: number | null;
  /** Lương cứng KHAI BÁO mỗi tháng — con số trong hồ sơ nhân sự, không phụ thuộc kỳ đang xem. */
  fixedMonthly: number;
  /**
   * Lương cứng THUỘC KỲ ĐANG XEM, chia theo số ngày chồng lấn của từng tháng
   * (`prorateMonthlyAmount`, AGENTS.md mục 14 và 16 — lương cố định đi theo THỜI GIAN).
   *
   * `null` = kỳ KHÔNG có mốc đầu/cuối ("Toàn bộ") nên không chia theo ngày được. CHƯA BIẾT, không
   * phải 0 (AGENTS.md mục 42).
   */
  fixed: number | null;
  bonusTotal: number;
  /** `null` = CHƯA BIẾT (không quy đổi được LN cá nhân sang cơ sở dòng tiền), khác hẳn 0. */
  bonusPersonal: number | null;
  bonusRevenue: number;
  /** `null` khi một phần bất kỳ chưa biết — một phần chưa biết thì tổng cũng chưa biết. */
  salary: number | null;
  /**
   * BÙ TRỪ LỖ LŨY KẾ CỦA CHÍNH NGƯỜI NÀY (chủ shop chốt 15/09/2026).
   *
   * `null` = sổ KHÔNG ÁP DỤNG cho kỳ đang xem (chưa bật, kỳ không phải một tháng lịch, hoặc tháng
   * nằm trước mốc mở sổ). Khác hẳn "áp dụng nhưng số dư chưa biết" — ca đó `carry` có giá trị và
   * bên trong nó `openingBalance` mới là `null`.
   */
  carry: PayrollCarryLine | null;
};

/** Một dòng bù trừ lỗ lũy kế, đủ để chủ shop đọc mà không cần mở thêm màn hình nào. */
export type PayrollCarryLine = {
  monthKey: string;
  /** Số dư lỗ đầu tháng (≤ 0). `null` = CHƯA BIẾT. */
  openingBalance: number | null;
  openingBasis: OpeningBasis;
  /** Số dư đã đủ căn cứ để CHỐT kỳ chưa. Xem được không có nghĩa là chốt được. */
  openingEstablished: boolean;
  openingReason: string;
  /** LN thực phát sinh của tháng — lỗ cũ KHÔNG bị trừ vào đây lần nữa. */
  realProfit: number | null;
  /** Phần lỗ cũ được bù trong tháng (≥ 0). */
  lossApplied: number | null;
  /** `max(LN thực + số dư đầu, 0)` — cơ sở tính hoa hồng được trả. */
  commissionBase: number | null;
  /** `r × (LN thực + số dư đầu)`, GIỮ DẤU. Chỉ để theo dõi, không phải tiền phải trả. */
  signedCommission: number | null;
  /** Số dư chuyển sang tháng sau (≤ 0). */
  closingBalance: number | null;
};

export type PayrollReport = {
  basis: PayrollBasis;
  totalProfit: number;
  /** LN danh nghĩa tổng (để đối chiếu) */
  nominalTotal: number;
  /**
   * Hệ số quy đổi LN cá nhân sang dòng tiền thực (= 1 khi KHÔNG phải cơ sở dòng tiền).
   *
   * `null` = CHƯA TÍNH ĐƯỢC: cơ sở dòng tiền quy đổi bằng `LN dòng tiền ÷ LN1 toàn shop`, mà LN1
   * toàn shop ≤ 0 thì phép chia ấy không có nghĩa (mẫu số 0 ⇒ vô định; mẫu số âm ⇒ hệ số âm, đem
   * nhân vào là LẬT DẤU lợi nhuận của từng người). Khi ấy LN cá nhân và thưởng theo LN cá nhân là
   * CHƯA BIẾT, không phải 0.
   */
  cashRatio: number | null;
  /** Vì sao `cashRatio` là `null` — hiện thẳng ra màn hình, không nuốt. */
  cashRatioReason: string | null;
  lines: PayrollLine[];
  /** `null` khi lương cứng của kỳ chưa biết — xem `PayrollLine.fixed`. */
  totalSalary: number | null;
  /**
   * CĂN CỨ CHIA LƯƠNG CỨNG, để màn hình nói được vì sao cột "lương cứng" không bằng con số khai
   * trong hồ sơ. `bounded = false` ⇒ kỳ không có mốc đầu/cuối ⇒ lương cứng của kỳ là CHƯA BIẾT.
   */
  fixedBasis: { bounded: boolean; days: number; monthlyTotal: number };
  /**
   * TIỀN LƯƠNG ĐÃ RA KHỎI TÚI TRONG KỲ — đọc `expenses` nhóm "Lương" theo NGÀY PHÁT SINH thô.
   * Chiều khác hẳn "phải trả"; `perPerson: false` vì không chứng từ chi nào mang khoá tài khoản.
   */
  paid: { amount: number; count: number; perPerson: false; missingWhat: string };
  marketers: MarketerReport;
};

/**
 * ═══════ TIỀN LƯƠNG ĐÃ THẬT SỰ RA KHỎI TÚI TRONG KỲ ═══════
 *
 * "PHẢI TRẢ" và "ĐÃ TRẢ" là hai chiều khác nhau, và gộp chúng lại là cách làm mất dấu một tháng
 * lương. Phải trả là phép TÍNH trên kỳ làm việc; đã trả là một SỰ KIỆN TIỀN có ngày của riêng nó —
 * lương tháng 8 trả ngày 05/09 là tiền ra của tháng 9 nhưng là chi phí của tháng 8 (AGENTS.md mục
 * 17). Nên hàm này đọc theo `occurred_at` THÔ, không qua phép phân bổ theo kỳ.
 *
 * ─── VÌ SAO KHÔNG TÁCH ĐƯỢC THEO TỪNG NGƯỜI ───
 *
 * `expenses` không có cột nào trỏ tới một tài khoản: chỉ có `description` là ô chữ tự do. Bổ đôi
 * chuỗi ấy để đoán tên người là đúng thứ AGENTS.md mục 34 cấm — quy kết đi bằng KHOÁ TÀI KHOẢN,
 * không bằng ô chữ. Nên con số này là MỨC TOÀN SHOP và nói thẳng ra như vậy, thay vì chia bừa rồi
 * in ra một cột "đã trả" cạnh tên từng người mà không ai kiểm lại được.
 */
async function salaryPaidInPeriod(period: Period): Promise<{ amount: number; count: number; perPerson: false; missingWhat: string }> {
  const db = await getDb();
  const e = schema.expenses;
  const conds: SQL[] = [eq(e.category, "SALARY")];
  if (period.from) conds.push(gte(e.occurredAt, period.from));
  if (period.to) conds.push(lte(e.occurredAt, period.to));
  const [row] = await db
    .select({ amount: sql<number>`coalesce(sum(${e.amount}), 0)`, count: sql<number>`count(*)` })
    .from(e)
    .where(and(...conds));
  return {
    amount: Number(row?.amount ?? 0),
    count: Number(row?.count ?? 0),
    perPerson: false,
    missingWhat: "Khoản chi nhóm “Lương” không có cột nào trỏ tới một tài khoản nhân sự (chỉ có ô mô tả tự do), nên ERP không tách được “đã trả cho ai”. Muốn có con số ấy thì mỗi lần trả phải ghi kèm khoá tài khoản người nhận.",
  };
}

/** Bảng lương theo kỳ: lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân + % doanh thu cá nhân (thưởng chỉ tính khi số dương) */
export async function getPayrollReport(
  period: Period,
  basis: PayrollBasis,
): Promise<PayrollReport> {
  const [marketers, employees, cash, paid, carryConfig] = await Promise.all([
    getMarketerReport(period, basis),
    listEmployees(),
    basis === "cash" ? getCashProfitReport(period) : Promise.resolve(null),
    salaryPaidInPeriod(period),
    getCarryoverConfig(),
  ]);
  /*
    ═══ SỔ LỖ LŨY KẾ CHỈ ĐI THEO THÁNG LỊCH ═══

    Kỳ 7 ngày, kỳ tuỳ chọn hay một quý KHÔNG được tạo hay cộng lại số dư: số dư là một chuỗi TUẦN
    TỰ theo tháng, và cộng nó lại theo một kỳ khác làm mất đúng phần lỗ mà cơ chế này sinh ra để
    giữ. `wholeMonthKey` trả `null` cho mọi kỳ không phải trọn một tháng, và khi ấy `carry` là
    `null` — "KHÔNG ÁP DỤNG", khác hẳn "chưa biết" và khác hẳn "bằng 0".
  */
  const carryMonth = wholeMonthKey(period.from, period.to);
  const marketerIds = employees.filter((e) => e.active).map((e) => e.id);
  const openings =
    carryMonth && carryConfig.enabled
      ? await resolveOpeningMany(marketerIds, carryMonth, carryConfig)
      : new Map<string, OpeningResolution>();
  const nominalTotal = marketers.nominal.totals.expectedProfit;
  const modelTotal = marketers.totals.profit;
  const totalProfit = basis === "cash" && cash ? cash.net : basis === "nominal" ? nominalTotal : modelTotal;
  /*
    CƠ SỞ DÒNG TIỀN: LN cá nhân = LN1 cá nhân × (LN dòng tiền thực ÷ LN1 tổng). Tiền COD về theo
    bảng kê không tách được theo mã / theo người, nên đây là phép QUY ĐỔI THEO TỶ TRỌNG — một ước
    tính, không phải lợi nhuận đo được của từng người.

    MẪU SỐ ≤ 0 THÌ KHÔNG CÓ HỆ SỐ NÀO CẢ. Bản cũ trả 0 trong ca đó, nên mọi marketer hiện LN cá
    nhân đúng bằng "0 ₫" — đọc thành "người này không tạo ra đồng lợi nhuận nào", trong khi sự thật
    là PHÉP TÍNH KHÔNG CHẠY ĐƯỢC. Và ca ấy không hiếm: LN1 toàn shop ≤ 0 xảy ra ở mọi kỳ lỗ và ở
    những kỳ ngắn chưa kịp có đơn giao thành công. AGENTS.md mục 42 · mục 8.5: CHƯA BIẾT không được
    in ra thành 0.
  */
  const cashRatio = basis === "cash" && cash ? (modelTotal > 0 ? cash.net / modelTotal : null) : 1;
  const cashRatioReason =
    cashRatio === null
      ? `Không quy đổi được sang dòng tiền: LN1 toàn shop của kỳ là ${Math.round(modelTotal).toLocaleString("vi-VN")} ₫ (≤ 0) nên tỷ lệ “LN dòng tiền ÷ LN1 tổng” không có nghĩa. LN cá nhân và thưởng theo LN cá nhân là CHƯA BIẾT ở cơ sở này — xem cơ sở LN1 để có số đo được.`
      : null;
  // Kỳ "Toàn bộ" không có mốc đầu/cuối ⇒ không chia lương tháng theo ngày được ⇒ CHƯA BIẾT.
  const fixedBounded = Boolean(period.from && period.to);
  // Đếm ngày THEO LỊCH VIỆT NAM bằng đúng hàm mà `prorateMonthlyAmount` dùng: chia phút giây cho
  // 86.400.000 rồi làm tròn sẽ lệch một ngày ở mốc cuối 23:59:59.
  const fixedDays = period.from && period.to ? Math.max(0, inclusiveDays(period.from, period.to)) : 0;
  const lines: PayrollLine[] = employees
    .filter((e) => e.active)
    .map((e) => {
      const m = marketers.marketers.find((x) => x.marketerId === e.id);
      /*
        BA TRẠNG THÁI, KHÔNG PHẢI HAI:
          · không phải marketer (`m` rỗng)  ⇒ `null` — không có phần quy kết nào, thưởng = 0 đúng;
          · là marketer nhưng hệ số chưa có ⇒ `null` — CHƯA TÍNH ĐƯỢC, thưởng cũng chưa biết;
          · còn lại                         ⇒ con số.
      */
      const personalProfit = m && cashRatio !== null ? Math.round(m.personalProfit * cashRatio) : null;
      const personalRevenue = m ? m.attributedRevenue : null;
      const bonusTotal = Math.round(
        Math.max(totalProfit, 0) * (e.percentTotal / 100),
      );
      /*
        ═══ CHỖ SỐ ÂM TỪNG BỊ XOÁ ═══

        Bản cũ: `max(personalProfit, 0) × %`. Cái `max` ấy đúng ở chỗ không trả tiền âm cho người
        ta — nhưng nó cũng VỨT MẤT con số âm. Tháng lỗ 10 triệu và tháng hoà vốn cho ra cùng một
        kết quả là 0, nên tháng sau lãi 15 triệu thì người ấy ăn hoa hồng trên đủ 15 triệu như chưa
        từng có tháng lỗ.

        Nay số âm được GIỮ ở sổ (`marketer_profit_carryover`) và bù trước khi tính thưởng. Tiền trả
        vẫn không bao giờ âm — cái đổi là CƠ SỞ để nhân tỷ lệ, không phải dấu của khoản phải trả.

        Sổ chưa bật ⇒ nhánh dưới chạy y như trước. Đây là thay đổi cách tính tiền của người thật,
        nên nó không được tự áp: chủ shop bật và khai tháng mở sổ thì mới có hiệu lực.
      */
      const opening = carryMonth ? openings.get(e.id) : undefined;
      const carry: PayrollCarryLine | null =
        carryMonth && opening && opening.basis !== "NOT_APPLICABLE"
          ? (() => {
              const r = carryoverMonth({
                openingBalance: opening.balance,
                realProfit: personalProfit ?? 0,
                commissionPercent: e.percentPersonal,
              });
              return {
                monthKey: carryMonth,
                openingBalance: opening.balance,
                openingBasis: opening.basis,
                openingEstablished: opening.established,
                openingReason: opening.reason,
                // LN cá nhân chưa tính được (cơ sở dòng tiền mẫu số ≤ 0) thì LN thực của tháng
                // cũng chưa biết — không được đọc thành "người này làm ra 0 đồng".
                realProfit: personalProfit,
                lossApplied: personalProfit === null ? null : r.lossApplied,
                commissionBase: personalProfit === null ? null : r.commissionBase,
                signedCommission: personalProfit === null ? null : r.signedCommission,
                closingBalance: personalProfit === null ? null : r.closingBalance,
              };
            })()
          : null;
      const bonusPersonal =
        m && cashRatio === null
          ? null
          : carry
            ? carry.commissionBase === null
              ? null
              : Math.round((carry.commissionBase * e.percentPersonal) / 100)
            : Math.round(Math.max(personalProfit ?? 0, 0) * (e.percentPersonal / 100));
      const bonusRevenue = Math.round(
        Math.max(personalRevenue ?? 0, 0) * (e.percentRevenue / 100),
      );
      const fixedMonthly = Math.max(0, Math.round(Number(e.fixed) || 0));
      /*
        LƯƠNG CỨNG THUỘC KỲ, KHÔNG PHẢI LƯƠNG CỨNG MỘT THÁNG.

        Trước đây cột này chép thẳng `e.fixed` — con số khai theo THÁNG — vào bất kỳ kỳ nào người
        dùng chọn. Xem 7 ngày: bảng cộng đủ một tháng lương vào kỳ bảy ngày. Xem quý: bảng cộng
        đúng MỘT tháng lương cho ba tháng làm việc. Cùng lúc ấy `lib/queries/payroll-cost.ts` —
        cửa mà Profit Engine hỏi chi phí nhân sự — đã chia theo ngày bằng `prorateMonthlyAmount`.
        Hai nơi trong cùng một kho mã nói hai con số khác nhau về cùng một khoản lương, và nơi
        chủ shop nhìn để TRẢ TIỀN lại là nơi sai.

        Nay cả hai đi cùng một hàm, cùng luật: chia theo số ngày chồng lấn của TỪNG THÁNG THẬT
        (AGENTS.md mục 14 · 16). Cộng đủ một tháng vẫn ra đúng khoản tháng, không dư không thiếu.
      */
      const fixed = fixedBounded ? prorateMonthlyAmount(fixedMonthly, period.from, period.to) : null;
      return {
        employee: e,
        totalProfit,
        personalProfit,
        personalRevenue,
        fixedMonthly,
        fixed,
        bonusTotal,
        bonusPersonal,
        bonusRevenue,
        salary: fixed === null || bonusPersonal === null ? null : fixed + bonusTotal + bonusPersonal + bonusRevenue,
        carry,
      };
    });
  return {
    basis,
    totalProfit,
    nominalTotal,
    cashRatio,
    cashRatioReason,
    paid,
    lines,
    totalSalary: fixedBounded && lines.every((l) => l.salary !== null) ? lines.reduce((s, l) => s + (l.salary ?? 0), 0) : null,
    fixedBasis: {
      bounded: fixedBounded,
      days: fixedDays,
      monthlyTotal: lines.reduce((s, l) => s + l.fixedMonthly, 0),
    },
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
  /** Phần shop giữ lại khi chủ mã hưởng < 100% */
  shopRetained: number;
  /** Cách ghi nhận đơn: theo fanpage / theo QC / về chủ mã */
  attributionMode: AttributionMode;
  /** LN ròng cá nhân từ mã = profitBeforeAds − adSpend − otherCost ± ownerBonus − shopRetained */
  personalNet: number;
};

/** Lợi nhuận danh nghĩa (ước tính theo đơn lên trong kỳ) chia theo marketer — cùng quy tắc chủ mã / đẩy chéo với bảng lương */
export async function getNominalMarketerBreakdown(period: Period): Promise<{ rows: NominalMarketerRow[]; unattributed: number; shopRetained: number; ownerSharePct: number; pagesMapped: number; pagesTotal: number }> {
  return memo(`nominalByMarketer:${periodKey(period)}`, 120_000, async () => {
    const db = await getDb();
    const [nominal, employees, config, byPage] = await Promise.all([getNominalProfitReport(period), listEmployees(), loadPayrollConfig(), salesByProductPage(period, "confirmed")]);
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
        // Cùng ba trạng thái như `getMarketerReportUncached`: có người · khoá mồ côi · không ai.
        m = { marketerId: id, name: emp ? emp.shortName || emp.name : id ? `Nhân sự đã gỡ khỏi sổ lương (${id})` : "Chưa gán marketer", ownedProducts: [], adSpend: 0, testSpend: 0, otherCost: 0, attributedOrders: 0, attributedRevenue: 0, profitBeforeAds: 0, ownerBonusReceived: 0, ownerBonusPaid: 0, personalNet: 0, products: [] };
        rows.set(id, m);
      }
      return m;
    };
    let unattributed = 0;
    let shopRetained = 0;
    const pagesSeen = new Set<string>();
    const pagesMappedSet = new Set<string>();
    for (const r of nominal.rows) {
      const spend = byProduct.get(r.productId);
      const ownerId = config.productOwners[r.productId] ?? null;
      // LN ròng danh nghĩa trước QC của mã = LN ròng + QC + chi phí khác theo QC
      const netBeforeAds = r.netProfit + r.adSpend + r.otherCost;
      const adShares = new Map<string | null, number>();
      if (spend && spend.total > 0) for (const [mid, amount] of spend.byMarketer) adShares.set(mid, amount / spend.total);
      const buckets = byPage.get(r.productId) ?? [];
      /*
        "Page đã gán" = có NGƯỜI NÀO nhận đơn của page ấy, bằng BẤT KỲ nguồn fanpage nào — ảnh chụp
        theo mốc đơn lên hay bảng gán phẳng. Đếm riêng bảng phẳng làm con số này báo thiếu đúng vào
        lúc nguồn có thẩm quyền đang phủ tốt nhất, và chủ shop đi gán lại những page đã gán rồi.
      */
      for (const b of buckets) {
        if (!b.pageId) continue;
        pagesSeen.add(b.pageId);
        if (b.snapshotMarketerId || config.pageMarketers[b.pageId]) pagesMappedSet.add(b.pageId);
      }
      const attribution = attributionShares({ byPage: buckets, pageMarketers: config.pageMarketers, adShares, ownerId });
      const shares = attribution.shares;
      if (!shares.size) {
        unattributed += netBeforeAds;
        continue;
      }
      const pctShare = shareFor(config, r.productId);
      if (ownerId) ensure(ownerId).ownedProducts.push(r.code || r.productName);
      let bonusTotal = 0;
      for (const [mid, share] of shares) {
        const m = ensure(mid);
        const mySpend = spend?.byMarketer.get(mid) ?? 0;
        const other = Math.round(mySpend * otherPct);
        const isOwner = ownerId !== null && mid === ownerId;
        const base = Math.round(netBeforeAds * share) - mySpend - other;
        const split = splitProfit(base, isOwner || !ownerId ? "owner" : "cross", pctShare);
        const bonus = !isOwner && ownerId ? split.toOwner : 0;
        const toShop = isOwner || !ownerId ? split.toShop : 0;
        bonusTotal += bonus;
        shopRetained += toShop;
        m.adSpend += mySpend;
        m.otherCost += other;
        m.attributedOrders += Math.round(r.orders * share);
        m.attributedRevenue += Math.round(r.expectedRevenue * share);
        m.profitBeforeAds += Math.round(netBeforeAds * share);
        m.ownerBonusPaid += bonus;
        m.personalNet += base - bonus - toShop;
        m.products.push({ productId: r.productId, code: r.code, productName: r.productName, role: isOwner ? "owner" : "cross", share, attributionMode: attribution.mode, orders: Math.round(r.orders * share), revenue: Math.round(r.expectedRevenue * share), profitBeforeAds: Math.round(netBeforeAds * share), adSpend: mySpend, otherCost: other, ownerBonus: -bonus, shopRetained: toShop, personalNet: base - bonus - toShop });
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
          } else o.products.push({ productId: r.productId, code: r.code, productName: r.productName, role: "owner", share: 0, attributionMode: attribution.mode, orders: 0, revenue: 0, profitBeforeAds: 0, adSpend: 0, otherCost: 0, ownerBonus: bonusTotal, shopRetained: 0, personalNet: bonusTotal });
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
    return { rows: list, unattributed, shopRetained, ownerSharePct: config.ownerSharePct, pagesMapped: pagesMappedSet.size, pagesTotal: pagesSeen.size };
  });
}
