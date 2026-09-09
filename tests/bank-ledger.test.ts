import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { BANK_GROUPS, BANK_GROUP_SPEC, canPostToExpenses, postBlockedReason } from "@/lib/constants/bank";
import { COST_AUTHORITY, ECONOMIC_COSTS, EXPENSE_CATEGORIES_NOT_OWNED, EXPENSE_CATEGORY_ECONOMIC, expensesOwnCategory } from "@/lib/constants/cost-sources";
import { matchRule, ruleMatches, ruleMayOverwrite, type BankRuleLike } from "@/lib/integrations/bank/rules";
import { bankRefFor, dedupeByRef, LEDGER_TO_BANK_GROUP, statementInstant, toBankRow } from "@/lib/integrations/bank/statement";
import { parseLedger } from "@/lib/integrations/bank/ledger";
import { bankByGroup, bankSummary, listBankTransactions, unclassifiedBankCount } from "@/lib/queries/bank";
import { parseListParams, type Period } from "@/lib/search-params";

/**
 * ═══════ SỔ GIAO DỊCH NGÂN HÀNG ═══════
 *
 * Ba thứ phải đúng, và cả ba đều là loại lỗi "không ai nhìn ra bằng mắt":
 *  1. GIỜ — sao kê ghi giờ VN, lưu nhầm thành UTC thì giao dịch buổi chiều nhảy sang ngày hôm sau;
 *  2. KHOÁ TỰ NHIÊN — tải lại sao kê chồng lấn không được nhân đôi dòng tiền;
 *  3. LUẬT MỘT NGUỒN — khoản đã vào lợi nhuận từ nguồn khác không được trừ thêm lần nữa.
 */

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

const CSV = [
  "Ngày,Giờ,Tiền vào,Tiền ra,Nội dung,Đối tác,Mã GD,Mã danh mục",
  "03/09/2026,15:34,,6000000,CUSTOMER HO KHAC TRUYEN chuyen tien,TRAN ANH QUAN,FT26246948262000,",
  "03/09/2026,12:56,,34400000,CUSTOMER Mr T chuyen khoan nhanh qua Zalo,NGUYEN THI MINH HUONG,FT26246032875386,THUE_MAT_BANG",
  "03/09/2026,12:39,51329620,,Tong cong ty co phan Buu chinh Viettel VTP,TONG CONG TY CO PHAN BUU CHINH VIETTEL,FT26246148832693,THU_COD",
  "03/09/2026,09:25,,1000000,CUSTOMER HO KHAC TRUYEN chuyen tien,HO KHAC TRUYEN,FT26246053060000,CHUYEN_NOI_BO",
  "01/09/2026,17:03,,2366200,CUSTOMER THU NO THE TIN DUNG,,FT26244844440634,TRA_NO_GOC",
].join("\n");

export async function testBankLedger(db: Db) {
  // ══ 1. GIỜ VIỆT NAM ══
  // 03/09/2026 15:34 giờ VN = 08:34Z cùng ngày. Đọc như UTC sẽ ra 15:34Z và khi hiện lại theo lịch
  // VN thành 22:34 — chưa sai ngày. Nhưng 23:30 giờ VN đọc như UTC sẽ hiện thành 06:30 NGÀY HÔM SAU,
  // và một giao dịch cuối tháng nhảy hẳn sang kỳ sau.
  const chieu = statementInstant({ date: "2026-09-03", time: "15:34" });
  assert.equal(chieu.toISOString(), "2026-09-03T08:34:00.000Z", "1. 15:34 giờ VN = 08:34Z");
  const khuya = statementInstant({ date: "2026-09-30", time: "23:30" });
  assert.equal(khuya.toISOString(), "2026-09-30T16:30:00.000Z", "1. 23:30 ngày cuối tháng vẫn thuộc tháng 9 theo giờ VN");
  assert.equal(statementInstant({ date: "2026-09-03", time: "" }).toISOString(), "2026-09-02T17:00:00.000Z", "1. thiếu giờ ⇒ 00:00 giờ VN, KHÔNG phải 00:00 UTC");

  // ══ 2. KHOÁ TỰ NHIÊN & CHỐNG TRÙNG ══
  const txns = parseLedger(CSV);
  assert.equal(txns.length, 5, "2. đọc đủ 5 dòng CSV");
  const rows = txns.map(toBankRow);
  assert.equal(rows[0].bankRef, "FT26246948262000", "2. có mã GD thì dùng thẳng làm khoá");
  const khongMa = bankRefFor({ ...txns[0], bankRef: "" });
  assert.ok(khongMa.startsWith("NOREF:2026-09-03:"), "2. không có mã GD thì dựng khoá từ ngày + giờ + tiền + nội dung");
  assert.equal(khongMa, bankRefFor({ ...txns[0], bankRef: "" }), "2. cùng một dòng luôn cho cùng một khoá");
  assert.notEqual(khongMa, bankRefFor({ ...txns[0], bankRef: "", amount: -7_000_000 }), "2. khác số tiền ⇒ khác khoá");

  const gop = dedupeByRef([...rows, rows[0], rows[1]]);
  assert.equal(gop.rows.length, 5, "2. dòng trùng khoá ngay trong file bị gộp");
  assert.equal(gop.duplicates, 2, "2. đếm đúng số dòng trùng để báo lại cho người dùng");

  // ══ 3. GỢI Ý NHÓM TỪ MÃ DANH MỤC ══
  assert.equal(rows[1].accountingGroup, "RENT_UTILITIES", "3. THUE_MAT_BANG ⇒ Mặt bằng · điện nước");
  assert.equal(rows[2].accountingGroup, "COD_SETTLEMENT", "3. THU_COD ⇒ tiền COD ĐVVC trả về");
  assert.equal(rows[3].accountingGroup, "INTERNAL_TRANSFER", "3. CHUYEN_NOI_BO ⇒ chuyển giữa tài khoản của mình");
  assert.equal(rows[4].accountingGroup, "LOAN_PRINCIPAL", "3. TRA_NO_GOC ⇒ trả nợ gốc");
  assert.equal(rows[0].accountingGroup, "UNCLASSIFIED", "3. KHÔNG đoán bừa khi sao kê không có mã danh mục");
  assert.equal(LEDGER_TO_BANK_GROUP["MA_LA_KHONG_CO_THAT"], undefined, "3. mã lạ không có trong bảng ⇒ để chưa phân loại");
  assert.equal(rows[0].amount, -6_000_000, "3. tiền ra lưu số ÂM");
  assert.equal(rows[2].amount, 51_329_620, "3. tiền vào lưu số DƯƠNG");

  // ══ 4. LUẬT MỘT NGUỒN — CHỐNG TRỪ HAI LẦN ══
  assert.equal(canPostToExpenses("RENT_UTILITIES"), true, "4. mặt bằng: bảng Chi phí có thẩm quyền ⇒ đẩy được");
  assert.equal(canPostToExpenses("OTHER_EXPENSE"), true, "4. chi phí khác đẩy được");
  assert.equal(canPostToExpenses("ADS_SPEND"), false, "4. quảng cáo đã có từ tài khoản QC ⇒ KHÔNG đẩy");
  assert.equal(canPostToExpenses("PURCHASE"), false, "4. tiền hàng đã nằm trong giá vốn ⇒ KHÔNG đẩy");
  assert.equal(canPostToExpenses("SHIPPING_FEE"), false, "4. cước đã tính theo vận đơn ⇒ KHÔNG đẩy");
  assert.equal(canPostToExpenses("SALES_REVENUE"), false, "4. doanh thu không phải chi phí");
  assert.equal(canPostToExpenses("INTERNAL_TRANSFER"), false, "4. chuyển nội bộ không ảnh hưởng lãi lỗ");
  for (const g of ["ADS_SPEND", "PURCHASE", "SHIPPING_FEE", "RETURN_FEE"] as const) {
    assert.ok((postBlockedReason(g) ?? "").includes("hai lần"), `4. ${g} phải nói RÕ vì sao bị chặn, không im lặng`);
  }
  assert.equal(postBlockedReason("RENT_UTILITIES"), null, "4. nhóm đẩy được thì không có lý do chặn");

  // Mỗi loại chi phí kinh tế có ĐÚNG MỘT nguồn có thẩm quyền — không được để trống.
  for (const cost of ECONOMIC_COSTS) assert.ok(COST_AUTHORITY[cost], `4. ${cost} phải khai nguồn có thẩm quyền`);
  assert.deepEqual(
    [...EXPENSE_CATEGORIES_NOT_OWNED].sort(),
    ["ADS", "PURCHASE", "RETURN_FEE", "SHIPPING"].sort(),
    "4. bảng Chi phí KHÔNG có thẩm quyền với quảng cáo, tiền hàng, cước và phí hoàn",
  );
  assert.equal(expensesOwnCategory("SALARY"), true, "4. lương: bảng Chi phí là đường DUY NHẤT đưa vào lợi nhuận hôm nay");
  assert.equal(EXPENSE_CATEGORY_ECONOMIC.PURCHASE, "COGS", "4. nhập hàng là giá vốn, không phải chi phí vận hành");

  // Mọi nhóm đều phải khai đủ hợp đồng — thiếu một trường là một chỗ số liệu đi lạc mà không ai biết.
  for (const g of BANK_GROUPS) {
    const spec = BANK_GROUP_SPEC[g];
    assert.ok(spec.label && spec.hint, `4. nhóm ${g} phải có nhãn và giải thích`);
    if (spec.pnl.kind === "EXPENSE") assert.ok(spec.authority, `4. nhóm chi phí ${g} phải khai nguồn có thẩm quyền`);
    if (spec.pnl.kind === "NONE" && g !== "UNCLASSIFIED") assert.equal(spec.authority, null, `4. nhóm ${g} không vào lãi lỗ thì không có nguồn thẩm quyền`);
  }

  // ══ 5. QUY TẮC GÁN NHÃN ══
  const base: BankRuleLike = {
    id: "r1", name: "Thuê mặt bằng", priority: 100, direction: "OUT",
    matchCounterparty: "NGUYEN THI MINH HUONG", matchDescription: "", minAmount: 0, maxAmount: 0,
    accountingGroup: "RENT_UTILITIES", categoryCode: "", enabled: true,
  };
  const chi = { amount: -34_400_000, counterparty: "NGUYEN THI MINH HUONG", description: "chuyen khoan nhanh qua Zalo" };
  assert.equal(ruleMatches(base, chi), true, "5. khớp theo tên đối tác");
  assert.equal(ruleMatches(base, { ...chi, amount: 34_400_000 }), false, "5. quy tắc chiều RA không khớp tiền vào");
  assert.equal(ruleMatches({ ...base, enabled: false }, chi), false, "5. quy tắc đang tắt không khớp gì");
  // Bỏ dấu + không phân biệt hoa thường: sao kê lúc có dấu lúc không, người viết quy tắc thì gõ tự nhiên.
  assert.equal(ruleMatches({ ...base, matchCounterparty: "nguyễn thị minh hương" }, chi), true, "5. khớp bất kể dấu và hoa thường");
  // Khoảng tiền theo TRỊ TUYỆT ĐỐI — nếu so số âm thì mọi khoản chi đều nhỏ hơn mọi ngưỡng dương.
  assert.equal(ruleMatches({ ...base, matchCounterparty: "", minAmount: 30_000_000 }, chi), true, "5. lọc theo trị tuyệt đối của số tiền");
  assert.equal(ruleMatches({ ...base, matchCounterparty: "", minAmount: 40_000_000 }, chi), false, "5. dưới ngưỡng thì không khớp");
  assert.equal(ruleMatches({ ...base, matchCounterparty: "", maxAmount: 10_000_000 }, chi), false, "5. vượt trần thì không khớp");
  // Hai điều kiện chữ là VÀ, không phải HOẶC.
  assert.equal(ruleMatches({ ...base, matchDescription: "khong co trong noi dung" }, chi), false, "5. khai cả hai ô thì phải khớp cả hai");
  assert.equal(ruleMatches({ ...base, matchCounterparty: "", matchDescription: "", minAmount: 0, maxAmount: 0 }, chi), false, "5. quy tắc rỗng KHÔNG được khớp mọi dòng");

  // Quy tắc đầu tiên (ưu tiên nhỏ hơn) thắng — không cộng dồn nhiều quy tắc lên một dòng.
  const hep: BankRuleLike = { ...base, id: "r0", name: "Cụ thể hơn", priority: 10, accountingGroup: "SOFTWARE" };
  assert.equal(matchRule([base, hep], chi)?.group, "SOFTWARE", "5. quy tắc ưu tiên nhỏ hơn thắng");
  assert.equal(matchRule([hep, base], chi)?.group, "SOFTWARE", "5. kết quả không phụ thuộc thứ tự trong mảng");
  assert.equal(matchRule([{ ...base, accountingGroup: "NHOM_KHONG_TON_TAI" }], chi), null, "5. quy tắc trỏ tới nhóm không tồn tại thì bỏ qua, không ném lỗi");
  assert.equal(matchRule([], chi), null, "5. không có quy tắc nào ⇒ null");

  // Bảo vệ công sức phân loại tay: quy tắc chỉ được đụng dòng chưa ai sửa.
  assert.equal(ruleMayOverwrite(""), true, "5. dòng chưa ai phân loại");
  assert.equal(ruleMayOverwrite("rule"), true, "5. dòng do quy tắc gán lần trước thì chạy lại được");
  assert.equal(ruleMayOverwrite("chu@shop.vn"), false, "5. dòng người đã sửa tay là BẤT KHẢ XÂM PHẠM");

  // ══ 6. TRUY VẤN TRÊN CSDL THẬT ══
  await db.insert(schema.bankTransactions).values(
    rows.map((r, idx) => ({ ...r, id: `bank-test-${idx}`, source: "IMPORT" as const })),
  );
  const params = parseListParams({ period: "all" }, { defaultPeriod: "all", defaultPageSize: 50 });
  const list = await listBankTransactions(params, { direction: "ANY", onlyUnclassified: false });
  assert.equal(list.total, 5, "6. đọc lại đủ 5 giao dịch");
  const chiRa = await listBankTransactions(params, { direction: "OUT", onlyUnclassified: false });
  assert.equal(chiRa.total, 4, "6. lọc chiều tiền ra");
  const chuaPhanLoai = await listBankTransactions(params, { direction: "ANY", onlyUnclassified: true });
  assert.equal(chuaPhanLoai.total, 1, "6. đúng 1 dòng chưa phân loại");

  const tong = await bankSummary(params, { direction: "ANY", onlyUnclassified: false });
  assert.equal(tong.moneyIn, 51_329_620, "6. tổng tiền vào thô");
  assert.equal(tong.moneyOut, 6_000_000 + 34_400_000 + 1_000_000 + 2_366_200, "6. tổng tiền ra thô");
  // Chuyển nội bộ 1.000.000 và trả nợ gốc 2.366.200 KHÔNG phải dòng tiền kinh doanh.
  assert.equal(tong.businessOut, 6_000_000 + 34_400_000, "6. tiền ra kinh doanh loại chuyển nội bộ và trả nợ gốc");
  assert.ok(tong.businessOut < tong.moneyOut, "6. loại đúng các nhóm không phải dòng tiền kinh doanh");
  assert.equal(tong.unclassified, 1, "6. đếm dòng chưa phân loại");
  assert.equal(await unclassifiedBankCount(), 1, "6. huy hiệu tab đếm đúng");

  const nhom = await bankByGroup(ALL);
  const rent = nhom.find((g) => g.group === "RENT_UTILITIES");
  assert.equal(rent?.moneyOut, 34_400_000, "6. gộp theo nhóm kế toán đúng số");
  assert.equal(nhom.reduce((t, g) => t + g.count, 0), 5, "6. mọi giao dịch đều thuộc đúng một nhóm");

  // Nhập lại chồng lấn: cùng mã GD ⇒ KHÔNG nhân đôi dòng tiền.
  await db
    .insert(schema.bankTransactions)
    .values(rows.map((r, idx) => ({ ...r, id: `bank-test-again-${idx}`, source: "IMPORT" as const })))
    .onConflictDoUpdate({ target: schema.bankTransactions.bankRef, set: { description: sql`excluded.description` } });
  const sauKhiNhapLai = await bankSummary(params, { direction: "ANY", onlyUnclassified: false });
  assert.equal(sauKhiNhapLai.count, 5, "6. nhập lại cùng sao kê KHÔNG tạo thêm dòng");
  assert.equal(sauKhiNhapLai.moneyOut, tong.moneyOut, "6. nhập lại KHÔNG nhân đôi tiền ra");

  // Nhãn người dùng đã gán phải sống sót qua lần nhập lại.
  await db.update(schema.bankTransactions).set({ accountingGroup: "PACKAGING", classifiedBy: "chu@shop.vn" }).where(eq(schema.bankTransactions.bankRef, "FT26246948262000"));
  await db
    .insert(schema.bankTransactions)
    .values([{ ...rows[0], id: "bank-test-third", source: "IMPORT" as const }])
    .onConflictDoUpdate({ target: schema.bankTransactions.bankRef, set: { description: sql`excluded.description` } });
  const [giuNhan] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankRef, "FT26246948262000"));
  assert.equal(giuNhan.accountingGroup, "PACKAGING", "6. nhập lại sao kê KHÔNG xoá phân loại người dùng đã làm");
  assert.equal(giuNhan.classifiedBy, "chu@shop.vn", "6. giữ nguyên người đã phân loại");

  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} like 'bank-test-%'`);

  console.log("✓ Sổ ngân hàng: giờ VN đúng · nhập lại chồng lấn không nhân đôi và không xoá nhãn tay · chuyển nội bộ/trả gốc không tính vào dòng tiền kinh doanh · quy tắc không ghi đè phân loại tay");
  console.log("✓ Luật một nguồn: quảng cáo / tiền hàng / cước / phí hoàn KHÔNG đẩy được sang bảng Chi phí và nói rõ vì sao — chặn trừ hai lần ngay ở hợp đồng");
}
