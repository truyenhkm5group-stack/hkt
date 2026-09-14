import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { AGE_BUCKETS, INSPECT_TO_RESTOCK_SLA_HOURS, RECEIVE_TO_INSPECT_SLA_HOURS, RETURN_KPI_GAPS } from "@/lib/constants/return-kpi";
import { CASE_SLA_HOURS } from "@/lib/constants/action-queue";
import { INSPECT_AGE_DAYS } from "@/lib/constants/return-lifecycle";
import { RETURN_STAGE_BY_KEY } from "@/lib/constants/return-pipeline";
import { inspectionDashboard } from "@/lib/returns/inspection";
import { returnByInspector, returnBySku, returnThroughput, returnWarehouseKpi } from "@/lib/queries/return-warehouse-kpi";

/**
 * ═══════════ ĐO HIỆU SUẤT KHO HÀNG HOÀN: KIỆN ≠ MÓN, VÀ CHƯA BIẾT ≠ 0 ═══════════
 *
 * Bài kiểm này khoá bốn thứ dễ hỏng nhất của một bộ KPI:
 *
 *  1. **Đếm hai lần.** Một kiện ba món phải là MỘT kiện và BA món. Trộn hai đơn vị là cách nhanh
 *     nhất để một bảng điều khiển nói dối mà vẫn cộng đúng.
 *  2. **Hai màn hình hai con số.** Dải thẻ cũ và khối KPI mới đọc cùng một bảng; nếu chúng lệch
 *     nhau thì cả hai mất giá trị.
 *  3. **Mẫu số sai.** Tỷ lệ bán lại được phải chia cho kiện ĐÃ ĐẾM, không phải kiện đã nhận.
 *  4. **CHƯA BIẾT in thành 0.** Nhóm tuổi rỗng không có "kiện cũ nhất 0 giờ"; mẫu số 0 ra `null`.
 */
export async function testReturnWarehouseKpi(db: Db) {
  const P = "rwk-";

  /* ═══════════ 1 · HẠN LẤY LẠI TỪ HẰNG SỐ ĐANG CHẠY, KHÔNG GÕ LẠI ═══════════ */

  assert.equal(
    RECEIVE_TO_INSPECT_SLA_HOURS,
    CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION,
    "hạn chặng nhận→đếm phải ĐỌC THẲNG hằng số của hàng đợi việc — gõ lại một con số là mở đường cho hai nơi nói hai số (AGENTS.md mục 22)",
  );
  assert.equal(INSPECT_TO_RESTOCK_SLA_HOURS, RETURN_STAGE_BY_KEY.INSPECTED.slaHours, "hạn chặng đếm→nhập phải đọc từ khâu INSPECTED của đường ống");

  /* ═══════════ 2 · NHÓM TUỔI PHẢI KÍN VÀ KHÔNG CHỒNG NHAU ═══════════ */

  for (let i = 1; i < AGE_BUCKETS.length; i++) {
    assert.equal(AGE_BUCKETS[i].fromHours, AGE_BUCKETS[i - 1].toHours, `nhóm tuổi ${AGE_BUCKETS[i].key} hở hoặc chồng lên nhóm trước — một kiện sẽ rơi vào hai nhóm hoặc không nhóm nào`);
  }
  assert.equal(AGE_BUCKETS[0].fromHours, 0, "nhóm đầu phải bắt đầu từ 0 giờ");
  assert.equal(AGE_BUCKETS[AGE_BUCKETS.length - 1].toHours, null, "nhóm cuối phải để mở — kiện nằm 90 ngày vẫn phải đếm được");
  assert.equal(
    AGE_BUCKETS[AGE_BUCKETS.length - 1].fromHours,
    RECEIVE_TO_INSPECT_SLA_HOURS,
    "ranh giới nhóm cuối phải TRÙNG hạn xử lý, nếu không ô 'quá hạn' và nhóm tuổi cuối sẽ nói hai tập kiện khác nhau trên cùng màn hình",
  );

  /*
    ═══ HAI BỘ MỐC TUỔI SỐNG CẠNH NHAU — PHẢI ĐỒNG Ý VỚI NHAU Ở CHỖ "TRỄ" BẮT ĐẦU ═══

    Trang này có hai thứ đo tuổi, và cả hai đều có lý do tồn tại:
     · `AGE_BUCKETS` (GIỜ) — dải HIỂN THỊ, gắn thẳng vào hạn xử lý;
     · `INSPECT_AGE_DAYS` (NGÀY) — bộ lọc ở trạm đếm, người kho chọn "chờ ≥ 3 ngày".

    Chúng đang trùng nhau ở mốc "trễ" (3 ngày = 72 giờ), nhưng đó mới chỉ là TRÙNG HỢP: không có gì
    giữ cho một bên đổi mà bên kia đổi theo. Khi đó màn hình sẽ gọi một kiện là quá hạn ở dải trên
    còn bộ lọc thì không — và người kho tin bộ lọc.
  */
  assert.equal(
    INSPECT_AGE_DAYS.TON_DONG * 24,
    RECEIVE_TO_INSPECT_SLA_HOURS,
    "mốc 'tồn đọng' của bộ lọc trạm đếm phải bằng đúng hạn nhận→đếm, nếu không dải tuổi và bộ lọc sẽ gọi hai tập kiện khác nhau là 'trễ'",
  );

  /* ═══════════ 3 · FIXTURE: MỘT KIỆN BA MÓN, MỘT KIỆN QUÁ HẠN ═══════════ */

  await db.insert(schema.products).values({ id: `${P}p1`, name: "Áo kiểm thử KPI" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values([
    { id: `${P}v1`, productId: `${P}p1`, sku: `${P}SKU-A`, color: "Đỏ", size: "M" },
    { id: `${P}v2`, productId: `${P}p1`, sku: `${P}SKU-B`, color: "Xanh", size: "L" },
  ]);
  await db.insert(schema.shipments).values([
    { id: `${P}s1`, vtpOrderNumber: `${P}VTP1`, trackingCode: `${P}VTP1`, carrier: "VTP", stage: "RETURNED" },
    { id: `${P}s2`, vtpOrderNumber: `${P}VTP2`, trackingCode: `${P}VTP2`, carrier: "VTP", stage: "RETURNED" },
  ]);
  await db.insert(schema.users).values({ id: `${P}u1`, email: `${P}kho@test.vn`, name: "Kho Thử", role: "WAREHOUSE", passwordHash: "x" });

  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  // Kiện 1: ĐÃ ĐẾM, ba món vào lại tồn, đếm xong sau 2 giờ (trong hạn).
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ id: `${P}r1`, kind: "RETURN", receivedAt: gio(2), reference: "Đếm hàng hoàn KPI", totalQuantity: 3 })
    .returning();
  await db.insert(schema.stockReceiptItems).values([
    { id: `${P}ri1`, receiptId: phieu.id, variantId: `${P}v1`, quantity: 2, shipmentId: `${P}s1` },
    { id: `${P}ri2`, receiptId: phieu.id, variantId: `${P}v2`, quantity: 1, shipmentId: `${P}s1` },
  ]);
  await db.insert(schema.returnInspections).values({
    id: `${P}i1`,
    shipmentId: `${P}s1`,
    status: "INSPECTED",
    receivedAt: gio(4),
    inspectedAt: gio(2),
    inspectedBy: "Kho Thử",
    inspectedByUserId: `${P}u1`,
    condition: "RESTOCKABLE",
    restockQty: 3,
    unsellableQty: 1,
    stockReceiptId: phieu.id,
  });
  // Kiện 2: CHƯA ĐẾM và đã quá hạn.
  await db.insert(schema.returnInspections).values({
    id: `${P}i2`,
    shipmentId: `${P}s2`,
    status: "RECEIVED",
    receivedAt: gio(RECEIVE_TO_INSPECT_SLA_HOURS + 10),
  });

  clearMemo();
  const kpi = await returnWarehouseKpi();

  /* ═══════════ 4 · KIỆN ĐẾM MỘT LẦN, MÓN ĐẾM ĐÚNG SỐ MÓN ═══════════ */

  const [demKien] = await db.select({ n: sql<number>`count(*)` }).from(schema.returnInspections);
  assert.equal(
    kpi.receivedParcels,
    Number(demKien.n),
    "số KIỆN phải bằng số dòng `return_inspections` — một kiện ba món vẫn là MỘT kiện, và bảng này có `shipment_id` UNIQUE nên nó là mẫu đúng",
  );
  assert.equal(kpi.inspectedParcels + kpi.pendingInspection, kpi.receivedParcels, "đã đếm + chờ đếm phải bằng tổng kiện đã về — không có kiện nào rơi ra ngoài");

  const truoc = kpi.restockedQty;
  assert.ok(truoc >= 3, "món vào lại tồn phải đếm đủ 3 món của kiện ba món");
  assert.notEqual(kpi.restockedQty, kpi.restockedParcels, "MÓN và KIỆN là hai đơn vị khác nhau — fixture cố ý dựng kiện 3 món để hai số này không thể bằng nhau do trùng hợp");

  /* ═══════════ 5 · QUÁ HẠN VÀ NHÓM TUỔI NÓI CÙNG MỘT TẬP KIỆN ═══════════ */

  const nhomCuoi = kpi.aging.find((b) => b.key === AGE_BUCKETS[AGE_BUCKETS.length - 1].key);
  assert.ok(nhomCuoi, "thiếu nhóm tuổi cuối");
  assert.equal(kpi.slaBreach, nhomCuoi.parcels, "ô 'quá hạn đếm' và nhóm tuổi >72h phải là CÙNG MỘT tập kiện — hai con số cho một câu hỏi thì cả hai mất giá trị");
  assert.ok(kpi.slaBreach >= 1, "kiện dựng quá hạn phải được đếm");

  // Nhóm RỖNG: kiện cũ nhất là CHƯA BIẾT, không phải "0 giờ".
  for (const b of kpi.aging) {
    if (b.parcels === 0) assert.equal(b.oldestHours, null, `nhóm ${b.key} rỗng phải trả null cho 'kiện cũ nhất' — in 0 giờ là nói có một kiện vừa vào`);
    else assert.ok(typeof b.oldestHours === "number" && b.oldestHours >= 0, `nhóm ${b.key} có kiện thì phải đo được tuổi`);
  }
  assert.equal(
    kpi.aging.reduce((a, b) => a + b.parcels, 0),
    kpi.pendingInspection,
    "tổng bốn nhóm tuổi phải bằng số kiện chờ đếm — hở một kiện nghĩa là có kiện không nhóm nào nhận",
  );

  /* ═══════════ 6 · HAI TỶ LỆ, HAI MẪU SỐ — VÀ MẪU SỐ 0 RA null ═══════════ */

  assert.ok(kpi.restockableRate !== null, "có kiện đã đếm thì tỷ lệ bán lại được phải đo được");
  // Mẫu số là kiện ĐÃ ĐẾM, không phải kiện đã nhận: kiện chờ đếm không được kéo tỷ lệ xuống.
  const kyVong = (kpi.restockableParcels / kpi.inspectedParcels) * 100;
  assert.ok(Math.abs((kpi.restockableRate ?? 0) - kyVong) < 0.001, "tỷ lệ bán lại được phải chia cho kiện ĐÃ ĐẾM — chia cho kiện đã nhận là kết luận 'không bán lại được' cho thứ chưa ai mở ra");
  const khacNeuChiaSai = (kpi.restockableParcels / kpi.receivedParcels) * 100;
  assert.notEqual(Math.round(kyVong * 10), Math.round(khacNeuChiaSai * 10), "fixture phải dựng sao cho hai mẫu số ra hai số KHÁC nhau, nếu không bài kiểm này không chứng minh được gì");

  assert.ok(kpi.recoveryRate !== null && kpi.recoveryRate > 0 && kpi.recoveryRate < 100, "tỷ lệ thu hồi phải nằm giữa 0 và 100 khi có cả món vào tồn lẫn món hỏng");

  /* ═══════════ 7 · HAI MÀN HÌNH KHÔNG ĐƯỢC NÓI HAI CON SỐ ═══════════ */

  const cu = await inspectionDashboard();
  assert.equal(kpi.pendingInspection, cu.pendingInspection, "khối KPI mới và dải thẻ cũ đọc cùng một bảng — lệch nhau là một trong hai đang sai");
  assert.equal(kpi.awaitingArrival, cu.awaitingArrival, "'chờ kho nhận' phải dùng đúng vị ngữ của bàn nhận hàng");
  assert.equal(kpi.restockedQty, cu.restockedQty, "số món vào lại tồn phải khớp giữa hai khối");

  /* ═══════════ 8 · NĂNG SUẤT: ĐỦ NGÀY, KHÔNG HỞ, KHÔNG TRỘN ĐƠN VỊ ═══════════ */

  clearMemo();
  const ns = await returnThroughput(7);
  assert.equal(ns.length, 7, "xin 7 ngày phải trả đủ 7 dòng — ngày không có lượt nào vẫn phải có mặt, nếu không biểu đồ sẽ nối liền hai ngày cách nhau một tuần");
  for (let i = 1; i < ns.length; i++) assert.ok(ns[i].day > ns[i - 1].day, "ngày phải tăng dần");
  assert.equal(new Set(ns.map((d) => d.day)).size, ns.length, "không được trùng ngày");
  const nhanTrong7 = ns.reduce((a, d) => a + d.receivedParcels, 0);
  assert.ok(nhanTrong7 >= 1, "kiện dựng trong vài giờ qua phải nằm trong cửa sổ 7 ngày");

  /* ═══════════ 9 · THEO NGƯỜI: ĐO VIỆC HỌ LÀM, KHÔNG ĐOÁN NGƯỜI ═══════════ */

  clearMemo();
  const nguoi = await returnByInspector(30);
  const toi = nguoi.rows.find((r) => r.userId === `${P}u1`);
  assert.ok(toi, "người đếm có khoá tài khoản phải xuất hiện");
  assert.equal(toi.inspectedParcels, 1, "đếm theo KIỆN, không theo món");
  assert.equal(toi.restockQty, 3, "món thì đếm theo món");
  assert.equal(toi.onTimeRate, 100, "đếm xong sau 2 giờ là trong hạn 72 giờ");
  assert.ok(toi.medianHours !== null && Math.abs(toi.medianHours - 2) < 0.2, "thời gian đếm trung vị phải đo từ lúc NHẬN tới lúc ĐẾM XONG");
  assert.equal(toi.name, "Kho Thử", "tên do máy chủ đọc từ bảng `users`, không nhận từ nơi gọi (AGENTS.md mục 34)");

  /*
    Dòng không có khoá tài khoản KHÔNG được đoán về một người nào.

    Đo ĐỘ CHÊNH chứ không đo giá trị tuyệt đối: những bài kiểm chạy trước trong cùng CSDL cũng có
    lượt đếm vô danh hợp lệ của chúng. Thứ phải đúng ở đây là "thêm một dòng vô danh thì đếm vô
    danh tăng đúng một" — và đó cũng là điều đúng trên production.
  */
  const vonVoDanh = nguoi.unattributed;
  await db.insert(schema.shipments).values({ id: `${P}s3`, vtpOrderNumber: `${P}VTP3`, trackingCode: `${P}VTP3`, carrier: "VTP", stage: "RETURNED" });
  await db.insert(schema.returnInspections).values({
    id: `${P}i3`,
    shipmentId: `${P}s3`,
    status: "INSPECTED",
    receivedAt: gio(5),
    inspectedAt: gio(1),
    inspectedBy: "Ai đó ghi tay",
    inspectedByUserId: null,
    condition: "DAMAGED",
    note: "hỏng",
    restockQty: 0,
    unsellableQty: 2,
  });
  clearMemo();
  const nguoi2 = await returnByInspector(30);
  assert.equal(nguoi2.unattributed, vonVoDanh + 1, "lượt đếm không có khoá tài khoản phải đếm RIÊNG, không gán cho ai");
  assert.ok(!nguoi2.rows.some((r) => r.userId === "Ai đó ghi tay"), "ô CHỮ không bao giờ được dùng làm khoá quy kết (AGENTS.md mục 34)");
  assert.equal(nguoi2.rows.find((r) => r.userId === `${P}u1`)?.inspectedParcels, 1, "thêm một dòng vô danh không được làm đổi số của người có khoá");

  /* ═══════════ 10 · THEO MẪU MÃ: ĐỌC TỪ PHIẾU KHO, KIỆN ĐẾM DISTINCT ═══════════ */

  clearMemo();
  const mauMa = await returnBySku(90, 50);
  const a = mauMa.find((r) => r.variantId === `${P}v1`);
  const b = mauMa.find((r) => r.variantId === `${P}v2`);
  assert.ok(a && b, "cả hai mẫu mã của phiếu tái nhập phải có mặt");
  assert.equal(a.restockedQty, 2, "món đếm theo số lượng trên dòng phiếu");
  assert.equal(b.restockedQty, 1);
  assert.equal(a.parcels, 1, "hai dòng phiếu của CÙNG một kiện vẫn là MỘT kiện — đếm distinct vận đơn, không đếm dòng");
  assert.equal(a.sku, `${P}SKU-A`, "mã mẫu mã đọc từ danh mục");

  /* ═══════════ 11 · KHÔNG CÓ ĐƯỜNG TẮT TRONG MÃ NGUỒN ═══════════ */

  const nguon = readFileSync("lib/queries/return-warehouse-kpi.ts", "utf8");
  // Đây là lớp ĐỌC. Một lệnh ghi ở đây nghĩa là một bảng điều khiển đang sửa dữ liệu nó đo.
  for (const cam of ["insert(", "update(", "delete(", "recordInspection", "markReturnsArrived"]) {
    assert.ok(!nguon.includes(cam), `truy vấn KPI không được GHI ("${cam}") — đo và sửa là hai việc, gộp lại thì không ai tin được con số nữa`);
  }
  // Hạn phải đọc từ hằng số dùng chung, không được gõ số vào SQL.
  assert.ok(!/interval\s*'\s*72/.test(nguon), "không được gõ cứng 72 giờ vào SQL — hạn đọc từ hằng số dùng chung");
  assert.match(nguon, /RECEIVE_TO_INSPECT_SLA_HOURS/, "hạn phải lấy từ hằng số");
  // Cắt ngày theo giờ Việt Nam: cắt theo UTC là mỗi sáng mất một mẩu ca làm.
  assert.match(nguon, /Asia\/Ho_Chi_Minh/, "ngày phải cắt theo giờ Việt Nam");

  /* ═══════════ 12 · BA CHỖ CHƯA ĐO ĐƯỢC PHẢI KHAI ĐỦ, VÀ HIỆN RA MÀN HÌNH ═══════════ */

  assert.ok(RETURN_KPI_GAPS.length >= 3, "phải khai đủ ba chỗ chưa đo được");
  for (const g of RETURN_KPI_GAPS) {
    assert.ok(g.measured.length > 10, `${g.key} phải nói ĐO ĐƯỢC BAO NHIÊU, không chỉ nói "chưa có"`);
    assert.ok(g.missingWhat.length > 20, `${g.key} phải nói cần gì để đo được — cụ thể tới mức sửa được (AGENTS.md mục 45)`);
    assert.ok(g.blocks.length > 10, `${g.key} phải nói nó đang chặn chỉ số nào`);
  }
  const nguonUi = readFileSync("app/(dashboard)/inventory/returns/warehouse-kpi.tsx", "utf8");
  assert.match(nguonUi, /RETURN_KPI_GAPS/, "ba chỗ chưa đo được phải HIỆN RA màn hình, không giấu trong mã nguồn (AGENTS.md mục 24)");

  /* ═══════════ 13 · DỌN SẠCH: bài sau không được thấy fixture của bài này ═══════════ */

  await db.delete(schema.returnInspections).where(sql`${schema.returnInspections.id} like ${P + "%"}`);
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like ${P + "%"}`);
  await db.delete(schema.stockReceipts).where(eq(schema.stockReceipts.id, `${P}r1`));
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${P + "%"}`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like ${P + "%"}`);
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  await db.delete(schema.users).where(eq(schema.users.id, `${P}u1`));
  clearMemo();

  console.log(
    `✓ KPI kho hàng hoàn: hạn đọc từ hằng số đang chạy (không gõ lại) · bốn nhóm tuổi kín và ranh giới cuối TRÙNG hạn nên "quá hạn" và nhóm >72h là cùng một tập kiện · KIỆN đếm một lần còn MÓN đếm đúng số món · tỷ lệ bán lại được chia cho kiện ĐÃ ĐẾM (fixture chứng minh hai mẫu số ra hai số khác nhau) · nhóm tuổi rỗng trả "chưa biết" chứ không phải 0 giờ · khối KPI mới và dải thẻ cũ khớp từng số · người đếm đo theo KHOÁ tài khoản, lượt vô danh đếm riêng không gán cho ai · mẫu mã đếm distinct kiện · lớp đọc không có một lệnh ghi nào`,
  );
}
