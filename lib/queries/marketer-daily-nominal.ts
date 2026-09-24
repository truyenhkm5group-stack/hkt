import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { distributeProportionally } from "@/lib/constants/cost-allocation";
import { MARKETING_UNATTRIBUTED, MARKETING_UNATTRIBUTED_LABEL } from "@/lib/constants/marketing-daily";
import { CONFIRMED_STAGES } from "@/lib/constants/pancake";
import { attributionShares, type PageBucket } from "@/lib/constants/payroll";
import { CARRIER_HANDOFF_AT_SQL } from "@/lib/constants/report-time-basis";
import type { OrderOutcome } from "@/lib/constants/returns";
import { OUTCOME_GROUP } from "@/lib/constants/truth";
import { adMarketerMap } from "@/lib/integrations/facebook/ads-index";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { listEmployees, loadPayrollConfig } from "@/lib/queries/payroll";
import { getNominalProfitReport, type NominalRow } from "@/lib/queries/profit-nominal";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { getProbabilityLookup, orderDeliveryShare } from "@/lib/queries/projected-delivery";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { AD_MESSAGES } from "@/lib/queries/ads-roas";
import type { Period } from "@/lib/search-params";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ LỢI NHUẬN ƯỚC TÍNH THEO NGÀY × MARKETER — CHIA TỪ BÁO CÁO LỢI NHUẬN, KHÔNG TÍNH LẠI ═══════════
 *
 * Câu hỏi của chủ shop (23/09/2026): *"mỗi ngày trôi qua, từng MKT ra được bao nhiêu đơn, bao nhiêu
 * doanh thu, bao nhiêu lợi nhuận — số ước tính theo đúng logic Báo cáo lợi nhuận"*.
 *
 * Bảng bóc tách cũ ở `/ads/daily` KHÔNG trả lời được câu đó, vì nó đứng trên một bộ máy khác:
 *
 *     ô                bảng bóc tách cũ                     Báo cáo lợi nhuận danh nghĩa
 *     ─────────────────────────────────────────────────────────────────────────────────────
 *     doanh thu        DT thực đã giao + phần đang đi × TL   DT GTC ƯT theo thang bậc của MÃ
 *     cước             cước ĐO ĐƯỢC tới hôm nay              đơn × (GTC × cước gửi + hoàn × cước hoàn)
 *     vận hành/thuế    không có                              phân bổ theo doanh số / số đơn
 *
 * Nên hai trang in hai con số lợi nhuận cho cùng một marketer, và cột "ước tính" của trang này lạc
 * quan đúng bằng phần phí hoàn chưa phát sinh.
 *
 * ─── CÁCH LÀM: SỐ CỦA MÃ LÀ TỔNG, ĐƠN CHỈ LÀ CĂN CỨ CHIA ───
 *
 * Tệp này KHÔNG có công thức tiền nào. Nó đọc `getNominalProfitReport` (CHÍNH hàm dựng bảng lợi
 * nhuận theo mã) rồi CHIA từng khoản của từng mã xuống các (đơn × mã) của mã ấy, mỗi khoản theo
 * một căn cứ khai rõ (AGENTS.md mục 14):
 *
 *     DT GTC ƯT · thuế           ← doanh số dòng × phần giao được của CHÍNH đơn đó
 *     giá vốn ƯT · rủi ro tồn    ← giá vốn dòng × phần giao được của CHÍNH đơn đó
 *     cước ƯT · đóng hàng · NV   ← mỗi (đơn × mã) một phần, đúng cách báo cáo đếm "đơn" của mã
 *     vận hành đã nhập · cố định ← doanh số dòng (báo cáo phân bổ theo doanh số POS)
 *
 * "Phần giao được" là đúng thứ báo cáo đã dùng để ra con số của mã: mã tính theo TỪNG ĐƠN
 * (`ORDER_LEVEL`) thì là trọng số của hợp đồng dự báo (`orderDeliveryShare`); mã tính theo TỶ LỆ
 * (`RATE`) thì là `1 − tỷ lệ hoàn` cho mọi đơn. Chia bằng LARGEST REMAINDER nên cộng mọi ô của một
 * mã ra ĐÚNG ô của mã đó trên Báo cáo lợi nhuận, tới từng đồng — `tests/marketer-daily-nominal
 * .test.ts` khoá điều ấy.
 *
 * ─── AI NHẬN ĐƠN: CÙNG THỨ TỰ CĂN CỨ VỚI BẢNG "LN DANH NGHĨA THEO MARKETER" ───
 *
 * `attributionShares` (lib/constants/payroll.ts): ẢNH CHỤP người phụ trách fanpage tại mốc đơn lên →
 * bảng gán page phẳng → `ad_id` → (đơn trên page chưa gán) tỷ trọng QC trên mã / chủ mã. Khác duy
 * nhất: bảng kia nhân TỶ TRỌNG CẢ KỲ với tiền của mã; ở đây mỗi đơn mang đúng phần giao được của
 * nó, nên ngày cũ đã ngã ngũ không bị kéo về tỷ lệ bình quân của ngày mới. Σ theo mã vẫn khớp.
 *
 * ─── TIỀN QUẢNG CÁO: MỘT NGUỒN, KHÔNG CHIA LẠI ───
 *
 * `ad_spends` theo (ngày chi, marketer). Marketer có đơn mà bảng chi tiêu CHƯA TỪNG khai chiến dịch
 * nào cho họ thì Chi QC và lợi nhuận là CHƯA BIẾT (—), không phải 0 (AGENTS.md mục 67) — tiền thật
 * của họ đang nằm ở dòng "Chưa quy kết". Ngày sau biên đồng bộ chi tiêu cũng vậy.
 */

/* ═══════════════════ HÌNH DẠNG ═══════════════════ */

export type NominalCell = {
  /** Đơn chốt (không huỷ). Có thể lẻ khi một đơn nhiều mã chia cho nhiều người theo QC. */
  orders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /** Đơn còn chưa ngã ngũ (chưa gửi · chờ lấy · đang đi) — thước đo phần "ước tính" của ô. */
  openOrders: number;
  /** Doanh số POS = Σ tiền dòng hàng — đúng `grossSales` của Báo cáo lợi nhuận. */
  posSales: number;
  expectedRevenue: number;
  expectedCogs: number;
  shipCost: number;
  /** Vận hành phân bổ = đã nhập + cố định + đóng hàng + NV vận đơn. */
  opex: number;
  inventoryRisk: number;
  tax: number;
  /** `null` = CHƯA BIẾT (ngày sau biên đồng bộ, hoặc marketer chưa được ghép chiến dịch nào). */
  adSpend: number | null;
  messages: number | null;
  /** CP khác = QC × % ở Giả định. */
  otherCost: number | null;
  /** LN danh nghĩa ƯT = DT GTC ƯT − giá vốn ƯT − cước ƯT − QC. */
  expectedProfit: number | null;
  /** LN ròng ƯT = LN danh nghĩa − vận hành − rủi ro tồn − thuế − CP khác (TRƯỚC chia % chủ mã). */
  netProfit: number | null;
};

export type NominalMarketerColumn = {
  key: string;
  label: string;
  /** Bảng chi tiêu đã từng khai chiến dịch nào cho người này chưa. `false` ⇒ Chi QC là CHƯA BIẾT. */
  spendMapped: boolean;
  total: NominalCell;
};

export type NominalDayRow = { day: string; spendKnown: boolean; cells: Record<string, NominalCell>; total: NominalCell };

export type MarketerDailyNominal = {
  period: Period;
  marketers: NominalMarketerColumn[];
  /** Mới nhất trước — ngày hôm qua là thứ người mở trang muốn thấy đầu tiên. */
  days: NominalDayRow[];
  total: NominalCell;
  /** Ngày gần nhất nguồn chi quảng cáo đã nói tới. Sau ngày này Chi QC và lợi nhuận là CHƯA BIẾT. */
  spendObservedThrough: string | null;
  /**
   * ĐỐI CHIẾU VỚI BÁO CÁO LỢI NHUẬN DANH NGHĨA trên cùng kỳ — in ra màn hình, không chỉ nằm trong
   * bài kiểm. `ours` cộng MỌI ô, kể cả ô mà QC chưa biết (khi ấy coi QC đã có là QC — đúng cách
   * báo cáo kia cộng), nên hai vế phải bằng nhau.
   */
  reconcile: { expectedRevenue: { ours: number; report: number }; expectedProfit: { ours: number; report: number }; netProfit: { ours: number; report: number } };
  /** Doanh số theo CĂN CỨ quy kết — để thấy bao nhiêu phần đi bằng ảnh chụp, bao nhiêu phải đoán theo QC. */
  attribution: Record<"snapshot" | "page" | "ad" | "fallback" | "none", number>;
  assumptions: { shipFeeDelivered: number; shipFeeReturned: number; otherCostPercentOfAds: number; taxPercent: number };
  /**
   * Số sản phẩm bán ra VẪN CHƯA BIẾT giá vốn sau khi đã lấp giá dự tính (không phiếu nhập, không
   * giá Pancake, không giá dự tính) — chúng đang trừ 0 ₫ giá vốn, và màn hình phải nói ra.
   */
  unknownCostQty: number;
  /**
   * Phần giá vốn ƯT đến từ giá DỰ TÍNH chủ shop đặt (đã nằm trong `expectedCogs`), tách ra để dán
   * nhãn (AGENTS.md mục 8.6) — đúng cách tab Lợi nhuận danh nghĩa tính.
   */
  estimatedCogs: { amount: number; products: number };
  warnings: string[];
};

const emptyCell = (): NominalCell => ({
  orders: 0,
  deliveredOrders: 0,
  returnedOrders: 0,
  openOrders: 0,
  posSales: 0,
  expectedRevenue: 0,
  expectedCogs: 0,
  shipCost: 0,
  opex: 0,
  inventoryRisk: 0,
  tax: 0,
  adSpend: null,
  messages: null,
  otherCost: null,
  expectedProfit: null,
  netProfit: null,
});

/* ═══════════════════ HÀM THUẦN ═══════════════════ */

/**
 * CHIA MỘT KHOẢN THEO CĂN CỨ ĐẦU TIÊN CÓ TỔNG DƯƠNG.
 *
 * Căn cứ cuối cùng luôn là "mỗi phần một", nên một khoản khác 0 KHÔNG BAO GIỜ rơi mất: mã có DT ƯT
 * dương mà mọi đơn đang ở trạng thái ngoài mô hình (trọng số 0) vẫn chia được, và cộng lại vẫn ra
 * đúng số của Báo cáo lợi nhuận.
 */
export function chiaTheoCanCu(total: number, ...canCu: number[][]): number[] {
  const n = canCu[0]?.length ?? 0;
  if (!total || !n) return new Array<number>(n).fill(0);
  for (const keys of canCu) {
    if (keys.reduce((t, k) => t + Math.max(0, k), 0) > 0) return distributeProportionally(total, keys);
  }
  return distributeProportionally(total, new Array<number>(n).fill(1));
}

/**
 * PHẦN CỦA TỪNG MARKETER TRÊN MỘT ĐƠN CHƯA NÓI ĐƯỢC LÀ CỦA AI (fanpage chưa gán, không ad_id).
 *
 * `attributionShares` trả tỷ trọng CẢ MÃ = (phần gán được + phần chia hộ) / tổng. Phần chia hộ của
 * một marketer vì vậy là `tỷ trọng × tổng − phần gán được của họ`, chia cho phần chưa gán. Suy ngược
 * như vậy thay vì viết lại bậc lùi (QC → chủ mã → tỷ trọng page) để bậc lùi chỉ sống ở MỘT chỗ.
 *
 * Map rỗng = không ai nhận (mã không page gán, không QC, không chủ mã) ⇒ "Chưa quy kết".
 */
export function fallbackShares(shares: Map<string | null, number>, mappedByMarketer: Map<string, number>, total: number, unmappedValue: number): Map<string | null, number> {
  const out = new Map<string | null, number>();
  if (!shares.size) return out;
  if (unmappedValue > 0) {
    for (const [mid, sh] of shares) {
      const v = sh * total - (mid ? (mappedByMarketer.get(mid) ?? 0) : 0);
      if (v > 1e-9) out.set(mid, v);
    }
  }
  // Không còn gì để suy (mã chỉ có đơn giá trị 0) ⇒ dùng thẳng tỷ trọng cả mã.
  const src = out.size ? out : shares;
  const sum = [...src.values()].reduce((t, v) => t + v, 0);
  const norm = new Map<string | null, number>();
  if (sum > 0) for (const [mid, v] of src) norm.set(mid, v / sum);
  return norm;
}

/** Lợi nhuận của một ô từ các vế đã cộng. QC chưa biết ⇒ cả hai lợi nhuận chưa biết. */
export function finishCell(c: NominalCell, otherPct: number): NominalCell {
  if (c.adSpend === null) return { ...c, otherCost: null, expectedProfit: null, netProfit: null };
  const otherCost = Math.round(c.adSpend * otherPct);
  const expectedProfit = c.expectedRevenue - c.expectedCogs - c.shipCost - c.adSpend;
  return { ...c, otherCost, expectedProfit, netProfit: expectedProfit - c.opex - c.inventoryRisk - c.tax - otherCost };
}

function addInto(t: NominalCell, c: NominalCell) {
  t.orders += c.orders;
  t.deliveredOrders += c.deliveredOrders;
  t.returnedOrders += c.returnedOrders;
  t.openOrders += c.openOrders;
  t.posSales += c.posSales;
  t.expectedRevenue += c.expectedRevenue;
  t.expectedCogs += c.expectedCogs;
  t.shipCost += c.shipCost;
  t.opex += c.opex;
  t.inventoryRisk += c.inventoryRisk;
  t.tax += c.tax;
}

/* ═══════════════════ ĐỌC SỐ ═══════════════════ */

type LineRow = {
  order_id: string;
  day: string;
  page_id: string | null;
  ad_id: string | null;
  snap: string | null;
  pid: string | null;
  code: string | null;
  line: string | number;
  cogs: string | number;
  outcome: string;
  con: string;
  age_hours: string | number | null;
};

/**
 * CÙNG TẬP DÒNG VỚI BẢNG LỢI NHUẬN THEO MÃ: dòng không tặng · đơn đã xác nhận · không huỷ · lọc theo
 * ngày tạo đơn. Gộp theo (đơn × mã) — đúng đơn vị mà báo cáo gọi là "một đơn của mã".
 *
 * `ORDER_OUTCOME` tính MỘT LẦN mỗi đơn trong CTE rồi mới nối dòng hàng (`offset 0` giữ nó không bị
 * gập vào từng dòng) — cùng hình dạng với `getProjectedDeliveryMetrics`.
 */
async function readLines(period: Period): Promise<LineRow[]> {
  const db = await getDb();
  const con = carrierSubstateSql(sql`"shipments"."vtp_status"`, sql`"shipments"."vtp_status_name"`, sql`"shipments"."stage"::text`);
  const dk: SQL[] = [
    sql`"orders"."stage"::text in (${sql.join(CONFIRMED_STAGES.map((s) => sql`${s}`), sql`, `)})`,
    sql`"orders"."stage"::text not in ('CANCELLED','DELETED')`,
  ];
  if (period.from) dk.push(sql`"orders"."inserted_at" >= ${period.from}`);
  if (period.to) dk.push(sql`"orders"."inserted_at" <= ${period.to}`);
  return chayKhongJit(db, async (tx) =>
    rowsOf<LineRow>(
      await tx.execute(sql`
        with don as (
          select "orders"."id" as order_id,
                 to_char("orders"."inserted_at" at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day,
                 "orders"."page_id" as page_id,
                 "orders"."ad_id" as ad_id,
                 ${con} as con,
                 ${ORDER_OUTCOME_FAST} as outcome,
                 extract(epoch from (now() - ${sql.raw(CARRIER_HANDOFF_AT_SQL)})) / 3600 as age_hours
            from "orders"
            left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
           where ${and(...dk)}
          offset 0
        )
        select d.order_id, d.day, d.page_id, d.ad_id, d.con, d.outcome, d.age_hours,
               max("order_attributions"."marketer_id") as snap,
               coalesce("product_variants"."product_id", "order_items"."product_id") as pid,
               max(coalesce("products"."custom_id", '')) as code,
               coalesce(sum("order_items"."line_total"), 0) as line,
               coalesce(sum("order_items"."quantity" * ${LINE_UNIT_COST}), 0) as cogs
          from don d
          join "order_items" on "order_items"."order_id" = d.order_id and "order_items"."is_bonus" = false
          left join "product_variants" on "product_variants"."id" = "order_items"."variant_id"
          left join "products" on "products"."id" = coalesce("product_variants"."product_id", "order_items"."product_id")
          left join "order_attributions" on "order_attributions"."order_id" = d.order_id
         group by d.order_id, d.day, d.page_id, d.ad_id, d.con, d.outcome, d.age_hours, coalesce("product_variants"."product_id", "order_items"."product_id")
      `),
    ),
  );
}

async function readSpend(period: Period) {
  const db = await getDb();
  const ads = schema.adSpends;
  const conds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) conds.push(gte(ads.spendDate, period.from));
  if (period.to) conds.push(lte(ads.spendDate, period.to));
  const day = sql<string>`to_char(${ads.spendDate} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const [byDay, byProduct, frontier, mapped] = await Promise.all([
    db
      .select({ day, marketerId: ads.marketerId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)`, messages: sql<number>`coalesce(sum(${AD_MESSAGES}), 0)` })
      .from(ads)
      .where(and(...conds))
      .groupBy(sql`1`, ads.marketerId),
    // Tỷ trọng QC trên từng mã — đầu vào bậc lùi của `attributionShares`, đúng như bảng marketer của báo cáo.
    db
      .select({ productId: ads.productId, marketerId: ads.marketerId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(...conds))
      .groupBy(ads.productId, ads.marketerId),
    // Biên quan sát đọc trên TOÀN BẢNG, không giới hạn theo kỳ — xem `spendByDay` ở marketing-daily.ts.
    db.select({ day: sql<string | null>`to_char(max(${ads.spendDate}) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')` }).from(ads).where(eq(ads.excluded, false)),
    // "Nguồn chi tiêu có biết tới người này không" — một dòng bất kỳ, mọi thời gian.
    db.selectDistinct({ marketerId: ads.marketerId }).from(ads).where(and(eq(ads.excluded, false), sql`${ads.marketerId} is not null`)),
  ]);
  return { byDay, byProduct, observedThrough: frontier[0]?.day ?? null, mappedMarketers: new Set(mapped.map((r) => r.marketerId as string)) };
}

/* ═══════════════════ HÀM CHÍNH ═══════════════════ */

type Slot = {
  day: string;
  key: string;
  orderId: string;
  outcome: string;
  /** Phần của marketer trên dòng (0–1). */
  frac: number;
  /** Phần của dòng trong đơn — để một đơn nhiều mã vẫn đếm là MỘT đơn. */
  orderFrac: number;
  pos: number;
  revKey: number;
  cogsKey: number;
  cogs: number;
};

async function getMarketerDailyNominalUncached(period: Period): Promise<MarketerDailyNominal> {
  const [nominal, lines, spend, lookup, employees, config] = await Promise.all([
    /*
      HAI CỜ, MỖI CỜ MỘT LÝ DO:
        · giá vốn DỰ TÍNH — BẬT, ngoại lệ DUY NHẤT của khu quảng cáo với luật 2 ở
          `lib/constants/estimated-cost.ts` (chủ shop chốt 23/09/2026). Đo production kỳ 30 ngày:
          522 sản phẩm bán ra chưa có giá vốn; trừ 0 ₫ cho chúng thì LN ròng lệch −150,7% so với
          tab Lợi nhuận danh nghĩa — bảng báo lãi trong khi tab báo lỗ, đúng lúc người ta dùng nó
          để chia ngân sách quảng cáo. Phần dự tính KHÔNG tan vào tổng: nói ra ở `estimatedCogs`.
        · TỒN KHO — TẮT. Không đồng nào của nó vào lợi nhuận, và nó là 5,1–6,5s trên 8,1s nguội
          của báo cáo (perf-probe production 23/09/2026). Xem `withStock`.
    */
    getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false),
    readLines(period),
    readSpend(period),
    getProbabilityLookup(),
    listEmployees(),
    loadPayrollConfig(),
  ]);
  const a = nominal.assumptions;
  const otherPct = Math.max(0, Number(a.otherCostPercentOfAds ?? 0)) / 100;
  const adMap = await adMarketerMap(lines.map((l) => l.ad_id).filter((x): x is string => Boolean(x)));

  const rowByProduct = new Map<string, NominalRow>(nominal.rows.map((r) => [r.productId, r]));
  // Mã hàng dùng để điều kiện hoá xác suất CHỈ khi đơn thuộc ĐÚNG MỘT mã — cùng luật với hợp đồng.
  const codesOfOrder = new Map<string, Set<string>>();
  const linesOfOrder = new Map<string, number>();
  for (const l of lines) {
    if (!l.pid) continue;
    linesOfOrder.set(l.order_id, (linesOfOrder.get(l.order_id) ?? 0) + 1);
    const code = (l.code ?? "").trim();
    if (code) codesOfOrder.set(l.order_id, (codesOfOrder.get(l.order_id) ?? new Set()).add(code));
  }
  const uniqueCode = (orderId: string) => {
    const s = codesOfOrder.get(orderId);
    return s && s.size === 1 ? [...s][0] : null;
  };

  const adShareByProduct = new Map<string, Map<string | null, number>>();
  for (const r of spend.byProduct) {
    if (!r.productId) continue;
    const m = adShareByProduct.get(r.productId) ?? new Map<string | null, number>();
    m.set(r.marketerId, (m.get(r.marketerId) ?? 0) + Number(r.spend));
    adShareByProduct.set(r.productId, m);
  }

  const linesByProduct = new Map<string, LineRow[]>();
  for (const l of lines) {
    if (!l.pid) continue; // dòng không lần được mã: Báo cáo lợi nhuận theo mã cũng không có nó
    const list = linesByProduct.get(l.pid) ?? [];
    list.push(l);
    linesByProduct.set(l.pid, list);
  }

  const attribution = { snapshot: 0, page: 0, ad: 0, fallback: 0, none: 0 };
  const cells = new Map<string, NominalCell>();
  const cellOf = (day: string, key: string) => {
    const k = `${day}|${key}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = emptyCell()));
    return c;
  };
  const keyOf = (mid: string | null) => mid ?? MARKETING_UNATTRIBUTED;

  for (const [pid, plines] of linesByProduct) {
    const row = rowByProduct.get(pid);
    if (!row) continue;
    /* ─── AI NHẬN TỪNG DÒNG ─── */
    const buckets: PageBucket[] = plines.map((l) => ({ pageId: l.page_id || null, value: Number(l.line), adMarketerId: l.ad_id ? (adMap.get(l.ad_id) ?? null) : null, snapshotMarketerId: l.snap || null }));
    const att = attributionShares({ byPage: buckets, pageMarketers: config.pageMarketers, adShares: adShareByProduct.get(pid) ?? new Map(), ownerId: config.productOwners[pid] ?? null });
    const mappedBy = new Map<string, number>();
    const direct = buckets.map((b) => {
      const flat = b.pageId ? config.pageMarketers[b.pageId] : undefined;
      const mid = b.snapshotMarketerId || flat || b.adMarketerId || null;
      if (mid) mappedBy.set(mid, (mappedBy.get(mid) ?? 0) + Math.max(0, b.value));
      return { mid, via: b.snapshotMarketerId ? "snapshot" : flat ? "page" : b.adMarketerId ? "ad" : null };
    });
    const total = buckets.reduce((t, b) => t + Math.max(0, b.value), 0);
    const fb = fallbackShares(att.shares, mappedBy, total, att.unmappedValue);

    /* ─── PHẦN GIAO ĐƯỢC CỦA TỪNG DÒNG — đúng căn cứ báo cáo đã dùng cho mã này ─── */
    const r = row.returnRate === null ? 0 : Math.min(Math.max(row.returnRate, 0), 100) / 100;
    const slots: Slot[] = [];
    plines.forEach((l, idx) => {
      const w =
        row.revenueBasis === "ORDER_LEVEL"
          ? (orderDeliveryShare({ outcome: l.outcome, con: l.con, productCode: uniqueCode(l.order_id), ageHours: l.age_hours === null ? null : Number(l.age_hours) }, lookup) ?? 0)
          : 1 - r;
      const pos = Number(l.line);
      const cogs = Number(l.cogs);
      const d = direct[idx];
      const recipients: [string | null, number][] = d.mid ? [[d.mid, 1]] : fb.size ? [...fb.entries()] : [[null, 1]];
      if (d.via) attribution[d.via as "snapshot" | "page" | "ad"] += pos;
      else if (fb.size) attribution.fallback += pos;
      else attribution.none += pos;
      const orderFrac = 1 / (linesOfOrder.get(l.order_id) ?? 1);
      for (const [mid, frac] of recipients) {
        slots.push({ day: l.day, key: keyOf(mid), orderId: l.order_id, outcome: l.outcome, frac, orderFrac, pos: pos * frac, revKey: pos * w * frac, cogsKey: cogs * w * frac, cogs: cogs * frac });
      }
    });

    /* ─── CHIA TỪNG KHOẢN CỦA MÃ XUỐNG CÁC Ô ─── */
    const pos = slots.map((s) => s.pos);
    const cnt = slots.map((s) => s.frac);
    const rev = slots.map((s) => s.revKey);
    const cogsK = slots.map((s) => s.cogsKey);
    const expRev = chiaTheoCanCu(row.expectedRevenue, rev, pos, cnt);
    const expCogs = chiaTheoCanCu(row.expectedCogs, cogsK, rev, cnt);
    const ship = chiaTheoCanCu(row.shipCost, cnt);
    const opexPos = chiaTheoCanCu(row.operatingAlloc + row.fixedAlloc, pos, cnt);
    const opexCnt = chiaTheoCanCu(row.packingCost + row.opsStaffCost, cnt);
    const risk = chiaTheoCanCu(row.inventoryRisk, cogsK, rev, cnt);
    const tax = chiaTheoCanCu(row.tax, rev, pos, cnt);
    // Doanh số POS cũng chia bằng largest remainder để Σ ô = `grossSales` của mã, không lệch vì làm tròn.
    const posInt = chiaTheoCanCu(row.grossSales, pos, cnt);

    slots.forEach((s, i) => {
      const c = cellOf(s.day, s.key);
      c.posSales += posInt[i];
      c.expectedRevenue += expRev[i];
      c.expectedCogs += expCogs[i];
      c.shipCost += ship[i];
      c.opex += opexPos[i] + opexCnt[i];
      c.inventoryRisk += risk[i];
      c.tax += tax[i];
      // ĐƠN: một đơn nhiều mã vẫn là MỘT đơn — mỗi dòng mang `1/số dòng` của đơn.
      const share = s.frac * s.orderFrac;
      c.orders += share;
      const group = OUTCOME_GROUP[s.outcome as OrderOutcome];
      if (group === "SUCCESS") c.deliveredOrders += share;
      else if (group === "RETURNED") c.returnedOrders += share;
      else if (group === "OPEN") c.openOrders += share;
    });
  }

  /* ─── CHI QUẢNG CÁO ─── */
  const spendCell = new Map<string, { spend: number; messages: number }>();
  for (const r of spend.byDay) {
    const k = `${r.day}|${keyOf(r.marketerId)}`;
    const e = spendCell.get(k) ?? { spend: 0, messages: 0 };
    e.spend += Number(r.spend);
    e.messages += Number(r.messages);
    spendCell.set(k, e);
    cellOf(r.day, keyOf(r.marketerId)); // ngày chỉ có tiền mà không đơn nào vẫn phải là một ô
  }

  const names = new Map(employees.map((e) => [e.id, e.shortName || e.name]));
  const labelOf = (key: string) => (key === MARKETING_UNATTRIBUTED ? MARKETING_UNATTRIBUTED_LABEL : (names.get(key) ?? `Nhân sự đã gỡ khỏi sổ lương (${key})`));
  const spendMappedOf = (key: string) => key === MARKETING_UNATTRIBUTED || spend.mappedMarketers.has(key);
  const dayKnown = (day: string) => spend.observedThrough !== null && day <= spend.observedThrough;

  const dayMap = new Map<string, NominalDayRow>();
  const colTotals = new Map<string, NominalCell>();
  const colProfitSums = new Map<string, { exp: number; net: number; ads: number; msgs: number; knownCells: number }>();
  for (const [k, raw] of cells) {
    const [day, key] = k.split("|") as [string, string];
    const s = spendCell.get(k);
    const known = spendMappedOf(key) && (dayKnown(day) || Boolean(s));
    const cell = finishCell({ ...raw, adSpend: known ? (s?.spend ?? 0) : null, messages: known ? (s?.messages ?? 0) : null }, otherPct);
    const dr = dayMap.get(day) ?? { day, spendKnown: dayKnown(day), cells: {}, total: emptyCell() };
    dr.cells[key] = cell;
    dayMap.set(day, dr);
    const ct = colTotals.get(key) ?? emptyCell();
    addInto(ct, cell);
    colTotals.set(key, ct);
    const ps = colProfitSums.get(key) ?? { exp: 0, net: 0, ads: 0, msgs: 0, knownCells: 0 };
    if (cell.adSpend !== null) {
      ps.knownCells += 1;
      ps.ads += cell.adSpend;
      ps.msgs += cell.messages ?? 0;
      ps.exp += cell.expectedProfit ?? 0;
      ps.net += cell.netProfit ?? 0;
    }
    colProfitSums.set(key, ps);
  }

  /*
    HÀNG TỔNG CỦA NGÀY đọc TỔNG chi tiêu của ngày (mọi marketer, kể cả chưa quy kết) — nên nó biết
    được lợi nhuận của cả shop kể cả khi một người trong ngày là CHƯA BIẾT: tiền của người ấy đang
    nằm ở dòng "Chưa quy kết", không mất đi đâu.
  */
  const daySpend = new Map<string, { spend: number; messages: number }>();
  for (const r of spend.byDay) {
    const e = daySpend.get(r.day) ?? { spend: 0, messages: 0 };
    e.spend += Number(r.spend);
    e.messages += Number(r.messages);
    daySpend.set(r.day, e);
  }
  const grand = emptyCell();
  let grandAds = 0;
  let grandMsgs = 0;
  let grandExp = 0;
  let grandNet = 0;
  let grandExpAll = 0;
  let grandNetAll = 0;
  for (const dr of dayMap.values()) {
    const t = emptyCell();
    for (const c of Object.values(dr.cells)) addInto(t, c);
    const s = daySpend.get(dr.day);
    const known = dr.spendKnown || Boolean(s);
    dr.total = finishCell({ ...t, adSpend: known ? (s?.spend ?? 0) : null, messages: known ? (s?.messages ?? 0) : null }, otherPct);
    addInto(grand, t);
    // Đối chiếu: báo cáo kia coi QC chưa có là 0 và vẫn chốt — cộng theo đúng cách ấy ở vế `ours`.
    const asIfKnown = finishCell({ ...t, adSpend: s?.spend ?? 0, messages: 0 }, otherPct);
    grandExpAll += asIfKnown.expectedProfit ?? 0;
    grandNetAll += asIfKnown.netProfit ?? 0;
    if (dr.total.adSpend !== null) {
      grandAds += dr.total.adSpend;
      grandMsgs += dr.total.messages ?? 0;
      grandExp += dr.total.expectedProfit ?? 0;
      grandNet += dr.total.netProfit ?? 0;
    }
  }

  const marketers: NominalMarketerColumn[] = [...colTotals.entries()].map(([key, t]) => {
    const ps = colProfitSums.get(key) ?? { exp: 0, net: 0, ads: 0, msgs: 0, knownCells: 0 };
    const anyKnown = ps.knownCells > 0;
    return {
      key,
      label: labelOf(key),
      spendMapped: spendMappedOf(key),
      total: { ...t, adSpend: anyKnown ? ps.ads : null, messages: anyKnown ? ps.msgs : null, otherCost: anyKnown ? Math.round(ps.ads * otherPct) : null, expectedProfit: anyKnown ? ps.exp : null, netProfit: anyKnown ? ps.net : null },
    };
  });
  marketers.sort((x, y) => (x.key === MARKETING_UNATTRIBUTED ? 1 : y.key === MARKETING_UNATTRIBUTED ? -1 : y.total.orders - x.total.orders || y.total.posSales - x.total.posSales));

  const days = [...dayMap.values()].sort((x, y) => y.day.localeCompare(x.day));
  const anyDayKnown = days.some((d) => d.total.adSpend !== null);
  const total: NominalCell = { ...grand, adSpend: anyDayKnown ? grandAds : null, messages: anyDayKnown ? grandMsgs : null, otherCost: anyDayKnown ? Math.round(grandAds * otherPct) : null, expectedProfit: anyDayKnown ? grandExp : null, netProfit: anyDayKnown ? grandNet : null };

  const warnings: string[] = [];
  const unmapped = marketers.filter((m) => !m.spendMapped && m.total.orders > 0);
  if (unmapped.length) {
    warnings.push(
      `Bảng chi quảng cáo chưa khai chiến dịch nào cho ${unmapped.map((m) => m.label).join(" · ")}, nên Chi QC và lợi nhuận của họ là CHƯA BIẾT (—), KHÔNG phải 0 — tiền thật của họ đang nằm ở cột "${MARKETING_UNATTRIBUTED_LABEL}". Ghép chiến dịch với marketer ở trang Quảng cáo thì cột này mới có số.`,
    );
  }
  const lateDays = days.filter((d) => !d.spendKnown && d.total.orders > 0);
  if (lateDays.length) {
    warnings.push(`Nguồn chi quảng cáo mới đồng bộ tới ngày ${spend.observedThrough ?? "—"}. ${lateDays.length} ngày sau đó có đơn nhưng CHƯA BIẾT chi bao nhiêu, nên lợi nhuận của những ngày ấy để trống thay vì chốt một con số; hàng tổng chỉ cộng lợi nhuận của những ngày đã có số chi.`);
  }
  if (nominal.totals.expectedCogsEstimated > 0) {
    warnings.push(
      `Giá vốn ước tính gồm ${nominal.totals.expectedCogsEstimated.toLocaleString("vi-VN")} ₫ giá vốn DỰ TÍNH (chủ shop đặt ở Báo cáo lợi nhuận) cho ${nominal.totals.estimatedCostProducts} mã chưa có giá nhập thật — cùng cách tab Lợi nhuận danh nghĩa tính. Lợi nhuận của MKTer chạy những mã ấy phụ thuộc con số đặt tay này; lập phiếu nhập có đơn giá thì giá thật tự thay chỗ.`,
    );
  }
  if (nominal.totals.cogsUncoveredQty > 0) {
    warnings.push(
      `${nominal.totals.cogsUncoveredQty.toLocaleString("vi-VN")} sản phẩm bán ra chưa có giá vốn nào — không phiếu nhập, không giá Pancake, cũng chưa đặt giá dự tính — nên đang trừ 0 ₫ giá vốn: lợi nhuận của những mã ấy đang CAO hơn thực tế. Đặt giá dự tính ở Báo cáo lợi nhuận → Lợi nhuận danh nghĩa, hoặc lập phiếu nhập có đơn giá.`,
    );
  }
  if (nominal.totals.projectionError) warnings.push(`Mô hình dự báo giao thành công lỗi (${nominal.totals.projectionError}); Báo cáo lợi nhuận đang tính mọi mã theo tỷ lệ, và bảng này chia đúng theo con số ấy.`);

  return {
    period,
    marketers,
    days,
    total,
    spendObservedThrough: spend.observedThrough,
    reconcile: {
      expectedRevenue: { ours: grand.expectedRevenue, report: nominal.totals.expectedRevenue },
      expectedProfit: { ours: grandExpAll, report: nominal.totals.expectedProfit },
      netProfit: { ours: grandNetAll, report: nominal.totals.netProfit },
    },
    attribution,
    assumptions: { shipFeeDelivered: a.shipFeeDeliveredUsed, shipFeeReturned: a.shipFeeReturnedUsed, otherCostPercentOfAds: Number(a.otherCostPercentOfAds ?? 0), taxPercent: Number(a.taxPercent ?? 0) },
    unknownCostQty: nominal.totals.cogsUncoveredQty,
    estimatedCogs: { amount: nominal.totals.expectedCogsEstimated, products: nominal.totals.estimatedCostProducts },
    warnings,
  };
}

/**
 * Đệm 120 giây như Báo cáo lợi nhuận danh nghĩa — tham số duy nhất ảnh hưởng kết quả là KỲ, và nó
 * nằm trong khoá (AGENTS.md mục 2). Mốc luôn là ngày tạo đơn (`ORDERED`), đúng mốc của bảng
 * marketer trên Báo cáo lợi nhuận; đổi mốc ở `/ads/daily` KHÔNG đổi bảng này, và màn hình nói ra.
 */
export async function getMarketerDailyNominal(period: Period): Promise<MarketerDailyNominal> {
  return memo(`marketerDailyNominal:${periodKey(period)}`, 120_000, () => getMarketerDailyNominalUncached(period));
}
