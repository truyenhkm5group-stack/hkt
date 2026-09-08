import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import { getDashboardData } from "@/lib/queries/dashboard";
import { DELIVERED_REVENUE, metricScope } from "@/lib/queries/metrics";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * CHÂN LÝ TÀI CHÍNH — sáu con số tiền, mỗi con số một ý nghĩa.
 *
 * Điều phải khoá: KHÔNG được coi doanh thu giao thành công là tiền thực nhận, và không được
 * coi tiền đã về là bằng chứng đã giao. Cùng với đó: bậc thang phải cộng đúng, và những dòng
 * chỉ có ở mức kỳ phải được ghi nhãn để không ai chia nhỏ chúng về từng đơn.
 */
export async function testFinancialTruth(db: Db) {
  clearMemo();
  const f = await getFinancialTruth(ALL);

  // ───────── 1. Ba con số doanh thu / tiền là BA con số khác nhau ─────────
  assert.ok(f.revenue.booked >= f.revenue.delivered, "doanh thu lên đơn phải ≥ doanh thu giao thành công");
  assert.ok(f.revenue.booked > 0 && f.revenue.delivered > 0, "fixture phải có cả hai con số để so");
  assert.notEqual(f.revenue.delivered, f.cash.total, "doanh thu giao thành công KHÔNG được bằng tiền thực nhận — phần lớn còn ở ĐVVC");
  assert.ok(f.revenue.returned > 0, "doanh thu của đơn hoàn phải đếm riêng — đó là tiền không bao giờ về");

  // Doanh thu giao thành công phải đúng bằng định nghĩa chuẩn ở hợp đồng chỉ số.
  const [truth] = await db
    .select({ revenue: DELIVERED_REVENUE })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(metricScope(ALL, "confirmed"));
  assert.equal(f.revenue.delivered, Number(truth.revenue), "chân lý tài chính phải dùng CÙNG định nghĩa doanh thu với mọi màn hình khác");
  const dash = await getDashboardData(ALL);
  assert.equal(f.revenue.delivered, dash.kpi.successRevenue, "Tổng quan và Báo cáo phải nói cùng một con số");

  // ───────── 2. Bốn bậc chứng từ của tiền tách bạch ─────────
  // Mỗi vận đơn chỉ nằm ở đúng một bậc, nên tổng số đếm không được vượt tổng vận đơn của kỳ.
  const [{ n: shipmentsInScope }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .innerJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(metricScope(ALL, "confirmed"));
  assert.ok(
    f.cod.collectedCount + f.cod.reconciledCount + f.cod.paidToBankCount <= Number(shipmentsInScope),
    "ba bậc trạng thái tiền phải loại trừ lẫn nhau, không được cộng chồng",
  );
  assert.ok(f.cod.outstanding >= 0 && f.cod.outstandingCount >= 0);

  // ───────── 3. Bậc thang phải CỘNG ĐÚNG ─────────
  const line = (key: string) => f.waterfall.find((l) => l.key === key)!;
  assert.ok(line("delivered_revenue") && line("contribution") && line("estimated_profit"), "bậc thang phải có đủ các mốc");
  const contributionParts =
    line("delivered_revenue").amount + line("cogs").amount + line("shipping_out").amount + line("shipping_return").amount + line("ads").amount;
  assert.equal(line("contribution").amount, contributionParts, "lợi nhuận góp phải đúng bằng tổng các dòng phía trên");
  assert.equal(f.contribution, contributionParts);
  assert.equal(line("estimated_profit").amount, line("contribution").amount + line("operating").amount, "lợi nhuận ước tính = lợi nhuận góp − chi phí vận hành");
  assert.equal(f.estimatedProfit, line("estimated_profit").amount);
  // Mọi dòng chi phí phải mang dấu âm để bậc thang đọc được bằng mắt.
  for (const key of ["cogs", "shipping_out", "shipping_return", "ads", "operating"]) {
    assert.ok(line(key).amount <= 0, `dòng chi phí ${key} phải mang dấu âm`);
  }

  // ───────── 4. KHÔNG GIẢ VỜ CHÍNH XÁC ─────────
  assert.equal(line("ads").precision, "period_only", "chi quảng cáo chỉ có ở mức kỳ, không phân bổ về đơn");
  assert.equal(line("operating").precision, "period_only", "chi phí vận hành chỉ có ở mức kỳ");
  assert.equal(line("delivered_revenue").precision, "per_order", "doanh thu giao thành công truy được về từng đơn");
  assert.equal(line("cogs").precision, "per_order");
  for (const l of f.waterfall) assert.ok(l.note.length > 20, `dòng ${l.key} phải giải thích được cho người đọc`);

  // ───────── 5. THIẾU CHỨNG TỪ THÌ NÓI LÀ CHƯA BIẾT, KHÔNG ĐƯỢC TRẢ 0 ─────────
  const [{ n: batches }] = await db.select({ n: sql<number>`count(*)` }).from(schema.codBatches);
  if (Number(batches) === 0) {
    assert.equal(f.realizedProfit, null, "chưa có bảng kê nào thì lợi nhuận thực nhận là CHƯA BIẾT, không phải 0");
    assert.ok(f.realizedBlockedBy, "và phải nói rõ vì sao chưa tính được");
  } else {
    assert.equal(f.realizedBlockedBy, null);
    assert.equal(typeof f.realizedProfit, "number");
  }
  // Đơn thiếu giá vốn phải làm dòng giá vốn mang nhãn "thiếu dữ liệu", không im lặng.
  const [{ n: missingCogs }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${metricScope(ALL, "confirmed")} and ${schema.orders.cogs} = 0 and ${schema.orders.totalPriceAfterDiscount} > 0`);
  if (Number(missingCogs) > 0) {
    assert.ok(line("cogs").note.includes("giá vốn 0") || line("cogs").known === false, "đơn không tra được giá vốn phải được nói ra ở bậc thang");
  }

  // ───────── 6. Tiền thực nhận phải khớp báo cáo dòng tiền — một nguồn, hai màn hình ─────────
  const cashReport = await getCashProfitReport(ALL);
  assert.equal(f.cash.received, cashReport.cashIn.codPaidToBank, "tiền về theo bảng kê phải khớp báo cáo dòng tiền");
  assert.equal(f.cash.total, f.cash.received + f.cash.prepaid);

  console.log(
    `✓ Chân lý tài chính: lên đơn ${f.revenue.booked}đ ≠ giao TC ${f.revenue.delivered}đ ≠ thực nhận ${f.cash.total}đ · lợi nhuận góp ${f.contribution}đ · thực nhận ${f.realizedProfit === null ? "CHƯA XÁC MINH" : `${f.realizedProfit}đ`}`,
  );
}
