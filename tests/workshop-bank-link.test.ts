import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { LINK_TARGET_DOMAIN, LINK_TARGET_LABEL, LINK_TARGET_TYPES } from "@/lib/constants/finance-truth";
import { bankLinkDetails } from "@/lib/queries/bank-link-detail";
import { getWorkshopLedger, supplierLinkCandidates } from "@/lib/queries/workshop-ledger";
import { createPaymentFromTxn, linkTxnToSupplierPayment } from "@/lib/workshop/bank-link";

/**
 * ═══════════ SỔ NGÂN HÀNG ↔ THANH TOÁN XƯỞNG MAY / NHÀ VẢI ═══════════
 *
 * Chủ shop yêu cầu (25/09/2026): ghép giao dịch trả xưởng / nhà vải trên sao kê vào phần thanh toán ở
 * Sổ đặt xưởng, và ghi chú trên Sổ ngân hàng phải nói rõ đồng tiền ấy là gì. Năm chỗ dễ sai:
 *  1. Ghép vượt số tiền (một chuyển khoản trả cho hai đợt cùng lúc mà cộng trùng).
 *  2. Ghép dòng tiền VÀO với một khoản trả đi.
 *  3. Tự động phân loại đè nhóm người đã chọn (AGENTS.md mục 17).
 *  4. Ghép trọn mà ngày trả vẫn là ngày TẠM của lượt nhập bảng tính.
 *  5. Dòng đã đối chiếu vẫn chỉ in "đã đối chiếu" + mã uuid.
 */

const d = (iso: string) => new Date(`${iso}T09:00:00+07:00`);

async function donDep(db: Db) {
  await db.delete(schema.bankTransactionLinks).where(like(schema.bankTransactionLinks.txnId, "zbl-%"));
  await db.delete(schema.bankTransactions).where(like(schema.bankTransactions.id, "zbl-%"));
  await db.delete(schema.supplierPayments).where(sql`${schema.supplierPayments.batchId} in (select id from production_batches where product_code like 'ZBL%') or ${schema.supplierPayments.fabricOrderId} in (select id from fabric_orders where product_code like 'ZBL%')`);
  await db.delete(schema.fabricOrders).where(like(schema.fabricOrders.productCode, "ZBL%"));
  await db.delete(schema.productionBatches).where(like(schema.productionBatches.productCode, "ZBL%"));
}

export async function testWorkshopBankLink(db: Db) {
  assert.ok((LINK_TARGET_TYPES as readonly string[]).includes("SUPPLIER_PAYMENT"));
  assert.ok(LINK_TARGET_LABEL.SUPPLIER_PAYMENT.includes("xưởng"));
  assert.equal(LINK_TARGET_DOMAIN.SUPPLIER_PAYMENT, "EXPENSE", "sổ đặt xưởng là CÔNG NỢ — không phải một sổ tiền để nối tiền vào tiền");

  await donDep(db);
  try {
    await db.insert(schema.productionBatches).values({ id: "zbl-b1", productCode: "ZBL1", batchNo: 1, supplier: "Xưởng Kiểm", orderedAt: d("2027-05-01"), orderedQty: 10, agreedQty: 10, laborUnitPrice: 60_000 });
    await db.insert(schema.fabricOrders).values({ id: "zbl-f1", productCode: "ZBL1", batchId: "zbl-b1", supplier: "Vải Kiểm", description: "vải chính", orderedAt: d("2027-04-28"), amount: 300_000 });
    // Đợt nhập từ bảng tính: ngày TẠM, hình thức "Khác".
    await db.insert(schema.supplierPayments).values({ id: "zbl-p1", batchId: "zbl-b1", kind: "PAYMENT", amount: 600_000, paidAt: d("2027-05-10"), method: "OTHER", reference: "Bảng tính dòng 2", note: "Nhập từ bảng tính — bảng tính không có ngày trả, tạm lấy 10/05/2027" });
    // Đợt cọc còn TRỐNG sao kê — để thử "tiền vào" bị chặn vì CHIỀU, không phải vì hết chỗ.
    await db.insert(schema.supplierPayments).values({ id: "zbl-p2", batchId: "zbl-b1", kind: "DEPOSIT", amount: 100_000, paidAt: d("2027-05-02"), method: "BANK" });
    await db.insert(schema.bankTransactions).values([
      { id: "zbl-t1", txnAt: d("2027-05-12"), amount: -600_000, bankRef: "ZBLREF1", description: "CK xuong kiem tien cong", accountingGroup: "UNCLASSIFIED" },
      { id: "zbl-t2", txnAt: d("2027-05-02"), amount: -300_000, bankRef: "ZBLREF2", description: "CK vai", accountingGroup: "OTHER", classifiedBy: "chu@shop.vn" },
      { id: "zbl-t3", txnAt: d("2027-05-03"), amount: 100_000, bankRef: "ZBLREF3", description: "tien vao", accountingGroup: "UNCLASSIFIED" },
    ]);

    // ── Ứng viên: đợt khớp đúng số tiền đứng đầu ──
    const c = await supplierLinkCandidates("zbl-t1");
    assert.equal(c?.payments[0]?.id, "zbl-p1");
    assert.equal(c?.payments[0]?.exact, true);
    assert.ok(c?.targets.some((t) => t.id === "zbl-f1" && t.remaining === 300_000), "đợt vải còn nợ là đích tạo đợt thanh toán mới");

    // ── Ghép trọn ⇒ sao kê thay ngày tạm ──
    const kq = await linkTxnToSupplierPayment("zbl-t1", "zbl-p1", { email: "ketoan@shop.vn" });
    assert.ok(!("error" in kq), JSON.stringify(kq));
    assert.equal(kq.amount, 600_000);
    const p1 = await db.query.supplierPayments.findFirst({ where: eq(schema.supplierPayments.id, "zbl-p1") });
    assert.equal(p1?.paidAt.toISOString(), d("2027-05-12").toISOString(), "ghép trọn ⇒ ngày trả lấy theo sao kê, thay ngày tạm");
    assert.deepEqual([p1?.method, p1?.reference], ["BANK", "ZBLREF1"]);
    assert.ok(p1?.note.includes("sao kê"), "ghi chú 'ngày tạm' được thay — nó không còn đúng nữa");
    const t1 = await db.query.bankTransactions.findFirst({ where: eq(schema.bankTransactions.id, "zbl-t1") });
    assert.equal(t1?.accountingGroup, "PURCHASE", "dòng chưa phân loại ⇒ tự vào nhóm Nhập hàng · trả tiền xưởng");
    assert.equal(t1?.linkedType, "SUPPLIER_PAYMENT", "ảnh chụp mối nối chính đi theo bảng mối nối");

    // ── Không ghép hai lần, không ghép vượt ──
    const lai = await linkTxnToSupplierPayment("zbl-t1", "zbl-p1", { email: "ketoan@shop.vn" });
    assert.ok("error" in lai, "ghép lại đúng cặp ⇒ từ chối");
    const vuot = await createPaymentFromTxn({ txnId: "zbl-t1", batchId: "zbl-b1", fabricOrderId: null, kind: "PAYMENT" }, { id: null, email: "ketoan@shop.vn", name: "Kế toán" });
    assert.ok("error" in vuot, "dòng tiền đã nối đủ ⇒ không tạo thêm đợt thanh toán");
    const tienVao = await linkTxnToSupplierPayment("zbl-t3", "zbl-p2", { email: "ketoan@shop.vn" });
    assert.ok("error" in tienVao && tienVao.error.includes("tiền RA"), "dòng tiền VÀO không ghép được với một khoản trả đi — dù đợt còn chỗ");

    // ── Tạo đợt mới từ sao kê cho đợt vải; nhóm người đã chọn KHÔNG bị đè ──
    const moi = await createPaymentFromTxn({ txnId: "zbl-t2", batchId: null, fabricOrderId: "zbl-f1", kind: "PAYMENT" }, { id: null, email: "ketoan@shop.vn", name: "Kế toán" });
    assert.ok(!("error" in moi), JSON.stringify(moi));
    assert.equal(moi.amount, 300_000);
    assert.equal(moi.batchId, "zbl-b1", "đợt vải của lô 1 ⇒ làm mới trang lô 1");
    const t2 = await db.query.bankTransactions.findFirst({ where: eq(schema.bankTransactions.id, "zbl-t2") });
    assert.deepEqual([t2?.accountingGroup, t2?.classifiedBy], ["OTHER", "chu@shop.vn"], "nhóm người đã chọn tay KHÔNG bị ghép đè (AGENTS.md mục 17)");

    // ── Diễn giải trên Sổ ngân hàng ──
    const chiTiet = await bankLinkDetails(["zbl-t1", "zbl-t2", "zbl-t3"]);
    assert.match(chiTiet.get("zbl-t1")?.[0] ?? "", /Trả xưởng Xưởng Kiểm · ZBL1 lô 1 · thanh toán tiền công/);
    assert.match(chiTiet.get("zbl-t2")?.[0] ?? "", /Trả vải Vải Kiểm · ZBL1 vải chính \(lô 1\)/);
    assert.equal(chiTiet.has("zbl-t3"), false, "dòng chưa nối không có diễn giải bịa");

    // ── Sổ đặt xưởng thấy sao kê ──
    const so = await getWorkshopLedger();
    const tt = so.payments.find((p) => p.id === "zbl-p1");
    assert.deepEqual(tt?.bankLinks.map((x) => x.bankRef), ["ZBLREF1"]);
    const vai = so.fabrics.find((f) => f.id === "zbl-f1");
    assert.equal(vai?.pay.state, "PAID", "đợt vải đã trả đủ nhờ đợt tạo từ sao kê");
    console.log("✓ Sổ ngân hàng ↔ thanh toán xưởng: ghép trọn thay ngày tạm bằng ngày sao kê · không ghép hai lần / vượt tiền / tiền vào · không đè nhóm người đã chọn · diễn giải nói rõ trả ai, mã nào, lô nào");
  } finally {
    await donDep(db);
  }
}
