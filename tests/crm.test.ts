import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CRM_RULE, CRM_SEGMENT_ACTION, CRM_SEGMENT_LABEL, CRM_SEGMENT_ORDER } from "@/lib/constants/crm";
import { getRetentionReport, monthIndex, segmentOf } from "@/lib/queries/crm";

/**
 * ───────── GIỮ CHÂN KHÁCH ─────────
 *
 * Điều phải khoá: **khách mua lại đếm trên ĐƠN GIAO THÀNH CÔNG, không phải đơn đã đặt.**
 *
 * Bài kiểm thử dựng đúng ca gây hiểu lầm: một khách đặt ba đơn và hoàn cả ba. Cách đếm quen thuộc
 * gọi người đó là "khách mua lại"; cách đếm đúng thì người đó thậm chí chưa từng nhận được hàng.
 * Nếu có ai đó đổi mẫu số sang "đơn đã đặt" cho tỷ lệ đẹp hơn, bài này đỏ ngay.
 */

const DAY = 86_400_000;

export async function testCrm(db: Db) {
  clearMemo();

  // ───────── 1. Phân khúc theo đơn ĐÃ NHẬN và độ nguội ─────────
  assert.equal(segmentOf(1, 10), "NEW", "một đơn đã nhận, vừa mua xong");
  assert.equal(segmentOf(2, 10), "REPEAT", "hai đơn đã nhận, còn hoạt động");
  assert.equal(segmentOf(CRM_RULE.loyalOrders, 10), "LOYAL", `từ ${CRM_RULE.loyalOrders} đơn đã nhận trở lên là trung thành`);
  assert.equal(segmentOf(3, CRM_RULE.activeDays + 1), "AT_RISK", "khách từng mua đều mà chững lại là nguy cơ, không phải đã mất");
  assert.equal(segmentOf(1, CRM_RULE.activeDays + 1), "CHURNED", "mua đúng một lần rồi im lặng thì coi như đã rời bỏ");
  assert.equal(segmentOf(5, CRM_RULE.churnedDays + 1), "CHURNED", "quá mốc rời bỏ thì số đơn cũ không giữ được ai");
  // Ranh giới phải nằm đúng chỗ, không lệch một ngày.
  assert.equal(segmentOf(2, CRM_RULE.activeDays), "REPEAT", "đúng ngày cuối của kỳ hoạt động vẫn là đang hoạt động");
  assert.equal(segmentOf(2, CRM_RULE.churnedDays), "AT_RISK", "đúng ngày cuối của kỳ nguy cơ vẫn là nguy cơ");

  assert.equal(monthIndex("2026-01", "2026-01"), 0);
  assert.equal(monthIndex("2025-11", "2026-02"), 3, "chỉ số tháng phải nhảy đúng qua ranh giới năm");

  // Mỗi phân khúc phải có nhãn tiếng Việt và nói được NÊN LÀM GÌ.
  for (const s of CRM_SEGMENT_ORDER) {
    assert.ok(CRM_SEGMENT_LABEL[s]?.length > 3, `thiếu nhãn phân khúc ${s}`);
    assert.ok(CRM_SEGMENT_ACTION[s]?.length > 20, `${s}: đặt tên một nhóm mà không nói nên làm gì thì nhóm đó vô dụng`);
  }
  assert.equal(new Set(Object.values(CRM_SEGMENT_LABEL)).size, CRM_SEGMENT_ORDER.length, "hai phân khúc không được dùng chung một nhãn");

  // ───────── 2. Trên CSDL thật ─────────
  const customerIds = ["crm-c1", "crm-c2", "crm-c3", "crm-c4", "crm-c5"];
  const orderIds = ["crm-o11", "crm-o12", "crm-o21", "crm-o22", "crm-o23", "crm-o31", "crm-o41", "crm-o42", "crm-o51"];
  const truoc = await getRetentionReport();
  try {
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
    await db.insert(schema.customers).values([
      { id: customerIds[0], name: "Khách mua lại thật", phone: "0900000001" },
      { id: customerIds[1], name: "Khách đặt nhiều hoàn hết", phone: "0900000002" },
      { id: customerIds[2], name: "Khách một lần rồi mất", phone: "0900000003" },
      { id: customerIds[3], name: "Khách đang nguội", phone: "0900000004", lastOrderAt: at(150) },
      { id: customerIds[4], name: "Khách vừa mua lần đầu", phone: "0900000005" },
    ]);

    /** Dựng một đơn kèm vận đơn. Tiền thực thu > 100K ⇒ ORDER_OUTCOME kết luận GIAO THÀNH CÔNG. */
    const mk = async (id: string, customerId: string, daysAgo: number, ket_qua: "DELIVERED" | "RETURNED", revenue = 499_000) => {
      await db.insert(schema.orders).values({
        id,
        systemId: Number(id.replace(/\D/g, "")),
        customerId,
        stage: "DELIVERED",
        status: 0,
        insertedAt: at(daysAgo),
        totalPriceAfterDiscount: revenue,
      });
      await db.insert(schema.shipments).values({
        orderId: id,
        carrier: "Viettel Post",
        vtpOrderNumber: `CRM${id.replace(/\D/g, "")}`,
        stage: ket_qua === "DELIVERED" ? "DELIVERED" : "RETURNED",
        codAmount: revenue,
        codCollected: ket_qua === "DELIVERED" ? revenue : 0,
      });
    };

    await mk(orderIds[0], customerIds[0], 200, "DELIVERED");
    await mk(orderIds[1], customerIds[0], 100, "DELIVERED");
    // Đặt ba đơn, hoàn cả ba: cách đếm theo đơn đã đặt gọi đây là khách mua lại.
    await mk(orderIds[2], customerIds[1], 90, "RETURNED");
    await mk(orderIds[3], customerIds[1], 60, "RETURNED");
    await mk(orderIds[4], customerIds[1], 30, "RETURNED");
    await mk(orderIds[5], customerIds[2], 300, "DELIVERED");
    await mk(orderIds[6], customerIds[3], 400, "DELIVERED");
    await mk(orderIds[7], customerIds[3], 150, "DELIVERED");
    // Khách nhận hàng lần đầu trong THÁNG NÀY — cohort mới nhất chưa có cơ hội quay lại.
    await mk(orderIds[8], customerIds[4], 2, "DELIVERED");

    clearMemo();
    const r = await getRetentionReport();

    // Ba khách ĐÃ NHẬN hàng: c1, c3, c4. Khách hoàn hết không phải người mua.
    assert.equal(r.buyers - truoc.buyers, 4, "khách chưa từng nhận được hàng KHÔNG được tính là người mua");
    assert.equal(r.repeatBuyers - truoc.repeatBuyers, 2, "chỉ c1 và c4 thực sự nhận hàng từ hai lần trở lên");

    // Cách đếm quen dùng gom cả khách hoàn hết vào — và đó chính là phần thổi phồng.
    assert.equal(r.naiveBuyers - truoc.naiveBuyers, 5, "đếm theo đơn đã đặt thì khách hoàn hết vẫn được tính");
    assert.equal(r.naiveRepeatBuyers - truoc.naiveRepeatBuyers, 3, "đếm theo đơn đã đặt thì khách hoàn ba đơn thành khách mua lại");

    // Độ phủ: 5 đơn giao thành công vừa dựng đều có gán khách.
    assert.equal(r.coverage.deliveredWithCustomer - truoc.coverage.deliveredWithCustomer, 6);
    assert.ok(
      r.coverage.deliveredOrders >= r.coverage.deliveredWithCustomer,
      "đơn giao thành công có gán khách không thể nhiều hơn tổng đơn giao thành công",
    );

    // Phân khúc phải phủ hết và không đếm trùng.
    const tongPhanKhuc = r.segments.reduce((sum, s) => sum + s.customers, 0);
    assert.equal(tongPhanKhuc, r.buyers, "mỗi người mua phải thuộc đúng MỘT phân khúc");
    for (const s of r.segments) {
      assert.ok(s.avgValue === null || s.customers > 0, `${s.segment}: có giá trị trung bình thì phải có khách`);
      assert.ok(s.revenue >= 0 && Number.isInteger(s.revenue), `${s.segment}: tiền là số nguyên VND không âm`);
    }

    // Khách đang nguội phải nằm trong danh sách hành động, kèm tiền đã mang lại.
    const nguoi_nguoi = r.atRisk.find((c) => c.id === customerIds[3]);
    assert.ok(nguoi_nguoi, "khách từng mua hai lần và đã chững phải xuất hiện ở danh sách nguy cơ");
    assert.equal(nguoi_nguoi?.orders, 2);
    assert.ok((nguoi_nguoi?.daysSince ?? 0) > CRM_RULE.activeDays);
    assert.ok(r.atRisk.length <= CRM_RULE.atRiskListSize, "danh sách hành động phải có giới hạn để còn dùng được");
    assert.ok(!r.atRisk.some((c) => c.id === customerIds[1]), "khách hoàn hết không được lọt vào danh sách chăm sóc");

    // Cohort: tháng CHƯA TỚI phải để trống, không phải 0.
    assert.ok(r.cohorts.length >= 1, "phải có ít nhất một cohort");
    const moi_nhat = r.cohorts[r.cohorts.length - 1];
    assert.equal(moi_nhat.months.length, CRM_RULE.cohortMonths);
    assert.ok(
      moi_nhat.months.some((m) => m === null),
      "cohort tháng này chưa có cơ hội quay lại — các tháng chưa tới phải là CHƯA BIẾT, không phải 0",
    );
    for (const c of r.cohorts) {
      for (const m of c.months) {
        assert.ok(m === null || m <= c.size, `${c.cohort}: số khách quay lại không thể nhiều hơn quy mô cohort`);
      }
    }

    // Tỷ lệ phải là null khi không có mẫu số, không phải 0.
    assert.ok(r.repeatRate === null || (r.repeatRate >= 0 && r.repeatRate <= 100));
    if (r.repeatRate !== null && r.naiveRepeatRate !== null) {
      assert.equal(r.inflationPoints, Math.round((r.naiveRepeatRate - r.repeatRate) * 10) / 10, "khoảng chênh phải đúng bằng hiệu hai cách đếm");
    }

    assert.ok(
      r.limitations.some((l) => l.includes("GIAO THÀNH CÔNG")),
      "phải nói thẳng mẫu số là đơn giao thành công",
    );
    assert.ok(
      r.limitations.some((l) => l.includes("hai số điện thoại")),
      "phải nói rõ khách trùng chưa được gộp — nếu không, con số bị hiểu là đã chính xác",
    );
  } finally {
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
    await db.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    clearMemo();
  }

  console.log(
    `✓ Giữ chân khách: mua lại đếm trên ĐƠN GIAO THÀNH CÔNG (khách hoàn 3 đơn không phải khách mua lại) · phân khúc phủ hết không trùng · cohort tháng chưa tới để trống`,
  );
}
