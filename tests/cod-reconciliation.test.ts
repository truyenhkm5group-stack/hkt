import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { materializeCodFromStatementLines } from "@/lib/integrations/viettelpost/statement-db";
import { codSettlementCounts, codSettlementSummary, listCodSettlement, listStatementPayments, statementGapDays } from "@/lib/queries/cod-settlement";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ĐỐI SOÁT COD THEO TỪNG ĐƠN.
 *
 * Câu hỏi nghiệp vụ: Viettel Post đã trả tiền cho đơn giao thành công chưa, trả đủ hay thiếu, đơn
 * nào quá hạn. Hai cái bẫy phải tránh, đều đã xảy ra thật:
 *   1. lấy trạng thái "Giao thành công" của Viettel Post làm căn cứ — Viettel Post ghi như vậy cho
 *      cả đơn khách không nhận hàng, chỉ trả tiền ship (230 vận đơn, 15,9tr khai báo / 6tr thực thu
 *      bị tính thành nợ);
 *   2. cộng TIỀN THU HỘ KHAI BÁO thay vì tiền bảng kê thật.
 */
export async function testCodReconciliation() {
  const db = await getDb();
  const ngay = (lech: number) => new Date(Date.now() + lech * 86_400_000);

  await db.insert(schema.shipments).values([
    // 1. Giao thành công, bảng kê trả đủ.
    { id: "ds-du", vtpOrderNumber: "PKE7700000001", trackingCode: "PKE7700000001", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 499000, deliveredAt: ngay(-10) },
    // 2. Giao thành công, bảng kê trả 400K trên đơn khai 800K ⇒ Viettel Post còn nợ 400K.
    { id: "ds-thieu", vtpOrderNumber: "PKE7700000002", trackingCode: "PKE7700000002", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 800000, deliveredAt: ngay(-10) },
    // 3. Viettel Post báo "Giao thành công" nhưng bảng kê chỉ trả 30K — khách chỉ trả tiền ship
    //    để xem hàng. Theo quy tắc của shop đây là ĐƠN HOÀN, không phải Viettel Post nợ 469K.
    { id: "ds-giao-hoan", vtpOrderNumber: "PKE7700000003", trackingCode: "PKE7700000003", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 499000, deliveredAt: ngay(-10) },
    // 4. Giao thành công đã lâu, chưa dòng bảng kê nào ⇒ quá hạn.
    { id: "ds-quahan", vtpOrderNumber: "PKE7700000004", trackingCode: "PKE7700000004", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 600000, deliveredAt: ngay(-(COD_OVERDUE_DAYS + 3)) },
    // 5. Giao thành công hôm qua, chưa có bảng kê ⇒ còn trong hạn.
    { id: "ds-cho", vtpOrderNumber: "PKE7700000005", trackingCode: "PKE7700000005", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 700000, deliveredAt: ngay(-1) },
    // 6. Đơn hoàn ⇒ Viettel Post không thu được tiền nên không phải trả.
    { id: "ds-hoan", vtpOrderNumber: "PKE7700000006", trackingCode: "PKE7700000006", carrier: "Viettel Post", stage: "RETURNED", codAmount: 900000, returnedAt: ngay(-6) },
  ]).onConflictDoNothing();

  await db.insert(schema.codStatementLines).values([
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7700000001", cod: 499000, fee: 17000, net: 482000, codReported: true, statementAt: ngay(-8), shipmentId: "ds-du" },
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7700000002", cod: 400000, fee: 17000, net: 383000, codReported: true, statementAt: ngay(-8), shipmentId: "ds-thieu" },
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7700000003", cod: 30000, fee: 17000, net: 13000, codReported: true, statementAt: ngay(-8), shipmentId: "ds-giao-hoan" },
    // Dòng bảng kê có mã vận đơn mà ERP không có ⇒ tiền có thật nhưng chưa truy nguyên được.
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7799999999", cod: 250000, fee: 0, net: 250000, codReported: true, statementAt: ngay(-8), shipmentId: null },
  ]).onConflictDoNothing();
  // Đúng như bản chạy thật: số tiền trên vận đơn là kết quả dựng lại từ sổ chứng từ.
  await materializeCodFromStatementLines(["ds-du", "ds-thieu", "ds-giao-hoan"]);
  clearMemo();

  // ───────── 1. Phân loại từng đơn ─────────
  const { rows } = await listCodSettlement({ period: ALL, status: "ALL", pageSize: 300 });
  const theoDon = new Map(rows.map((r) => [r.id, r]));

  assert.equal(theoDon.get("ds-du")?.status, "DA_TRA_DU", "bảng kê trả đủ tiền thu hộ ⇒ đã trả đủ");
  assert.equal(theoDon.get("ds-du")?.codPaid, 499000, "tiền trả lấy từ dòng bảng kê");
  assert.equal(theoDon.get("ds-du")?.fee, 17000, "cước lấy từ dòng bảng kê, không ước lượng");

  assert.equal(theoDon.get("ds-thieu")?.status, "TRA_THIEU", "vẫn là đơn giao thành công mà trả thiếu ⇒ Viettel Post còn nợ");
  assert.equal(theoDon.get("ds-thieu")?.gap, 400000, "chênh lệch = thu hộ khai báo − tiền bảng kê trả");

  assert.equal(theoDon.get("ds-giao-hoan")?.status, "GIAO_NHUNG_HOAN",
    "Viettel Post báo giao thành công nhưng chỉ thu được tiền ship ⇒ đơn hoàn, KHÔNG phải nợ");

  assert.equal(theoDon.get("ds-quahan")?.status, "QUA_HAN", `đã phát quá ${COD_OVERDUE_DAYS} ngày mà chưa có bảng kê ⇒ quá hạn`);
  assert.equal(theoDon.get("ds-quahan")?.codPaid, 0, "không có chứng từ thì tiền đã trả là 0, không lấy COD khai báo");

  assert.equal(theoDon.get("ds-cho")?.status, "CHUA_TRA", "mới phát hôm qua thì còn trong hạn, không được báo quá hạn");
  assert.equal(theoDon.get("ds-hoan")?.status, "KHONG_PHAI_TRA", "đơn hoàn thì Viettel Post không thu được tiền nên không phải trả");

  // ───────── 2. Tổng hợp: không được chứa nợ ảo ─────────
  const tong = await codSettlementSummary(ALL);
  const phaiTra = rows.filter((r) => ["DA_TRA_DU", "TRA_THIEU", "CHUA_TRA", "QUA_HAN"].includes(r.status));
  assert.equal(tong.phaiThu.count, phaiTra.length, "phải thu chỉ gồm đơn giao thành công theo kết quả đơn");
  assert.ok(!phaiTra.some((r) => r.id === "ds-giao-hoan"), "đơn khách chỉ trả tiền ship KHÔNG được tính là Viettel Post còn nợ");
  assert.ok(!phaiTra.some((r) => r.id === "ds-hoan"), "đơn hoàn không được tính vào tiền Viettel Post phải trả");

  // Đơn đã có bảng kê thì phải trả = số bảng kê; chưa có thì tạm tính theo khai báo.
  const mongDoi = phaiTra.reduce((t, r) => t + (r.codPaid > 0 ? r.codPaid : r.codDeclared), 0);
  assert.equal(tong.phaiThu.amount, mongDoi, "có chứng từ thì lấy số bảng kê, chưa có mới tạm tính theo khai báo");
  assert.equal(tong.daTra.amount, phaiTra.reduce((t, r) => t + r.codPaid, 0), "đã trả = cộng tiền bảng kê từng đơn");
  assert.ok(tong.daTra.amount <= tong.phaiThu.amount, "đã trả không bao giờ lớn hơn phải trả");
  assert.equal(tong.conThieu, tong.phaiThu.amount - tong.daTra.amount, "còn thiếu = phải thu − đã trả");

  // Phần đang tạm tính phải nói rõ là bao nhiêu — chưa biết không được trình bày như đã xác minh.
  const chuaCoChungTu = phaiTra.filter((r) => r.codPaid === 0);
  assert.equal(tong.uocTinh.count, chuaCoChungTu.length, "phải nêu được bao nhiêu đơn đang tạm tính");
  assert.equal(tong.uocTinh.amount, chuaCoChungTu.reduce((t, r) => t + r.codDeclared, 0));

  assert.ok(tong.quaHan.amount >= 600000, "tiền quá hạn phải gồm đơn ds-quahan");
  assert.equal(tong.traThieu.gap, 400000, "chênh lệch trả thiếu chỉ tính đơn vẫn là giao thành công");
  assert.ok(tong.giaoNhungHoan.count >= 1, "phải đếm được đơn giao nhưng thu không đủ");
  assert.ok(tong.giaoNhungHoan.khaiBao >= 499000 && tong.giaoNhungHoan.thucThu >= 30000,
    "nhóm giao nhưng hoàn phải nêu cả số khai báo lẫn số thực thu để thấy khoảng cách");
  assert.ok(tong.chuaGhep.amount >= 250000, "phải nêu được phần tiền bảng kê chưa ghép về vận đơn nào");
  assert.equal(tong.overdueDays, COD_OVERDUE_DAYS);

  // ───────── 3. Đếm theo tab phải cộng lại đúng bằng tổng ─────────
  const dem = await codSettlementCounts(ALL);
  const cong = (["DA_TRA_DU", "TRA_THIEU", "CHUA_TRA", "QUA_HAN", "CHUA_GIAO", "GIAO_NHUNG_HOAN", "KHONG_PHAI_TRA"] as const).reduce((t, k) => t + dem[k], 0);
  assert.equal(cong, dem.ALL, "cộng các nhóm phải bằng tổng — không đơn nào rơi ra ngoài hoặc bị đếm hai lần");

  const chiQuaHan = await listCodSettlement({ period: ALL, status: "QUA_HAN", pageSize: 300 });
  assert.equal(chiQuaHan.total, dem.QUA_HAN, "lọc theo nhóm phải khớp số trên tab");
  assert.ok(chiQuaHan.rows.every((r) => r.status === "QUA_HAN"));

  // ───────── 4. Ngày phát chưa được bảng kê nào chi trả ─────────
  const thieu = await statementGapDays();
  const ngayQuaHan = theoDon.get("ds-quahan")?.deliveredAt;
  assert.ok(
    thieu.some((g) => Boolean(ngayQuaHan) && g.from <= ngayQuaHan! && ngayQuaHan! <= g.to),
    "ngày phát của đơn chưa được trả phải hiện ra để biết còn thiếu bảng kê kỳ nào",
  );
  assert.ok(thieu.every((g) => g.amount >= 0 && g.shipments > 0), "mỗi khoảng thiếu phải có đơn thật, không dựng khoảng rỗng");

  // ───────── 5. Từng bảng kê = một lần trả tiền ─────────
  const bangKe = await listStatementPayments(50);
  const test1 = bangKe.find((f) => f.filename === "BK-test-1.xlsx");
  assert.ok(test1, "bảng kê vừa nạp phải hiện trong danh sách lần trả tiền");
  assert.equal(test1.lines, 4, "đếm đủ mọi dòng của bảng kê");
  assert.equal(test1.matched, 3, "ba dòng ghép được vận đơn");
  assert.equal(test1.codMatched, 929000, "tiền đã truy nguyên = 499.000 + 400.000 + 30.000");
  assert.equal(test1.codUnmatched, 250000, "phần chưa truy nguyên giữ nguyên, không giấu đi");

  // ───────── 6. Dọn dẹp ─────────
  await db.delete(schema.codStatementLines).where(eq(schema.codStatementLines.sourceFile, "BK-test-1.xlsx"));
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'ds-%'`);
  clearMemo();

  console.log(`✓ Đối soát COD theo đơn: phải trả ${tong.phaiThu.amount} (tạm tính ${tong.uocTinh.amount}) · đã trả ${tong.daTra.amount} · quá hạn ${tong.quaHan.count} đơn · trả thiếu ${tong.traThieu.gap}đ · giao nhưng hoàn ${tong.giaoNhungHoan.count} đơn`);
}
