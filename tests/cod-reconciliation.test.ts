import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { codSettlementCounts, codSettlementSummary, listCodSettlement, listStatementPayments, statementGapDays } from "@/lib/queries/cod-settlement";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ĐỐI SOÁT COD THEO TỪNG ĐƠN.
 *
 * Câu hỏi nghiệp vụ: Viettel Post đã trả tiền cho đơn đã phát thành công chưa, trả đủ hay thiếu,
 * đơn nào quá hạn. Mọi con số phải truy được về DÒNG BẢNG KÊ thật, không suy từ trạng thái giao
 * hàng và không lấy tiền thu hộ khai báo làm tiền đã trả.
 */
export async function testCodReconciliation() {
  const db = await getDb();
  const ngay = (lech: number) => new Date(Date.now() + lech * 86_400_000);

  // ───────── Dựng bốn tình huống đối soát tách bạch ─────────
  await db.insert(schema.shipments).values([
    // 1. Giao thành công, bảng kê trả đủ.
    { id: "ds-du", vtpOrderNumber: "PKE7700000001", trackingCode: "PKE7700000001", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 499000, deliveredAt: ngay(-10) },
    // 2. Giao thành công, bảng kê chỉ trả 30.000 (khách chỉ trả tiền ship).
    { id: "ds-thieu", vtpOrderNumber: "PKE7700000002", trackingCode: "PKE7700000002", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 499000, deliveredAt: ngay(-10) },
    // 3. Giao thành công đã lâu, chưa dòng bảng kê nào ⇒ quá hạn.
    { id: "ds-quahan", vtpOrderNumber: "PKE7700000003", trackingCode: "PKE7700000003", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 600000, deliveredAt: ngay(-(COD_OVERDUE_DAYS + 3)) },
    // 4. Giao thành công hôm qua, chưa có bảng kê ⇒ còn trong hạn.
    { id: "ds-cho", vtpOrderNumber: "PKE7700000004", trackingCode: "PKE7700000004", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 700000, deliveredAt: ngay(-1) },
    // 5. Đơn hoàn ⇒ Viettel Post không thu được tiền nên không phải trả.
    { id: "ds-hoan", vtpOrderNumber: "PKE7700000005", trackingCode: "PKE7700000005", carrier: "Viettel Post", stage: "RETURNED", codAmount: 800000, returnedAt: ngay(-6) },
  ]).onConflictDoNothing();

  await db.insert(schema.codStatementLines).values([
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7700000001", cod: 499000, fee: 17000, net: 482000, codReported: true, statementAt: ngay(-8), shipmentId: "ds-du" },
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7700000002", cod: 30000, fee: 17000, net: 13000, codReported: true, statementAt: ngay(-8), shipmentId: "ds-thieu" },
    // Dòng bảng kê có mã vận đơn mà ERP không có ⇒ tiền có thật nhưng chưa truy nguyên được.
    { sourceFile: "BK-test-1.xlsx", trackingCode: "PKE7799999999", cod: 250000, fee: 0, net: 250000, codReported: true, statementAt: ngay(-8), shipmentId: null },
  ]).onConflictDoNothing();
  clearMemo();

  // ───────── 1. Phân loại từng đơn ─────────
  const theoDon = new Map<string, (typeof rows)[number]>();
  const { rows } = await listCodSettlement({ period: ALL, status: "ALL", pageSize: 200 });
  for (const r of rows) theoDon.set(r.id, r);

  assert.equal(theoDon.get("ds-du")?.status, "DA_TRA_DU", "bảng kê trả đủ tiền thu hộ ⇒ đã trả đủ");
  assert.equal(theoDon.get("ds-du")?.codPaid, 499000, "tiền trả lấy từ dòng bảng kê");
  assert.equal(theoDon.get("ds-du")?.fee, 17000, "cước lấy từ dòng bảng kê, không ước lượng");

  assert.equal(theoDon.get("ds-thieu")?.status, "TRA_THIEU");
  assert.equal(theoDon.get("ds-thieu")?.gap, 469000, "chênh lệch = thu hộ khai báo − tiền bảng kê trả");

  assert.equal(theoDon.get("ds-quahan")?.status, "QUA_HAN", `đã phát quá ${COD_OVERDUE_DAYS} ngày mà chưa có bảng kê ⇒ quá hạn`);
  assert.equal(theoDon.get("ds-quahan")?.codPaid, 0, "không có chứng từ thì tiền đã trả là 0, không lấy COD khai báo");

  assert.equal(theoDon.get("ds-cho")?.status, "CHUA_TRA", "mới phát hôm qua thì còn trong hạn, không được báo quá hạn");
  assert.equal(theoDon.get("ds-hoan")?.status, "KHONG_PHAI_TRA", "đơn hoàn thì Viettel Post không thu được tiền nên không phải trả");

  // ───────── 2. Tổng hợp phải khớp với chi tiết ─────────
  const tong = await codSettlementSummary(ALL);
  const daGiaoCoThuHo = rows.filter((r) => r.stage === "DELIVERED" && r.codDeclared > 0);
  assert.equal(tong.phaiThu.count, daGiaoCoThuHo.length, "phải thu chỉ gồm đơn đã phát thành công có thu hộ");
  assert.equal(tong.phaiThu.amount, daGiaoCoThuHo.reduce((t, r) => t + r.codDeclared, 0), "tổng phải thu = cộng từng đơn");
  assert.equal(tong.daTra.amount, daGiaoCoThuHo.reduce((t, r) => t + r.codPaid, 0), "tổng đã trả = cộng tiền bảng kê từng đơn");
  assert.ok(tong.daTra.amount <= tong.phaiThu.amount, "đã trả không bao giờ lớn hơn phải trả");
  assert.equal(tong.conThieu, tong.phaiThu.amount - tong.daTra.amount, "còn thiếu = phải thu − đã trả");
  assert.ok(tong.quaHan.amount >= 600000, "tiền quá hạn phải gồm đơn ds-quahan");
  assert.ok(tong.traThieu.gap >= 469000, "chênh lệch trả thiếu phải gồm đơn ds-thieu");
  assert.ok(tong.chuaGhep.amount >= 250000, "phải nêu được phần tiền bảng kê chưa ghép về vận đơn nào");
  assert.equal(tong.overdueDays, COD_OVERDUE_DAYS);

  // Đơn hoàn KHÔNG được nằm trong phải thu — đó là lý do phễu không phình.
  const hoanTrongPhaiThu = daGiaoCoThuHo.some((r) => r.id === "ds-hoan");
  assert.equal(hoanTrongPhaiThu, false, "đơn hoàn không được tính vào tiền Viettel Post phải trả");

  // ───────── 3. Đếm theo tab phải cộng lại đúng bằng tổng ─────────
  const dem = await codSettlementCounts(ALL);
  const cong = (["DA_TRA_DU", "TRA_THIEU", "CHUA_TRA", "QUA_HAN", "CHUA_GIAO", "KHONG_PHAI_TRA"] as const).reduce((t, k) => t + dem[k], 0);
  assert.equal(cong, dem.ALL, "cộng các nhóm phải bằng tổng — không đơn nào rơi ra ngoài hoặc bị đếm hai lần");

  // Lọc theo một nhóm phải ra đúng số của nhóm đó.
  const chiQuaHan = await listCodSettlement({ period: ALL, status: "QUA_HAN", pageSize: 200 });
  assert.equal(chiQuaHan.total, dem.QUA_HAN, "lọc theo nhóm phải khớp số trên tab");
  assert.ok(chiQuaHan.rows.every((r) => r.status === "QUA_HAN"));

  // ───────── 4. Ngày phát chưa được bảng kê nào chi trả ─────────
  const thieu = await statementGapDays();
  const ngayQuaHan = theoDon.get("ds-quahan")?.deliveredAt;
  assert.ok(
    thieu.some((g) => ngayQuaHan !== null && ngayQuaHan !== undefined && g.from <= ngayQuaHan && ngayQuaHan <= g.to),
    "ngày phát của đơn chưa được trả phải hiện ra để biết còn thiếu bảng kê kỳ nào",
  );
  assert.ok(
    thieu.every((g) => g.amount >= 0 && g.shipments > 0),
    "mỗi khoảng thiếu phải có đơn thật, không dựng khoảng rỗng",
  );

  // ───────── 5. Từng bảng kê = một lần trả tiền ─────────
  const bangKe = await listStatementPayments(50);
  const test1 = bangKe.find((f) => f.filename === "BK-test-1.xlsx");
  assert.ok(test1, "bảng kê vừa nạp phải hiện trong danh sách lần trả tiền");
  assert.equal(test1.lines, 3, "đếm đủ mọi dòng của bảng kê");
  assert.equal(test1.matched, 2, "hai dòng ghép được vận đơn");
  assert.equal(test1.codMatched, 529000, "tiền đã truy nguyên = 499.000 + 30.000");
  assert.equal(test1.codUnmatched, 250000, "phần chưa truy nguyên giữ nguyên, không giấu đi");

  // ───────── 6. Dọn dẹp để không ảnh hưởng phần kiểm thử khác ─────────
  await db.delete(schema.codStatementLines).where(eq(schema.codStatementLines.sourceFile, "BK-test-1.xlsx"));
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'ds-%'`);
  clearMemo();

  console.log(`✓ Đối soát COD theo đơn: phải trả ${tong.phaiThu.amount} · đã trả ${tong.daTra.amount} · quá hạn ${tong.quaHan.count} đơn · trả thiếu ${tong.traThieu.gap}đ · chưa ghép ${tong.chuaGhep.amount}đ`);
}
