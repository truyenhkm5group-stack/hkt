import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { BANK_GROUPS } from "@/lib/constants/bank";
import { CASHFLOW_SECTIONS, GROUPS_BY_SECTION, sectionOf } from "@/lib/constants/cashflow-sections";
import { getCashflowStatement } from "@/lib/queries/cashflow-statement";
import { getExpenseReport } from "@/lib/queries/expense-report";
import { getFinanceOverview } from "@/lib/queries/finance-overview";
import { getProfitCashBridge } from "@/lib/queries/profit-cash-bridge";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BUỒNG LÁI TÀI CHÍNH ═══════════
 *
 * Bốn báo cáo mới đọc CÙNG một sổ ngân hàng. Rủi ro lớn nhất không phải một phép cộng sai mà là
 * một nhóm kế toán rơi khỏi báo cáo: nhóm mới thêm ở `lib/constants/bank.ts` mà không ai ánh xạ
 * sang khoang dòng tiền thì tiền thật biến mất khỏi màn hình, lặng lẽ, và tổng vẫn trông hợp lý.
 *
 * Nên bộ này khoá bốn điều:
 *   1. MỌI nhóm kế toán đều thuộc đúng MỘT khoang — không nhóm nào rơi, không nhóm nào ở hai chỗ;
 *   2. đẳng thức đầu kỳ + phát sinh = cuối kỳ phải khớp, và lệch thì phải NÊU RA chứ không làm ngơ;
 *   3. chuyển nội bộ KHÔNG được thổi phồng tiền vào / tiền ra;
 *   4. bảng lợi nhuận ≠ tiền không được ép cho khớp — phần chưa giải thích phải đứng riêng.
 *
 * Dữ liệu đặt ở tháng 05/2027 với tiền tố `fc-` để không chạm fixture của bộ khác.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const KY: Period = { key: "custom", from: d("2027-05-01"), to: dEnd("2027-05-31"), label: "Tháng 5/2027", fromKey: "2027-05-01", toKey: "2027-05-31" };

async function reset(db: Db) {
  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} like 'fc-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'fc-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'fc-%'`);
  clearMemo();
}

export async function testFinanceCockpit(db: Db) {
  await reset(db);

  // ═══ 1. KHÔNG NHÓM KẾ TOÁN NÀO ĐƯỢC RƠI KHỎI BÁO CÁO DÒNG TIỀN ═══
  /*
    Đây là lá chắn quan trọng nhất của tệp và nó canh CẢ BỀ MẶT, không canh một danh sách gõ tay —
    đúng bài học đã lặp lại tám lần trong kho mã này (xem `tests/smoke-coverage.test.ts`).
    Thêm một nhóm mới ở `lib/constants/bank.ts` mà quên ánh xạ ⇒ bài kiểm này đỏ ngay.
  */
  for (const group of BANK_GROUPS) {
    const thuoc = CASHFLOW_SECTIONS.filter((s) => GROUPS_BY_SECTION[s].includes(group));
    assert.equal(thuoc.length, 1, `1. nhóm ${group} phải thuộc ĐÚNG MỘT khoang, đang thuộc ${thuoc.length} (${thuoc.join(", ")})`);
    assert.equal(thuoc[0], sectionOf(group), `1. ánh xạ nhóm ${group} phải nhất quán hai chiều`);
  }
  assert.equal(
    CASHFLOW_SECTIONS.reduce((t, s) => t + GROUPS_BY_SECTION[s].length, 0),
    BANK_GROUPS.length,
    "1. tổng số nhóm trong bốn khoang phải bằng đúng số nhóm kế toán — thừa hoặc thiếu đều là tiền sai chỗ",
  );
  // Chưa phân loại VẪN phải nằm trong dòng tiền vận hành: đẩy nó ra thì đẳng thức đầu/cuối kỳ vỡ.
  assert.equal(sectionOf("UNCLASSIFIED"), "OPERATING", "1. dòng chưa phân loại vẫn là tiền đã vào/ra, phải ở trong báo cáo");

  // ── Dựng một tháng có đủ bốn khoang ──
  await db.insert(schema.bankAccounts).values([
    { id: "fc-acc-a", provider: "SEPAY", gateway: "MBBank", accountNumber: "5555000011", label: "MB kinh doanh", status: "ACTIVE" },
    { id: "fc-acc-b", provider: "SEPAY", gateway: "MBBank", accountNumber: "5555000022", label: "MB dự phòng", status: "ACTIVE" },
  ]);

  await db.insert(schema.bankTransactions).values([
    // Số dư đầu kỳ: 10.000.000 ở tài khoản A (mốc 30/04)
    { id: "fc-t0", bankAccountId: "fc-acc-a", txnAt: d("2027-04-30"), amount: 10_000_000, bankRef: "fc-r0", balanceAfter: 10_000_000, accountingGroup: "COD_SETTLEMENT" },
    // ── Vận hành ──
    { id: "fc-t1", bankAccountId: "fc-acc-a", txnAt: d("2027-05-05"), amount: 30_000_000, bankRef: "fc-r1", balanceAfter: 40_000_000, accountingGroup: "COD_SETTLEMENT" },
    { id: "fc-t2", bankAccountId: "fc-acc-a", txnAt: d("2027-05-06"), amount: -8_000_000, bankRef: "fc-r2", balanceAfter: 32_000_000, accountingGroup: "ADS_SPEND", counterparty: "Meta Platforms" },
    { id: "fc-t3", bankAccountId: "fc-acc-a", txnAt: d("2027-05-07"), amount: -5_000_000, bankRef: "fc-r3", balanceAfter: 27_000_000, accountingGroup: "RENT_UTILITIES", counterparty: "Chu nha" },
    // ── Chưa phân loại: vẫn là tiền thật ──
    { id: "fc-t4", bankAccountId: "fc-acc-a", txnAt: d("2027-05-08"), amount: -1_000_000, bankRef: "fc-r4", balanceAfter: 26_000_000, accountingGroup: "UNCLASSIFIED", counterparty: "Chua ro" },
    // ── Vốn & vay ──
    { id: "fc-t5", bankAccountId: "fc-acc-a", txnAt: d("2027-05-10"), amount: 20_000_000, bankRef: "fc-r5", balanceAfter: 46_000_000, accountingGroup: "LOAN_IN" },
    // ── Đầu tư ──
    { id: "fc-t6", bankAccountId: "fc-acc-a", txnAt: d("2027-05-12"), amount: -6_000_000, bankRef: "fc-r6", balanceAfter: 40_000_000, accountingGroup: "ASSET_PURCHASE", counterparty: "Cua hang may tinh" },
    // ── Chuyển nội bộ: HAI ĐẦU, phải triệt tiêu ──
    { id: "fc-t7", bankAccountId: "fc-acc-a", txnAt: d("2027-05-20"), amount: -15_000_000, bankRef: "fc-r7", balanceAfter: 25_000_000, accountingGroup: "INTERNAL_TRANSFER" },
    { id: "fc-t8", bankAccountId: "fc-acc-b", txnAt: d("2027-05-20"), amount: 15_000_000, bankRef: "fc-r8", balanceAfter: 15_000_000, accountingGroup: "INTERNAL_TRANSFER" },
  ]);

  clearMemo();
  const bc = await getCashflowStatement(KY);

  // ═══ 2. ĐẲNG THỨC ĐẦU KỲ + PHÁT SINH = CUỐI KỲ ═══
  assert.equal(bc.opening, 10_000_000, "2. đầu kỳ đọc từ số dư ngân hàng ghi ngay trước ngày đầu kỳ");
  assert.equal(bc.closing, 40_000_000, "2. cuối kỳ = 25.000.000 (A) + 15.000.000 (B)");
  assert.equal(bc.movementAll, 30_000_000, "2. tổng phát sinh mọi dòng trong kỳ");
  assert.equal(bc.integrityGap, 0, "2. đầu kỳ + phát sinh − cuối kỳ = 0 ⇒ sổ liền mạch");

  // ═══ 3. "TIỀN KINH DOANH" LÀ KHOANG VẬN HÀNH, KHÔNG PHẢI "mọi thứ trừ chuyển nội bộ" ═══
  /*
    HAI THỨ BỊ LOẠI, VÌ HAI LÝ DO KHÁC NHAU.

    · CHUYỂN NỘI BỘ — hai đầu của lần chuyển 15 triệu đều nằm trong sổ. Tính vào thì "tiền vào"
      thành 65 triệu và "tiền ra" thành 35 triệu: chênh lệch vẫn đúng nhưng chủ shop đọc thành
      "tháng này quay vòng 65 triệu", gần gấp rưỡi thực tế.

    · VỐN GÓP / TIỀN VAY — 20 triệu giải ngân KHÔNG phải tiền shop làm ra. Bản đầu của nhánh này
      cộng nó vào `moneyIn` (kỳ vọng cũ: 50 triệu) trong khi CHÍNH bài kiểm này, ba dòng bên dưới,
      khẳng định "vay tiền về KHÔNG được nằm trong vận hành". Hai khẳng định không thể cùng đúng.

      Kỳ vọng cũ là cái sai: `isBusinessCash()` ở lib/constants/bank.ts loại `CAPITAL`/`OWNER` từ
      đầu, `CASHFLOW_SECTION_HINT.OPERATING` nói thẳng "vay tiền về hay bơm vốn vào đều không nằm ở
      đây", và nếu giữ nguyên thì một shop đang lỗ mà đi vay sẽ hiện ra như một shop đang bán tốt —
      đúng thứ khoang vận hành sinh ra để ngăn.

    `INVESTING` và `FINANCING` không mất đi: chúng vẫn là khoang riêng ngay dưới đây.
  */
  assert.equal(bc.moneyIn, 30_000_000, "3. tiền vào kinh doanh = 30tr COD. KHÔNG gồm 20tr vay, KHÔNG gồm 15tr chuyển nội bộ");
  assert.equal(bc.moneyOut, 14_000_000, "3. tiền ra kinh doanh = 8 + 5 + 1 triệu. KHÔNG gồm 6tr mua tài sản (đầu tư)");
  assert.equal(bc.net, 16_000_000, "3. dòng tiền kinh doanh ròng = 30 − 14");

  const khoang = new Map(bc.sections.map((s) => [s.section, s]));
  // Con số headline PHẢI đúng bằng khoang vận hành — nếu lệch thì nhãn "kinh doanh" đang nói dối.
  assert.equal(bc.net, khoang.get("OPERATING")!.net, "3. headline và khoang vận hành là MỘT con số, không phải hai");
  assert.equal(khoang.get("OPERATING")!.net, 16_000_000, "3. vận hành: +30 − 8 − 5 − 1");
  assert.equal(khoang.get("FINANCING")!.net, 20_000_000, "3. vay tiền về KHÔNG được nằm trong vận hành");
  assert.equal(khoang.get("INVESTING")!.net, -6_000_000, "3. mua tài sản là đầu tư, không phải chi phí vận hành");
  assert.equal(khoang.get("EXCLUDED")!.net, 0, "3. hai đầu chuyển nội bộ triệt tiêu về 0");
  assert.equal(bc.unclassified.count, 1, "3. dòng chưa phân loại được đếm riêng để thành việc cần làm");

  // ═══ 4. SỔ THIẾU GIAO DỊCH PHẢI BỊ NÊU RA, KHÔNG ĐƯỢC LÀM NGƠ ═══
  /*
    Xoá một giao dịch (mô phỏng sổ thiếu dòng) rồi kiểm: đẳng thức phải VỠ và `integrityGap` phải
    nói đúng khoản lệch. Đây là điều phân biệt một báo cáo đáng tin với một báo cáo chỉ biết cộng.
  */
  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} = 'fc-t3'`);
  clearMemo();
  const thieu = await getCashflowStatement(KY);
  /*
    DẤU CỦA KHOẢNG LỆCH NÓI RA LOẠI HỎNG, nên nó phải được khoá chứ không chỉ khoá độ lớn.

    Mất một khoản CHI 5.000.000 ⇒ phát sinh ERP cộng được (35tr) NHIỀU HƠN mức ngân hàng thật sự
    đổi (30tr) ⇒ `opening + movement − closing = +5.000.000`. Dấu DƯƠNG = sổ đang thiếu tiền RA
    hoặc thừa một dòng tiền vào. Dấu ÂM là chiều ngược lại. Lẫn hai chiều này thì người đi tìm
    nguyên nhân sẽ lục sai nửa sổ.
  */
  assert.equal(thieu.integrityGap, 5_000_000, "4. thiếu đúng khoản chi 5.000.000 ⇒ nêu ra đúng chừng đó, dấu DƯƠNG");
  assert.notEqual(thieu.integrityGap, 0, "4. TUYỆT ĐỐI không được báo khớp khi sổ đang thiếu dòng");

  // Trả lại để các phép kiểm sau chạy trên sổ lành.
  await db.insert(schema.bankTransactions).values({
    id: "fc-t3", bankAccountId: "fc-acc-a", txnAt: d("2027-05-07"), amount: -5_000_000, bankRef: "fc-r3", balanceAfter: 27_000_000, accountingGroup: "RENT_UTILITIES", counterparty: "Chu nha",
  });

  // ═══ 5. BÁO CÁO CHI PHÍ: hai cơ sở tách bạch, biến động xếp theo TIỀN ═══
  await db.insert(schema.expenses).values([
    { id: "fc-exp-1", category: "RENT", description: "Thuê mặt bằng tháng 5", amount: 5_000_000, occurredAt: d("2027-05-01"), costSource: "MANUAL" },
    { id: "fc-exp-2", category: "SOFTWARE", description: "Phần mềm tháng 5", amount: 900_000, occurredAt: d("2027-05-02"), costSource: "MANUAL" },
  ]);
  clearMemo();
  const cp = await getExpenseReport(KY);

  const rent = cp.byCategory.find((c) => c.category === "RENT");
  assert.ok(rent, "5. nhóm Mặt bằng phải có trong báo cáo");
  assert.equal(rent!.amount, 5_000_000, "5. cộng đúng khoản đã phân bổ");
  // Quảng cáo và nhập hàng có nguồn chuyên biệt, KHÔNG được cộng lại từ bảng Chi phí.
  assert.ok(!cp.byCategory.some((c) => c.category === "ADS"), "5. nhóm Quảng cáo không được lấy từ bảng Chi phí — nguồn của nó là tài khoản QC");
  assert.ok(!cp.byCategory.some((c) => c.category === "PURCHASE"), "5. nhóm Nhập hàng không được lấy từ bảng Chi phí — nguồn của nó là phiếu kho");

  const ngayCoChi = cp.trend.find((p) => p.day === "2027-05-06");
  assert.ok(ngayCoChi && ngayCoChi.cashOut === 8_000_000, "5. biểu đồ theo ngày dùng TIỀN THẬT ĐÃ RA, theo ngày ngân hàng ghi");
  assert.ok(!cp.trend.some((p) => p.day === "2027-05-20"), "5. ngày chỉ có chuyển nội bộ KHÔNG được thành một đỉnh chi phí");

  assert.equal(cp.unclassifiedOutflow.count, 1, "5. tiền ra chưa phân loại là việc cần làm, đếm riêng");
  assert.equal(cp.unclassifiedOutflow.amount, 1_000_000, "5. và nói rõ đang treo bao nhiêu tiền");

  const vendor = cp.topVendors.find((v) => v.counterparty === "Meta Platforms");
  assert.ok(vendor && vendor.amount === 8_000_000, "5. trả cho ai nhiều nhất — đọc từ sao kê");
  assert.ok(!cp.topVendors.some((v) => v.amount === 15_000_000), "5. chuyển cho chính mình KHÔNG phải một nhà cung cấp");

  // ═══ 6. LỢI NHUẬN ≠ TIỀN: KHÔNG ĐƯỢC ÉP CHO KHỚP ═══
  clearMemo();
  const bridge = await getProfitCashBridge(KY);
  assert.ok(bridge.lines.some((l) => l.key === "profit" && l.anchor), "6. bảng phải bắt đầu từ lợi nhuận, nói rõ đó là mốc");
  assert.equal(bridge.cashMovement, bc.net, "6. điểm đến là biến động tiền thật trên sao kê, không tính lại");
  assert.ok(bridge.reasons.length > 0, "6. phải nói VÌ SAO còn phần chưa giải thích — không được im lặng");
  assert.ok(
    bridge.reasons.some((r) => r.includes("công nợ phải trả")),
    "6. phải nêu đúng cái ERP KHÔNG có (sổ phải trả nhà cung cấp), không nói chung chung",
  );
  /*
    Phần chưa giải thích phải là một con số ĐỨNG RIÊNG, không được nhồi vào một dòng "điều chỉnh
    khác" để bảng khớp 0đ. Một bảng khớp nhờ khoản nhồi là cách hợp pháp hoá mọi sai sót về sau.
  */
  assert.ok(bridge.unexplained !== null, "6. có sao kê thì phải tính được phần chưa giải thích");
  assert.ok(!bridge.lines.some((l) => /điều chỉnh khác|khác\b/i.test(l.label) && !l.known), "6. không có dòng nhồi cho khớp");
  const congLai = bridge.profit + bridge.explained + (bridge.unexplained ?? 0);
  assert.equal(congLai, bridge.cashMovement, "6. lợi nhuận + giải thích được + chưa giải thích được = tiền thật, theo đúng định nghĩa");

  // ═══ 7. TỔNG QUAN: ngoại lệ phải nổi lên, và mỗi ngoại lệ phải có chỗ để bấm vào ═══
  clearMemo();
  const tq = await getFinanceOverview(KY);
  const chuaPhanLoai = tq.exceptions.find((e) => e.key === "bank-unclassified");
  assert.ok(chuaPhanLoai, "7. giao dịch chưa phân loại phải thành một việc cần làm");
  assert.equal(chuaPhanLoai!.severity, "high", "7. và là việc ưu tiên cao — mọi con số phía trên đang thiếu đúng khoản đó");
  for (const e of tq.exceptions) {
    assert.ok(e.href.startsWith("/"), `7. ngoại lệ "${e.title}" phải có đường dẫn tới chỗ xử lý`);
    assert.ok(e.impact.length > 30, `7. ngoại lệ "${e.title}" phải nói HẬU QUẢ, không chỉ nói tên`);
  }
  // Ngoại lệ nặng đứng trước ngoại lệ nhẹ — người đọc làm từ trên xuống.
  const mucDo = tq.exceptions.map((e) => ({ high: 0, medium: 1, low: 2 })[e.severity]);
  assert.deepEqual([...mucDo].sort((a, b) => a - b), mucDo, "7. ngoại lệ phải xếp theo mức độ, nặng trước");

  assert.equal(tq.cash.total, 40_000_000, "7. tiền hiện có gộp cả hai tài khoản");
  assert.equal(tq.statement.net, bc.net, "7. tổng quan KHÔNG tính lại dòng tiền, nó đọc lại đúng engine");

  await reset(db);
  console.log(
    "✓ Buồng lái tài chính: 24/24 nhóm kế toán thuộc đúng một khoang · đẳng thức đầu/cuối kỳ khớp và vỡ đúng lúc · chuyển nội bộ không thổi phồng · lợi nhuận ≠ tiền không ép khớp · ngoại lệ có hậu quả + lối xử lý",
  );
}
