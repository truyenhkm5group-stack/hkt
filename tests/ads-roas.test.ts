import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import { eq, sql } from "drizzle-orm";
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
  /*
    ─── ĐƠN THỨ BA LÀ CẢ BÀI KIỂM: ĐANG ĐI, NHƯNG PANCAKE ĐÃ GHI SẴN MỘT KHOẢN CƯỚC ───

    `orders.partner_fee` được điền lúc LÊN ĐƠN, không phải lúc gửi hàng. Đơn chưa ngã ngũ vì thế
    mang một con số cước mà shop chưa hề chi đồng nào — và với mô hình BÁN TRƯỚC thì đó là phần lớn
    đơn của mọi kỳ.

    Bản trước của `getAdsRoas` cộng `sum(shipping)` KHÔNG lọc nên gánh trọn khoản ấy. Đo production
    23/09/2026, 30 ngày, đúng population của truy vấn: cước đúng **6.947.112 ₫** so với
    **12.804.112 ₫** đang in ra — dư **5.857.000 ₫ (+84%)** trên 45/87 dòng, dòng lệch nhiều nhất
    778.000 ₫. Và **98,8%** phần dư ấy đến từ ĐƠN ĐANG TREO, chỉ 68.000 ₫ từ đơn huỷ theo ĐVVC.

    CỐ Ý dùng đơn ĐANG TREO chứ không phải đơn huỷ-Pancake: `metricScope` đã loại đơn huỷ-Pancake
    khỏi population từ đầu, nên một ảnh chụp bằng đơn huỷ sẽ XANH kể cả với công thức sai — tôi đã
    viết đúng cái ảnh chụp vô dụng ấy trước khi kiểm đột biến bắt được.

    Khối này nằm ngay DƯỚI bảng quyết định trên cùng màn hình `/ads`, nên cùng một chiến dịch hiện
    hai con số lợi nhuận góp cách nhau một cú cuộn chuột.
  */
  await db.insert(schema.orders).values({
    id: "roas-order-treo",
    // Trong `CONFIRMED_STAGES` nên NẰM TRONG population; không có vận đơn nên chưa ngã ngũ.
    stage: "SHIPPED",
    adId: "ad-roas-1",
    cod: 1_000_000,
    totalPriceAfterDiscount: 1_000_000,
    prepaid: 0,
    partnerFee: 500_000,
    insertedAt: new Date("2026-09-02T00:00:00Z"),
  });
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
  assert.equal(camp.bookedOrders, 3, "cả ba đơn (giao TC · hoàn · đang treo) đều tính vào doanh thu lên đơn — chỉ đơn huỷ mới bị loại");
  assert.equal(camp.deliveredOrders, 1, "chỉ một đơn tới tay khách");
  assert.equal(camp.bookedRevenue, 3_000_000);
  assert.equal(camp.deliveredRevenue, 1_000_000, "đơn hoàn KHÔNG được tính vào doanh thu giao thành công");
  assert.equal(camp.cashReceived, 900_000, "tiền về là số THỰC THU có chứng từ, không phải COD khai báo");
  assert.equal(camp.orderRoas, 3, "ROAS lên đơn = 3.000.000 ÷ 1.000.000");
  assert.equal(camp.deliveredRoas, 1, "ROAS giao thành công = 1.000.000 ÷ 1.000.000");
  assert.equal(camp.cashRoas, 0.9, "ROAS tiền về = 900.000 ÷ 1.000.000");
  assert.ok(camp.contributionRoas !== null && camp.contributionRoas < camp.cashRoas, "ROAS lợi nhuận góp phải thấp nhất — đã trừ giá vốn, cước và chính tiền QC");
  assert.equal(camp.successRate, 50, "GTC của chiến dịch = 1 giao TC ÷ 2 đơn đã kết thúc");

  /*
    ───────── 0b. CƯỚC CHỈ TÍNH TRÊN ĐƠN ĐÃ NGÃ NGŨ ─────────

    Hai đơn đã ngã ngũ, mỗi đơn cước 30.000 ⇒ 60.000. Đơn huỷ mang `partner_fee` 500.000 của
    Pancake và phải nằm NGOÀI — nếu nó lọt vào, lợi nhuận góp tụt đúng nửa triệu và màn hình `/ads`
    lại nói hai con số ở hai khối cách nhau một cú cuộn chuột.

    Khẳng định bằng LỢI NHUẬN GÓP chứ không bằng một cột cước, vì lợi nhuận góp mới là thứ đi lên
    màn hình và đi vào ROAS.
  */
  /*
    Bài kiểm chỉ có nghĩa nếu đơn huỷ THẬT SỰ nằm trong dữ liệu — nếu lệnh gieo hỏng, khẳng định
    dưới đây vẫn xanh mà không chứng minh gì. `bookedOrders` KHÔNG dùng làm phép dò được: nó cố ý
    loại đơn huỷ (đó đúng là hành vi cần có), nên phải hỏi thẳng bảng.
  */
  const soDonTreo = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(eq(schema.orders.id, "roas-order-treo"));
  assert.equal(Number(soDonTreo[0].n), 1, "đơn đang treo phải có trong dữ liệu, nếu không phép kiểm cước bên dưới là rỗng nghĩa");
  /*
    `contribution` ở đây là SAU tiền quảng cáo: doanh thu giao TC − giá vốn − cước − chi QC.
    Fixture không có dòng hàng nên giá vốn 0, nên con số nói thẳng về vế CƯỚC:

        1.000.000 − 0 − 60.000 − 1.000.000 = −60.000

    Bản cũ cho **−560.000**: nó gánh thêm 500.000 cước ước tính của đơn ĐANG TREO.
  */
  assert.equal(
    camp.contribution,
    camp.deliveredRevenue - 60_000 - camp.spend,
    "lợi nhuận góp chỉ trừ cước của HAI đơn đã ngã ngũ (2 × 30.000); cước ước tính 500.000 của đơn ĐANG TREO là tiền chưa hề chi",
  );

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

  // ───────── CAC: chi phí thu hút một khách ─────────
  // CAC giao thành công LUÔN cao hơn hoặc bằng CAC lên đơn, vì mẫu số nhỏ hơn. Khoảng cách giữa hai
  // con số chính là tiền đã trả cho những đơn hoàn — với shop bán COD đó thường là chỗ lỗ.
  for (const row of r.rows) {
    if (row.cacBooked !== null && row.cacDelivered !== null) {
      assert.ok(row.cacDelivered >= row.cacBooked, `${row.name}: CAC giao thành công không thể rẻ hơn CAC lên đơn`);
    }
    // Không có đơn thì KHÔNG có CAC — chia cho 0 là vô nghĩa, không phải bằng 0.
    if (row.bookedOrders === 0) assert.equal(row.cacBooked, null, `${row.name}: chưa có đơn nào thì không có CAC`);
    if (row.deliveredOrders === 0) assert.equal(row.cacDelivered, null, `${row.name}: chưa giao đơn nào thì không có CAC giao thành công`);
    // CAC phải khớp đúng định nghĩa, không phải một con số gần đúng.
    if (row.cacBooked !== null) assert.equal(row.cacBooked, Math.round(row.spend / row.bookedOrders), `${row.name}: CAC lên đơn phải bằng chi QC ÷ số đơn`);
  }

  // ───────── CẤP MẨU QUẢNG CÁO: có đơn, KHÔNG có tiền ─────────
  // Facebook chỉ cho chi tiêu theo CHIẾN DỊCH/ngày. Trước đây tra tiền theo khoá mã mẩu quảng cáo
  // nên mọi dòng đều ra 0đ, và toàn bộ tiền chiến dịch bị xếp nhầm vào "chi tiêu không có đơn nào"
  // — một kết luận sai hoàn toàn. Nay nói thẳng là CHƯA BIẾT thay vì nói là 0.
  const byAd = await getAdsRoas(ALL, "ad");
  for (const row of byAd.rows) {
    assert.equal(row.spendKnown, false, `${row.name}: cấp mẩu quảng cáo KHÔNG có chi tiêu riêng`);
    assert.equal(row.orderRoas, null, `${row.name}: không biết chi tiêu thì KHÔNG có ROAS`);
    assert.equal(row.deliveredRoas, null, `${row.name}: không biết chi tiêu thì KHÔNG có ROAS giao thành công`);
    assert.equal(row.cacBooked, null, `${row.name}: không biết chi tiêu thì KHÔNG có CAC`);
  }
  assert.equal(byAd.unmapped.spendWithoutOrders, 0, "cấp mẩu quảng cáo không được kết luận tiền chiến dịch là 'không có đơn nào'");
  // Xếp theo doanh thu GIAO THÀNH CÔNG: mẩu nào đưa được hàng tới tay khách thì đứng trước.
  for (let i = 1; i < byAd.rows.length; i += 1) {
    assert.ok(byAd.rows[i - 1].deliveredRevenue >= byAd.rows[i].deliveredRevenue, "cấp mẩu quảng cáo phải xếp theo doanh thu giao thành công");
  }
  // Cấp chiến dịch thì ngược lại: có tiền thật.
  assert.ok(r.rows.every((row) => row.spendKnown), "cấp chiến dịch phải biết chi tiêu");

  console.log(
    `✓ ROAS theo kết quả đơn: ${r.rows.length} chiến dịch · chi ${r.totals.spend}đ · ${r.unmapped.ordersWithoutAd} đơn không có ad_id hiện riêng, không chia đều`,
  );
}
