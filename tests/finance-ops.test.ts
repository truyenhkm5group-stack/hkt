import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { createLink } from "@/lib/finance/linkage";
import { codMatchStatus, matchEmployeeByText } from "@/lib/constants/finance-ops";
import { matchInternalTransferPairs } from "@/lib/integrations/bank/internal-transfer";
import {
  codMatchQueue,
  countExpensesWithoutPayment,
  countPaymentsWithoutExpense,
  expensesWithoutPayment,
  internalTransferCandidateRows,
  paymentsWithoutExpense,
  payrollUnmatched,
  searchCodBatchesForLink,
  searchExpensesForLink,
} from "@/lib/queries/finance-ops";

/**
 * ═══════ HÀNG ĐỢI TÁC VỤ TÀI CHÍNH ═══════
 *
 * Trang này không phát minh luật mới — nó gom việc còn treo từ các module đã có. Nên điều quan
 * trọng nhất phải khoá là CHIỀU NGƯỢC LẠI: một khi việc đã xong (đã nối chứng từ, đã ghép cặp), dòng
 * đó phải BIẾN MẤT khỏi hàng đợi, nếu không người dùng sẽ xử lý một việc đã xong hoài không hết.
 */

const ngay = (d: string) => new Date(`${d}T03:00:00Z`);

export function testFinanceOpsPure() {
  // ───────── 1. Ghép cặp chuyển nội bộ: chỉ ghép khi khớp MỘT-MỘT ─────────
  const mot1 = matchInternalTransferPairs([
    { id: "out1", amount: -5_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctA" },
    { id: "in1", amount: 5_000_000, txnAt: ngay("2026-09-06"), bankAccountId: "acctB" },
  ]);
  assert.equal(mot1.length, 1, "một ra một vào, cùng tiền, khác tài khoản, trong cửa sổ ngày ⇒ ghép được");
  assert.equal(mot1[0].outId, "out1");
  assert.equal(mot1[0].inId, "in1");
  assert.equal(mot1[0].amount, 5_000_000);
  assert.ok(mot1[0].reasons.length >= 2, "phải nói rõ vì sao ghép");

  const cungTk = matchInternalTransferPairs([
    { id: "out2", amount: -3_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctA" },
    { id: "in2", amount: 3_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctA" },
  ]);
  assert.equal(cungTk.length, 0, "cùng một tài khoản thì KHÔNG phải chuyển nội bộ");

  // Đây là luật quan trọng nhất: hai khoản CHI cùng số tiền cùng khớp một khoản THU thì không được
  // đoán đại một cặp — hệt luật "không nối bằng số tiền đơn độc" của lib/integrations/bank/match.ts.
  const nhapNhang = matchInternalTransferPairs([
    { id: "outA", amount: -2_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctA" },
    { id: "outB", amount: -2_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctA" },
    { id: "inX", amount: 2_000_000, txnAt: ngay("2026-09-06"), bankAccountId: "acctB" },
  ]);
  assert.equal(nhapNhang.length, 0, "hai khoản chi cùng số tiền cùng khớp một khoản thu ⇒ không được ghép bừa");

  const thieuTk = matchInternalTransferPairs([
    { id: "out3", amount: -1_000_000, txnAt: ngay("2026-09-05"), bankAccountId: null },
    { id: "in3", amount: 1_000_000, txnAt: ngay("2026-09-05"), bankAccountId: "acctB" },
  ]);
  assert.equal(thieuTk.length, 0, "chưa biết tài khoản thì không chắc là hai tài khoản khác nhau");

  const quaXaNgay = matchInternalTransferPairs([
    { id: "out4", amount: -1_000_000, txnAt: ngay("2026-09-01"), bankAccountId: "acctA" },
    { id: "in4", amount: 1_000_000, txnAt: ngay("2026-09-10"), bankAccountId: "acctB" },
  ]);
  assert.equal(quaXaNgay.length, 0, "lệch quá xa ngày thì không còn là cùng một lượt chuyển");

  // ───────── 2. Quy đổi mức tin cậy COD sang bốn trạng thái nghiệp vụ ─────────
  const matched = codMatchStatus(5_000_000, { confidence: "EXACT", target: { amount: 5_000_000 }, others: [] });
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.difference, 0);

  const partial = codMatchStatus(4_800_000, { confidence: "AMBIGUOUS", target: null, others: [{ amount: 5_000_000 }] });
  assert.equal(partial.status, "PARTIAL", "đúng một đợt COD cùng mã nhưng lệch tiền ⇒ khớp một phần, không phải review");
  assert.equal(partial.difference, -200_000, "chênh lệch = tiền sao kê − tiền chứng từ");

  const review = codMatchStatus(5_000_000, { confidence: "AMBIGUOUS", target: null, others: [{ amount: 5_000_000 }, { amount: 5_000_000 }] });
  assert.equal(review.status, "REVIEW", "nhiều đợt COD cùng khớp thì phải để người xem, không đoán");
  assert.equal(review.difference, null);

  const unmatched = codMatchStatus(1_234_000, { confidence: "UNMATCHED", target: null, others: [] });
  assert.equal(unmatched.status, "UNMATCHED");
  assert.equal(unmatched.difference, null);

  // ───────── 3. Gợi ý nhân sự theo tên / bí danh ─────────
  const employees = [
    { id: "e1", name: "Nguyễn Văn Quân", shortName: "Quân TA", aliases: ["QA4"], active: true },
    { id: "e2", name: "Trần Thị Bình", shortName: "Bình", aliases: [], active: false },
  ];
  assert.equal(matchEmployeeByText("CHUYEN LUONG THANG 9 QUAN TA", employees)?.id, "e1", "khớp theo tên ngắn, không phân biệt dấu/hoa thường");
  assert.equal(matchEmployeeByText("thanh toan chien dich QA4", employees)?.id, "e1", "khớp theo bí danh");
  assert.equal(matchEmployeeByText("BINH tra tien dien", employees), null, "nhân sự không active thì không được gợi ý");
  assert.equal(matchEmployeeByText("khong lien quan ai ca", employees), null, "không khớp gì thì trả về null, không đoán đại");

  console.log(
    "✓ Hàng đợi tác vụ tài chính (thuần): ghép chuyển nội bộ một-một, không đoán khi nhập nhằng · quy đổi COD MATCHED/PARTIAL/REVIEW/UNMATCHED đúng luật đối khớp · gợi ý nhân sự theo tên/bí danh, bỏ qua người ngừng hoạt động",
  );
}

export async function testFinanceOpsQueries(db: Db) {
  const b = schema.bankTransactions;
  await db.delete(b).where(sql`${b.id} like 'fops-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'fops-%'`);
  await db.delete(schema.codBatches).where(sql`${schema.codBatches.id} like 'fops-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'fops-%'`);

  try {
    // ───────── 1. Khoản chi chưa có chứng từ tiền — biến mất đúng lúc được nối ─────────
    await db.insert(schema.expenses).values({
      id: "fops-exp-1",
      category: "RENT",
      description: "fops thue kho thang 9",
      amount: 8_000_000,
      occurredAt: ngay("2026-09-05"),
      createdBy: "test",
    });
    const truocKhiNoi = await expensesWithoutPayment(500);
    assert.ok(truocKhiNoi.some((r) => r.id === "fops-exp-1"), "khoản chi chưa nối phải hiện trong hàng đợi");
    const demTruoc = await countExpensesWithoutPayment();

    await db.insert(b).values({
      id: "fops-b1",
      bankRef: "FOPS0001",
      txnAt: ngay("2026-09-05"),
      amount: -8_000_000,
      description: "CK tien thue kho",
      counterparty: "CHU NHA",
      accountingGroup: "RENT_UTILITIES",
      source: "IMPORT",
    });
    /*
      NỐI QUA `createLink`, KHÔNG GHI THẲNG `linked_type/linked_id`.

      Hai cột đó nay chỉ là ẢNH CHỤP mối nối lớn nhất; nguồn sự thật là `bank_transaction_links`.
      Ghi thẳng ảnh chụp trong bài kiểm nghĩa là bài kiểm dựng một trạng thái mà ứng dụng không bao
      giờ tạo ra được — nó sẽ xanh trong khi đường thật hỏng, hoặc đỏ trong khi đường thật đúng.
      Đi qua đúng hàm mà Server Action gọi thì bài kiểm mới nói được điều gì về ứng dụng.
    */
    const noi = await createLink({
      txnId: "fops-b1", targetType: "EXPENSE", targetId: "fops-exp-1",
      confidence: "MANUAL", method: "MANUAL", confirmedBy: "kiemthu@shop.vn",
    });
    assert.ok("ok" in noi, "nối được khoản chi với dòng tiền");
    const sauKhiNoi = await expensesWithoutPayment(500);
    assert.ok(!sauKhiNoi.some((r) => r.id === "fops-exp-1"), "đã nối chứng từ thì phải biến mất khỏi hàng đợi");
    const demSau = await countExpensesWithoutPayment();
    assert.equal(demSau, demTruoc - 1, "đếm gọn phải giảm đúng một khi một khoản được nối");

    // ───────── 2. Đã phân loại chi phí nhưng chưa nối — ngược lại với mục 1 ─────────
    await db.insert(b).values({
      id: "fops-b2",
      bankRef: "FOPS0002",
      txnAt: ngay("2026-09-06"),
      amount: -1_200_000,
      description: "fops phi phan mem thang 9",
      counterparty: "NHA CUNG CAP PHAN MEM",
      accountingGroup: "SOFTWARE",
      source: "IMPORT",
    });
    const demPay1 = await countPaymentsWithoutExpense();
    const payRows = await paymentsWithoutExpense(500);
    assert.ok(payRows.some((r) => r.id === "fops-b2"), "dòng đã gán nhóm chi phí nhưng chưa nối phải hiện trong hàng đợi");
    assert.ok(!payRows.some((r) => r.id === "fops-b1"), "dòng đã nối rồi thì không được hiện lại ở đây");

    const [exp2] = await db.insert(schema.expenses).values({ id: "fops-exp-2", category: "SOFTWARE", description: "fops phan mem", amount: 1_200_000, occurredAt: ngay("2026-09-06"), createdBy: "test" }).returning({ id: schema.expenses.id });
    await db.update(b).set({ linkedType: "EXPENSE", linkedId: exp2.id }).where(eq(b.id, "fops-b2"));
    const demPay2 = await countPaymentsWithoutExpense();
    assert.equal(demPay2, demPay1 - 1, "nối xong thì đếm phải giảm");

    // ───────── 3. Lương/hoa hồng: đã gán nhóm nhưng chưa nối chứng từ ─────────
    await db.insert(b).values({
      id: "fops-b3",
      bankRef: "FOPS0003",
      txnAt: ngay("2026-09-07"),
      amount: -6_000_000,
      description: "fops luong thang 9",
      counterparty: "NGUYEN VAN A",
      accountingGroup: "PAYROLL_SALARY",
      source: "IMPORT",
    });
    const payroll = await payrollUnmatched(500);
    const dongLuong = payroll.find((r) => r.id === "fops-b3");
    assert.ok(dongLuong, "dòng đã gán Lương cố định nhưng chưa nối phải hiện trong hàng đợi lương");
    assert.equal(dongLuong?.reason, "CLASSIFIED_NOT_LINKED");
    // Cấu trúc gợi ý nhân sự phải luôn có mặt (null hoặc đối tượng) — không kiểm khớp cụ thể vì
    // `payroll.employees` là cấu hình chung của cả bộ kiểm thử, không phải fixture riêng của bài này.
    assert.ok("employeeSuggestion" in dongLuong!, "phải có trường gợi ý nhân sự dù có khớp hay không");

    // ───────── 4. Ghép cặp chuyển nội bộ trên dữ liệu thật (có bankAccountId) ─────────
    await db.insert(schema.bankAccounts).values([
      { id: "fops-acct-a", provider: "", gateway: "MBBank", accountNumber: "FOPSACCTA", status: "ACTIVE" },
      { id: "fops-acct-b", provider: "", gateway: "Vietcombank", accountNumber: "FOPSACCTB", status: "ACTIVE" },
    ]);
    await db.insert(b).values([
      { id: "fops-out", bankRef: "FOPS0004", txnAt: ngay("2026-09-08"), amount: -3_300_000, description: "fops chuyen sang tk kia", counterparty: "", accountingGroup: "UNCLASSIFIED", bankAccountId: "fops-acct-a", source: "IMPORT" },
      { id: "fops-in", bankRef: "FOPS0005", txnAt: ngay("2026-09-08"), amount: 3_300_000, description: "fops nhan tu tk kia", counterparty: "", accountingGroup: "UNCLASSIFIED", bankAccountId: "fops-acct-b", source: "IMPORT" },
    ]);
    const transfers = await internalTransferCandidateRows(500);
    const cap = transfers.find((t) => t.out.id === "fops-out" || t.in.id === "fops-in");
    assert.ok(cap, "cặp chuyển nội bộ hợp lệ phải xuất hiện trong hàng đợi");
    assert.equal(cap?.out.id, "fops-out");
    assert.equal(cap?.in.id, "fops-in");
    assert.equal(cap?.amount, 3_300_000);

    // ───────── 5. Bank → COD: bốn trạng thái trên dữ liệu thật ─────────
    await db.insert(schema.codBatches).values([
      { id: "fops-cod-exact", reference: "FOPSCOD-EXACT-9001", receivedAt: ngay("2026-09-09"), totalAmount: 9_100_000 },
      { id: "fops-cod-r1", reference: "FOPSCOD-REVIEW-1", receivedAt: ngay("2026-09-09"), totalAmount: 4_400_000 },
      { id: "fops-cod-r2", reference: "FOPSCOD-REVIEW-2", receivedAt: ngay("2026-09-09"), totalAmount: 4_400_000 },
    ]);
    await db.insert(b).values([
      // Mã trong nội dung + tiền khớp ⇒ MATCHED (EXACT).
      { id: "fops-cod-b1", bankRef: "FOPS0006", txnAt: ngay("2026-09-09"), amount: 9_100_000, description: "VTP tra tien FOPSCOD-EXACT-9001", counterparty: "VIETTEL POST", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
      // Mã đúng nhưng tiền lệch ⇒ PARTIAL.
      { id: "fops-cod-b2", bankRef: "FOPS0007", txnAt: ngay("2026-09-09"), amount: 9_050_000, description: "VTP tra tien FOPSCOD-EXACT-9001 tru phi", counterparty: "VIETTEL POST", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
      // Không có ứng viên nào ⇒ UNMATCHED.
      { id: "fops-cod-b3", bankRef: "FOPS0008", txnAt: ngay("2026-09-09"), amount: 7_777_000, description: "VTP tra tien khong ro dot", counterparty: "VIETTEL POST", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" },
    ]);
    const codQ1 = await codMatchQueue(500);
    const rowExact = codQ1.rows.find((r) => r.txnId === "fops-cod-b1");
    assert.equal(rowExact?.status, "MATCHED");
    assert.equal(rowExact?.difference, 0);
    assert.equal(rowExact?.reference, "FOPSCOD-EXACT-9001", "phải nêu đúng mã đợt COD để người đọc đối chiếu");

    const rowPartial = codQ1.rows.find((r) => r.txnId === "fops-cod-b2");
    assert.equal(rowPartial?.status, "PARTIAL", "mã đúng nhưng tiền lệch (bị trừ phí) phải là khớp một phần, không phải review");
    assert.equal(rowPartial?.difference, 9_050_000 - 9_100_000);

    const rowUnmatched = codQ1.rows.find((r) => r.txnId === "fops-cod-b3");
    assert.equal(rowUnmatched?.status, "UNMATCHED");

    // Hai đợt COD cùng số tiền, một dòng sao kê chỉ khớp được bằng tiền + ngày ⇒ REVIEW (không đoán).
    await db.insert(b).values({ id: "fops-cod-b4", bankRef: "FOPS0009", txnAt: ngay("2026-09-09"), amount: 4_400_000, description: "VTP tra tien dot thu 3", counterparty: "VIETTEL POST", accountingGroup: "COD_SETTLEMENT", source: "IMPORT" });
    const codQ2 = await codMatchQueue(500);
    const rowReview = codQ2.rows.find((r) => r.txnId === "fops-cod-b4");
    assert.equal(rowReview?.status, "REVIEW", "hai đợt COD cùng số tiền cùng khớp ⇒ phải để người chọn");
    assert.equal(rowReview?.difference, null);

    // ───────── 6. Tìm chứng từ để nối tay ─────────
    const timResult = await searchExpensesForLink("fops phan mem", 20);
    assert.ok(timResult.some((r) => r.id === "fops-exp-2"), "tìm khoản chi theo mô tả phải ra đúng dòng");
    const timCod = await searchCodBatchesForLink("FOPSCOD-EXACT", 20);
    assert.ok(timCod.some((r) => r.id === "fops-cod-exact"), "tìm đợt COD theo mã tham chiếu phải ra đúng dòng");

    console.log(
      "✓ Hàng đợi tác vụ tài chính (CSDL): khoản chi biến mất khỏi hàng đợi đúng lúc được nối · dòng đã phân loại nhưng chưa nối vẫn hiện tới khi nối · lương chưa nối vẫn hiện · ghép cặp chuyển nội bộ trên dữ liệu thật · Bank→COD ra đúng bốn trạng thái · tìm chứng từ để nối tay hoạt động",
    );
  } finally {
    await db.delete(b).where(sql`${b.id} like 'fops-%'`);
    await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'fops-%'`);
    await db.delete(schema.codBatches).where(sql`${schema.codBatches.id} like 'fops-%'`);
    await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'fops-%'`);
  }
}

if (process.argv[1] && /finance-ops\.test\.ts$/.test(process.argv[1])) {
  testFinanceOpsPure();
}
