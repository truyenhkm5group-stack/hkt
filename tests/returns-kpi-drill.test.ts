import assert from "node:assert/strict";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { NO_ORDER_VALUE_FILTER, orderValueWhereSql } from "@/lib/constants/order-value";
import { CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL, TIME_BASES, type TimeBasis } from "@/lib/constants/report-time-basis";
import { ELIGIBLE_SENT_SQL } from "@/lib/constants/returns";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { getReturnRateSummary, listReturnSummaryOrders, outcomeColumn, OUTCOME_FENCE, PRIMARY_ATTEMPT, REPORTABLE_ORDER, RETURN_SUMMARY_BUCKETS, type ReturnSummaryBucket } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ KPI /reports/returns BẤM XUỐNG RA ĐÚNG SỐ TRÊN THẺ (OD-UX-04) ═══════
 *
 * Ba điều được khoá:
 *
 *   1. SỐ THẺ KHÔNG ĐỔI vì refactor. `demBanCu` dưới đây là câu đếm của `getReturnRateSummary` CHÉP
 *      NGUYÊN VĂN từ bản trước OD-UX-04 (main 73460b03b) — phạm vi, phép nối, vị từ đều viết tay như cũ.
 *      Hàm mới đi qua `returnSummaryScope` + `returnSummaryBucketWhere` phải ra đúng từng con số.
 *   2. DANH SÁCH = THẺ: với mọi nhóm × mốc × kỳ × ô tìm, `listReturnSummaryOrders(...).total` bằng số trên thẻ.
 *   3. PHÂN TRANG không trùng, không sót: Σ dòng qua mọi trang = total, mỗi đơn đúng một lần.
 *
 * Kỳ và từ tìm dựng TỪ CHÍNH DỮ LIỆU fixture (AGENTS 50) — không ghim ngày tuyệt đối.
 */
const o = schema.orders;
const s = schema.shipments;

async function demBanCu(db: Db, period: Period, q: string, basis: TimeBasis): Promise<Record<ReturnSummaryBucket, number>> {
  const conds: SQL[] = [REPORTABLE_ORDER];
  const moc = basis === "ORDERED" ? sql`${o.insertedAt}` : basis === "SHIPPED" ? sql.raw(CARRIER_HANDOFF_AT_SQL) : sql.raw(FINAL_OUTCOME_AT_SQL);
  if (period.from) conds.push(sql`${moc} >= ${period.from}`);
  if (period.to) conds.push(sql`${moc} <= ${period.to}`);
  if ((period.from || period.to) && basis !== "ORDERED") conds.push(sql`${moc} is not null`);
  const locGiaTri = orderValueWhereSql(NO_ORDER_VALUE_FILTER);
  if (locGiaTri) conds.push(sql.raw(locGiaTri));
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`exists (select 1 from order_items oi where oi.order_id = ${o.id} and oi.is_bonus = false and (oi.sku ilike ${like} or oi.product_name ilike ${like} or oi.variation_detail ilike ${like}))`);
  }
  const base = db
    .select({ shipmentStage: s.stage, outcome: outcomeColumn() })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(conds.length ? and(...conds) : undefined)
    .offset(OUTCOME_FENCE)
    .as("gtc_base_cu");
  const [row] = await db
    .select({
      shipped: sql<number>`count(*) filter (where ${base.outcome} in (${sql.raw(ELIGIBLE_SENT_SQL)}))`,
      delivered: sql<number>`count(*) filter (where ${base.outcome} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${base.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))`,
      returnedByRule: sql<number>`count(*) filter (where ${base.outcome} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(*) filter (where ${base.outcome} = 'IN_TRANSIT')`,
      failed: sql<number>`count(*) filter (where ${base.outcome} = 'IN_TRANSIT' and ${base.shipmentStage} = 'DELIVERY_FAILED')`,
      pending: sql<number>`count(*) filter (where ${base.outcome} = 'NOT_SHIPPED')`,
      cancelled: sql<number>`count(*) filter (where ${base.outcome} = 'CANCELLED')`,
    })
    .from(base);
  return Object.fromEntries(RETURN_SUMMARY_BUCKETS.map((b) => [b, Number(row?.[b] ?? 0)])) as Record<ReturnSummaryBucket, number>;
}

const ky = (from: Date | null, to: Date | null, ten: string): Period => ({ key: from || to ? "custom" : "all", from, to, label: ten, fromKey: null, toKey: null });

export async function testReturnsKpiDrill(db: Db) {
  // ───────── Kỳ và từ tìm dựng từ dữ liệu đang có ─────────
  const [moc] = (await db.execute(sql`select min(inserted_at) as dau, max(inserted_at) as cuoi from orders where stage::text <> 'NEW'`)).rows as { dau: string | Date | null; cuoi: string | Date | null }[];
  assert.ok(moc?.dau && moc?.cuoi, "fixture phải có đơn để bài so có nghĩa");
  const dau = new Date(moc.dau!);
  const cuoi = new Date(moc.cuoi!);
  const giua = new Date(dau.getTime() + (cuoi.getTime() - dau.getTime()) / 2);
  // Kỳ rộng hai đầu (dư 400 ngày để mốc bàn giao / mốc kết cục muộn hơn ngày lên đơn vẫn lọt vào) và một nửa kỳ.
  const NGAY = 86_400_000;
  const kys: Period[] = [ky(null, null, "all"), ky(new Date(dau.getTime() - NGAY), new Date(cuoi.getTime() + 400 * NGAY), "rong"), ky(dau, giua, "nua")];
  const [mau] = (await db.execute(sql`select substr(sku, 1, 3) as tu from order_items where is_bonus = false and coalesce(sku, '') <> '' group by 1 order by count(*) desc limit 1`)).rows as { tu: string }[];
  const tuTim = ["", mau?.tu ?? ""].filter((t, i, a) => a.indexOf(t) === i);

  let soLanSo = 0;
  let coGiao = false;
  let coHoan = false;
  for (const basis of TIME_BASES) {
    for (const k of kys) {
      for (const q of tuTim) {
        clearMemo();
        const the = await getReturnRateSummary(k, q, basis, NO_ORDER_VALUE_FILTER);
        const cu = await demBanCu(db, k, q, basis);
        const nhan = `(mốc=${basis}, kỳ=${k.label}, tìm="${q}")`;
        for (const b of RETURN_SUMMARY_BUCKETS) {
          assert.equal(the[b], cu[b], `${nhan} ${b}: số trên thẻ ĐỔI sau refactor (${cu[b]} → ${the[b]})`);
          const ds = await listReturnSummaryOrders(k, q, basis, NO_ORDER_VALUE_FILTER, b, 1, 50);
          assert.equal(ds.total, the[b], `${nhan} ${b}: danh sách ${ds.total} đơn ≠ thẻ ${the[b]}`);
          assert.equal(ds.rows.length, Math.min(50, the[b]), `${nhan} ${b}: trang đầu phải đủ dòng`);
          soLanSo += 1;
        }
        // Phép cộng đang in trên trang vẫn đúng với các tập danh sách.
        assert.equal(the.delivered + the.returned + the.inTransit, the.shipped, `${nhan}: giao + hoàn + chưa kết thúc = đã gửi`);
        assert.ok(the.failed <= the.inTransit && the.returnedByRule <= the.returned, `${nhan}: nhóm con nằm trong nhóm cha`);
        coGiao ||= the.delivered > 0;
        coHoan ||= the.returned > 0;
      }
    }
  }
  assert.ok(coGiao && coHoan, "fixture phải chạm cả giao lẫn hoàn — bài so không chạm số nào là bài so không chạy");

  // ───────── Phân trang: Σ dòng = total, không trùng ─────────
  const tatCa = kys[0];
  for (const b of RETURN_SUMMARY_BUCKETS) {
    const dau1 = await listReturnSummaryOrders(tatCa, "", "SHIPPED", NO_ORDER_VALUE_FILTER, b, 1, 7);
    const ids: string[] = [...dau1.rows.map((r) => r.id)];
    for (let p = 2; p <= dau1.pageCount; p++) ids.push(...(await listReturnSummaryOrders(tatCa, "", "SHIPPED", NO_ORDER_VALUE_FILTER, b, p, 7)).rows.map((r) => r.id));
    assert.equal(ids.length, dau1.total, `${b}: Σ dòng qua ${dau1.pageCount} trang phải bằng total`);
    assert.equal(new Set(ids).size, ids.length, `${b}: một đơn hiện ở hai trang — thứ tự không ổn định`);
  }
  const quaTrang = await listReturnSummaryOrders(tatCa, "", "SHIPPED", NO_ORDER_VALUE_FILTER, "shipped", 9999, 7);
  assert.equal(quaTrang.rows.length, 0, "trang vượt cuối ra rỗng, không lỗi");

  console.log(`✓ KPI /reports/returns bấm xuống: ${soLanSo} phép so · số thẻ y hệt bản trước refactor · danh sách = thẻ ở mọi nhóm × ${TIME_BASES.length} mốc × ${kys.length} kỳ × ${tuTim.length} ô tìm · phân trang không trùng không sót`);
}
