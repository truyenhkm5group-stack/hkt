import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { balanceAsOf, getCashPosition } from "@/lib/queries/cash-position";

/**
 * ═══════════ "CÒN BAO NHIÊU TIỀN" — VÀ KHI NÀO KHÔNG ĐƯỢC TRẢ LỜI ═══════════
 *
 * Câu hỏi đầu tiên của chủ shop mỗi sáng. Cách sai duy nhất mà bài kiểm này tồn tại để chặn: cộng
 * `sum(amount)` từ 0 rồi gọi đó là số dư. Phép cộng đó cho ra một con số trông hoàn hảo và sai
 * hàng trăm triệu, vì nó giả định tài khoản mở ra với 0đ VÀ ERP thấy đủ mọi giao dịch kể từ đó.
 *
 * Nên bốn điều được khoá ở đây đều thuộc loại "sai thì mất tiền":
 *   1. tài khoản CHƯA BAO GIỜ có số dư ngân hàng ⇒ `null`, KHÔNG phải 0, và không vào tổng;
 *   2. tổng chỉ là tổng của phần BIẾT ĐƯỢC, kèm cờ `complete` để màn hình nói ra điều đó;
 *   3. giao dịch mới hơn mốc số dư ⇒ suy ra (`DERIVED`) và PHẢI tự nhận là đã suy;
 *   4. chuỗi số dư đứt (thiếu / trùng giao dịch) phải bị NÊU RA, không được lặng lẽ cộng tiếp.
 *
 * Dữ liệu đặt ở tháng 03/2027 với tiền tố `cp-` để không chạm fixture của bộ khác.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);

async function reset(db: Db) {
  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} like 'cp-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'cp-%'`);
  clearMemo();
}

export async function testCashPosition(db: Db) {
  await reset(db);

  await db.insert(schema.bankAccounts).values([
    { id: "cp-acc-confirmed", provider: "SEPAY", gateway: "MBBank", accountNumber: "1111222233", label: "MB chính", status: "ACTIVE" },
    { id: "cp-acc-derived", provider: "SEPAY", gateway: "ACB", accountNumber: "4444555566", label: "ACB phụ", status: "ACTIVE" },
    { id: "cp-acc-unknown", provider: "", gateway: "Vietcombank", accountNumber: "7777888899", label: "VCB sao kê tay", status: "ACTIVE" },
    { id: "cp-acc-disabled", provider: "", gateway: "TPBank", accountNumber: "1010101010", label: "TP đã đóng", status: "DISABLED" },
  ]);

  await db.insert(schema.bankTransactions).values([
    // ── Tài khoản 1: giao dịch mới nhất CÓ số dư ⇒ CONFIRMED, số dư 5.000.000 ──
    { id: "cp-t1", bankAccountId: "cp-acc-confirmed", txnAt: d("2027-03-01"), amount: 3_000_000, bankRef: "cp-r1", balanceAfter: 3_000_000, accountingGroup: "COD_SETTLEMENT" },
    { id: "cp-t2", bankAccountId: "cp-acc-confirmed", txnAt: d("2027-03-02"), amount: 2_000_000, bankRef: "cp-r2", balanceAfter: 5_000_000, accountingGroup: "COD_SETTLEMENT" },
    // ── Tài khoản 2: mốc số dư 1.000.000, rồi hai giao dịch KHÔNG có số dư ⇒ DERIVED ──
    { id: "cp-t3", bankAccountId: "cp-acc-derived", txnAt: d("2027-03-01"), amount: 1_000_000, bankRef: "cp-r3", balanceAfter: 1_000_000, accountingGroup: "SALES_REVENUE" },
    { id: "cp-t4", bankAccountId: "cp-acc-derived", txnAt: d("2027-03-03"), amount: -400_000, bankRef: "cp-r4", accountingGroup: "ADS_SPEND" },
    { id: "cp-t5", bankAccountId: "cp-acc-derived", txnAt: d("2027-03-04"), amount: 250_000, bankRef: "cp-r5", accountingGroup: "UNCLASSIFIED" },
    // ── Tài khoản 3: có tiền vào ra nhưng KHÔNG dòng nào có số dư ⇒ UNKNOWN ──
    { id: "cp-t6", bankAccountId: "cp-acc-unknown", txnAt: d("2027-03-02"), amount: 9_000_000, bankRef: "cp-r6", accountingGroup: "SALES_REVENUE" },
    { id: "cp-t7", bankAccountId: "cp-acc-unknown", txnAt: d("2027-03-05"), amount: -1_000_000, bankRef: "cp-r7", accountingGroup: "UNCLASSIFIED" },
    // ── Tài khoản 4 (ngừng dùng): CÓ số dư thật, nhưng không được vào tổng ──
    { id: "cp-t8", bankAccountId: "cp-acc-disabled", txnAt: d("2027-03-02"), amount: 800_000, bankRef: "cp-r8", balanceAfter: 800_000, accountingGroup: "SALES_REVENUE" },
  ]);

  clearMemo();
  const pos = await getCashPosition();
  const byId = new Map(pos.accounts.map((a) => [a.accountId, a]));
  const confirmed = byId.get("cp-acc-confirmed")!;
  const derived = byId.get("cp-acc-derived")!;
  const unknown = byId.get("cp-acc-unknown")!;
  const disabled = byId.get("cp-acc-disabled")!;

  // ═══ 1. SỐ DƯ NGÂN HÀNG GHI — không qua phép cộng nào của ERP ═══
  assert.equal(confirmed.confidence, "CONFIRMED", "1. giao dịch mới nhất có số dư ⇒ ngân hàng ghi");
  assert.equal(confirmed.balance, 5_000_000, "1. lấy đúng số dư của giao dịch mới nhất, không cộng lại từ đầu");
  assert.equal(confirmed.derivedFrom, 0, "1. không có giao dịch nào phải cộng thêm");

  // ═══ 2. SUY RA THÌ PHẢI TỰ NHẬN LÀ ĐÃ SUY ═══
  assert.equal(derived.confidence, "DERIVED", "2. còn giao dịch mới hơn mốc số dư ⇒ là số suy ra");
  assert.equal(derived.balance, 850_000, "2. mốc 1.000.000 − 400.000 + 250.000 = 850.000");
  assert.equal(derived.derivedFrom, 2, "2. nói rõ đã cộng thêm bao nhiêu giao dịch — để người đọc tự định giá độ tin");

  // ═══ 3. CHƯA BIẾT LÀ NULL, KHÔNG PHẢI 0 — LUẬT KHÔNG THƯƠNG LƯỢNG ═══
  /*
    Đây là assertion quan trọng nhất của cả tệp. Tài khoản này có 8.000.000 đồng đi qua
    (9.000.000 − 1.000.000). Cộng dồn từ 0 sẽ ra "số dư 8.000.000" — một con số hoàn toàn bịa,
    vì không ai biết tài khoản có bao nhiêu TRƯỚC giao dịch đầu tiên mà ERP nhìn thấy.
  */
  assert.equal(unknown.balance, null, "3. chưa bao giờ có số dư ngân hàng ⇒ CHƯA BIẾT");
  assert.equal(unknown.confidence, "UNKNOWN", "3. và phải nói thẳng là chưa biết");
  assert.notEqual(unknown.balance, 8_000_000, "3. TUYỆT ĐỐI không cộng dồn từ 0 để bịa ra số dư");
  assert.equal(unknown.txnCount, 2, "3. vẫn đếm đủ giao dịch — chưa biết số dư không có nghĩa là không có dữ liệu");

  // ═══ 4. TỔNG LÀ TỔNG CỦA PHẦN BIẾT ĐƯỢC, VÀ NÓI RA RẰNG NÓ CHƯA ĐỦ ═══
  assert.equal(pos.total, 5_850_000, "4. chỉ cộng hai tài khoản biết được số dư (5.000.000 + 850.000)");
  assert.equal(pos.knownAccounts, 2, "4. hai tài khoản biết được");
  assert.equal(pos.unknownAccounts, 1, "4. một tài khoản chưa biết (ngừng dùng không nằm trong phép đếm này)");
  assert.equal(pos.complete, false, "4. còn tài khoản chưa biết ⇒ tổng là CẬN DƯỚI, màn hình phải nói ra");

  // ═══ 5. TÀI KHOẢN NGỪNG DÙNG: ngoài tổng, trong danh sách ═══
  assert.equal(disabled.balance, 800_000, "5. vẫn đọc được số dư — tiền ở đó là thật");
  assert.ok(!pos.total || pos.total === 5_850_000, "5. nhưng KHÔNG được cộng vào tiền hiện có");
  assert.ok(byId.has("cp-acc-disabled"), "5. và không được ẩn khỏi danh sách — tiền biến mất khỏi màn hình là tệ hơn");

  // ═══ 6. BẤT BIẾN CHUỖI SỐ DƯ: thiếu / trùng giao dịch phải bị nêu ra ═══
  assert.equal(pos.chainBreaks, 0, "6. dữ liệu trên đang liền mạch");
  /*
    Giờ chèn một giao dịch có số dư KHÔNG khớp bước nhảy: số dư nhảy từ 5.000.000 lên 9.000.000
    trong khi số tiền chỉ 1.000.000. Nghĩa là có 3.000.000 đã đi qua tài khoản mà sổ KHÔNG thấy.
    Lặng lẽ cộng tiếp là cách mọi con số tiền phía sau sai mà không ai biết.
  */
  await db.insert(schema.bankTransactions).values({
    id: "cp-t9", bankAccountId: "cp-acc-confirmed", txnAt: d("2027-03-06"), amount: 1_000_000, bankRef: "cp-r9", balanceAfter: 9_000_000, accountingGroup: "SALES_REVENUE",
  });
  clearMemo();
  const sau = await getCashPosition();
  const vo = sau.accounts.find((a) => a.accountId === "cp-acc-confirmed")!;
  assert.equal(vo.chainBreaks, 1, "6. bước nhảy số dư không bằng số tiền ⇒ nêu ra đúng một chỗ đứt");
  assert.ok(sau.chainBreaks >= 1, "6. tổng toàn sổ cũng phải thấy");
  assert.equal(vo.balance, 9_000_000, "6. vẫn lấy số dư ngân hàng ghi — ERP không tự sửa số của ngân hàng, chỉ nêu nghi vấn");

  // ═══ 7. GIAO DỊCH CHƯA PHÂN LOẠI ĐẾM THEO TỪNG TÀI KHOẢN ═══
  assert.equal(sau.accounts.find((a) => a.accountId === "cp-acc-derived")!.unclassified, 1, "7. đếm đúng dòng chưa phân loại của tài khoản này");

  // ═══ 8. SỐ DƯ TẠI MỘT MỐC — để dòng tiền có đầu kỳ / cuối kỳ thật ═══
  const dauKy = await balanceAsOf(d("2027-03-02"));
  /*
    Tới hết 02/03: tài khoản 1 có mốc 5.000.000 (giao dịch cp-t2), tài khoản 2 có mốc 1.000.000.
    Tài khoản 3 chưa có mốc nào nên không vào tổng; tài khoản ngừng dùng bị loại.
  */
  assert.equal(dauKy.balance, 6_000_000, "8. số dư tại mốc chỉ gộp các tài khoản có mốc số dư trước thời điểm đó");
  assert.equal(dauKy.knownAccounts, 2, "8. hai tài khoản có mốc");

  const truocKhiCoDuLieu = await balanceAsOf(d("2027-02-01"));
  assert.equal(truocKhiCoDuLieu.balance, null, "8. trước khi có bất kỳ mốc số dư nào ⇒ CHƯA BIẾT, không phải 0đ");
  assert.equal(truocKhiCoDuLieu.confidence, "UNKNOWN", "8. và nói thẳng là chưa biết");

  await reset(db);
  console.log("✓ Tiền hiện có: số dư ngân hàng ghi / ERP suy ra / chưa biết tách bạch · chưa biết là NULL không phải 0 · tài khoản ngừng dùng ngoài tổng · chuỗi số dư đứt bị nêu");
}
