import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { orderCogsFast } from "@/lib/queries/cogs";
import { metricScope } from "@/lib/queries/metrics";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";
import { getOperatingCost } from "@/lib/queries/cost-engine";

/**
 * ───────────────────── CHÂN LÝ TÀI CHÍNH ─────────────────────
 *
 * Sáu con số dưới đây **không bao giờ được coi là một**, và trước nay chúng bị gọi chung là
 * "doanh thu" ở các màn hình khác nhau:
 *
 *  1. DOANH THU LÊN ĐƠN   — khách chốt bao nhiêu (Pancake).
 *  2. DOANH THU GIAO TC   — bao nhiêu thật sự tới tay khách (chứng từ ĐVVC + tiền có chứng từ).
 *  3. COD ĐÃ THU          — Viettel Post đã cầm bao nhiêu (họ khai).
 *  4. COD ĐÃ ĐỐI SOÁT     — hai bên đã chốt bao nhiêu.
 *  5. TIỀN THỰC NHẬN      — bao nhiêu đã nằm trong tài khoản shop (bảng kê + trả trước).
 *  6. LỢI NHUẬN           — ước tính (theo đơn) và thực nhận (theo dòng tiền).
 *
 * Hai điều tuyệt đối cấm, đều đã từng xảy ra:
 *  · coi DOANH THU GIAO THÀNH CÔNG là TIỀN THỰC NHẬN — tiền còn nằm ở ĐVVC hàng tuần;
 *  · coi TIỀN ĐÃ VỀ NGÂN HÀNG là bằng chứng ĐÃ GIAO — đó là suy chiều tiền sang chiều logistics.
 *
 * ĐỘ CHÍNH XÁC ĐƯỢC GHI RÕ. Chi phí quảng cáo, chi phí vận hành và cước theo bảng kê chỉ có ở
 * mức KỲ, không phân bổ được về từng đơn. Bậc thang bên dưới ghi `precision` cho từng dòng để
 * không ai đọc nhầm một con số phân bổ thành con số của đơn.
 *
 * Hợp đồng chỉ số: docs/metrics-contract.md.
 */

const o = schema.orders;
const s = schema.shipments;

/** Độ chính xác của một dòng trong bậc thang. */
export type LinePrecision =
  /** Truy được về từng đơn / từng vận đơn. */
  | "per_order"
  /** Truy được về từng chứng từ (dòng bảng kê, phiếu nhập). */
  | "per_document"
  /** Chỉ có ở mức KỲ — không phân bổ về đơn được, đừng chia nhỏ. */
  | "period_only";

export const PRECISION_LABEL: Record<LinePrecision, string> = {
  per_order: "Theo từng đơn",
  per_document: "Theo từng chứng từ",
  period_only: "Chỉ có ở mức kỳ",
};

export const PRECISION_HINT: Record<LinePrecision, string> = {
  per_order: "Truy nguyên được về từng đơn hàng cụ thể.",
  per_document: "Truy nguyên được về dòng bảng kê / phiếu kho cụ thể.",
  period_only: "Chỉ đo được cho cả kỳ. KHÔNG chia về từng đơn — chia là bịa ra độ chính xác không có.",
};

export type WaterfallLine = {
  key: string;
  label: string;
  /** Số tiền (VND, số nguyên). Dòng chi phí mang dấu âm. */
  amount: number;
  /** `null` = CHƯA BIẾT, không phải 0. */
  known: boolean;
  precision: LinePrecision;
  note: string;
  /** Dòng tổng cộng (đậm trên giao diện). */
  subtotal?: boolean;
};

export type FinancialTruth = {
  period: Period;
  /** Sáu con số gốc, mỗi con số một ý nghĩa. */
  revenue: {
    booked: number;
    bookedOrders: number;
    delivered: number;
    deliveredOrders: number;
    /** Doanh thu của đơn hoàn — tiền đã lên đơn nhưng không bao giờ về. */
    returned: number;
    returnedOrders: number;
  };
  cod: {
    /** ĐVVC khai đã thu (cod_status COLLECTED trở lên) — LỜI KHAI, chưa phải chứng từ. */
    collected: number;
    collectedCount: number;
    /** Hai bên đã chốt số. */
    reconciled: number;
    reconciledCount: number;
    /** Đã có dòng chứng từ bảng kê chứng minh tiền về tài khoản. */
    paidToBank: number;
    paidToBankCount: number;
    /** Của đơn đã giao thành công mà chưa thấy đồng nào trên bảng kê. */
    outstanding: number;
    outstandingCount: number;
  };
  cash: {
    /** Tiền thực nhận trong kỳ theo bảng kê (đã trừ cước ĐVVC giữ lại). */
    received: number;
    /** Khách chuyển trước của đơn giao thành công. */
    prepaid: number;
    total: number;
  };
  /** Bậc thang từ doanh thu giao thành công xuống lợi nhuận. */
  waterfall: WaterfallLine[];
  /** Lợi nhuận GÓP: doanh thu giao TC − giá vốn − cước − phí hoàn − quảng cáo. Chưa trừ vận hành. */
  contribution: number;
  /** Lợi nhuận ƯỚC TÍNH theo đơn trong kỳ (có dòng chỉ ở mức kỳ). */
  estimatedProfit: number;
  /**
   * Lợi nhuận THỰC NHẬN theo dòng tiền, chỉ tính khi kỳ đã có bảng kê.
   * `null` = CHƯA ĐỦ CHỨNG TỪ để nói — không được thay bằng 0.
   */
  realizedProfit: number | null;
  /** Vì sao chưa tính được lợi nhuận thực nhận. */
  realizedBlockedBy: string | null;
};

function between(column: AnyPgColumn, from: Date | null, to: Date | null): SQL | undefined {
  const conds: SQL[] = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds.length ? and(...conds) : undefined;
}

async function financialTruthUncached(period: Period): Promise<FinancialTruth> {
  const db = await getDb();
  const scope = metricScope(period, "confirmed");
  const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;

  /**
   * ───────── TÍNH KẾT QUẢ ĐƠN MỘT LẦN CHO MỖI DÒNG, KHÔNG PHẢI MƯỜI HAI LẦN ─────────
   *
   * Đo trên production 09/09/2026: hàm này mất **20,5 giây** để trả về 2kB. Nguyên nhân: mười hai
   * cột gộp dưới đây, cột nào cũng nội tuyến trọn `ORDER_OUTCOME` (một biểu thức CASE chứa nhiều
   * truy vấn con tương quan). Postgres không gộp chúng lại được nên mỗi đơn bị tính kết quả mười
   * hai lần — trang chủ vì thế mất hơn 30 giây và người mở đầu tiên mỗi sáng phải ngồi chờ.
   *
   * Bọc vào bảng dẫn xuất kèm rào `OUTCOME_FENCE` thì mỗi dòng tính đúng một lần. Đây là đổi HÌNH
   * DẠNG truy vấn, KHÔNG đổi công thức: cùng `ORDER_OUTCOME`, cùng phép nối, cùng bộ lọc, nên cùng
   * con số ra. `tests/metric-shape-consistency.test.ts` chứng minh điều đó bằng cách tính lại theo
   * cách nội tuyến cũ rồi so từng con số.
   */
  const facts = db
    .select({
      revenue: sql<number>`${o.totalPriceAfterDiscount}`.as("f_revenue"),
      /**
       * GIÁ VỐN CỦA KỲ ĐÃ CHỐT, KHÔNG PHẢI GIÁ VỐN HÔM NAY.
       *
       * Đơn đã ghi nhận giao thành công dùng `recognized_cogs` — con số đã chốt tại thời điểm giao và
       * không đổi nữa. Nếu không, nhập một lô mới hôm nay sẽ viết lại lợi nhuận của tháng trước:
       * chủ shop in báo cáo tháng 8 hai lần vào hai ngày khác nhau ra hai con số khác nhau.
       *
       * Đơn chưa chốt vẫn dùng giá vốn hiện tại — đó là ƯỚC TÍNH, và nó chỉ vào phần chưa giao.
       */
      // MỘT định nghĩa giá vốn duy nhất cho mọi báo cáo — xem `orderCogsFast()`.
      cogs: orderCogsFast().as("f_cogs"),
      fee: sql<number>`${FEE}`.as("f_fee"),
      returnFee: sql<number>`${o.returnFee}`.as("f_return_fee"),
      prepaid: sql<number>`${o.prepaid} + ${o.transferMoney} + ${o.cash}`.as("f_prepaid"),
      // Đọc kết quả ĐÃ VẬT CHẤT HOÁ; thiếu dòng thì tự tính bằng luật chuẩn (xem canonical-outcome.ts).
      outcome: ORDER_OUTCOME_FAST.as("f_outcome"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn có nhiều lần gửi không được đếm nhiều lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(scope)
    .offset(OUTCOME_FENCE)
    .as("truth_facts");

  const isDelivered = sql`${facts.outcome} = 'DELIVERED'`;
  const isReturned = sql`${facts.outcome} in ('RETURNED','RETURNED_BY_RULE')`;
  const isBooked = sql`${facts.outcome} <> 'CANCELLED'`;

  /*
    JIT TẮT TRONG ĐÚNG GIAO DỊCH NÀY.

    perf-probe trên production 10/09/2026: `getFinancialTruth` **19.162ms nguội / 0ms ấm**. Câu
    lệnh này là câu đắt nhất của nó — mười hai cột gộp trên bảng dẫn xuất `facts`, chi phí ước
    lượng đủ cao để Postgres bật JIT.

    Cùng họ với truy vấn đã tách bạch được: 8.578ms bật JIT ↔ 26ms tắt JIT, CÙNG số khối đệm.
    Chỉ bọc câu lệnh này; các câu COD/bảng kê/quảng cáo bên dưới chạy riêng như cũ.
  */
  const [orderRow] = await chayKhongJit(db, (tx) => tx
    .select({
      bookedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${isBooked}), 0)`,
      bookedOrders: sql<number>`count(*) filter (where ${isBooked})`,
      deliveredRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${isDelivered}), 0)`,
      deliveredOrders: sql<number>`count(*) filter (where ${isDelivered})`,
      deliveredCogs: sql<number>`coalesce(sum(${facts.cogs}) filter (where ${isDelivered}), 0)`,
      returnedRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${isReturned}), 0)`,
      returnedOrders: sql<number>`count(*) filter (where ${isReturned})`,
      shippingDelivered: sql<number>`coalesce(sum(${facts.fee}) filter (where ${isDelivered}), 0)`,
      shippingReturned: sql<number>`coalesce(sum(${facts.fee}) filter (where ${isReturned}), 0)`,
      returnFee: sql<number>`coalesce(sum(${facts.returnFee}) filter (where ${isReturned}), 0)`,
      prepaid: sql<number>`coalesce(sum(${facts.prepaid}) filter (where ${isDelivered}), 0)`,
      missingCogsOrders: sql<number>`count(*) filter (where ${isDelivered} and ${facts.cogs} = 0 and ${facts.revenue} > 0)`,
    })
    .from(facts));

  // ── Chiều TIỀN: đọc trên vận đơn của đơn trong kỳ, tách rõ ba bậc chứng từ ──
  /*
    CÂU NÀY TỪNG LÀ CÂU CHẬM NHẤT CỦA TRANG CHỦ — VÌ JIT, KHÔNG VÌ DỮ LIỆU.

    perf-probe production 11/09/2026, EXPLAIN ANALYZE: `Seq Scan on shipments … actual
    time=2703ms..2707ms rows=1976` — dòng đầu tiên mất 2,7 giây, 1.975 dòng còn lại mất 4ms. Các
    SubPlan bên trong chỉ tốn 0,006–0,036ms mỗi lượt. Chi phí ước lượng 801.408 vượt `jit_above_cost`
    nên Postgres biên dịch hàng trăm hàm trước khi đọc dòng đầu; máy 2 nhân trả 2,7–3,5 giây cho
    việc đó, và ba lượt gọi đồng thời (trang chủ + tóm tắt + sự thật tài chính) chen nhau tới mức
    một câu `select … from settings where key = $1` phải chờ 300ms.

    Cùng cách sửa với `orderRow`: tắt JIT trong đúng giao dịch này. Đọc kết quả ĐÃ VẬT CHẤT HOÁ để
    biểu thức không phải tính lại (`ORDER_OUTCOME_FAST`, cùng công thức, chỉ khác lúc tính).
    MỖI ĐƠN MỘT DÒNG: đơn gửi lại nhiều lần chỉ tính lần gửi quyết định (PRIMARY_ATTEMPT), vì các
    cột này được gắn nhãn "đơn" trên màn hình.
  */
  const codRowP = chayKhongJit(db, (tx) => tx
    .select({
      collected: sql<number>`coalesce(sum(${s.codAmount}) filter (where ${s.codStatus} = 'COLLECTED'), 0)`,
      collectedCount: sql<number>`count(*) filter (where ${s.codStatus} = 'COLLECTED')`,
      reconciled: sql<number>`coalesce(sum(${s.codAmount}) filter (where ${s.codStatus} = 'RECONCILED'), 0)`,
      reconciledCount: sql<number>`count(*) filter (where ${s.codStatus} = 'RECONCILED')`,
      paidToBank: sql<number>`coalesce(sum(coalesce(nullif(${s.codCollected}, 0), ${s.codAmount})) filter (where ${s.codStatus} = 'PAID_TO_BANK'), 0)`,
      paidToBankCount: sql<number>`count(*) filter (where ${s.codStatus} = 'PAID_TO_BANK')`,
      // Đơn ĐÃ GIAO THÀNH CÔNG mà chưa có đồng nào trên bảng kê — phần Viettel Post còn giữ.
      outstanding: sql<number>`coalesce(sum(${s.codAmount}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0), 0)`,
      outstandingCount: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0)`,
    })
    .from(o)
    .innerJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(scope));

  // ── TIỀN THỰC NHẬN: theo NGÀY ĐỐI SOÁT của bảng kê, không theo ngày lên đơn ──
  const b = schema.codBatches;
  const batchRowP = db
    .select({ count: sql<number>`count(*)`, net: sql<number>`coalesce(sum(${b.totalAmount}), 0)`, fee: sql<number>`coalesce(sum(${b.feeTotal}), 0)` })
    .from(b)
    .where(between(b.receivedAt, period.from, period.to));

  const adsRowP = db
    .select({ amount: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), between(schema.adSpends.spendDate, period.from, period.to)));
  // Một đường duy nhất: Profit Engine. Trang "sự thật tài chính" không được tự cộng theo cách riêng.
  // Bốn phép đọc không phụ thuộc nhau: chạy song song thay vì nối đuôi.
  const [[codRow], [batchRow], [adsRow], opsRow] = await Promise.all([codRowP, batchRowP, adsRowP, getOperatingCost(period)]);

  const deliveredRevenue = Number(orderRow?.deliveredRevenue ?? 0);
  const deliveredCogs = Number(orderRow?.deliveredCogs ?? 0);
  const shippingDelivered = Number(orderRow?.shippingDelivered ?? 0);
  const shippingReturned = Number(orderRow?.shippingReturned ?? 0);
  const returnFee = Number(orderRow?.returnFee ?? 0);
  const adSpend = Number(adsRow?.amount ?? 0);
  const operating = Number(opsRow?.amount ?? 0);
  const missingCogsOrders = Number(orderRow?.missingCogsOrders ?? 0);

  const contribution = deliveredRevenue - deliveredCogs - shippingDelivered - shippingReturned - returnFee - adSpend;
  const estimatedProfit = contribution - operating;

  const statementCount = Number(batchRow?.count ?? 0);
  const cashReceived = Number(batchRow?.net ?? 0);
  const prepaid = Number(orderRow?.prepaid ?? 0);

  const waterfall: WaterfallLine[] = [
    {
      key: "delivered_revenue",
      label: "Doanh thu giao thành công",
      amount: deliveredRevenue,
      known: true,
      precision: "per_order",
      note: `${Number(orderRow?.deliveredOrders ?? 0)} đơn tới tay khách. KHÁC doanh thu lên đơn và KHÁC tiền đã về tài khoản.`,
    },
    {
      key: "cogs",
      label: "− Giá vốn hàng bán",
      amount: -deliveredCogs,
      known: missingCogsOrders === 0,
      precision: "per_order",
      note:
        missingCogsOrders > 0
          ? `${missingCogsOrders} đơn không tra được giá nhập nên đang tính giá vốn 0 — lợi nhuận của nhóm này đang CAO HƠN thực tế.`
          : "Giá vốn tra theo phiếu nhập ERP gần nhất, rồi tới giá vốn Pancake, rồi giá nhập mẫu mã.",
    },
    {
      key: "shipping_out",
      label: "− Cước gửi hàng (đơn giao thành công)",
      amount: -shippingDelivered,
      known: true,
      precision: "per_order",
      note: "Cước trên vận đơn; không có thì lấy phí đối tác Pancake ghi trên đơn.",
    },
    {
      key: "shipping_return",
      label: "− Cước và phí của đơn hoàn",
      amount: -(shippingReturned + returnFee),
      known: true,
      precision: "per_order",
      note: `Chi phí của ${Number(orderRow?.returnedOrders ?? 0)} đơn hoàn: hàng đi rồi về, tiền không thu được nhưng cước vẫn mất.`,
    },
    {
      key: "ads",
      label: "− Chi quảng cáo",
      amount: -adSpend,
      known: true,
      precision: "period_only",
      note: "Lấy theo ngày tiêu tiền của tài khoản quảng cáo. KHÔNG phân bổ về từng đơn — quy kết đơn nào do quảng cáo nào là việc của trang Quảng cáo, và chỉ khi ghép được ad_id.",
    },
    {
      key: "contribution",
      label: "= Lợi nhuận góp",
      amount: contribution,
      known: missingCogsOrders === 0,
      precision: "period_only",
      subtotal: true,
      note: "Phần còn lại sau khi trừ mọi chi phí gắn trực tiếp với việc bán hàng, chưa trừ chi phí vận hành cố định.",
    },
    {
      key: "operating",
      label: "− Chi phí vận hành",
      amount: -operating,
      known: true,
      precision: "period_only",
      note: "Lương, mặt bằng, phần mềm, đóng gói… ghi theo kỳ. Không chia về đơn.",
    },
    {
      key: "estimated_profit",
      label: "= Lợi nhuận ước tính",
      amount: estimatedProfit,
      known: missingCogsOrders === 0,
      precision: "period_only",
      subtotal: true,
      note: "Ước tính THEO ĐƠN trong kỳ. Không phải tiền trong tài khoản — phần lớn còn nằm ở Viettel Post.",
    },
  ];

  const realizedBlockedBy = statementCount === 0 ? "Kỳ này chưa có bảng kê Viettel Post nào — chưa có chứng từ để nói tiền đã về bao nhiêu." : null;
  const realizedProfit = realizedBlockedBy ? null : cashReceived + prepaid - operating - adSpend;

  return {
    period,
    revenue: {
      booked: Number(orderRow?.bookedRevenue ?? 0),
      bookedOrders: Number(orderRow?.bookedOrders ?? 0),
      delivered: deliveredRevenue,
      deliveredOrders: Number(orderRow?.deliveredOrders ?? 0),
      returned: Number(orderRow?.returnedRevenue ?? 0),
      returnedOrders: Number(orderRow?.returnedOrders ?? 0),
    },
    cod: {
      collected: Number(codRow?.collected ?? 0),
      collectedCount: Number(codRow?.collectedCount ?? 0),
      reconciled: Number(codRow?.reconciled ?? 0),
      reconciledCount: Number(codRow?.reconciledCount ?? 0),
      paidToBank: Number(codRow?.paidToBank ?? 0),
      paidToBankCount: Number(codRow?.paidToBankCount ?? 0),
      outstanding: Number(codRow?.outstanding ?? 0),
      outstandingCount: Number(codRow?.outstandingCount ?? 0),
    },
    cash: { received: cashReceived, prepaid, total: cashReceived + prepaid },
    waterfall,
    contribution,
    estimatedProfit,
    realizedProfit,
    realizedBlockedBy,
  };
}

export async function getFinancialTruth(period: Period): Promise<FinancialTruth> {
  return memo(`financialTruth:${periodKey(period)}`, 90_000, () => financialTruthUncached(period));
}
