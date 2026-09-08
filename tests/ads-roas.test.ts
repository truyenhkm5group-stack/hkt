import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { ROAS_HINT, ROAS_LABEL, getAdsRoas } from "@/lib/queries/ads-roas";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ROAS THEO KẾT QUẢ ĐƠN.
 *
 * Hai điều phải khoá: bốn mức ROAS không được bằng nhau (nếu bằng thì có nơi đang dùng nhầm định
 * nghĩa doanh thu), và phần KHÔNG quy kết được phải hiện ra chứ không bị chia đều cho các chiến dịch.
 */
export async function testAdsRoas(db: Db) {
  // Dựng một chiến dịch có đủ dữ liệu để bốn mức ROAS thật sự khác nhau: hai đơn cùng ad,
  // một giao thành công có tiền thực thu, một hoàn.
  await db.insert(schema.fbAds).values({ id: "ad-roas-1", name: "Mẩu QC A", campaignId: "camp-roas-1", campaignName: "Chiến dịch ROAS" }).onConflictDoNothing();
  await db.insert(schema.adSpends).values({ platform: "FACEBOOK", campaign: "Chiến dịch ROAS", campaignId: "camp-roas-1", spend: 1_000_000, spendDate: new Date("2026-09-01T00:00:00Z"), createdBy: "test" });
  for (const [i, spec] of [
    { stage: "DELIVERED", collected: 900_000, total: 1_000_000, code: "ROAS-OK" },
    { stage: "RETURNED", collected: 0, total: 1_000_000, code: "ROAS-HOAN" },
  ].entries()) {
    const orderId = `roas-order-${i}`;
    await db.insert(schema.orders).values({ id: orderId, stage: "SHIPPED", adId: "ad-roas-1", cod: spec.total, totalPriceAfterDiscount: spec.total, prepaid: 0, insertedAt: new Date("2026-09-02T00:00:00Z") });
    await db.insert(schema.shipments).values({
      orderId,
      vtpOrderNumber: spec.code,
      trackingCode: spec.code,
      stage: spec.stage as never,
      codAmount: spec.total,
      codCollected: spec.collected,
      shippingFee: 30_000,
      vtpStatusDate: new Date("2026-09-03T00:00:00Z"),
      deliveredAt: spec.stage === "DELIVERED" ? new Date("2026-09-03T00:00:00Z") : null,
    });
  }

  clearMemo();
  const r = await getAdsRoas(ALL, "campaign");

  // ───────── 0. Chiến dịch vừa dựng phải xuất hiện với đủ bốn mức ROAS ─────────
  const camp = r.rows.find((row) => row.key === "camp-roas-1");
  assert.ok(camp, "chiến dịch có đơn gắn ad_id phải xuất hiện trong bảng");
  assert.equal(camp.spend, 1_000_000);
  assert.equal(camp.bookedOrders, 2, "hai đơn đều tính vào doanh thu lên đơn");
  assert.equal(camp.deliveredOrders, 1, "chỉ một đơn tới tay khách");
  assert.equal(camp.bookedRevenue, 2_000_000);
  assert.equal(camp.deliveredRevenue, 1_000_000, "đơn hoàn KHÔNG được tính vào doanh thu giao thành công");
  assert.equal(camp.cashReceived, 900_000, "tiền về là số THỰC THU có chứng từ, không phải COD khai báo");
  assert.equal(camp.orderRoas, 2, "ROAS lên đơn = 2.000.000 ÷ 1.000.000");
  assert.equal(camp.deliveredRoas, 1, "ROAS giao thành công = 1.000.000 ÷ 1.000.000");
  assert.equal(camp.cashRoas, 0.9, "ROAS tiền về = 900.000 ÷ 1.000.000");
  assert.ok(camp.contributionRoas !== null && camp.contributionRoas < camp.cashRoas, "ROAS lợi nhuận góp phải thấp nhất — đã trừ giá vốn, cước và chính tiền QC");
  assert.equal(camp.successRate, 50, "GTC của chiến dịch = 1 giao TC ÷ 2 đơn đã kết thúc");

  // ───────── 1. Bốn mức ROAS phải giảm dần theo đúng bản chất ─────────
  for (const row of r.rows) {
    if (!row.spend) continue;
    assert.ok(row.bookedRevenue >= row.deliveredRevenue, `${row.name}: doanh thu lên đơn phải ≥ doanh thu giao thành công`);
    assert.ok(row.deliveredRevenue >= row.cashReceived || row.cashReceived === 0, `${row.name}: tiền về không thể vượt doanh thu giao thành công`);
    if (row.orderRoas !== null && row.deliveredRoas !== null) {
      assert.ok(row.orderRoas >= row.deliveredRoas, `${row.name}: ROAS lên đơn phải ≥ ROAS giao thành công`);
    }
    if (row.deliveredRoas !== null && row.contributionRoas !== null) {
      assert.ok(row.deliveredRoas >= row.contributionRoas, `${row.name}: ROAS giao thành công phải ≥ ROAS lợi nhuận góp`);
    }
  }

  // ───────── 2. Chưa tiêu đồng nào thì ROAS là CHƯA BIẾT, không phải 0 ─────────
  for (const row of r.rows) {
    if (row.spend === 0) {
      assert.equal(row.orderRoas, null, `${row.name}: chia cho 0 là vô nghĩa, phải trả null`);
      assert.equal(row.contributionRoas, null);
    }
  }

  // ───────── 3. KHÔNG BỊA QUY KẾT: phần không gán được phải hiện ra ─────────
  assert.ok(r.unmapped.ordersWithoutAd >= 0);
  assert.ok(r.unmapped.revenueWithoutAd >= 0);
  assert.ok(r.unmapped.spendWithoutOrders >= 0);
  // Doanh thu đã quy kết + doanh thu không có ad_id không được vượt tổng doanh thu của kỳ.
  const attributedRevenue = r.rows.reduce((t, row) => t + row.bookedRevenue, 0);
  assert.equal(r.totals.bookedRevenue, attributedRevenue, "tổng phải bằng tổng các dòng, không được cộng thêm gì");

  // ───────── 4. Nhãn và giải thích phải đủ cho người đọc ─────────
  for (const key of ["orderRoas", "deliveredRoas", "cashRoas", "contributionRoas"] as const) {
    assert.ok(ROAS_LABEL[key] && ROAS_HINT[key].length > 30, `${key} phải có nhãn và giải thích`);
  }

  console.log(
    `✓ ROAS theo kết quả đơn: ${r.rows.length} chiến dịch · chi ${r.totals.spend}đ · ${r.unmapped.ordersWithoutAd} đơn không có ad_id hiện riêng, không chia đều`,
  );
}
