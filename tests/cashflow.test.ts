import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { getCashflow } from "@/lib/queries/cashflow";

/**
 * DÒNG TIỀN & VỐN LƯU ĐỘNG.
 *
 * Điều phải khoá: LỢI NHUẬN KHÔNG PHẢI TIỀN, và ERP không được giả vờ biết số dư ngân hàng.
 */
export async function testCashflow(db: Db) {
  const r = await getCashflow();

  // ───────── 1. Không bịa số dư ngân hàng ─────────
  // ERP không có nguồn số dư. Bịa một số dư mở đầu để có con số "đẹp" là cách nhanh nhất biến công
  // cụ ra quyết định thành công cụ gây thiệt hại.
  assert.ok(r.limitations.length >= 3, "phải nói rõ những gì ERP KHÔNG biết");
  assert.ok(
    r.limitations.some((l) => l.includes("KHÔNG có số dư ngân hàng")),
    "phải nói thẳng đây là dòng tiền ròng, không phải số dư tài khoản",
  );
  assert.ok(
    r.limitations.some((l) => l.includes("CHƯA giao")),
    "phải nói rõ không dự phóng tiền từ đơn chưa giao",
  );

  /**
   * ───────── 1b. 0đ VÌ KHÔNG PHÁT SINH, hay 0đ VÌ CHƯA AI NHẬP? ─────────
   *
   * Bốn cấu phần của dự phóng đều có thể bằng 0 vì hai lý do khác hẳn nhau, và trình bày chúng giống
   * nhau là cách chắc chắn nhất để chủ shop tin nhầm một con số rỗng. Đo trên production 10/09/2026:
   * `production_orders` 0 dòng, `stock_receipts` đúng 2, 0/37 mẫu mã có giá nhập — nên "đã cam kết
   * với xưởng 0đ" và "vốn tồn kho 0đ" đều đang là CHƯA BIẾT.
   *
   * `limitations` vì thế phải ĐO dữ liệu, không được là văn bản cố định.
   */
  const soLenhSanXuat = (await db.select({ n: sql<number>`count(*)` }).from(schema.productionOrders))[0];
  if (Number(soLenhSanXuat?.n ?? 0) === 0) {
    assert.equal(r.workingCapital.productionCommitted, 0, "fixture: chưa có lệnh sản xuất thì phần cam kết là 0");
    assert.ok(
      r.limitations.some((l) => l.includes("CHƯA CÓ lệnh sản xuất")),
      "0đ vì chưa ai nhập lệnh sản xuất PHẢI được nói ra — nếu không nó đọc y như 'shop không cam kết gì với xưởng'",
    );
  }

  const giaNhap = (
    await db
      .select({ co: sql<number>`count(*) filter (where coalesce(${schema.productVariants.lastImportedPrice}, 0) > 0)`, tong: sql<number>`count(*)` })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.isRemoved, false))
  )[0];
  if (Number(giaNhap?.co ?? 0) === 0) {
    assert.ok(
      r.limitations.some((l) => l.includes("KHÔNG mẫu mã nào có giá nhập")),
      "vốn tồn kho 0đ vì thiếu giá nhập phải được nói là CHƯA BIẾT, không phải 'hàng không đáng tiền'",
    );
  } else {
    assert.ok(
      r.limitations.some((l) => l.includes("mẫu mã CÓ giá nhập")),
      "phải nói rõ vốn tồn kho chỉ phủ được bao nhiêu mẫu mã",
    );
  }

  // ───────── 2. Ba kỳ phải nhất quán với nhau ─────────
  const [d7, d14, d30] = r.buckets;
  assert.equal(d7.days, 7);
  assert.equal(d14.days, 14);
  assert.equal(d30.days, 30);
  for (const b of r.buckets) {
    // Kỳ dài hơn không thể thu ít hơn, chi ít hơn.
    assert.ok(Number.isFinite(b.net), `${b.label}: dòng tiền ròng phải hữu hạn`);
    assert.equal(b.net, b.codExpected - b.adsPlanned - b.opexPlanned - b.productionDue, `${b.label}: ròng phải đúng bằng vào trừ ra`);
    assert.ok(b.codExpected >= 0 && b.adsPlanned >= 0 && b.opexPlanned >= 0, `${b.label}: các khoản không được âm`);
  }
  assert.ok(d14.adsPlanned >= d7.adsPlanned, "kỳ dài hơn thì chi quảng cáo dự kiến không thể ít hơn");
  assert.ok(d30.opexPlanned >= d14.opexPlanned, "kỳ dài hơn thì chi vận hành dự kiến không thể ít hơn");
  assert.ok(d30.codExpected >= d7.codExpected, "kỳ dài hơn thì tiền COD về không thể ít hơn");

  // ───────── 3. COD về không được vượt tổng COD đang bị giữ ─────────
  // Dự phóng thu nhiều hơn số đang có là tạo ra tiền từ hư không.
  for (const b of r.buckets) {
    assert.ok(b.codExpected <= r.workingCapital.codReceivable + 1, `${b.label}: không được dự phóng thu quá số COD đang bị giữ`);
  }

  // ───────── 4. Vốn lưu động phải nhất quán ─────────
  const w = r.workingCapital;
  assert.ok(w.codOverdue <= w.codReceivable + 1, "phần quá hạn không thể lớn hơn tổng COD đang chờ");
  assert.ok(w.inventoryValue >= 0, "vốn tồn kho không được âm");
  assert.ok(w.productionCommitted >= 0, "tiền hàng cam kết không được âm");
  assert.ok(w.codReceivableCount >= 0);

  // ───────── 5. Cơ sở dự phóng phải hiện ra để kiểm chứng ─────────
  // Một con số dự phóng mà không nói dựa trên nhịp nào thì không ai kiểm được.
  assert.ok(r.basis.adsPerDay >= 0 && Number.isFinite(r.basis.adsPerDay), "phải nói nhịp chi quảng cáo mỗi ngày");
  assert.ok(r.basis.opexPerDay >= 0 && Number.isFinite(r.basis.opexPerDay), "phải nói nhịp chi vận hành mỗi ngày");
  assert.ok(r.basis.codSettlementDays > 0, "phải nói kỳ đối soát COD dùng để rải tiền về");

  console.log(
    `✓ Dòng tiền: 3 kỳ dự phóng · COD đang bị giữ ${Math.round(w.codReceivable).toLocaleString("vi-VN")}đ · nhịp QC ${r.basis.adsPerDay.toLocaleString("vi-VN")}đ/ngày · KHÔNG bịa số dư ngân hàng, KHÔNG dự phóng tiền từ đơn chưa giao`,
  );
}
