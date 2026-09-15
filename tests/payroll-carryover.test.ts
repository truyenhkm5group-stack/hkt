/**
 * ═══════ LỖ LŨY KẾ ĐI QUA BẢNG LƯƠNG THẬT ═══════
 *
 * `tests/profit-carryover.test.ts` khoá PHÉP TÍNH. Bộ này khoá phần NỐI: sổ có thật sự chạm tới
 * con số mà `/payroll` in ra không, và nó có chịu tắt khi chủ shop chưa bật không.
 *
 * Ca dùng ở đây cố ý tạo LỢI NHUẬN ÂM bằng tiền quảng cáo của một mã chưa có đơn — vừa là hình
 * dạng thật của một tháng lỗ, vừa đi qua đúng nhánh mà bản này vừa vá (mã chỉ có quảng cáo).
 *
 * Dữ liệu đặt ở tháng 05 và 06/2027 để không đụng fixture của bộ khác.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_CARRYOVER_KEY, wholeMonthKey } from "@/lib/constants/payroll-carryover";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import type { CostEngineWarning } from "@/lib/queries/cost-engine";
import { getPayrollReport } from "@/lib/queries/payroll";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const ky = (from: string, to: string, label: string): Period => ({
  key: "custom",
  from: d(from),
  to: dEnd(to),
  label,
  fromKey: from,
  toKey: to,
});

const THANG5 = ky("2027-05-01", "2027-05-31", "Tháng 5/2027");
const THANG6 = ky("2027-06-01", "2027-06-30", "Tháng 6/2027");
/** Kỳ 7 ngày — cố ý KHÔNG phải một tháng lịch. */
const TUAN = ky("2027-06-01", "2027-06-07", "Tuần 1 tháng 6/2027");

const MKT: Employee = {
  id: "co-mkt-1",
  name: "Marketer Lũy Kế",
  shortName: "LK",
  department: "Marketing",
  aliases: [],
  accountIds: [],
  fixed: 0,
  percentTotal: 0,
  percentPersonal: 10,
  percentRevenue: 0,
  active: true,
  note: "",
};

async function reset(db: Db) {
  await db.delete(schema.marketerProfitCarryover).where(sql`${schema.marketerProfitCarryover.employeeId} like 'co-%'`);
  await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like 'co-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'co-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  await setSettingJson(PAYROLL_CARRYOVER_KEY, { enabled: false, startMonth: null, startNote: "" });
  clearMemo();
}

const dongLuong = (report: Awaited<ReturnType<typeof getPayrollReport>>) =>
  report.lines.find((l) => l.employee.id === MKT.id);

export async function testPayrollCarryover(db: Db) {
  await reset(db);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [MKT] });

  // Tháng 5: tiêu 8 triệu quảng cáo, chưa bán được gì ⇒ LN cá nhân = −8 triệu.
  await db.insert(schema.products).values({ id: "co-prod", name: "Mã thử lỗ lũy kế" });
  await db.insert(schema.adSpends).values({
    id: "co-ads-t5",
    platform: "facebook",
    campaign: "Tháng 5 lỗ",
    spend: 8_000_000,
    spendDate: d("2027-05-10"),
    productId: "co-prod",
    marketerId: MKT.id,
    excluded: false,
  });
  clearMemo();

  /* ══ 1 · CHƯA BẬT SỔ ⇒ BẢNG LƯƠNG CHẠY Y NHƯ TRƯỚC ══
   *
   * Đây là thay đổi cách tính tiền của người thật nên nó KHÔNG được tự áp. Nếu nhánh này đỏ thì
   * một lượt triển khai đã lặng lẽ đổi số lương của mọi shop chưa kịp khai gì.
   */
  const chuaBat = await getPayrollReport(THANG5, "profit1");
  const d1 = dongLuong(chuaBat);
  assert.equal(d1?.carry, null, "1. chưa bật sổ ⇒ không có dòng bù trừ nào");
  assert.equal(d1?.personalProfit, -8_000_000, "1. LN cá nhân vẫn là −8 triệu (tiền quảng cáo về đúng người chạy)");
  assert.equal(d1?.bonusPersonal, 0, "1. và thưởng theo LN cá nhân vẫn là 0 như luật cũ");

  /* ══ 2 · BẬT SỔ TỪ THÁNG 5 ⇒ SỐ ÂM ĐƯỢC GIỮ LẠI ══
   *
   * Tháng mở sổ: số dư đầu bằng 0 THEO KHAI BÁO của chủ shop — có chủ, có ngày, truy nguyên được;
   * khác hẳn máy tự điền 0 cho mọi người.
   */
  await setSettingJson(PAYROLL_CARRYOVER_KEY, {
    enabled: true,
    startMonth: "2027-05",
    startNote: "Mở sổ từ tháng 5/2027 theo thống nhất với chủ shop",
  });
  clearMemo();

  const thang5 = await getPayrollReport(THANG5, "profit1");
  const d2 = dongLuong(thang5);
  assert.equal(d2?.carry?.openingBalance, 0, "2. tháng mở sổ ⇒ số dư đầu 0 theo KHAI BÁO");
  assert.equal(d2?.carry?.openingBasis, "OPENING_DECLARATION", "2. và căn cứ phải nói rõ đó là khai báo, không phải suy ra");
  assert.equal(d2?.carry?.openingEstablished, true, "2. khai báo là đủ căn cứ để chốt");
  assert.equal(d2?.carry?.realProfit, -8_000_000, "2. LN thực của tháng là −8 triệu");
  assert.equal(d2?.carry?.commissionBase, 0, "2. cơ sở hoa hồng bằng 0");
  assert.equal(d2?.bonusPersonal, 0, "2. và không trả đồng hoa hồng nào");
  assert.equal(
    d2?.carry?.signedCommission,
    -800_000,
    "2. NHƯNG hoa hồng CÓ DẤU vẫn hiện −800.000đ để chủ shop theo dõi",
  );
  assert.equal(
    d2?.carry?.closingBalance,
    -8_000_000,
    "2. và −8 triệu được GIỮ LẠI để chuyển sang tháng sau — đây là thứ luật cũ làm mất",
  );

  /* ══ 3 · THÁNG SAU: SỐ DƯ CHƯA XÁC LẬP LÀ CHƯA BIẾT, KHÔNG PHẢI 0 ══
   *
   * Tháng 5 mới là NHÁP (chưa ai bấm chốt), nên tháng 6 chỉ MÔ PHỎNG được — xem thì được, chốt thì
   * chưa. Đây là chỗ dễ sai nhất: lấy đại số dư của một tháng chưa chốt rồi trả tiền theo nó.
   */
  const thang6Nhap = await getPayrollReport(THANG6, "profit1");
  const d3 = dongLuong(thang6Nhap);
  assert.equal(
    d3?.carry?.openingBasis,
    "NONE",
    "3. tháng 5 chưa có dòng sổ nào ⇒ số dư đầu tháng 6 là CHƯA BIẾT",
  );
  assert.equal(d3?.carry?.openingBalance, null, "3. và nó phải là null, KHÔNG phải 0");
  assert.equal(d3?.carry?.openingEstablished, false, "3. chưa đủ căn cứ để chốt tháng 6");
  assert.equal(d3?.bonusPersonal, null, "3. thưởng theo LN cá nhân cũng CHƯA BIẾT — không được in ra 0 ₫");
  assert.equal(d3?.salary, null, "3. và tổng lương của dòng ấy cũng chưa biết");
  assert.equal(thang6Nhap.totalSalary, null, "3. nên tổng lương của kỳ chưa biết ⇒ chưa đủ điều kiện chốt");

  /* ══ 4 · THÁNG 5 ĐÃ CHỐT ⇒ THÁNG 6 CÓ CĂN CỨ, VÀ LỖ ĐƯỢC BÙ ĐÚNG ══ */
  await db.insert(schema.marketerProfitCarryover).values({
    id: "co-ledger-t5",
    employeeId: MKT.id,
    monthKey: "2027-05",
    openingBalance: 0,
    openingSource: "OPENING_DECLARATION",
    realProfit: -8_000_000,
    lossApplied: 0,
    commissionBase: 0,
    commissionRateBp: 1000,
    signedCommission: -800_000,
    payableCommission: 0,
    closingBalance: -8_000_000,
    status: "FINAL",
    snapshot: { nguon: "kiểm thử" },
    finalizedAt: new Date(),
  });
  // Tháng 6 tiêu thêm 2 triệu quảng cáo ⇒ LN thực tháng 6 = −2 triệu, cộng dồn thành −10 triệu.
  await db.insert(schema.adSpends).values({
    id: "co-ads-t6",
    platform: "facebook",
    campaign: "Tháng 6 vẫn lỗ",
    spend: 2_000_000,
    spendDate: d("2027-06-10"),
    productId: "co-prod",
    marketerId: MKT.id,
    excluded: false,
  });
  clearMemo();

  const thang6 = await getPayrollReport(THANG6, "profit1");
  const d4 = dongLuong(thang6);
  assert.equal(d4?.carry?.openingBalance, -8_000_000, "4. số dư đầu tháng 6 lấy từ tháng 5 ĐÃ CHỐT");
  assert.equal(d4?.carry?.openingBasis, "PREV_MONTH_FINAL", "4. và nói rõ căn cứ là tháng trước đã chốt");
  assert.equal(d4?.carry?.openingEstablished, true, "4. đủ căn cứ để chốt tháng 6");
  assert.equal(d4?.carry?.realProfit, -2_000_000, "4. LN THỰC của tháng 6 là −2 triệu — lỗ cũ KHÔNG bị trừ vào đây lần nữa");
  assert.equal(d4?.carry?.closingBalance, -10_000_000, "4. số dư cộng dồn thành −10 triệu");
  assert.equal(d4?.bonusPersonal, 0, "4. vẫn chưa có hoa hồng");

  /* ══ 5 · KỲ KHÔNG PHẢI MỘT THÁNG LỊCH ⇒ KHÔNG ÁP DỤNG, KHÔNG PHẢI BẰNG 0 ══
   *
   * Xem 7 ngày không được tạo hay cộng lại số dư: số dư là chuỗi TUẦN TỰ theo tháng, cộng nó theo
   * một kỳ khác làm mất đúng phần lỗ mà cơ chế này sinh ra để giữ.
   */
  assert.equal(wholeMonthKey(TUAN.from, TUAN.to), null, "5. kỳ 7 ngày không phải một tháng lịch");
  const tuan = await getPayrollReport(TUAN, "profit1");
  assert.equal(dongLuong(tuan)?.carry, null, "5. kỳ 7 ngày ⇒ sổ KHÔNG ÁP DỤNG (null), không được hiện số dư");

  /* ══ 6 · THÁNG TRƯỚC MỐC MỞ SỔ ⇒ KHÔNG ÁP DỤNG ══ */
  await setSettingJson(PAYROLL_CARRYOVER_KEY, { enabled: true, startMonth: "2027-06", startNote: "mở sổ tháng 6" });
  clearMemo();
  const truocMoc = await getPayrollReport(THANG5, "profit1");
  assert.equal(dongLuong(truocMoc)?.carry, null, "6. tháng nằm trước mốc mở sổ ⇒ không áp dụng");
  assert.equal(
    dongLuong(truocMoc)?.bonusPersonal,
    0,
    "6. và bảng lương tháng ấy chạy theo luật cũ, không bị sổ đụng vào",
  );

  /* ══ 7 · BỘ ĐIỀU KIỆN CHỐT: MÀN HÌNH VÀ SERVER PHẢI NÓI CÙNG MỘT ĐIỀU ══
   *
   * Hàm thuần `payrollFinalizeBlockers` là chỗ DUY NHẤT quyết định "kỳ này chốt được chưa". Bài này
   * khoá bốn cửa của nó, và khoá luôn cái ranh giới dễ sai nhất: cảnh báo mức `medium` là lời khai
   * về NGUỒN, không phải lỗ hổng về SỐ — chặn nó là cách không bao giờ chốt được kỳ nào, rồi sẽ có
   * người đi tắt hết cảnh báo cho xong.
   */
  const nen = {
    bounded: true,
    basisEligible: true,
    basisWhy: "LN1 là cơ sở duy nhất được phép",
    basisLabel: "LN1",
    totalSalary: 9_000_000,
    costWarnings: [] as CostEngineWarning[],
    lines: [] as { name: string; carryEstablished: boolean | null; carryReason: string | null }[],
  };
  assert.equal(payrollFinalizeBlockers(nen).length, 0, "7. nền sạch ⇒ không còn việc gì thiếu");
  assert.equal(
    payrollFinalizeBlockers({ ...nen, bounded: false })[0]?.code,
    "PERIOD_UNBOUNDED",
    "7. kỳ không có mốc đầu/cuối bị chặn",
  );
  assert.equal(
    payrollFinalizeBlockers({ ...nen, basisEligible: false })[0]?.code,
    "BASIS_NOT_ELIGIBLE",
    "7. cơ sở không đủ điều kiện bị chặn",
  );
  assert.equal(
    payrollFinalizeBlockers({ ...nen, totalSalary: null })[0]?.code,
    "UNKNOWN_SALARY",
    "7. còn con số CHƯA BIẾT thì bị chặn",
  );
  const canhBaoCao: CostEngineWarning = {
    rule: "DUPLICATE_LOGISTICS_COST_SOURCE",
    severity: "high",
    title: "2 khoản cước gõ tay bị loại vì trùng với vận đơn",
    detail: "300.000 ₫ gõ tay không được cộng thêm.",
    action: "Khai là điều chỉnh thủ công kèm lý do.",
    amount: 300_000,
    count: 2,
  };
  assert.equal(
    payrollFinalizeBlockers({ ...nen, costWarnings: [canhBaoCao] })[0]?.code,
    "COST_EVIDENCE_MISSING",
    "7. có tiền thật đang nằm NGOÀI phép tính (cảnh báo mức high) ⇒ chặn",
  );
  const canhBaoVua: CostEngineWarning = { ...canhBaoCao, severity: "medium", rule: "COMMISSION_BASIS_NEEDS_REVIEW" };
  assert.equal(
    payrollFinalizeBlockers({ ...nen, costWarnings: [canhBaoVua] }).length,
    0,
    "7. cảnh báo mức medium là lời khai về NGUỒN — đi cùng con số, KHÔNG chặn",
  );
  assert.equal(
    payrollFinalizeBlockers({
      ...nen,
      lines: [{ name: "LK", carryEstablished: false, carryReason: "Tháng trước mới là nháp." }],
    })[0]?.code,
    "CARRYOVER_OPENING_NOT_ESTABLISHED",
    "7. số dư lỗ đầu kỳ chưa xác lập ⇒ chặn (xem được không có nghĩa là chốt được)",
  );
  assert.equal(
    payrollFinalizeBlockers({
      ...nen,
      lines: [{ name: "LK", carryEstablished: null, carryReason: null }],
    }).length,
    0,
    "7. sổ KHÔNG ÁP DỤNG không phải một lỗ hổng — null khác false",
  );

  /* ══ 8 · CHỐT KỲ PHẢI NGUYÊN TỬ — VÀ DÒNG ĐÃ CHỐT KHÔNG BỊ GHI ĐÈ ══
   *
   * GIỚI HẠN CỦA BÀI NÀY, NÓI TRƯỚC: PGlite chỉ có MỘT kết nối, nên hai giao dịch ở đây luôn chạy
   * nối đuôi nhau. Không thể mô phỏng tranh chấp thật, và một bài "chạy hai lượt rồi thấy đúng một
   * cái thắng" trên PGlite chứng minh được ĐÚNG KHÔNG GÌ CẢ — nó sẽ xanh kể cả khi mã không có lá
   * chắn nào. Nên bài này khoá hai thứ KIỂM ĐƯỢC, và phần tranh chấp thật phải thử trên PostgreSQL.
   *
   * 8a. Lá chắn `setWhere status = 'DRAFT'`: một dòng ĐÃ FINAL không bị lượt ghi thứ hai đè lên.
   *     Đây chính là chỗ chặn "hai yêu cầu cùng dùng một số dư cũ để ghi hai kết quả".
   */
  await db.insert(schema.marketerProfitCarryover).values({
    id: "co-race-1",
    employeeId: "co-race-emp",
    monthKey: "2027-08",
    openingBalance: -5_000_000,
    openingSource: "PREV_MONTH",
    realProfit: 1_000_000,
    lossApplied: 1_000_000,
    commissionBase: 0,
    commissionRateBp: 1000,
    signedCommission: -400_000,
    payableCommission: 0,
    closingBalance: -4_000_000,
    status: "FINAL",
    snapshot: { nguon: "lượt chốt thứ nhất" },
    finalizedAt: new Date(),
  });
  const c = schema.marketerProfitCarryover;
  await db
    .insert(c)
    .values({
      id: "co-race-2",
      employeeId: "co-race-emp",
      monthKey: "2027-08",
      openingBalance: 0,
      openingSource: "OPENING_DECLARATION",
      realProfit: 9_999_999,
      lossApplied: 0,
      commissionBase: 9_999_999,
      commissionRateBp: 1000,
      signedCommission: 999_999,
      payableCommission: 999_999,
      closingBalance: 0,
      status: "FINAL",
      snapshot: { nguon: "lượt chốt thứ hai — KHÔNG được thắng" },
      finalizedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [c.employeeId, c.monthKey, c.componentCode],
      set: { realProfit: 9_999_999, payableCommission: 999_999, closingBalance: 0 },
      setWhere: eq(c.status, "DRAFT"),
    });
  const [conLai] = await db.select().from(c).where(eq(c.employeeId, "co-race-emp"));
  assert.equal(conLai?.realProfit, 1_000_000, "8a. dòng ĐÃ CHỐT giữ nguyên con số của lượt chốt thứ nhất");
  assert.equal(conLai?.payableCommission, 0, "8a. lượt thứ hai KHÔNG ghi đè được tiền hoa hồng");
  assert.equal(conLai?.closingBalance, -4_000_000, "8a. và số dư chuyển tiếp cũng không bị viết lại");
  await db.delete(c).where(eq(c.employeeId, "co-race-emp"));

  /*
    8b. PHÉP KIỂM CHỒNG LẤN PHẢI NẰM TRONG GIAO DỊCH ĐÃ CẦM KHOÁ.

    Kiểm ngoài rồi ghi trong là đúng cái khe mà hai yêu cầu đồng thời lọt qua: cả hai cùng đọc
    "chưa có kỳ nào chồng lấn", rồi cả hai cùng ghi. Khoá tự nhiên (period_key, basis) không chặn
    được vì hai khoá KHÁC NHAU, và khoá một DÒNG cũng không cứu được vì dòng cần khoá CHƯA TỒN TẠI.

    Quét mã nguồn ĐÃ VÀO KHO, không đọc đĩa — cùng cách `tests/repo-integrity.test.ts` làm.
  */
  const nguon = execSync("git show HEAD:lib/actions/payroll-period.ts", { encoding: "utf8" });
  const viTriKhoa = nguon.indexOf("pg_advisory_xact_lock");
  const viTriKiem = nguon.indexOf("eq(p.status, \"FINAL\"), lte(p.periodStart");
  assert.ok(viTriKhoa > 0, "8b. lượt chốt phải cầm một khoá TÊN (pg_advisory_xact_lock) — khoá dòng không dùng được cho dòng chưa tồn tại");
  assert.ok(viTriKiem > 0, "8b. phép kiểm chồng lấn phải còn trong tệp");
  assert.ok(viTriKiem > viTriKhoa, "8b. và nó phải chạy SAU khi đã cầm khoá, không phải trước giao dịch");
  assert.ok(
    nguon.indexOf("setWhere: eq(c.status, \"DRAFT\")") > 0,
    "8b. ghi sổ lỗ phải có lá chắn setWhere để dòng đã chốt không bị lượt thứ hai đè",
  );

  await reset(db);
  console.log(
    "✓ Lỗ lũy kế qua bảng lương thật: chưa bật thì KHÔNG đổi một con số nào · tháng mở sổ có số dư 0 theo KHAI BÁO · số âm được giữ và hoa hồng có dấu vẫn hiện · tháng trước chưa chốt ⇒ CHƯA BIẾT chứ không phải 0 và chặn chốt · tháng trước đã chốt thì lỗ cộng dồn đúng và LN thực không bị trừ hai lần · kỳ 7 ngày và tháng trước mốc mở sổ ⇒ KHÔNG ÁP DỤNG · bộ điều kiện chốt dùng chung chặn đúng bốn cửa và KHÔNG chặn cảnh báo chỉ mang tính lời khai · dòng sổ đã chốt không bị lượt ghi thứ hai đè, và phép kiểm chồng lấn nằm SAU khoá tên trong cùng giao dịch",
  );
}
