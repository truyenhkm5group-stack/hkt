import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { BANK_CASH_CLASSES, BANK_GROUPS, BANK_GROUP_SPEC, BANK_LINK_TYPES, isBusinessCash } from "@/lib/constants/bank";
import { COST_AUTHORITY, ECONOMIC_COSTS, EXPENSE_CATEGORIES_NOT_OWNED, EXPENSE_CATEGORY_ECONOMIC, expensesOwnCategory } from "@/lib/constants/cost-sources";
import { matchRule, ruleMatches, ruleMayOverwrite, type BankRuleLike } from "@/lib/integrations/bank/rules";
import { bankRefFor, dedupeByRef, LEDGER_TO_BANK_GROUP, statementInstant, toBankRow } from "@/lib/integrations/bank/statement";
import { importStatementRows } from "@/lib/integrations/bank/statement-import";
import { normalizeBankRef } from "@/lib/integrations/bank/sepay";
import * as XLSX from "xlsx";
import { parseCsv, parseLedger } from "@/lib/integrations/bank/ledger";
import { parseLedgerFile } from "@/lib/integrations/bank/statement-file";
import { bankByGroup, bankReconciliation, bankSummary, listBankTransactions, unclassifiedBankCount } from "@/lib/queries/bank";
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
  // CÙNG KHOÁ VỚI WEBHOOK: file ghi " ft26246948262000 " và SePay gửi "FT26246948262000" là MỘT bút toán.
  // Bản trước chỉ trim() ⇒ hai dòng, một giao dịch đếm hai lần, lưới match_key chỉ nêu chứ không gộp.
  assert.equal(bankRefFor({ ...txns[0], bankRef: " ft26246948262000 " }), "FT26246948262000", "2. mã bút toán trong file chuẩn hoá y hệt webhook");
  assert.equal(bankRefFor({ ...txns[0], bankRef: " ft26246948262000 " }), normalizeBankRef("FT26246948262000"), "2. cùng hàm chuẩn hoá với đường SePay");
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

  // ══ 4. RANH GIỚI CỨNG: SAO KÊ LÀ TIỀN, KHÔNG PHẢI CHI PHÍ ══
  //
  // Nhóm kế toán chỉ quyết định LOẠI DÒNG TIỀN. Không có nhóm nào tạo ra một khoản chi trong lãi lỗ:
  // trả lương ngày 05/10 là tiền ra ngày 05/10, nhưng chi phí lương thuộc kỳ hưởng lợi ích.
  for (const g of BANK_GROUPS) {
    const spec = BANK_GROUP_SPEC[g];
    assert.ok(spec.label && spec.hint, `4. nhóm ${g} phải có nhãn và giải thích`);
    assert.ok(BANK_CASH_CLASSES.includes(spec.cashClass), `4. nhóm ${g} phải khai loại dòng tiền`);
    assert.ok(spec.linkTo === null || BANK_LINK_TYPES.includes(spec.linkTo), `4. nhóm ${g} khai sai loại chứng từ đối chiếu`);
    // Không còn khái niệm "đẩy sang chi phí" — kiểm ở mức kiểu dữ liệu để không ai thêm lại.
    assert.equal("pnl" in spec, false, `4. nhóm ${g} KHÔNG được mang ảnh hưởng lãi lỗ`);
    assert.equal("authority" in spec, false, `4. nhóm ${g} KHÔNG được mang thẩm quyền chi phí`);
  }
  assert.equal(BANK_GROUP_SPEC.ADS_SPEND.cashClass, "BUSINESS_OUTFLOW", "4. chi quảng cáo là tiền ra kinh doanh");
  assert.equal(BANK_GROUP_SPEC.ADS_SPEND.linkTo, "AD_SPEND", "4. đối chiếu với chi tiêu QC, không tạo chi phí mới");
  assert.equal(BANK_GROUP_SPEC.PURCHASE.linkTo, "STOCK_RECEIPT", "4. tiền hàng đối chiếu với phiếu nhập");
  assert.equal(BANK_GROUP_SPEC.COD_SETTLEMENT.linkTo, "COD_BATCH", "4. tiền COD đối chiếu với đợt nhận tiền");
  assert.equal(isBusinessCash("INTERNAL_TRANSFER"), false, "4. chuyển nội bộ không phải dòng tiền kinh doanh");
  assert.equal(isBusinessCash("LOAN_PRINCIPAL"), false, "4. trả nợ gốc không phải dòng tiền kinh doanh");
  assert.equal(isBusinessCash("OWNER_DRAW"), false, "4. rút vốn không phải dòng tiền kinh doanh");
  // CHƯA PHÂN LOẠI LÀ CHƯA BIẾT. Cộng nó vào "kinh doanh" là trình bày cái chưa ai xem xét như cái đã
  // xác nhận; nó phải được ĐẾM RIÊNG và hiện cạnh tổng (xem nhóm 6 bên dưới), không lẫn, không mất.
  assert.equal(isBusinessCash("UNCLASSIFIED"), false, "4. chưa phân loại KHÔNG được tính là dòng tiền kinh doanh — nó là CHƯA BIẾT");

  // Hợp đồng thẩm quyền chi phí sống ở nơi khác và KHÔNG dính vào sổ ngân hàng.
  for (const cost of ECONOMIC_COSTS) assert.ok(COST_AUTHORITY[cost], `4. ${cost} phải khai nguồn có thẩm quyền`);
  assert.deepEqual(
    [...EXPENSE_CATEGORIES_NOT_OWNED].sort(),
    ["ADS", "PURCHASE", "RETURN_FEE", "SHIPPING"].sort(),
    "4. bảng Chi phí KHÔNG có thẩm quyền với quảng cáo, tiền hàng, cước và phí hoàn",
  );
  assert.equal(expensesOwnCategory("SALARY"), true, "4. lương: bảng Chi phí vẫn là nguồn dự phòng hợp lệ");
  assert.equal(EXPENSE_CATEGORY_ECONOMIC.PURCHASE, "COGS", "4. nhập hàng là giá vốn, không phải chi phí vận hành");

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
  // Chuyển nội bộ 1.000.000 và trả nợ gốc 2.366.200 KHÔNG phải dòng tiền kinh doanh; 6.000.000 CHƯA
  // PHÂN LOẠI cũng không được cộng vào — nó đứng riêng ở `unclassified` / `unclassifiedAmount`.
  assert.equal(tong.businessOut, 34_400_000, "6. tiền ra kinh doanh loại chuyển nội bộ, trả nợ gốc VÀ dòng chưa phân loại");
  assert.ok(tong.businessOut < tong.moneyOut, "6. loại đúng các nhóm không phải dòng tiền kinh doanh");
  assert.equal(tong.unclassified, 1, "6. đếm dòng chưa phân loại");
  assert.equal(tong.unclassifiedAmount, 6_000_000, "6. số tiền chưa phân loại hiện RIÊNG cạnh tổng — không lẫn vào, không mất");
  assert.equal(tong.businessOut + tong.unclassifiedAmount + 1_000_000 + 2_366_200, tong.moneyOut, "6. kinh doanh + chưa phân loại + không-kinh-doanh = toàn bộ tiền ra: không đồng nào rơi mất");
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

  /**
   * ───────── 6b. NHẬP SAO KÊ KHÔNG VIẾT LẠI CHỨNG TỪ ĐÃ CÓ ─────────
   *
   * Bản trước `ON CONFLICT … SET amount, txn_at`: một sao kê tải nhầm viết lại số tiền của dòng
   * webhook đã nối chứng từ, mối nối thành nối vượt mà không ai thấy. Và 80 dòng IMPORT trên
   * production (13/09/2026) không biết mình thuộc tài khoản nào.
   */
  await db.insert(schema.bankAccounts).values([
    { id: "bank-test-acc-a", provider: "", gateway: "MBBank", accountNumber: "9990009999", label: "MB kiểm thử", status: "ACTIVE" },
    { id: "bank-test-acc-b", provider: "", gateway: "ACB", accountNumber: "9990008888", label: "ACB kiểm thử", status: "ACTIVE" },
  ]);
  const lanMot = await importStatementRows(db, [...rows, { ...rows[0], bankRef: "BANK-TEST-NEW", amount: -123_000, description: "dong moi" }], { bankAccountId: "bank-test-acc-a", filename: "sao-ke-thang-9.csv" });
  assert.equal(lanMot.inserted, 1, "6b. chỉ dòng mới được chèn");
  assert.equal(lanMot.updated, 5, "6b. năm dòng đã có chỉ được làm giàu, không tạo thêm");
  assert.equal(lanMot.conflicts.length, 0, "6b. cùng số tiền thì không có mâu thuẫn");
  const [gan] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankRef, "FT26246948262000"));
  assert.equal(gan.bankAccountId, "bank-test-acc-a", "6b. dòng đã có nay biết mình thuộc tài khoản nào (chỉ điền khi trước đó chưa biết)");
  assert.equal(gan.lastSeenSource, "IMPORT", "6b. ghi đường vào gần nhất");
  assert.equal((gan.seenSources as unknown[]).length, 1, "6b. provenance có đúng một mục cho lượt nhập này");
  assert.equal((gan.seenSources as { ref: string }[])[0]?.ref, "sao-ke-thang-9.csv", "6b. mục provenance mang tên tệp để truy nguyên");
  assert.equal(gan.accountingGroup, "PACKAGING", "6b. nhãn người dùng đã gán vẫn sống sót");
  const [moi] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankRef, "BANK-TEST-NEW"));
  assert.equal(moi.bankAccountId, "bank-test-acc-a", "6b. dòng mới gắn đúng tài khoản người nhập chọn");
  assert.equal(moi.source, "IMPORT");

  // File nói KHÁC số tiền ⇒ giữ dòng cũ, KHÔNG ghi đè, và mâu thuẫn được nêu ra.
  const lanHai = await importStatementRows(db, [{ ...rows[0], amount: -7_000_000, description: "so tien bi sua" }], { bankAccountId: "bank-test-acc-a", filename: "sao-ke-sai.csv" });
  assert.equal(lanHai.inserted + lanHai.updated, 0, "6b. dòng lệch số tiền không được ghi");
  assert.equal(lanHai.conflicts.length, 1, "6b. mâu thuẫn được đếm");
  assert.equal(lanHai.conflicts[0].reason, "AMOUNT_MISMATCH");
  assert.equal(lanHai.conflicts[0].existingAmount, -6_000_000, "6b. nói rõ sổ đang có bao nhiêu");
  assert.equal(lanHai.conflicts[0].incomingAmount, -7_000_000, "6b. và file nói bao nhiêu");
  assert.ok(lanHai.warnings.some((w) => /không ghi đè/i.test(w)), "6b. kết quả mang cảnh báo cho người nhập");
  const [giuNguyen] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankRef, "FT26246948262000"));
  assert.equal(giuNguyen.amount, -6_000_000, "6b. số tiền trong sổ KHÔNG bị viết lại");
  assert.equal(giuNguyen.description, gan.description, "6b. dòng mâu thuẫn không được làm giàu nửa vời");
  assert.equal((giuNguyen.seenSources as unknown[]).length, 1, "6b. lượt nhập bị từ chối không ghi provenance");

  // Cùng bút toán nhưng nhập cho tài khoản KHÁC ⇒ mâu thuẫn tài khoản, không lặng lẽ đổi tài khoản.
  const lanBa = await importStatementRows(db, [rows[0]], { bankAccountId: "bank-test-acc-b", filename: "sao-ke-acb.csv" });
  assert.equal(lanBa.conflicts.length, 1);
  assert.equal(lanBa.conflicts[0].reason, "ACCOUNT_MISMATCH", "6b. dòng đã thuộc tài khoản A không bị kéo sang B");
  const [vanA] = await db.select({ acc: schema.bankTransactions.bankAccountId }).from(schema.bankTransactions).where(eq(schema.bankTransactions.bankRef, "FT26246948262000"));
  assert.equal(vanA.acc, "bank-test-acc-a");

  // Không chọn tài khoản: vẫn ghi được (sổ có thể chưa có tài khoản nào) nhưng phải CẢNH BÁO.
  const khongTk = await importStatementRows(db, [{ ...rows[0], bankRef: "BANK-TEST-NOACC", amount: -1 }], { bankAccountId: null, filename: "x.csv" });
  assert.equal(khongTk.inserted, 1);
  assert.ok(khongTk.warnings.some((w) => /không gắn tài khoản/i.test(w)), "6b. nhập không tài khoản phải nói ra hậu quả");

  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.bankRef} in ('BANK-TEST-NEW', 'BANK-TEST-NOACC')`);
  await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} like 'bank-test-%'`);
  await db.delete(schema.bankAccounts).where(sql`${schema.bankAccounts.id} like 'bank-test-%'`);
  console.log("✓ Nhập sao kê: cùng khoá với webhook · dòng đã có không bị đổi số tiền (mâu thuẫn được nêu) · gắn tài khoản · provenance nối thêm");

  /**
   * ───────── SỔ RỖNG LÀ "CHƯA BIẾT", KHÔNG PHẢI "CHI 0đ" ─────────
   *
   * Đo trên production 10/09/2026: `bank_transactions` có **0 dòng** — shop chưa nhập sao kê lần nào.
   * Bảng đối soát khi đó hiện "tiền thật trên sao kê 0đ" và "chênh lệch −64.509.000đ" cho dòng quảng
   * cáo. Đó là báo động do THIẾU DỮ LIỆU, trình bày y hệt báo động do LỆCH SỔ — và người đọc không có
   * cách nào phân biệt.
   *
   * Luật 3 của `docs/business-rules/ORDER_OUTCOME.md`: NULL là CHƯA BIẾT, không phải 0.
   */
  const kyRong: Period = { key: "custom", from: new Date("2019-01-01T00:00:00+07:00"), to: new Date("2019-12-31T23:59:59+07:00"), label: "Kỳ không có sao kê", fromKey: "2019-01-01", toKey: "2019-12-31" };
  const doiSoatRong = await bankReconciliation(kyRong);
  assert.equal(doiSoatRong.hasBankData, false, "7. kỳ không có dòng sao kê nào phải được nhận biết là CHƯA NHẬP");
  for (const dong of doiSoatRong.lines) {
    assert.equal(dong.bankAmount, null, `7. ${dong.key}: chưa nhập sao kê thì tiền trên sao kê là CHƯA BIẾT (null), không phải 0`);
    assert.equal(dong.diff, null, `7. ${dong.key}: không có sao kê thì KHÔNG được bịa ra một khoảng lệch`);
  }

  // Và năm khoản mục phải cùng có mặt: cước và lương từng được TÍNH rồi bỏ đó không dùng, nên sao kê
  // có hai nhóm đó mà bảng đối soát vẫn im.
  assert.deepEqual(
    doiSoatRong.lines.map((l) => l.key).sort(),
    ["ads", "cod", "payroll", "purchase", "shipping"],
    "7. đối soát phải phủ đủ năm khoản mục sao kê có nhóm kế toán tương ứng",
  );

  console.log("✓ Sổ ngân hàng: giờ VN đúng · nhập lại chồng lấn không nhân đôi và không xoá nhãn tay · chuyển nội bộ/trả gốc không tính vào dòng tiền kinh doanh · quy tắc không ghi đè phân loại tay");
  console.log("✓ Ranh giới sao kê ↔ chi phí: nhóm kế toán chỉ quyết định LOẠI DÒNG TIỀN, không nhóm nào tạo khoản chi; đối chiếu bằng liên kết chứng từ");

  /**
   * ───────── 8. SAO KÊ CHÍNH THỨC NGÂN HÀNG GỬI ─────────
   *
   * SỰ CỐ THẬT (11/09/2026). Chủ shop tải sao kê MB Bank từ Internet Banking rồi nhập vào ERP; ERP
   * trả về đúng một câu "Không nhận ra cột Ngày / Tiền vào / Tiền ra trong CSV", và tệp .xlsx thì
   * không nhận. Bộ đọc cũ coi DÒNG ĐẦU TỆP là dòng tiêu đề — trong khi sao kê ngân hàng có 17 dòng
   * đầu thư (tên chủ tài khoản, số tài khoản, số dư đầu kỳ, lời chào song ngữ) trước bảng.
   *
   * Ba cái bẫy của định dạng này, cả ba đều im lặng:
   *  a) dòng tiêu đề nằm sâu trong tệp, và có HAI dòng (Việt rồi Anh);
   *  b) ngày và giờ nằm CHUNG một ô ("05/08/2026 14:08:08") — không có cột Giờ riêng;
   *  c) trình xuất CSV của MB ghi literal "37" vào MỌI ô trống. Lệch 37₫ mỗi dòng thì không ai
   *     nhìn ra bằng mắt, nhưng sổ sẽ không bao giờ khớp số dư ngân hàng.
   */
  const MB_SAO_KE = [
    ",,,,,,,,,",
    ",SỔ PHỤ CHI TIẾT KIÊM BÁO NỢ/BÁO CÓ,,,,,NGÂN HÀNG TMCP QUÂN ĐỘI,,,",
    "Tên khách hàng/ Customer name: HO KHAC TRUYEN,,,,,,,Tài khoản/ Account No: 9972165264,,",
    '"Số dư đầu kỳ/ Opening Balance: 2,154 VND",,,,,,,,,',
    ",,,,,,,,,",
    "Ngày giao dịch,Ngày hạch toán,Số bút toán,Phát sinh nợ,Phát sinh có,Số dư lũy kế,Nội dung,Đơn vị thụ hưởng/ Đơn vị chuyển,Tài khoản,Ngân hàng đối tác",
    "Transaction date,Accounting Date,Transaction No,Debit,Credit,Accumulated balance,Details,Beneficiary/Applicant,Account,Remitter Bank",
    '05/08/2026 14:08:08,05/08/2026,FT26217021601512,37,"3,122,361","3,124,515",Tong cong ty co phan Buu chinh Viet VTP GLMTQY05,TONG CONG TY CO PHAN BUU CHINH VIETTEL,0001092570236,MB',
    '10/08/2026 09:45:51,10/08/2026,FT26222139215282,"500,000",37,"2,624,515",CUSTOMER HO KHAC TRUYEN chuyen tien. DEN: HO KHAC TRUYEN,HO KHAC TRUYEN,000666126666,MB',
    '16/08/2026 01:21:02,15/08/2026,9972165264-20260815,37,139,"2,624,654","Tra lai tien gui, so TK: 9972165264-20260815",37,37,37',
    '11/09/2026 16:02:54,11/09/2026,FT26254097039000,"2,554,234",37,"70,420",CUSTOMER MBCT Mr T chuyen khoan nhanh qua Za lo,NGUYEN THANH LIEM,935977268234,TECHCOMBANK',
    'Tổng phát sinh trong kỳ / Total,,,"3,054,234","3,122,500",,,,,',
    '"Số dư cuối kỳ / Closing Balance: 70,420 VND",,,,,,,,,',
  ].join("\r\n");

  const mb = parseLedger(MB_SAO_KE);
  assert.equal(mb.length, 4, "8a. tìm được dòng tiêu đề nằm sâu trong tệp, bỏ dòng tiêu đề tiếng Anh và hai dòng tổng cuối");
  assert.equal(mb[0].bankRef, "FT26217021601512", "8a. đọc 'Số bút toán' làm mã giao dịch");
  assert.equal(mb[0].counterparty, "TONG CONG TY CO PHAN BUU CHINH VIETTEL", "8a. đọc 'Đơn vị thụ hưởng/ Đơn vị chuyển' làm đối tác");
  assert.equal(mb[0].time, "14:08", "8b. giờ nằm chung ô với ngày vẫn phải lấy ra được");
  assert.equal(toBankRow(mb[0]).txnAt.toISOString(), "2026-08-05T07:08:00.000Z", "8b. 14:08 giờ VN = 07:08Z");

  // 8c. "37" là ô trống, KHÔNG phải 37₫. Bằng chứng nằm ngay trong tệp: dòng trả lãi có "37" ở cột
  // ngân hàng đối tác — không ngân hàng nào tên "37" — và cột số dư lũy kế của chính MB xác nhận.
  assert.equal(mb[0].amount, 3_122_361, "8c. tiền vào đúng nguyên vẹn, không bị trừ 37₫ của ô trống");
  assert.equal(mb[1].amount, -500_000, "8c. tiền ra đúng nguyên vẹn, không bị cộng 37₫ của ô trống");
  assert.equal(mb[2].amount, 139, "8c. lãi 139₫ vẫn là 139₫ — ô trống bị bỏ chứ không phải mọi số nhỏ");
  const dauKy = 2_154;
  const cuoiKy = mb.reduce((so, t) => so + t.amount, dauKy);
  assert.equal(cuoiKy, 70_420, "8c. số dư đầu kỳ + các giao dịch đọc được = số dư cuối kỳ ngân hàng in ra");

  // 8d. Ngược lại: 37₫ THẬT không được tự ý bỏ. Không có bằng chứng ô trống thì giữ nguyên —
  // thà nhập thừa 37₫ còn hơn ERP tự xoá một khoản có thật.
  const batBaMuoiBay = parseLedger(
    ["Ngày,Giờ,Tiền vào,Tiền ra,Nội dung,Đối tác,Mã GD", "05/08/2026,14:08,37,,Phi dieu chinh,MB,FT-37"].join("\n"),
  );
  assert.equal(batBaMuoiBay[0].amount, 37, "8d. không có bằng chứng thì 37 vẫn là số tiền thật");

  // 8e. Cùng một sao kê ở dạng .xlsx phải cho ra kết quả y hệt. Ngân hàng cho tải cả hai định dạng
  // và chủ shop tải cái nào tiện tay; bắt đổi sang CSV trước khi nhập là đẩy việc sang người dùng.
  const luoi = MB_SAO_KE.split("\r\n").map((dong) => parseCsv(dong)[0] ?? []);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(luoi), "Sao ke tai khoan");
  const excel = parseLedgerFile(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  assert.deepEqual(excel, mb, "8e. .xlsx và .csv của cùng một sao kê phải cho ra cùng một danh sách giao dịch");

  console.log("✓ Sao kê ngân hàng chính thức: tìm tiêu đề sau phần đầu thư · ngày+giờ chung ô · ô trống \"37\" của MB không thành 37₫ · .xlsx = .csv");

  /**
   * ───────── 9. SAO KÊ KHÔNG TẠO CHI PHÍ TỪ GIAO DIỆN — KHOÁ Ở MỨC MÃ NGUỒN ─────────
   *
   * AGENTS.md 3.17. Ngày 13/09/2026 trang Chi phí vẫn còn nút "Nhập sao kê" gọi hai Server Action
   * (`previewBankLedger` / `importBankLedger`) ghi thẳng vào `expenses`, gác bằng `expenses:write`
   * — MARKETING / LEADER đọc được trọn sao kê mà không cần `bank:view`. Đã gỡ. Bài này quét mã để
   * không ai nối lại: KHÔNG tệp nào dưới `app/` hay `lib/actions/` được import đường ghi khoản chi
   * từ sao kê; đường đó chỉ còn cho `scripts/import-bank-ledger.ts`.
   */
  const goc = path.resolve(__dirname, "..");
  const quet = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === "node_modules" || d.name === ".next" ? [] : quet(full);
      return /\.(ts|tsx)$/.test(d.name) ? [full] : [];
    });
  const viPham = [...quet(path.join(goc, "app")), ...quet(path.join(goc, "lib", "actions"))].filter((f) => {
    const src = readFileSync(f, "utf8");
    return /integrations\/bank\/import["']/.test(src) || /insertLedgerExpenses/.test(src);
  });
  assert.deepEqual(viPham.map((f) => path.relative(goc, f).split(path.sep).join("/")), [], "9. không Server Action / trang nào được ghi khoản chi từ sao kê");
  assert.ok(!existsSync(path.join(goc, "lib", "actions", "bank-import.ts")), "9. lib/actions/bank-import.ts đã gỡ, không được thêm lại");
  assert.ok(!existsSync(path.join(goc, "app", "(dashboard)", "expenses", "bank-import-dialog.tsx")), "9. nút Nhập sao kê trên trang Chi phí đã gỡ");
  console.log("✓ Sao kê không tạo chi phí: không Server Action / trang nào import đường ghi khoản chi từ sao kê");

  console.log("✓ Đối soát sao kê: 5 khoản mục (thêm cước & lương lấy từ Profit Engine) · kỳ chưa nhập sao kê là CHƯA BIẾT chứ không phải chênh lệch");
}
