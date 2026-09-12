import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { parseSepayPayload } from "@/lib/integrations/bank/sepay";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { toBankRow } from "@/lib/integrations/bank/statement";
import { createLink, removeAllLinks } from "@/lib/finance/linkage";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getCashLedger, getCashProfitBridge, getObligationLedger } from "@/lib/queries/finance-ledger";
import { settledAmountByTarget, txnAllocation } from "@/lib/queries/finance-linkage";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ MƯỜI BẤT BIẾN TÀI CHÍNH — CỔNG PHÁT HÀNH ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`.
 *
 * `tests/finance-truth.test.ts` khoá TẦNG DỊCH VỤ khi nó được viết ra. Bộ này khoá BẢN GỘP: ba
 * nhánh tài chính làm song song, mỗi nhánh tự tin là mình đúng, và chỗ hỏng của một bản gộp không
 * nằm trong nhánh nào cả — nó nằm ở chỗ hai nhánh cùng chạm một con số.
 *
 * Mười bất biến dưới đây là điều kiện phát hành. Mỗi cái tương ứng một cách người ta ĐÃ hoặc SẼ làm
 * hỏng sổ tiền, và không cái nào phát ra lỗi khi hỏng — chúng chỉ làm con số lệch đi và mọi người
 * vẫn tin.
 *
 * Dữ liệu ở tháng 06/2027, mã bắt đầu bằng `inv-`, tự dọn khi xong.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);
const KY: Period = { key: "custom", from: d("2027-06-01"), to: dEnd("2027-06-30"), label: "Tháng 6/2027", fromKey: "2027-06-01", toKey: "2027-06-30" };

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

async function donDep(db: Db) {
  await db.delete(l).where(sql`${l.txnId} like 'inv-%' or ${l.targetId} like 'inv-%'`);
  await db.delete(b).where(sql`${b.id} like 'inv-%' or ${b.bankRef} like 'INV-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'inv-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'inv-%'`);
  await db.delete(schema.codBatches).where(sql`${schema.codBatches.id} like 'inv-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'inv-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'inv-%'`);
  clearMemo();
}

function txn(id: string, amount: number, ngay: string, group: string, account: string | null, over: Record<string, unknown> = {}) {
  return { id, txnAt: d(ngay), amount, bankRef: id.toUpperCase().replace("INV-", "INV-"), accountingGroup: group, bankAccountId: account, description: id, counterparty: "", ...over };
}

export async function testFinanceInvariants(db: Db) {
  await donDep(db);

  await db.insert(schema.bankAccounts).values([
    { id: "inv-acc-a", provider: "", gateway: "MBBank", accountNumber: "8880001111", label: "MB chính", status: "ACTIVE" },
    { id: "inv-acc-b", provider: "", gateway: "ACB", accountNumber: "8880002222", label: "ACB phụ", status: "ACTIVE" },
  ]);
  await db.insert(schema.expenses).values({
    id: "inv-exp-rent", category: "RENT", description: "Thuê mặt bằng 6/2027", amount: 12_000_000, occurredAt: d("2027-06-01"), costSource: "MANUAL",
  });
  // Một đơn GIAO THÀNH CÔNG 9 triệu, ĐVVC đã trả tiền qua bảng kê.
  await db.insert(schema.orders).values({
    id: "inv-order-1", insertedAt: d("2027-06-02"), stage: "DELIVERED", status: 3,
    totalPriceAfterDiscount: 9_000_000, partnerFee: 25_000, returnFee: 0, cod: 9_000_000,
  });
  await db.insert(schema.shipments).values({
    id: "inv-ship-1", orderId: "inv-order-1", vtpOrderNumber: "INV000000001", stage: "DELIVERED",
    shippingFee: 25_000, codAmount: 9_000_000, codCollected: 9_000_000, codStatus: "PAID_TO_BANK", deliveredAt: d("2027-06-08"),
  });
  await db.insert(schema.codBatches).values({
    id: "inv-cod-batch", reference: "INV-BK-2706", carrier: "Viettel Post", receivedAt: d("2027-06-12"),
    totalAmount: 8_975_000, codGross: 9_000_000, feeTotal: 25_000, source: "VTP_STATEMENT",
  });

  // ══════════ 1. MỘT GÓI TIN SEPAY → ĐÚNG MỘT DÒNG TIỀN ══════════
  //
  // SePay gửi lại tối đa 7 lần trong 5 giờ. Mỗi lần gửi lại mà đẻ một dòng là nhân đôi tiền thật.
  const goiTin = parseSepayPayload({
    id: 880001, gateway: "MBBank", transactionDate: "2027-06-05 09:10:00", accountNumber: "8880001111", subAccount: null,
    code: null, content: "khach chuyen tien", transferType: "in", description: "BankAPINotify", transferAmount: 2_000_000,
    accumulated: 50_000_000, referenceCode: "INV-SEPAY-0001",
  });
  assert.ok(goiTin.ok, "1. gói tin SePay phải đọc được");
  const lan1 = await ingestSepayTransaction(db, goiTin.txn);
  assert.equal(lan1.created, true, "1. lần đầu tạo dòng tiền");
  for (let i = 0; i < 3; i += 1) {
    const lai = await ingestSepayTransaction(db, goiTin.txn);
    assert.equal(lai.created, false, `1. lần gửi lại thứ ${i + 1} KHÔNG được tạo dòng mới`);
    assert.equal(lai.transactionId, lan1.transactionId, "1. và phải trỏ về đúng dòng đã có");
  }
  const [demSepay] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "INV-SEPAY-0001"));
  assert.equal(Number(demSepay.n), 1, "1. MỘT giao dịch ngân hàng = ĐÚNG MỘT dòng tiền, dù webhook gửi lại bao nhiêu lần");
  await db.update(b).set({ accountingGroup: "SALES_REVENUE" }).where(eq(b.id, lan1.transactionId));

  // ══════════ 2. SAO KÊ CSV + WEBHOOK SEPAY CÙNG MỘT GIAO DỊCH KHÔNG ĐẾM HAI LẦN ══════════
  //
  // Đây là điều kiện sống còn khi bật realtime trên một kho đã có lịch sử nhập bằng file.
  const dongFile = toBankRow({
    date: "2027-06-06", time: "14:20", amount: -1_500_000,
    description: "CUSTOMER thanh toan dich vu", counterparty: "CTY DV", bankRef: "INV-CSV-0002", categoryCode: "", note: "",
  });
  await db.insert(b).values({ ...dongFile, id: "inv-txn-csv", source: "IMPORT", accountingGroup: "SOFTWARE", classifiedBy: "ketoan@shop.vn", bankAccountId: "inv-acc-a" });
  const goiTrung = parseSepayPayload({
    id: 880002, gateway: "MBBank", transactionDate: "2027-06-06 14:20:00", accountNumber: "8880001111", subAccount: null,
    code: null, content: "noi dung webhook", transferType: "out", description: "BankAPINotify", transferAmount: 1_500_000,
    accumulated: 48_500_000, referenceCode: "INV-CSV-0002",
  });
  assert.ok(goiTrung.ok, "2. gói tin trùng phải đọc được");
  const hoiTu = await ingestSepayTransaction(db, goiTrung.txn);
  assert.equal(hoiTu.created, false, "2. cùng mã bút toán ngân hàng ⇒ KHÔNG đẻ dòng thứ hai");
  assert.equal(hoiTu.transactionId, "inv-txn-csv", "2. webhook hội tụ vào đúng dòng đã nhập từ file");
  const [sauHoiTu] = await db.select().from(b).where(eq(b.id, "inv-txn-csv"));
  assert.equal(sauHoiTu.accountingGroup, "SOFTWARE", "2. NHÃN người dùng đã gán không bị webhook xoá");
  assert.equal(sauHoiTu.amount, -1_500_000, "2. số tiền không bị nhân đôi hay đổi dấu");

  // ══════════ 3. TIỀN COD ĐVVC TRẢ VỀ KHÔNG SINH DOANH THU LẦN HAI ══════════
  await db.insert(b).values(txn("inv-txn-cod", 8_975_000, "2027-06-12", "COD_SETTLEMENT", "inv-acc-a", { balanceAfter: 57_475_000 }));
  await createLink({ txnId: "inv-txn-cod", targetType: "COD_BATCH", targetId: "inv-cod-batch", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  clearMemo();
  const truth = await getFinancialTruth(KY);
  assert.equal(truth.revenue.delivered, 9_000_000, "3. doanh thu giao thành công vẫn 9 triệu — tiền COD về KHÔNG cộng thêm lần hai");

  // ══════════ 4. KHOẢN CHI ĐÃ NỐI TIỀN KHÔNG ĐƯỢC GHI CHI PHÍ HAI LẦN ══════════
  clearMemo();
  const chiPhiTruoc = await getRecognizedCosts(KY);
  await db.insert(b).values([
    txn("inv-txn-rent-1", -7_000_000, "2027-06-05", "RENT_UTILITIES", "inv-acc-a"),
    txn("inv-txn-rent-2", -5_000_000, "2027-06-20", "RENT_UTILITIES", "inv-acc-a"),
  ]);
  await createLink({ txnId: "inv-txn-rent-1", targetType: "EXPENSE", targetId: "inv-exp-rent", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  clearMemo();
  let chiPhi = await getRecognizedCosts(KY);
  assert.equal(chiPhi.components.RENT.amount, chiPhiTruoc.components.RENT.amount, "4. nối tiền vào khoản chi KHÔNG làm chi phí tăng");
  assert.equal(chiPhi.components.RENT.amount, 12_000_000, "4. mặt bằng vẫn đúng 12 triệu, không phải 19");

  // Trả nốt phần còn lại: hai dòng tiền cùng phủ MỘT khoản chi, chi phí vẫn là một.
  await createLink({ txnId: "inv-txn-rent-2", targetType: "EXPENSE", targetId: "inv-exp-rent", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  const daTra = await settledAmountByTarget("EXPENSE", ["inv-exp-rent"], db);
  assert.equal(daTra.get("inv-exp-rent"), 12_000_000, "4. 7 + 5 = 12 triệu tiền thật đã phủ khoản chi");
  clearMemo();
  chiPhi = await getRecognizedCosts(KY);
  assert.equal(chiPhi.components.RENT.amount, 12_000_000, "4. và chi phí VẪN là 12 triệu — hai mối nối không thành hai khoản chi");

  // ══════════ 5. CHUYỂN NỘI BỘ: A −X, B +X ⇒ DÒNG TIỀN KINH DOANH RÒNG = 0 ══════════
  clearMemo();
  const truocCK = await getCashLedger(KY);
  await db.insert(b).values([
    txn("inv-txn-tf-out", -6_000_000, "2027-06-15", "INTERNAL_TRANSFER", "inv-acc-a"),
    txn("inv-txn-tf-in", 6_000_000, "2027-06-15", "INTERNAL_TRANSFER", "inv-acc-b"),
  ]);
  await createLink({ txnId: "inv-txn-tf-out", targetType: "BANK_TRANSACTION", targetId: "inv-txn-tf-in", confidence: "MANUAL", method: "TRANSFER_PAIR", confirmedBy: "ketoan@shop.vn" });
  clearMemo();
  const sauCK = await getCashLedger(KY);
  assert.equal(sauCK.businessNet, truocCK.businessNet, "5. một lần chuyển nội bộ KHÔNG làm đổi dòng tiền kinh doanh ròng — đóng góp đúng 0");
  assert.equal(sauCK.businessInflow, truocCK.businessInflow, "5. và không thổi phồng tiền vào");
  assert.equal(sauCK.businessOutflow, truocCK.businessOutflow, "5. cũng không thổi phồng tiền ra");
  assert.equal(sauCK.internalTransfer.net, 0, "5. hai vế triệt tiêu nhau");
  assert.equal(sauCK.internalTransfer.unpairedCount, 0, "5. cả hai vế đã được ghép — không còn chân lẻ");
  // Tổng THÔ vẫn phải đếm đủ: sao kê giấy của ngân hàng có cả hai dòng.
  assert.equal(sauCK.outflow - truocCK.outflow, 6_000_000, "5. tổng thô vẫn ghi nhận tiền ra — sao kê giấy phải khớp");
  assert.equal(sauCK.inflow - truocCK.inflow, 6_000_000, "5. và ghi nhận tiền vào");

  // ══════════ 6. GÓP VỐN / VAY KHÔNG VÀO DOANH THU KINH DOANH ══════════
  clearMemo();
  const truocVon = await getCashLedger(KY);
  const dtTruoc = (await getFinancialTruth(KY)).revenue.booked;
  await db.insert(b).values([
    txn("inv-txn-capital", 100_000_000, "2027-06-18", "CAPITAL_IN", "inv-acc-a"),
    txn("inv-txn-loan", 50_000_000, "2027-06-19", "LOAN_IN", "inv-acc-a"),
  ]);
  clearMemo();
  const sauVon = await getCashLedger(KY);
  assert.equal(sauVon.businessInflow, truocVon.businessInflow, "6. 150 triệu vốn + vay KHÔNG vào tiền vào kinh doanh");
  assert.equal(sauVon.inflow - truocVon.inflow, 150_000_000, "6. nhưng tiền thật đã vào tài khoản, tổng thô phải ghi nhận");
  assert.equal((await getFinancialTruth(KY)).revenue.booked, dtTruoc, "6. và tuyệt đối không thành doanh thu");

  // ══════════ 7. NGHĨA VỤ LƯƠNG ≠ TIỀN LƯƠNG ĐÃ TRẢ ══════════
  //
  // Lương tháng 5 trả ngày 05/06: TIỀN thuộc tháng 6, NGHĨA VỤ thuộc tháng 5. Gộp là vừa sai kỳ vừa
  // trừ hai lần. Mối nối trỏ tới KỲ LƯƠNG `2027-05`, không tới tháng 6.
  await db.insert(b).values(txn("inv-txn-payroll", -8_000_000, "2027-06-05", "PAYROLL_SALARY", "inv-acc-a"));
  await createLink({ txnId: "inv-txn-payroll", targetType: "PAYROLL_PERIOD", targetId: "2027-05", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  clearMemo();
  const nghiaVu = await getObligationLedger(KY);
  const luong = nghiaVu.lines.find((x) => x.key === "PAYROLL");
  assert.ok(luong, "7. sổ nghĩa vụ phải có dòng lương");
  assert.equal(luong.settled, 8_000_000, "7. TIỀN lương chi trong tháng 6 = 8 triệu");
  assert.notEqual(luong.obligation, luong.settled, "7. NGHĨA VỤ lương của kỳ KHÁC tiền đã chi — hai sổ, hai mốc thời gian");
  const [noiLuong] = await db.select({ t: l.targetId }).from(l).where(eq(l.txnId, "inv-txn-payroll"));
  assert.equal(noiLuong.t, "2027-05", "7. tiền trả tháng 6 nối về KỲ LƯƠNG tháng 5, không phải tháng 6");

  // ══════════ 8. LÃI LỖ KHÔNG ĐỔI CHỈ VÌ PHÂN LOẠI LẠI MỘT DÒNG SAO KÊ ══════════
  //
  // Đây là ranh giới trung tâm của cả hợp đồng. Đổi nhãn kế toán là đổi cách đọc DÒNG TIỀN; nếu nó
  // đụng tới lợi nhuận thì sao kê đã trở thành nguồn chi phí — đúng thứ bị cấm.
  clearMemo();
  const lnTruoc = (await getFinancialTruth(KY)).estimatedProfit;
  const chiPhiTruocPL = (await getRecognizedCosts(KY)).operatingTotal;
  await db.update(b).set({ accountingGroup: "OTHER_EXPENSE" }).where(eq(b.id, "inv-txn-rent-2"));
  clearMemo();
  assert.equal((await getFinancialTruth(KY)).estimatedProfit, lnTruoc, "8. phân loại lại một dòng sao kê KHÔNG được đổi lợi nhuận");
  assert.equal((await getRecognizedCosts(KY)).operatingTotal, chiPhiTruocPL, "8. và KHÔNG được đổi chi phí vận hành");
  await db.update(b).set({ accountingGroup: "RENT_UTILITIES" }).where(eq(b.id, "inv-txn-rent-2"));

  // ══════════ 9. LỢI NHUẬN ≠ TIỀN MẶT, NHƯNG CẦU NỐI PHẢI GIẢI THÍCH ĐƯỢC ══════════
  clearMemo();
  const cau = await getCashProfitBridge(KY);
  const tong = cau.lines.filter((x) => x.key !== "business_net_cash").reduce((t, x) => t + x.amount, 0);
  assert.equal(cau.businessNetCash - tong, cau.unexplained, "9. phần chưa giải thích được đúng bằng chênh giữa tiền thật và tổng các dòng đã nêu tên");
  assert.ok(cau.lines.some((x) => x.key === "cod_held"), "9. cầu nối phải nêu khoản COD ĐVVC còn giữ");
  assert.ok(cau.lines.some((x) => x.key === "unpaid_expense"), "9. và khoản chi đã ghi nhận nhưng chưa chi tiền");
  // KHÔNG ÉP KHỚP: phần chưa giải thích được hiện nguyên, không bị nhét vào một dòng "điều chỉnh khác".
  assert.ok(cau.limitations.some((x) => x.includes("chưa giải thích được")), "9. phải nói thẳng phần chưa giải thích được là gì");

  // ══════════ 10. GIAO DỊCH CHƯA PHÂN LOẠI VẪN ĐƯỢC GIỮ, KHÔNG BIẾN THÀNH 0 HAY NHÓM GIẢ ══════════
  await db.insert(b).values(txn("inv-txn-unknown", -3_300_000, "2027-06-22", "UNCLASSIFIED", "inv-acc-a"));
  clearMemo();
  const soCuoi = await getCashLedger(KY);
  assert.ok(soCuoi.unclassified.count >= 1, "10. dòng chưa phân loại phải được ĐẾM, không bị bỏ qua");
  assert.ok(soCuoi.unclassified.amount >= 3_300_000, "10. và số tiền của nó phải hiện ra, không thành 0");
  const [conNguyen] = await db.select({ g: b.accountingGroup }).from(b).where(eq(b.id, "inv-txn-unknown"));
  assert.equal(conNguyen.g, "UNCLASSIFIED", "10. KHÔNG đường tự động nào được gán cho nó một nhóm giả");
  // Chưa phân loại vẫn nằm trong dòng tiền kinh doanh: tiền đã thật sự rời tài khoản.
  assert.ok(soCuoi.businessOutflow >= 3_300_000, "10. tiền đã ra là đã ra — chưa phân loại không phải lý do bỏ nó khỏi dòng tiền");

  // ── Bất biến bao trùm: không dòng tiền nào bị nối vượt số tiền thật ──
  const vuot = await db.execute(sql`
    select count(*)::int as n from (
      select t.id from bank_transactions t
      join bank_transaction_links tl on tl.txn_id = t.id
      group by t.id, t.amount having sum(tl.amount) > abs(t.amount)
    ) x`);
  const vuotRows = (Array.isArray(vuot) ? vuot : (vuot as unknown as { rows: unknown[] }).rows) as { n: number }[];
  const soVuot = Number(vuotRows[0]?.n ?? 0);
  assert.equal(soVuot, 0, "bao trùm: KHÔNG dòng tiền nào được phân bổ vượt trị tuyệt đối số tiền của nó");

  // ── Bất biến bao trùm: ảnh chụp mối nối chính luôn trỏ vào một mối nối có thật ──
  const lech = await db
    .select({ n: sql<number>`count(*)` })
    .from(b)
    .where(sql`${b.linkedType} <> '' and not exists (select 1 from bank_transaction_links tl where tl.txn_id = ${b.id} and tl.target_type = ${b.linkedType} and tl.target_id = ${b.linkedId})`);
  assert.equal(Number(lech[0]?.n ?? 0), 0, "bao trùm: ảnh chụp linked_type/linked_id luôn khớp bảng nối");

  // ── HOÀN TÁC: gỡ mối nối trả sổ về đúng trạng thái, không để lại rác ──
  const truocGo = (await txnAllocation("inv-txn-rent-1", db)).allocated;
  assert.equal(truocGo, 7_000_000, "hoàn tác: trước khi gỡ đã phân bổ 7 triệu");
  await removeAllLinks("inv-txn-rent-1", db);
  assert.equal((await txnAllocation("inv-txn-rent-1", db)).allocated, 0, "hoàn tác: gỡ xong không còn phân bổ nào");
  assert.equal((await settledAmountByTarget("EXPENSE", ["inv-exp-rent"], db)).get("inv-exp-rent"), 5_000_000, "hoàn tác: khoản chi trở lại còn nợ đúng phần đã gỡ");
  const [sauGo] = await db.select({ t: b.linkedType }).from(b).where(eq(b.id, "inv-txn-rent-1"));
  assert.equal(sauGo.t, "", "hoàn tác: ảnh chụp mối nối chính được dọn theo");
  clearMemo();
  assert.equal((await getRecognizedCosts(KY)).components.RENT.amount, 12_000_000, "hoàn tác: gỡ mối nối KHÔNG đụng tới chi phí — nối chưa bao giờ tạo ra nó");

  console.log("✓ Mười bất biến tài chính: một gói tin một dòng tiền · CSV+SePay hội tụ · COD không sinh doanh thu lần hai · nối tiền không nhân đôi chi phí · chuyển nội bộ về 0 · vốn/vay không thành doanh thu · nghĩa vụ lương ≠ tiền lương · lãi lỗ không đổi vì phân loại · cầu nối không ép khớp · chưa phân loại vẫn được giữ");
  await donDep(db);
}
