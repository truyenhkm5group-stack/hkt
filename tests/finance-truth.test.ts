import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { allocationOf, LINK_AUTO_CONFIRMABLE, LINK_CONFIDENCES, LINK_TARGET_DOMAIN, remainingCapacity } from "@/lib/constants/finance-truth";
import { parseSepayPayload } from "@/lib/integrations/bank/sepay";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { toBankRow } from "@/lib/integrations/bank/statement";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { createLink, removeLink } from "@/lib/finance/linkage";
import { settledAmountByTarget, txnAllocation } from "@/lib/queries/finance-linkage";
import { getCashLedger, getCashProfitBridge, getObligationLedger } from "@/lib/queries/finance-ledger";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { PAYROLL_EMPLOYEES_KEY } from "@/lib/constants/payroll";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ SỰ THẬT TÀI CHÍNH & MỐI NỐI — KHOÁ NĂM CUỐN SỔ ═══════════
 *
 * Hợp đồng: `docs/finance-truth-contract.md`.
 *
 * Bộ này canh đúng một loại lỗi, loại KHÔNG AI NHÌN RA BẰNG MẮT: **một đồng được đếm hai lần**.
 * Nó không làm báo cáo đỏ, không làm trang hỏng — nó chỉ làm lợi nhuận sai vài phần trăm và mọi
 * người vẫn tin. Cụ thể tám tình huống dưới đây, tất cả đều là chuyện thường ngày của shop:
 *
 *   1. một dòng tiền vừa thành chi phí, vừa thành dòng tiền, vừa thành doanh thu;
 *   2. tiền COD ĐVVC trả về cộng thêm một lần nữa vào doanh thu đã ghi;
 *   3. chuyển giữa hai tài khoản của chính mình thổi phồng cả tiền vào lẫn tiền ra;
 *   4. trả một phần — "đã trả chưa" không phải câu hỏi đúng/sai mà là một con số;
 *   5. một khoản chi trả làm nhiều lần;
 *   6. một chuyển khoản trả nhiều chứng từ;
 *   7. sao kê nhập tay và webhook realtime cùng nói về một giao dịch;
 *   8. NGHĨA VỤ lương khác TIỀN lương — hai sổ, hai mốc thời gian.
 *
 * Dữ liệu đặt ở tháng 05/2027 và mọi mã bắt đầu bằng `ft-` để không chạm fixture của bộ khác;
 * bài kiểm tự dọn sạch khi xong.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);
const KY: Period = { key: "custom", from: d("2027-05-01"), to: dEnd("2027-05-31"), label: "Tháng 5/2027", fromKey: "2027-05-01", toKey: "2027-05-31" };

const b = schema.bankTransactions;
const l = schema.bankTransactionLinks;

async function donDep(db: Db) {
  await db.delete(l).where(sql`${l.txnId} like 'ft-%' or ${l.targetId} like 'ft-%'`);
  await db.delete(b).where(sql`${b.id} like 'ft-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'ft-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'ft-%'`);
  await db.delete(schema.codBatches).where(sql`${schema.codBatches.id} like 'ft-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'ft-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'ft-%'`);
  clearMemo();
}

/** Một dòng sao kê tối giản — chỉ khai những gì bài kiểm thật sự dùng tới. */
function txn(id: string, amount: number, ngay: string, group: string, account: string, over: Record<string, unknown> = {}) {
  return { id, txnAt: d(ngay), amount, bankRef: id.toUpperCase(), accountingGroup: group, bankAccountId: account, description: id, counterparty: "", ...over };
}

export async function testFinanceTruth(db: Db) {
  await donDep(db);

  // ══════════ CHUẨN BỊ ══════════
  await db.insert(schema.bankAccounts).values([
    { id: "ft-acc-a", provider: "", gateway: "MBBank", accountNumber: "9990001111", label: "MB chính", status: "ACTIVE" },
    { id: "ft-acc-b", provider: "", gateway: "ACB", accountNumber: "9990002222", label: "ACB phụ", status: "ACTIVE" },
  ]);

  await db.insert(schema.expenses).values([
    { id: "ft-exp-rent", category: "RENT", description: "Thuê mặt bằng tháng 5/2027", amount: 20_000_000, occurredAt: d("2027-05-01"), costSource: "MANUAL" },
    { id: "ft-exp-soft-a", category: "SOFTWARE", description: "Phần mềm A", amount: 20_000_000, occurredAt: d("2027-05-02"), costSource: "MANUAL" },
    { id: "ft-exp-soft-b", category: "SOFTWARE", description: "Phần mềm B", amount: 10_000_000, occurredAt: d("2027-05-02"), costSource: "MANUAL" },
  ]);

  // Một đơn GIAO THÀNH CÔNG 12 triệu, tiền COD đã về qua bảng kê.
  await db.insert(schema.orders).values({
    id: "ft-order-1", insertedAt: d("2027-05-03"), stage: "DELIVERED", status: 3,
    totalPriceAfterDiscount: 12_000_000, partnerFee: 30_000, returnFee: 0, cod: 12_000_000,
  });
  await db.insert(schema.shipments).values({
    id: "ft-ship-1", orderId: "ft-order-1", vtpOrderNumber: "FT0000000001", stage: "DELIVERED",
    shippingFee: 30_000, codAmount: 12_000_000, codCollected: 12_000_000, codStatus: "PAID_TO_BANK", deliveredAt: d("2027-05-10"),
  });
  await db.insert(schema.codBatches).values({
    id: "ft-cod-batch", reference: "FT-BK-2705", carrier: "Viettel Post", receivedAt: d("2027-05-15"),
    totalAmount: 11_970_000, codGross: 12_000_000, feeTotal: 30_000, source: "VTP_STATEMENT",
  });

  await db.insert(b).values([
    txn("ft-txn-rent-1", -8_000_000, "2027-05-05", "RENT_UTILITIES", "ft-acc-a"),
    txn("ft-txn-rent-2", -7_000_000, "2027-05-12", "RENT_UTILITIES", "ft-acc-a"),
    txn("ft-txn-rent-3", -5_000_000, "2027-05-20", "RENT_UTILITIES", "ft-acc-a"),
    txn("ft-txn-multi", -30_000_000, "2027-05-08", "SOFTWARE", "ft-acc-a"),
    txn("ft-txn-tf-out", -5_000_000, "2027-05-10", "INTERNAL_TRANSFER", "ft-acc-a"),
    txn("ft-txn-tf-in", 5_000_000, "2027-05-10", "INTERNAL_TRANSFER", "ft-acc-b"),
    txn("ft-txn-cod", 11_970_000, "2027-05-15", "COD_SETTLEMENT", "ft-acc-a", { balanceAfter: 40_000_000 }),
    txn("ft-txn-payroll", -9_000_000, "2027-05-06", "PAYROLL_SALARY", "ft-acc-a"),
  ]);

  // ═══════════ 0. LUẬT NỀN (hàm thuần, không cần CSDL) ═══════════
  assert.deepEqual(allocationOf(-1_000, []).state, "UNALLOCATED", "0. chưa nối gì");
  assert.deepEqual(allocationOf(-1_000, [400]).state, "PARTIAL", "0. nối một phần");
  assert.deepEqual(allocationOf(-1_000, [1_000]).state, "FULL", "0. nối đủ");
  assert.deepEqual(allocationOf(-1_000, [600, 600]).state, "OVER", "0. nối vượt phải NÊU RA, không làm tròn về đủ");
  assert.equal(allocationOf(-1_000, [600, 600]).remaining, -200, "0. phần vượt giữ dấu âm để nhìn thấy được");
  assert.equal(remainingCapacity(-1_000, [600, 600]), 0, "0. hết chỗ thì là 0, không phải số âm");
  // Nhập nhằng KHÔNG được lưu thành mối nối — mối nối là một khẳng định.
  assert.ok(!(LINK_CONFIDENCES as readonly string[]).includes("AMBIGUOUS"), "0. AMBIGUOUS không phải mức tin cậy lưu được");
  assert.equal(LINK_CONFIDENCES.filter((c) => LINK_AUTO_CONFIRMABLE[c]).length, 1, "0. CHỈ MỘT mức được tự nối (EXACT)");
  assert.equal(LINK_AUTO_CONFIRMABLE.EXACT, true, "0. và mức đó là EXACT");
  assert.equal(LINK_TARGET_DOMAIN.COD_BATCH, "CARRIER_SETTLEMENT", "0. đợt COD thuộc sổ đối soát ĐVVC, không phải sổ tiền");

  // ═══════════ 1. MỘT DÒNG TIỀN KHÔNG ĐƯỢC ĐẾM BA LẦN ═══════════
  //
  // Nối một dòng tiền ra với một khoản chi là ĐỐI CHIẾU. Nó KHÔNG được: (a) làm chi phí kỳ tăng lên,
  // (b) làm doanh thu đổi, (c) làm dòng tiền cộng thêm một lần nữa.
  clearMemo();
  const chiPhiTruoc = (await getRecognizedCosts(KY)).operatingTotal;
  const doanhThuTruoc = (await getFinancialTruth(KY)).revenue.booked;
  const tienTruoc = (await getCashLedger(KY)).businessOutflow;

  const noi1 = await createLink({ txnId: "ft-txn-rent-1", targetType: "EXPENSE", targetId: "ft-exp-rent", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  assert.ok("ok" in noi1, "1. nối được dòng tiền với khoản chi");

  clearMemo();
  assert.equal((await getRecognizedCosts(KY)).operatingTotal, chiPhiTruoc, "1. NỐI KHÔNG TẠO CHI PHÍ — chi phí kỳ không đổi");
  assert.equal((await getFinancialTruth(KY)).revenue.booked, doanhThuTruoc, "1. NỐI KHÔNG TẠO DOANH THU");
  assert.equal((await getCashLedger(KY)).businessOutflow, tienTruoc, "1. NỐI KHÔNG TẠO DÒNG TIỀN — tiền ra vẫn đếm đúng một lần");

  // ═══════════ 2. TIỀN COD ĐVVC TRẢ VỀ KHÔNG SINH DOANH THU LẦN HAI ═══════════
  //
  // Doanh thu đã ghi khi đơn GIAO THÀNH CÔNG. Tiền COD về tài khoản là cùng đồng tiền đó đi hết
  // chặng cuối; cộng lần nữa thì doanh thu 12 triệu thành 24 triệu.
  await createLink({ txnId: "ft-txn-cod", targetType: "COD_BATCH", targetId: "ft-cod-batch", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  clearMemo();
  const truth = await getFinancialTruth(KY);
  assert.equal(truth.revenue.delivered, 12_000_000, "2. doanh thu giao thành công vẫn là 12 triệu, KHÔNG phải 23,97 triệu");
  assert.ok(truth.revenue.booked <= 12_000_000, "2. doanh thu lên đơn không bị tiền COD về cộng thêm");
  const soTien = await getCashLedger(KY);
  assert.equal(soTien.businessInflow, 11_970_000, "2. tiền COD về nằm ở SỔ TIỀN, đúng một lần");

  // ═══════════ 3. CHUYỂN NỘI BỘ TRIỆT TIÊU VỀ 0 ═══════════
  //
  // 5 triệu rời tài khoản A vào tài khoản B là HAI dòng sao kê của MỘT sự kiện. Tính vào dòng tiền
  // kinh doanh thì shop trông như vừa thu thêm 5 triệu vừa chi thêm 5 triệu — chênh lệch vẫn đúng
  // nhưng cả hai con số tổng đều sai, và người đọc tưởng quy mô quay vòng gấp đôi thực tế.
  const ghepDoi = await createLink({ txnId: "ft-txn-tf-out", targetType: "BANK_TRANSACTION", targetId: "ft-txn-tf-in", confidence: "MANUAL", method: "TRANSFER_PAIR", confirmedBy: "ketoan@shop.vn" });
  assert.ok("ok" in ghepDoi, "3. ghép được hai chân chuyển nội bộ");
  // Chân kia phải được ghép TỰ ĐỘNG: ghép một chiều thì chân còn lại vẫn thổi phồng dòng tiền.
  const chanKia = await txnAllocation("ft-txn-tf-in", db);
  assert.equal(chanKia.links.length, 1, "3. chân đối ứng được ghép tự động, không để nửa cặp");
  assert.equal(chanKia.links[0].targetId, "ft-txn-tf-out", "3. và nó trỏ ngược lại đúng chân kia");

  // Ghép hai dòng CÙNG CHIỀU là khai khống một lần chuyển tiền.
  const saiChieu = await createLink({ txnId: "ft-txn-rent-2", targetType: "BANK_TRANSACTION", targetId: "ft-txn-rent-3", confidence: "MANUAL", method: "TRANSFER_PAIR", confirmedBy: "ketoan@shop.vn" });
  assert.ok("error" in saiChieu, "3. hai chân cùng chiều bị TỪ CHỐI");

  clearMemo();
  const so3 = await getCashLedger(KY);
  assert.equal(so3.internalTransfer.net, 0, "3. chuyển nội bộ triệt tiêu về 0");
  assert.equal(so3.internalTransfer.unpairedCount, 0, "3. không còn chân lẻ");
  // 8 triệu + 7 + 5 (mặt bằng) + 30 (phần mềm) + 9 (lương) = 59 triệu. KHÔNG có 5 triệu chuyển nội bộ.
  assert.equal(so3.businessOutflow, 59_000_000, "3. tiền ra kinh doanh KHÔNG gồm 5 triệu chuyển nội bộ");
  assert.equal(so3.businessInflow, 11_970_000, "3. tiền vào kinh doanh KHÔNG gồm 5 triệu chuyển nội bộ");
  // Sao kê giấy vẫn phải khớp: tổng THÔ vẫn đếm đủ cả hai chân.
  assert.equal(so3.outflow, 64_000_000, "3. tổng thô vẫn gồm cả hai chân — sao kê giấy phải khớp");
  assert.equal(so3.inflow, 16_970_000, "3. tổng thô tiền vào cũng vậy");

  // ═══════════ 4 + 5. MỘT KHOẢN CHI TRẢ LÀM NHIỀU LẦN ═══════════
  //
  // Mặt bằng 20 triệu trả ba lần 8 + 7 + 5. Sau lần đầu, "đã trả chưa" KHÔNG có câu trả lời đúng/sai
  // — nó là 8/20. Ô `linked_id` cũ không diễn tả được điều đó, và đó chính là lý do bảng nối tồn tại.
  let daTra = await settledAmountByTarget("EXPENSE", ["ft-exp-rent"], db);
  assert.equal(daTra.get("ft-exp-rent"), 8_000_000, "4. trả một phần: mới 8/20 triệu");

  await createLink({ txnId: "ft-txn-rent-2", targetType: "EXPENSE", targetId: "ft-exp-rent", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  await createLink({ txnId: "ft-txn-rent-3", targetType: "EXPENSE", targetId: "ft-exp-rent", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  daTra = await settledAmountByTarget("EXPENSE", ["ft-exp-rent"], db);
  assert.equal(daTra.get("ft-exp-rent"), 20_000_000, "5. một khoản chi được BA dòng tiền cùng phủ: 8 + 7 + 5 = 20 triệu");

  // Và khoản chi vẫn chỉ được ghi nhận MỘT lần trong chi phí — ba mối nối không thành ba khoản chi.
  clearMemo();
  const chiPhiSau = await getRecognizedCosts(KY);
  assert.equal(chiPhiSau.operatingTotal, chiPhiTruoc, "5. ba mối nối KHÔNG biến một khoản chi thành ba");
  assert.equal(chiPhiSau.components.RENT.amount, 20_000_000, "5. mặt bằng vẫn đúng 20 triệu");

  // ═══════════ 6. MỘT DÒNG TIỀN PHỦ NHIỀU NGHĨA VỤ ═══════════
  //
  // Một chuyển khoản 30 triệu trả hai hoá đơn phần mềm 20 + 10.
  await createLink({ txnId: "ft-txn-multi", targetType: "EXPENSE", targetId: "ft-exp-soft-a", amount: 20_000_000, confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  await createLink({ txnId: "ft-txn-multi", targetType: "EXPENSE", targetId: "ft-exp-soft-b", amount: 10_000_000, confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  const phanBo = await txnAllocation("ft-txn-multi", db);
  assert.equal(phanBo.state, "FULL", "6. 20 + 10 phủ trọn dòng tiền 30 triệu");
  assert.equal(phanBo.remaining, 0, "6. không còn phần nào chưa nối");

  // VƯỢT SỐ TIỀN THẬT bị chặn: cùng một đồng không được đánh dấu hai nghĩa vụ đã trả.
  const vuot = await createLink({ txnId: "ft-txn-multi", targetType: "EXPENSE", targetId: "ft-exp-rent", amount: 1_000, confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  assert.ok("error" in vuot, "6. nối vượt trị tuyệt đối số tiền bị TỪ CHỐI");
  // Nối tới một chứng từ KHÔNG CÓ THẬT cũng bị chặn — nếu không, nghĩa vụ kia biến mất khỏi danh sách chưa trả.
  const maLa = await createLink({ txnId: "ft-txn-rent-1", targetType: "EXPENSE", targetId: "ft-khong-ton-tai", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  assert.ok("error" in maLa, "6. nối tới chứng từ không tồn tại bị TỪ CHỐI");

  // ═══════════ 7. ẢNH CHỤP MỐI NỐI CHÍNH LUÔN KHỚP BẢNG NỐI ═══════════
  //
  // `linked_type/linked_id` không còn là nguồn sự thật nhưng vẫn được màn hình cũ đọc. Lệch giữa hai
  // chỗ là cách âm thầm nhất để một dòng "đã đối chiếu" trông như chưa, hoặc ngược lại.
  const [anhChup] = await db.select({ t: b.linkedType, i: b.linkedId }).from(b).where(eq(b.id, "ft-txn-multi"));
  assert.equal(anhChup.t, "EXPENSE", "7. ảnh chụp ghi đúng loại chứng từ chính");
  assert.equal(anhChup.i, "ft-exp-soft-a", "7. mối nối CHÍNH là mối nối lớn nhất (20 triệu)");
  const lech = await db
    .select({ n: sql<number>`count(*)` })
    .from(b)
    .where(sql`${b.linkedType} <> '' and not exists (select 1 from bank_transaction_links tl where tl.txn_id = ${b.id} and tl.target_type = ${b.linkedType} and tl.target_id = ${b.linkedId})`);
  assert.equal(Number(lech[0]?.n ?? 0), 0, "7. KHÔNG dòng nào có ảnh chụp trỏ vào một mối nối không tồn tại");

  // ═══════════ 8. SAO KÊ NHẬP TAY + WEBHOOK SEPAY VẪN HỘI TỤ ═══════════
  //
  // Bật realtime khi đã có lịch sử nhập bằng file là lúc dễ nhân đôi dòng tiền nhất. Và mối nối kế
  // toán đã làm trên dòng cũ KHÔNG được biến mất — làm lại công đối chiếu là cách nhanh nhất khiến
  // người dùng bỏ luôn việc đối chiếu.
  const dongFile = toBankRow({
    date: "2027-05-22", time: "10:15", amount: -3_000_000,
    description: "CUSTOMER thanh toan phan mem", counterparty: "CONG TY PM", bankRef: "FT27142000111", categoryCode: "", note: "",
  });
  await db.insert(b).values({ ...dongFile, id: "ft-txn-file", source: "IMPORT", accountingGroup: "SOFTWARE", classifiedBy: "ketoan@shop.vn", bankAccountId: "ft-acc-a" });
  await createLink({ txnId: "ft-txn-file", targetType: "EXPENSE", targetId: "ft-exp-soft-b", amount: 3_000_000, confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });

  const goiTin = parseSepayPayload({
    id: 770001, gateway: "MBBank", transactionDate: "2027-05-22 10:15:00", accountNumber: "9990001111", subAccount: null,
    code: null, content: "thanh toan phan mem", transferType: "out", description: "BankAPINotify", transferAmount: 3_000_000,
    accumulated: 25_000_000, referenceCode: "FT27142000111",
  });
  assert.ok(goiTin.ok, "8. gói tin SePay đọc được");
  const hoiTu = await ingestSepayTransaction(db, goiTin.txn);
  assert.equal(hoiTu.created, false, "8. cùng mã bút toán ngân hàng ⇒ KHÔNG đẻ dòng thứ hai");
  assert.equal(hoiTu.transactionId, "ft-txn-file", "8. webhook hội tụ vào đúng dòng đã nhập từ file");
  const sauHoiTu = await txnAllocation("ft-txn-file", db);
  assert.equal(sauHoiTu.links.length, 1, "8. mối nối kế toán SỐNG SÓT qua lần hội tụ");
  assert.equal(sauHoiTu.allocated, 3_000_000, "8. và số tiền phân bổ không bị nhân đôi");
  const [demFile] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "FT27142000111"));
  assert.equal(Number(demFile.n), 1, "8. đúng MỘT dòng cho một giao dịch ngân hàng");
  // Và tổng chi phí phần mềm B vẫn là 10 triệu — mối nối 3 triệu không làm nó thành 13.
  clearMemo();
  assert.equal((await getRecognizedCosts(KY)).components.SOFTWARE.amount, 30_000_000, "8. mối nối không cộng thêm vào chi phí phần mềm");

  // ═══════════ 9. NGHĨA VỤ LƯƠNG ≠ TIỀN LƯƠNG ĐÃ TRẢ ═══════════
  //
  // Lương tháng 4 trả ngày 06/05: TIỀN thuộc tháng 5, CHI PHÍ thuộc tháng 4. Gộp hai thứ đó là vừa
  // trừ sai kỳ vừa trừ hai lần. Mối nối trỏ tới KỲ LƯƠNG `2027-04`, không tới tháng 5.
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, {
    list: [{ id: "ft-emp-1", name: "Nhân sự kiểm thử", shortName: "KT", department: "Quản lý", aliases: [], accountIds: [], fixed: 9_000_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "" }],
  });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  await createLink({ txnId: "ft-txn-payroll", targetType: "PAYROLL_PERIOD", targetId: "2027-04", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });

  // Kỳ lương phải là THÁNG. Nối vào một chuỗi tự do thì sau này không tổng hợp lại được.
  const kyLa = await createLink({ txnId: "ft-txn-rent-1", targetType: "PAYROLL_PERIOD", targetId: "thang 4", confidence: "MANUAL", method: "MANUAL", confirmedBy: "ketoan@shop.vn" });
  assert.ok("error" in kyLa, "9. kỳ lương không đúng dạng YYYY-MM bị TỪ CHỐI");

  clearMemo();
  const nghiaVu = await getObligationLedger(KY);
  const luong = nghiaVu.lines.find((x) => x.key === "PAYROLL");
  assert.ok(luong, "9. sổ nghĩa vụ có dòng lương");
  assert.equal(luong.obligation, 9_000_000, "9. NGHĨA VỤ lương tháng 5 = 9 triệu (theo kỳ làm việc)");
  assert.equal(luong.settled, 9_000_000, "9. TIỀN lương chi trong tháng 5 = 9 triệu — nhưng là của kỳ 2027-04");
  // Hai con số bằng nhau chỉ là trùng hợp về SỐ; chúng nói về hai KỲ khác nhau và không được cộng.
  clearMemo();
  const chiPhiCuoi = await getRecognizedCosts(KY);
  assert.equal(chiPhiCuoi.components.SALARY.amount, 9_000_000, "9. chi phí lương của kỳ vẫn là 9 triệu, KHÔNG phải 18 triệu");

  const chiPhiDong = nghiaVu.lines.find((x) => x.key === "EXPENSE");
  assert.ok(chiPhiDong && chiPhiDong.settled > 0, "9. sổ nghĩa vụ đọc được phần chi phí đã có tiền thật phủ");

  // ═══════════ 10. CẦU NỐI LỢI NHUẬN → TIỀN MẶT ═══════════
  //
  // Không ÉP KHỚP: phần chưa giải thích được hiện nguyên, vì bịa một dòng "điều chỉnh khác" biến
  // công cụ chẩn đoán thành công cụ trấn an.
  clearMemo();
  const cau = await getCashProfitBridge(KY);
  // 59 triệu của khối chuẩn bị + 3 triệu của dòng nhập từ file ở nhóm 8 = 62 triệu tiền ra kinh doanh.
  assert.equal(cau.businessNetCash, 11_970_000 - 62_000_000, "10. dòng tiền kinh doanh ròng = vào − ra, đã loại chuyển nội bộ");
  assert.ok(cau.lines.some((x) => x.key === "cod_held"), "10. phải nêu khoản COD ĐVVC còn giữ — thường là chênh lớn nhất của shop COD");
  assert.ok(cau.lines.some((x) => x.key === "business_net_cash" && x.subtotal), "10. kết thúc bằng dòng tiền thật, không phải một con số ép cho khớp");
  assert.ok(cau.limitations.length > 0, "10. luôn nói ra giới hạn của con số");

  // ═══════════ 11. SỐ DƯ: CHƯA BIẾT KHÔNG PHẢI LÀ 0 ═══════════
  clearMemo();
  const so = await getCashLedger(KY);
  const taiKhoanB = so.balance.accounts.find((a) => a.id === "ft-acc-b");
  assert.equal(taiKhoanB?.balance, null, "11. tài khoản chưa có số dư luỹ kế là CHƯA BIẾT, không phải 0đ");
  const taiKhoanA = so.balance.accounts.find((a) => a.id === "ft-acc-a");
  // Dòng MỚI NHẤT có số dư là dòng 22/05 — số dư luỹ kế của nó do webhook SePay bổ sung ở nhóm 8,
  // chứ không phải dòng COD ngày 15/05. Số dư đi theo mốc thời gian, không theo đường vào.
  assert.equal(taiKhoanA?.balance, 25_000_000, "11. số dư lấy dòng MỚI NHẤT có số dư luỹ kế");

  // ═══════════ 12. GỠ MỐI NỐI TRẢ SỔ VỀ ĐÚNG TRẠNG THÁI ═══════════
  const canGo = (await txnAllocation("ft-txn-tf-out", db)).links[0];
  await removeLink(canGo.id, db);
  assert.equal((await txnAllocation("ft-txn-tf-in", db)).links.length, 0, "12. gỡ một chân chuyển nội bộ thì gỡ luôn chân kia — nửa cặp là vô nghĩa");
  const [sauGo] = await db.select({ t: b.linkedType }).from(b).where(eq(b.id, "ft-txn-tf-out"));
  assert.equal(sauGo.t, "", "12. ảnh chụp mối nối chính được dọn theo");

  // ══════════ DỌN ══════════
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  await db.delete(l).where(and(sql`true`, sql`${l.txnId} like 'ft-%'`));
  await donDep(db);
  console.log("✓ Sự thật tài chính & mối nối: 12 nhóm");
}
