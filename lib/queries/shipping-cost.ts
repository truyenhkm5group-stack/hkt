/**
 * ═══════════ CƯỚC CỦA MỘT VẬN ĐƠN — SỐ VIETTEL POST GHI NHẬN, THIẾU THÌ ƯỚC TÍNH CÓ NHÃN ═══════════
 *
 * Chủ shop 21/10/2026: "Chi phí vận chuyển thực tế khi tính lương cần tính đúng theo ghi nhận của VTP (lấy
 * từ dữ liệu VTP về hoặc từ file tôi up lên), đối soát COD cùng với chi phí vận chuyển. Còn chi phí vận
 * chuyển ước tính ở cấu hình BCLN có thể thay đổi theo khoảng thời gian khác nhau."
 *
 * Nên MỘT biểu thức cho cước chiều đi của một đơn, dùng chung bởi cơ sở lương (`payroll.ts`), bảng đối soát
 * (`payroll-reconciliation.ts`) và máy chi phí (`cost-engine.ts`) — ba nơi phải nói cùng một con số:
 *  · CÓ chứng từ Viettel Post: `shipments.shipping_fee > 0` — webhook (`moneyTotal`), bảng kê COD (ghi đè
 *    bằng số ĐÃ TÍNH TIỀN) hoặc tệp «Danh sách vận đơn» chủ shop tải lên. Bảng kê đã về
 *    (`cod_statement_ref`) ⇒ cước ĐÃ ĐỐI SOÁT cùng COD.
 *  · THIẾU: cước ƯỚC TÍNH theo lịch cước của cấu hình Báo cáo lợi nhuận tại NGÀY LÊN ĐƠN (`shipFeeSchedule`,
 *    trước mốc đầu tiên là ô chung). Đếm riêng, gắn nhãn ước tính ở bảng đối soát.
 *  · KHÔNG còn lùi về `orders.partner_fee` của Pancake: đó không phải ghi nhận của Viettel Post.
 *
 * Luật kết quả đơn ("cước < 10K") ở `return-rate.ts` KHÔNG đi qua đây — đổi nó là đổi số giao thành công.
 */
import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { DEFAULT_PROFIT_ASSUMPTIONS, manualShipFee, PROFIT_ASSUMPTIONS_KEY, resolveShipFees, shipFeeScheduleOf, shipFeesAt, type ProfitAssumptions, type ShipFeePair, type ShipFeePeriod, type ShipFeeSource } from "@/lib/constants/profit";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { vnStartOfDay } from "@/lib/format";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { getSettingJson } from "@/lib/settings";

const s = schema.shipments;
const o = schema.orders;

/** Cước có chứng từ Viettel Post của vận đơn đang nối (`NULL` = chưa có). */
export const VTP_SHIPPING_FEE_SQL = sql<number | null>`nullif(${s.shippingFee}, 0)`;
/** Vận đơn đã nằm trong một bảng kê COD — cước ấy là số ĐÃ TÍNH TIỀN, đối soát cùng COD. */
export const ON_COD_STATEMENT_SQL = sql<boolean>`(${s.codStatementRef} is not null)`;

/**
 * Cước bình quân 90 ngày từ dữ liệu, cho ô cước để trống. CHỈ cước Viettel Post ghi nhận (không trộn
 * `partner_fee` của Pancake). Đệm 2 phút: số này đổi chậm.
 */
export function shipFeeFromData() {
  return memo("profit-assumptions:ship-fee-90d", 120_000, async () => {
    const db = await getDb();
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [row] = await chayKhongJit(db, (tx) =>
      tx
        .select({
          delivered: sql<number>`avg(nullif(${s.shippingFee}, 0)) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
          returnFee: sql<number>`avg(nullif(${o.returnFee}, 0)) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
          returnFeeSample: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)}) and ${o.returnFee} > 0)`,
        })
        .from(o)
        .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
        .where(gte(o.insertedAt, since)),
    );
    return row;
  });
}

export type ShipFeeBase = ShipFeePair & { source: ShipFeeSource; returnFeeFromData: number; returnFeeSample: number; schedule: ShipFeePeriod[] };

/** Ô chung (đặt tay hoặc bình quân 90 ngày) + lịch cước đã lọc. */
export async function resolveShipFeeBase(saved?: ProfitAssumptions): Promise<ShipFeeBase> {
  const a = saved ?? (await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS));
  const manual = { delivered: manualShipFee(a, "shipFeeDelivered"), returned: manualShipFee(a, "shipFeeReturned") };
  let delivered = 0;
  let returnFee = 0;
  let returnFeeSample = 0;
  // Hai ô đều đặt tay thì không cần câu 90 ngày (5 giây khi đệm nguội).
  if (manual.delivered === null || manual.returned === null) {
    const row = await shipFeeFromData();
    delivered = Math.round(Number(row?.delivered ?? 0));
    returnFee = Math.round(Number(row?.returnFee ?? 0));
    returnFeeSample = Number(row?.returnFeeSample ?? 0);
  }
  const fees = resolveShipFees(manual, { delivered, returnFee });
  return { delivered: fees.delivered, returned: fees.returned, source: fees.source, returnFeeFromData: returnFee, returnFeeSample, schedule: shipFeeScheduleOf(a) };
}

/**
 * Cước ƯỚC TÍNH (chiều đi) theo ngày lên đơn — một `CASE` dựng từ lịch cước, rơi về ô chung trước mốc đầu.
 * Mốc tính theo 00:00 giờ VN của ngày ghi trên lịch.
 */
export function estimatedShipFeeSql(base: ShipFeeBase): SQL<number> {
  if (!base.schedule.length) return sql<number>`${base.delivered}::bigint`;
  const nhanh = [...base.schedule].reverse().map((x) => sql`when ${o.insertedAt} >= ${vnStartOfDay(x.from)} then ${shipFeesAt(base, base.schedule, x.from, base.returnFeeFromData).delivered}::bigint`);
  return sql<number>`(case ${sql.join(nhanh, sql` `)} else ${base.delivered}::bigint end)`;
}

/**
 * Biểu thức dùng chung: `fee` = cước Viettel Post nếu có, không thì ước tính; `estimated` = phần ước tính
 * (0 khi có cước Viettel Post) — để bảng đối soát đếm riêng. Cần nối `shipments` vận đơn chính (`PRIMARY_ATTEMPT`).
 */
export async function shipmentCostSql(saved?: ProfitAssumptions): Promise<{ fee: SQL<number>; estimated: SQL<number>; base: ShipFeeBase }> {
  const base = await resolveShipFeeBase(saved);
  // Ước tính CHỈ khi đơn thật sự đi qua ĐVVC: có vận đơn, hoặc Pancake ghi cước đối tác (chỉ dùng như DẤU
  // HIỆU "có gửi", không dùng làm số tiền). Đơn tự giao / đơn tay không vận đơn ⇒ 0, không bịa 17.000 ₫.
  const quaDvvc = sql`(${s.id} is not null or coalesce(${o.partnerFee}, 0) > 0)`;
  const uocTinh = sql<number>`(case when ${quaDvvc} then ${estimatedShipFeeSql(base)} else 0 end)`;
  return {
    base,
    fee: sql<number>`coalesce(${VTP_SHIPPING_FEE_SQL}, ${uocTinh})::bigint`,
    estimated: sql<number>`(case when ${VTP_SHIPPING_FEE_SQL} is null then ${uocTinh} else 0 end)::bigint`,
  };
}
