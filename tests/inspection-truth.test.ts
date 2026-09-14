import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  CONDITION_UNKNOWN,
  EVIDENCE_IS_CONCLUSIVE,
  QUALITY_COVERAGE_MIN_PCT,
  QUALITY_MIN_SAMPLE,
  REPORTED_CONDITIONS,
  countsTowardQualityRate,
  coverageVerdict,
} from "@/lib/constants/inspection-truth";
import { ITEM_CONDITIONS } from "@/lib/constants/return-lifecycle";
import { inspectionTruth } from "@/lib/queries/inspection-truth";

/**
 * ═══════════ CHỨNG CỨ, KHÔNG PHẢI SUY DIỄN ═══════════
 *
 * Bài kiểm này khoá đúng một câu: **không đường nào biến "hàng đã vào tồn" thành "hàng còn tốt".**
 *
 * Ba lối tắt bị chặn ở đây, và cả ba đều nghe hợp lý lúc viết:
 *   · có phiếu tái nhập  ⇒ hàng tốt
 *   · tồn có tăng        ⇒ điều kiện GOOD
 *   · không có dòng hỏng ⇒ hỏng = 0
 *
 * Đo production 14/09/2026: 132 món CÓ chứng cứ (tất cả `OK`), 615 món KHÔNG có chứng cứ nào,
 * 0 món hỏng. Nếu ba lối tắt trên tồn tại, màn hình sẽ nói "747 món tốt, 0% hỏng" — một câu về
 * 615 món chưa ai mở ra.
 */
export async function testInspectionTruth(db: Db) {
  const P = "itr-";

  /* ═══════ 1 · SỔ ĐĂNG KÝ: "CHƯA BIẾT" KHÔNG ĐƯỢC LÀ MỘT LỰA CHỌN Ở TRẠM ĐẾM ═══════ */

  assert.ok(
    !(ITEM_CONDITIONS as readonly string[]).includes(CONDITION_UNKNOWN),
    "`UNKNOWN` KHÔNG được nằm trong danh sách người đếm chọn được — một nút 'Chưa biết' trên trạm đếm là một nút bỏ qua việc",
  );
  assert.ok((REPORTED_CONDITIONS as readonly string[]).includes(CONDITION_UNKNOWN), "nhưng báo cáo thì PHẢI có `UNKNOWN`, nếu không phần chưa biết sẽ biến mất");
  assert.equal(REPORTED_CONDITIONS.length, ITEM_CONDITIONS.length + 1, "sổ báo cáo = sổ trạm đếm + đúng MỘT giá trị; thêm nữa là đang dựng phân loại thứ hai");
  assert.equal(countsTowardQualityRate(CONDITION_UNKNOWN), false, "`UNKNOWN` phải nằm NGOÀI mẫu số của tỷ lệ chất lượng");
  for (const c of ITEM_CONDITIONS) assert.equal(countsTowardQualityRate(c), true, `${c} là một kết luận thật, phải vào mẫu số`);
  assert.equal(EVIDENCE_IS_CONCLUSIVE.PARCEL_LEVEL_ONLY, false, "kết luận CẢ KIỆN không đủ để nói về một MÓN");
  assert.equal(EVIDENCE_IS_CONCLUSIVE.NO_EVIDENCE, false, "không chứng cứ thì không kết luận");
  assert.equal(EVIDENCE_IS_CONCLUSIVE.ITEM_CONFIRMED, true, "chỉ dòng kết luận từng món mới đủ");

  /* ═══════ 2 · NGƯỠNG ĐỦ CĂN CỨ PHÂN BIỆT ĐƯỢC BA LÝ DO KHÁC NHAU ═══════ */

  assert.equal(coverageVerdict(0, 0), "NONE", "chưa có gì ⇒ NONE");
  assert.equal(coverageVerdict(0, 100), "NONE", "có hàng nhưng không món nào có chứng cứ ⇒ NONE");
  assert.equal(coverageVerdict(QUALITY_MIN_SAMPLE - 1, QUALITY_MIN_SAMPLE), "LOW_SAMPLE", "mẫu quá nhỏ phải nói rõ là MẪU NHỎ, không phải thiếu độ phủ");
  assert.equal(coverageVerdict(QUALITY_MIN_SAMPLE + 5, 1000), "LOW_COVERAGE", "mẫu đủ lớn nhưng phủ ít ⇒ LOW_COVERAGE — hai việc phải làm khác nhau");
  assert.equal(coverageVerdict(90, 100), "ENOUGH", "90% và mẫu lớn ⇒ đủ căn cứ");
  // Đúng ngưỡng là ĐỦ, không phải thiếu.
  assert.equal(coverageVerdict(QUALITY_COVERAGE_MIN_PCT, 100), "ENOUGH", `đúng ${QUALITY_COVERAGE_MIN_PCT}% phải tính là ĐỦ`);

  /* ═══════ 3 · FIXTURE: TÁI HIỆN ĐÚNG HÌNH DẠNG PRODUCTION ═══════ */

  await db.insert(schema.products).values({ id: `${P}p1`, name: "Áo kiểm thử chứng cứ" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values([
    { id: `${P}v1`, productId: `${P}p1`, sku: `${P}SKU-A`, color: "Đỏ", size: "M" },
    { id: `${P}v2`, productId: `${P}p1`, sku: `${P}SKU-B`, color: "Xanh", size: "L" },
  ]);
  await db.insert(schema.users).values({ id: `${P}u1`, email: `${P}kho@test.vn`, name: "Kho Chứng Cứ", role: "WAREHOUSE", passwordHash: "x" });
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  // Mẫu mã v1 có phiếu NHẬP với đơn giá ⇒ tra được giá vốn. v2 KHÔNG có ⇒ giá vốn CHƯA BIẾT.
  await db.insert(schema.stockReceipts).values({ id: `${P}rin`, kind: "RECEIPT", receivedAt: gio(240), reference: "Nhập kiểm thử", totalQuantity: 10 });
  await db.insert(schema.stockReceiptItems).values({ id: `${P}rini`, receiptId: `${P}rin`, variantId: `${P}v1`, quantity: 10, unitCost: 100_000 });

  const dungKien = async (i: number, opts: { items?: boolean; receipt?: boolean; qty: number; variant: string }) => {
    const sid = `${P}s${i}`;
    await db.insert(schema.shipments).values({ id: sid, vtpOrderNumber: `${P}VTP${i}`, trackingCode: `${P}VTP${i}`, carrier: "VTP", stage: "RETURNED" });
    let receiptId: string | null = null;
    if (opts.receipt) {
      receiptId = `${P}r${i}`;
      await db.insert(schema.stockReceipts).values({ id: receiptId, kind: "RETURN", receivedAt: gio(3), reference: `Đếm ${i}`, totalQuantity: opts.qty });
      await db.insert(schema.stockReceiptItems).values({ id: `${P}ri${i}`, receiptId, variantId: opts.variant, quantity: opts.qty, shipmentId: sid });
    }
    await db.insert(schema.returnInspections).values({
      id: `${P}i${i}`,
      shipmentId: sid,
      status: "INSPECTED",
      receivedAt: gio(6),
      inspectedAt: gio(3),
      inspectedBy: "Kho Chứng Cứ",
      inspectedByUserId: `${P}u1`,
      condition: "RESTOCKABLE",
      restockQty: opts.qty,
      stockReceiptId: receiptId,
    });
    if (opts.items) {
      await db.insert(schema.returnInspectionItems).values({
        id: `${P}ii${i}`,
        inspectionId: `${P}i${i}`,
        shipmentId: sid,
        expectedVariantId: opts.variant,
        expectedSku: opts.variant,
        expectedQty: opts.qty,
        actualVariantId: opts.variant,
        actualSku: opts.variant,
        actualQty: opts.qty,
        condition: "OK",
        inspectedBy: "Kho Chứng Cứ",
        inspectedByUserId: `${P}u1`,
        inspectedAt: gio(3),
      });
    }
    return sid;
  };

  const truoc = await (async () => {
    clearMemo();
    return inspectionTruth();
  })();

  // Kiện A: CÓ phiếu, CÓ dòng món ⇒ chứng cứ đầy đủ, mẫu mã biết giá vốn.
  await dungKien(1, { items: true, receipt: true, qty: 2, variant: `${P}v1` });
  // Kiện B: CÓ phiếu nhưng KHÔNG dòng món ⇒ đây là nhóm 608 của production.
  await dungKien(2, { items: false, receipt: true, qty: 3, variant: `${P}v1` });
  // Kiện C: CÓ phiếu, KHÔNG dòng món, mẫu mã KHÔNG biết giá vốn.
  await dungKien(3, { items: false, receipt: true, qty: 4, variant: `${P}v2` });

  clearMemo();
  const sau = await inspectionTruth();

  /* ═══════ 4 · PHIẾU TÁI NHẬP KHÔNG SINH RA MỘT MÓN "TỐT" NÀO ═══════ */

  const themCoChungCu = sau.items.withEvidence - truoc.items.withEvidence;
  const themChuaBiet = sau.items.unknown - truoc.items.unknown;
  assert.equal(themCoChungCu, 2, "chỉ kiện CÓ dòng món mới thêm vào phần có chứng cứ — 2 món của kiện A");
  assert.equal(themChuaBiet, 7, "7 món của kiện B và C có phiếu tái nhập nhưng KHÔNG dòng món ⇒ phải là CHƯA BIẾT, không phải 'tốt'");

  const themKienCoChungCu = sau.parcels.withItemEvidence - truoc.parcels.withItemEvidence;
  const themKienChiCaKien = sau.parcels.parcelLevelOnly - truoc.parcels.parcelLevelOnly;
  assert.equal(themKienCoChungCu, 1, "một kiện có dòng món");
  assert.equal(themKienChiCaKien, 2, "hai kiện chỉ có kết luận cả kiện — phiếu tái nhập KHÔNG nâng chúng lên mức có chứng cứ");

  /* ═══════ 5 · "CHƯA BIẾT" CÓ MẶT TRONG PHÂN LOẠI, VÀ KHÔNG CÓ TỶ LỆ ═══════ */

  const oChuaBiet = sau.conditions.find((c) => c.condition === CONDITION_UNKNOWN);
  assert.ok(oChuaBiet, "phần chưa biết phải CÓ MẶT trong phân loại — bỏ nó đi là làm nó biến mất khỏi màn hình");
  assert.ok(oChuaBiet.items > 0);
  assert.equal(oChuaBiet.share, null, "CHƯA BIẾT không có tỷ lệ: nó không phải một kết luận để chiếm phần trăm của các kết luận khác");
  assert.equal(sau.conditions[sau.conditions.length - 1].condition, CONDITION_UNKNOWN, "CHƯA BIẾT luôn đứng cuối");

  // Tổng phân loại phải khớp số món đã vào tồn — không món nào rơi ra ngoài.
  const tongPhanLoai = sau.conditions.reduce((a, c) => a + c.items, 0);
  assert.equal(tongPhanLoai, sau.items.restocked, "tổng phân loại (kể cả CHƯA BIẾT) phải bằng số món đã vào tồn");

  /* ═══════ 6 · HỎNG = 0 KHÁC HỎNG = CHƯA BIẾT ═══════ */

  // Độ phủ của fixture rất thấp ⇒ chưa đủ căn cứ ⇒ TỶ LỆ hỏng phải là null.
  assert.ok(sau.coverage.verdict !== "ENOUGH", "fixture cố ý dựng độ phủ thấp");
  assert.equal(sau.damagedRate, null, "độ phủ chưa đủ ⇒ TỶ LỆ hỏng là CHƯA BIẾT, không phải 0% — 0% là một phát biểu về phần hàng chưa ai xem");
  assert.notEqual(sau.damagedRate, 0, "tuyệt đối không được là 0");

  /* ═══════ 7 · GIÁ VỐN: BIẾT LÀ SỐ, CHƯA BIẾT LÀ null — VÀ 0 THẬT VẪN KHÁC CHƯA BIẾT ═══════ */

  assert.ok(sau.cost.knownRecoveredValue > truoc.cost.knownRecoveredValue, "món biết giá vốn phải cộng vào giá trị thu hồi");
  const themChuaBietGia = sau.cost.unknownQty - truoc.cost.unknownQty;
  assert.equal(themChuaBietGia, 4, "4 món của mẫu mã không có phiếu nhập phải nằm ở 'chưa biết giá vốn', KHÔNG được nhân với 0 rồi cộng vào tổng");
  // 5 món của v1 (2 + 3) × 100.000đ — phần chưa biết KHÔNG kéo tổng xuống.
  assert.equal(sau.cost.knownRecoveredValue - truoc.cost.knownRecoveredValue, 5 * 100_000, "tổng chỉ gồm phần BIẾT giá, và đúng bằng số lượng × đơn giá phiếu nhập");

  // Giá vốn 0 THẬT (phiếu ghi 0) vẫn phải khác CHƯA BIẾT: biểu thức lọc `unit_cost > 0` nên 0
  // không bao giờ được coi là một mức giá đã biết.
  const nguonGia = readFileSync("lib/queries/cost-basis.ts", "utf8");
  assert.match(nguonGia, /unit_cost\s*>\s*0/, "chỉ đơn giá LỚN HƠN 0 mới là giá đã biết — 0 trên phiếu là chưa khai, không phải hàng cho không");
  assert.ok(!/coalesce\([^)]*,\s*0\s*\)/.test(nguonGia), "đường giá vốn này KHÔNG được có nhánh nào rơi về 0 — đó chính là lỗi nó sinh ra để sửa");

  /*
    VÀ NÓ PHẢI ĐỌC THEO TẬP, KHÔNG PHẢI TRUY VẤN CON TƯƠNG QUAN.

    Bản đầu gọi giá vốn ba lần trên mỗi dòng phiếu hoàn. Trên production đó là ~2.200 lượt quét
    bảng phiếu nhập trong một lần dựng trang, và vì Node chạy một luồng nên nó làm ĐỎ những trang
    KHÁC (`/ads` lỗi máy chủ, `/reports/returns` quá 60 giây) trong khi trang hàng hoàn vẫn xanh
    98 ms. Bài kiểm này canh đúng chỗ đó: một lần hồi quy nữa là một lượt triển khai hỏng.
  */
  assert.match(nguonGia, /distinct on \(ri_g\.variant_id\)/, "giá vốn phải quét bảng phiếu MỘT LẦN cho mỗi mẫu mã");
  assert.ok(
    !/export function receiptUnitCost/.test(nguonGia),
    "không được giữ lại bản theo DÒNG của giá vốn: nó là truy vấn con tương quan, và nó đã làm đỏ một lượt triển khai",
  );

  /* ═══════ 8 · KHÔNG SUY DIỄN TRONG MÃ NGUỒN ═══════ */

  const nguon = readFileSync("lib/queries/inspection-truth.ts", "utf8");
  assert.match(nguon, /LAST_RECEIPT_COST_BY_VARIANT/, "phần giá vốn phải NỐI vào bảng giá đọc một lần");
  assert.ok(!/receiptUnitCost\(/.test(nguon), "không lời gọi nào được tính lại giá vốn trên từng dòng");
  // Phần đếm chứng cứ KHÔNG được đọc cột nào của mức CẢ KIỆN để kết luận về MÓN.
  const khoiPhanLoai = nguon.slice(nguon.indexOf("select condition::text"), nguon.indexOf("GIÁ VỐN CỦA HÀNG"));
  for (const cam of ["stock_receipt_id", "restock_qty", "returnInspections"]) {
    assert.ok(!khoiPhanLoai.includes(cam), `phân loại điều kiện KHÔNG được đọc "${cam}" — đó là suy từ "hàng đã vào tồn" ra "hàng còn tốt"`);
  }
  assert.match(khoiPhanLoai, /return_inspection_items/, "chứng cứ duy nhất được chấp nhận là dòng kết luận từng món");
  // Lớp đọc không được ghi.
  for (const cam of ["insert(", "update(", "delete("]) {
    assert.ok(!nguon.includes(cam), `lớp đo KHÔNG được ghi ("${cam}") — đo và sửa là hai việc`);
  }
  // Và KHÔNG được backfill: không nhánh nào biến nhóm "chỉ có kết luận cả kiện" thành một kết luận.
  assert.ok(!/PARCEL_LEVEL_ONLY[^\n]*OK/.test(nguon), "không được ánh xạ nhóm 'chỉ có cả kiện' sang một kết luận nào");

  /* ═══════ 9 · MÀN HÌNH PHẢI HIỆN ĐỘ PHỦ, KHÔNG TÔ XANH KHI CHƯA ĐỦ ═══════ */

  const nguonUi = readFileSync("app/(dashboard)/inventory/returns/inspection-truth-section.tsx", "utf8");
  assert.match(nguonUi, /COVERAGE_VERDICT_LABEL/, "nhãn 'dữ liệu chưa đủ' phải hiện ra màn hình");
  assert.match(nguonUi, /damagedItems === null \? "—"/, "món hỏng chưa đủ căn cứ phải in '—', không in 0");
  assert.ok(!/tone: "green"[^}]*damagedRate/.test(nguonUi), "không tô xanh cho một tỷ lệ chưa đủ căn cứ");

  /* ═══════ 10 · DỌN SẠCH ═══════ */

  await db.delete(schema.returnInspectionItems).where(sql`${schema.returnInspectionItems.id} like ${P + "%"}`);
  await db.delete(schema.returnInspections).where(sql`${schema.returnInspections.id} like ${P + "%"}`);
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like ${P + "%"}`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like ${P + "%"}`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${P + "%"}`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like ${P + "%"}`);
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  await db.delete(schema.users).where(eq(schema.users.id, `${P}u1`));
  clearMemo();

  console.log(
    `✓ Chứng cứ kiểm hàng: phiếu tái nhập KHÔNG sinh ra một món "tốt" nào (7 món có phiếu mà không có dòng món ⇒ CHƯA BIẾT) · "CHƯA BIẾT" có mặt trong phân loại, đứng cuối, và KHÔNG có tỷ lệ · độ phủ thấp ⇒ tỷ lệ hỏng là null chứ không phải 0% · giá vốn chưa biết KHÔNG bị nhân 0 rồi cộng vào tổng (4 món đứng riêng, tổng chỉ gồm phần biết giá) · 0đ trên phiếu vẫn khác CHƯA BIẾT · phân loại không đọc một cột nào của mức CẢ KIỆN · lớp đo không ghi`,
  );
}
