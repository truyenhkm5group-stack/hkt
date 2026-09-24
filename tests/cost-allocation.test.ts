import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { allocateExpenseToRange, distributeProportionally, inclusiveDays, inventoryRiskExposure, inventoryRiskOnSold, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import { allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";
import { getOperatingCost, getOperatingCostByDay, getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getDailyBreakdown, getProfitReport } from "@/lib/queries/reports";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getMarketingDaily } from "@/lib/queries/marketing-daily";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_CALC_VERSION, PAYROLL_EMPLOYEES_KEY, payrollPeriodKey } from "@/lib/constants/payroll";
import { getMarketerReport, getPayrollReport } from "@/lib/queries/payroll";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import { buildPayrollSnapshot, getPayrollPeriodState, payrollDrift } from "@/lib/queries/payroll-period";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ PHÂN BỔ CHI PHÍ THEO KHOẢNG BÁO CÁO ═══════
 *
 * Bug gốc: doanh thu lọc theo khoảng ngày người dùng chọn, còn chi phí thì cộng NGUYÊN khoản nếu
 * `occurred_at` rơi vào khoảng đó. Tiền thuê 2.000.000đ/tháng ghi ngày 01/09 vào ĐỦ khi xem tuần
 * 01–07/09 và bằng 0 khi xem tuần 08–14/09 — cả hai đều sai, và lợi nhuận tuần thành vô nghĩa.
 *
 * Bộ này khoá cả hai bản tính (TypeScript và SQL) phải cho CÙNG một con số.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
/** Mốc cuối kỳ luôn là hết ngày theo giờ Việt Nam — đúng quy ước tính CẢ hai đầu. */
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const RENT: AllocatableExpense = {
  amount: 2_000_000,
  occurredAt: d("2026-09-01"),
  allocationMethod: "PERIOD_PRORATA",
  periodStart: d("2026-09-01"),
  periodEnd: dEnd("2026-09-30"),
};

export async function testCostAllocation(db: Db) {
  // ══ 1. Cả tháng ⇒ trọn khoản ══
  assert.equal(allocateExpenseToRange(RENT, d("2026-09-01"), dEnd("2026-09-30")), 2_000_000, "1. cả kỳ thì lấy trọn khoản");

  // ══ 2 & 3. Một tuần ⇒ 7/30 ══
  const tuan1 = allocateExpenseToRange(RENT, d("2026-09-01"), dEnd("2026-09-07"));
  const tuan2 = allocateExpenseToRange(RENT, d("2026-09-08"), dEnd("2026-09-14"));
  assert.equal(tuan1, Math.round((2_000_000 * 7) / 30), "2. tuần đầu = 7/30 khoản");
  assert.equal(tuan2, Math.round((2_000_000 * 14) / 30) - Math.round((2_000_000 * 7) / 30), "3. tuần thứ hai cũng 7 ngày");
  assert.ok(tuan1 < 500_000, "2. KHÔNG được cộng nguyên 2.000.000đ vào một tuần");

  // ══ 4. Hai khoảng liền nhau cộng lại = đúng trọn khoản, không thừa không thiếu ══
  const phanDau = allocateExpenseToRange(RENT, d("2026-09-01"), dEnd("2026-09-07"));
  const phanSau = allocateExpenseToRange(RENT, d("2026-09-08"), dEnd("2026-09-30"));
  assert.equal(phanDau + phanSau, 2_000_000, "4. hai khoảng liền nhau cộng lại phải bằng đúng khoản, không lệch vì làm tròn");
  // Chia nhỏ tới từng ngày cũng phải cộng đúng — đây là chỗ phép nhân phân số sẽ trượt.
  let tongNgay = 0;
  for (let i = 1; i <= 30; i += 1) {
    const ngay = `2026-09-${String(i).padStart(2, "0")}`;
    tongNgay += allocateExpenseToRange(RENT, d(ngay), dEnd(ngay));
  }
  assert.equal(tongNgay, 2_000_000, "4. cộng 30 ngày lẻ vẫn đúng trọn khoản");

  // ══ 5. Kỳ vắt qua hai tháng ⇒ chỉ lấy phần chồng lấn ══
  const vatThang: AllocatableExpense = { ...RENT, amount: 3_100_000, periodStart: d("2026-08-15"), periodEnd: dEnd("2026-09-14") };
  const chiThang9 = allocateExpenseToRange(vatThang, d("2026-09-01"), dEnd("2026-09-30"));
  const chiThang8 = allocateExpenseToRange(vatThang, d("2026-08-01"), dEnd("2026-08-31"));
  assert.equal(chiThang8 + chiThang9, 3_100_000, "5. hai tháng cộng lại bằng đúng khoản");
  assert.ok(chiThang9 > 0 && chiThang9 < 3_100_000, "5. tháng 9 chỉ nhận phần chồng lấn");

  // ══ 6. Khoản một lần chỉ nằm ở đúng kỳ chứa ngày phát sinh ══
  const motLan: AllocatableExpense = { amount: 500_000, occurredAt: d("2026-09-10"), allocationMethod: "EVENT_DATE" };
  assert.equal(allocateExpenseToRange(motLan, d("2026-09-01"), dEnd("2026-09-07")), 0, "6. ngoài kỳ ⇒ 0");
  assert.equal(allocateExpenseToRange(motLan, d("2026-09-08"), dEnd("2026-09-14")), 500_000, "6. trong kỳ ⇒ trọn khoản");

  // ══ 9. Tháng Hai năm nhuận ══
  const nhuan: AllocatableExpense = { ...RENT, amount: 2_900_000, periodStart: d("2028-02-01"), periodEnd: dEnd("2028-02-29") };
  assert.equal(inclusiveDays(d("2028-02-01"), d("2028-02-29")), 29, "9. tháng 2 năm nhuận có 29 ngày");
  assert.equal(allocateExpenseToRange(nhuan, d("2028-02-01"), dEnd("2028-02-29")), 2_900_000, "9. cả tháng nhuận ⇒ trọn khoản");
  assert.equal(inclusiveDays(d("2026-02-01"), d("2026-02-28")), 28, "9. năm thường có 28 ngày");

  // ══ Bản SQL phải cho CÙNG con số — nếu lệch thì báo cáo và kiểm thử nói hai điều ══
  await db.insert(schema.expenses).values([
    { id: "ca-rent", category: "RENT", description: "Thuê mặt bằng tháng 9", amount: 2_000_000,
      occurredAt: d("2026-09-01"), allocationMethod: "PERIOD_PRORATA", periodStart: d("2026-09-01"), periodEnd: dEnd("2026-09-30") },
    { id: "ca-oneoff", category: "OTHER", description: "Sửa chữa một lần", amount: 500_000,
      occurredAt: d("2026-09-10"), allocationMethod: "EVENT_DATE" },
  ]);
  const sqlTong = async (from: Date, to: Date) => {
    const [row] = await db
      .select({ v: allocatedExpenseSum(from, to) })
      .from(schema.expenses)
      .where(and(sql`${schema.expenses.id} in ('ca-rent','ca-oneoff')`, expenseInRange(from, to)));
    return Number(row?.v ?? 0);
  };
  assert.equal(await sqlTong(d("2026-09-01"), dEnd("2026-09-30")), 2_500_000, "SQL: cả tháng = thuê trọn + khoản một lần");
  assert.equal(await sqlTong(d("2026-09-01"), dEnd("2026-09-07")), tuan1, "SQL: tuần đầu khớp bản TypeScript, và KHÔNG gồm khoản một lần ngày 10");
  assert.equal(await sqlTong(d("2026-09-08"), dEnd("2026-09-14")), tuan2 + 500_000, "SQL: tuần hai = phần thuê + khoản một lần");
  const sqlDau = await sqlTong(d("2026-09-01"), dEnd("2026-09-07"));
  const sqlSau = await sqlTong(d("2026-09-08"), dEnd("2026-09-30"));
  assert.equal(sqlDau + sqlSau, 2_500_000, "SQL: hai khoảng liền nhau cộng lại đúng tổng, không double count");

  // Khoản theo kỳ phải LỌT vào báo cáo dù `occurred_at` nằm ngoài khoảng — chỗ bản cũ bỏ sót.
  const [ngoai] = await db
    .select({ v: allocatedExpenseSum(d("2026-09-20"), dEnd("2026-09-25")) })
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, "ca-rent"), expenseInRange(d("2026-09-20"), dEnd("2026-09-25"))));
  assert.ok(Number(ngoai?.v ?? 0) > 0, "khoản thuê vẫn được tính ở tuần cuối tháng dù ghi ngày 01/09");

  // ══ Rải theo NGÀY: biểu đồ theo ngày không được có một cột dựng đứng ở ngày ghi sổ ══
  clearMemo();
  const thang9: Period = { key: "custom", from: d("2026-09-01"), to: dEnd("2026-09-30"), label: "Tháng 9/2026", fromKey: "2026-09-01", toKey: "2026-09-30" };
  const { byDay } = await getOperatingCostByDay(thang9, db);
  const ngay01 = byDay.get("2026-09-01") ?? 0;
  const ngay20 = byDay.get("2026-09-20") ?? 0;
  assert.ok(ngay01 > 0 && ngay20 > 0, "theo ngày: mọi ngày trong kỳ thuê đều có chi phí, không chỉ ngày ghi sổ");
  assert.ok(Math.abs(ngay01 - ngay20) <= 1, "theo ngày: tiền thuê rải đều, hai ngày bất kỳ chênh nhau tối đa 1đ");
  assert.ok(ngay01 < 100_000, "theo ngày: KHÔNG được dồn cả 2.000.000đ vào ngày 01/09");
  const tongTheoNgay = [...byDay.values()].reduce((t, v) => t + v, 0);
  assert.equal(tongTheoNgay, 2_500_000, "theo ngày: cộng 30 ngày = đúng tổng đã phân bổ của kỳ, không thừa không thiếu");
  const ngay10 = byDay.get("2026-09-10") ?? 0;
  assert.ok(Math.abs(ngay10 - (ngay01 + 500_000)) <= 1, "theo ngày: ngày 10 = phần thuê của ngày đó + trọn khoản một lần 500K");

  await db.delete(schema.expenses).where(sql`${schema.expenses.id} in ('ca-rent','ca-oneoff')`);

  await testOperatingCostByDayAuthority(db);
  await testLogisticsAdjustmentOnePath(db);
  await testPayrollLogisticsAdjustment(db);

  // ══ RỦI RO TỒN KHO: driver là HÀNG BÁN RA, không phải hàng nhập ══
  // Bối cảnh chủ shop nêu: mã Q002 nhập 200 triệu, dự phòng 10% = 20 triệu, tuần chỉ bán 100/1.000 đơn.
  const giaTriLo = 200_000_000;
  const duPhongCaLo = 20_000_000;
  assert.equal(inventoryRiskOnSold(giaTriLo, 10), duPhongCaLo, "bán hết cả lô ⇒ đúng 10% giá trị lô, tỷ lệ giữ nguyên ý nghĩa cũ");
  const giaVonTuan = giaTriLo / 10; // bán 100/1.000 đơn của lô
  const duPhongTuan = inventoryRiskOnSold(giaVonTuan, 10);
  assert.equal(duPhongTuan, 2_000_000, "tuần bán 1/10 lô chỉ gánh 1/10 dự phòng");
  assert.ok(duPhongTuan < duPhongCaLo / 5, "KHÔNG được ném trọn 20 triệu vào tuần bán 100/1.000 đơn");
  // Cộng mọi kỳ của vòng đời lô = đúng dự phòng cả lô: đổi THỜI ĐIỂM ghi nhận, không đổi TỔNG.
  let congDon = 0;
  for (let tuan = 0; tuan < 10; tuan += 1) congDon += inventoryRiskOnSold(giaVonTuan, 10);
  assert.equal(congDon, duPhongCaLo, "10 tuần bán hết lô cộng lại = đúng dự phòng cả lô");
  assert.equal(inventoryRiskOnSold(0, 10), 0, "kỳ không bán được gì ⇒ chưa giải phóng đồng dự phòng nào");
  assert.equal(inventoryRiskOnSold(1_000_000, 0), 0, "tỷ lệ 0 ⇒ không dự phòng");
  assert.equal(inventoryRiskOnSold(1_000_000, 999), 1_000_000, "tỷ lệ bị kẹp ở 100%");
  assert.equal(inventoryRiskOnSold(-5_000_000, 10), 0, "giá vốn âm ⇒ 0, không sinh dự phòng âm");
  // Phần còn treo trên hàng tồn phải LỘ RA, nếu không rủi ro hàng ế biến mất khỏi màn hình.
  assert.equal(inventoryRiskExposure(giaTriLo * 0.9, 10), 18_000_000, "hàng còn tồn 90% lô ⇒ còn treo 18 triệu");
  assert.equal(inventoryRiskExposure(0, 10), 0);

  // ══ CHIA MỘT TỔNG: Σ các dòng phải BẰNG ĐÚNG tổng ══
  const chia = distributeProportionally(5_000_000, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(chia.reduce((t, v) => t + v, 0), 5_000_000, "chia 5 triệu cho 7 mã: cộng lại đúng 5 triệu");
  const lech = [1, 1, 1, 1, 1, 1, 1].map(() => Math.round(5_000_000 / 7)).reduce((t, v) => t + v, 0);
  assert.notEqual(lech, 5_000_000, "cách làm tròn từng dòng kiểu cũ thì KHÔNG khớp — đây là lý do phải dùng largest remainder");
  const nhieu = distributeProportionally(1_234_567, Array.from({ length: 313 }, (_, k) => k + 1));
  assert.equal(nhieu.reduce((t, v) => t + v, 0), 1_234_567, "chia cho 313 mã trọng số lệch nhau vẫn cộng đúng tổng");
  assert.deepEqual(distributeProportionally(1_000, [3, 1]), [750, 250], "chia theo đúng tỷ trọng");
  assert.deepEqual(distributeProportionally(1_000, [0, 0]), [0, 0], "mọi trọng số 0 ⇒ không chia bừa cho ai");
  assert.equal(distributeProportionally(-900, [2, 1]).reduce((t, v) => t + v, 0), -900, "tổng âm vẫn cộng đúng");

  // ══ RANH GIỚI Ở MỨC MÃ NGUỒN: không trang nào được tự cộng chi phí theo `occurred_at` ══
  //
  // Bug này đã bị sửa MỘT LẦN ở báo cáo lợi nhuận rồi lại tái sinh ở năm trang khác, vì mỗi trang tự
  // viết lại `sum(expenses.amount) where occurred_at between ...`. Lời hứa trong tài liệu không chặn
  // được ai; bài kiểm thử này đỏ ngay khi có người chép lại phép cộng thô.
  //
  // TRƯỚC 10/09/2026 bài kiểm này canh một DANH SÁCH SÁU TỆP gõ tay — nên `cashflow.ts` cộng thẳng
  // toàn bộ `expenses.amount` suốt một thời gian dài mà không đỏ: nó không có tên trong danh sách.
  // Nhịp chi của trang Dòng tiền vì thế cộng cả khoản gõ tay nhóm "Quảng cáo" CHỒNG LÊN chi tiêu lấy
  // từ tài khoản QC ngay phía trên — đốt tiền trông gấp đôi thực tế.
  //
  // Nay quét NGƯỢC LẠI: mọi tệp trong `lib/queries` đụng tới `expenses.amount` đều phải chứng minh,
  // và muốn miễn thì phải khai lý do. Danh sách trắng gõ tay không bao giờ theo kịp kho mã.
  const MIEN_TRU_CHI_PHI: Record<string, { lyDo: string; phaiLocThamQuyen: boolean }> = {
    // Trang Chi phí là SỔ GHI, không phải báo cáo tài chính: nó phải hiện ĐỦ mọi khoản đã gõ, kể cả
    // khoản bị loại khỏi lợi nhuận vì nguồn khác có thẩm quyền. Lọc bớt ở đây thì người vừa nhập
    // xong thấy khoản của mình biến mất — tệ hơn nhiều so với việc phải giải thích cột "bị loại".
    // Phần bị loại đã được nêu riêng bằng luật đối soát EXCLUDED_BY_AUTHORITY.
    "lib/queries/expenses.ts": { lyDo: "sổ ghi chi phí, hiện đúng số đã gõ vào", phaiLocThamQuyen: false },
    // Dòng tiền đo TIỀN RA THẬT theo ngày chi, không theo kỳ kế toán — nên không đi qua bộ phân bổ.
    // Nhưng nó VẪN là một con số tài chính, nên vẫn phải tôn trọng thẩm quyền nguồn chi.
    "lib/queries/cashflow.ts": { lyDo: "dự phóng dòng tiền đo theo ngày chi thật", phaiLocThamQuyen: true },
  };
  const CONG_THO = /sum\(\s*\$\{\s*schema\.expenses\.amount\s*\}\s*\)|sum\(schema\.expenses\.amount\)/;
  const tepTruyVan = readdirSync("lib/queries")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `lib/queries/${f}`);
  assert.ok(tepTruyVan.length > 20, `đọc hụt thư mục truy vấn (chỉ thấy ${tepTruyVan.length} tệp)`);

  const congTho: string[] = [];
  for (const file of tepTruyVan) {
    const src = readFileSync(file, "utf8");
    // Không trang nào được tự gõ lại danh sách nhóm bị loại — đó chính là chỗ SHIPPING và
    // RETURN_FEE bị bỏ sót và bị trừ hai lần suốt một thời gian dài.
    assert.equal(/not in \('ADS','PURCHASE'\)/.test(src), false, `${file}: còn gõ tay danh sách nhóm bị loại`);
    if (!CONG_THO.test(src)) continue;
    const mienTru = MIEN_TRU_CHI_PHI[file];
    if (mienTru) {
      // Miễn PHÂN BỔ không kéo theo miễn THẨM QUYỀN: con số nào còn là con số tài chính thì vẫn phải
      // hỏi ai có quyền sở hữu khoản chi đó, nếu không quảng cáo bị cộng hai lần.
      if (mienTru.phaiLocThamQuyen) {
        assert.ok(
          /operatingExpenseCond|getOperatingCost|getRecognizedCosts/.test(src),
          `${file}: được miễn phân bổ theo kỳ (${mienTru.lyDo}), NHƯNG vẫn phải lọc thẩm quyền nguồn chi`,
        );
      }
      continue;
    }
    // `getOperatingCostByDay` khớp nhánh `getOperatingCost` — nó CŨNG là một cửa của Profit Engine.
    if (!/getOperatingCost|getRecognizedCosts/.test(src)) congTho.push(file);
  }
  assert.deepEqual(
    congTho,
    [],
    `Cộng thẳng expenses.amount mà không qua Profit Engine: ${congTho.join(", ")}. ` +
      "Dùng getOperatingCost / getOperatingCostByDay / getRecognizedCosts, hoặc khai vào MIEN_TRU_CHI_PHI kèm lý do.",
  );

  // Các trang lợi nhuận thì không được miễn: chúng PHẢI hỏi Profit Engine.
  //
  // TRƯỚC 24/09/2026 cổng này chấp nhận cả `allocatedExpenseByDay` — một hàm đọc THẲNG bảng Chi phí
  // mà không qua sổ thẩm quyền. Nên `reports.ts` (biểu đồ theo ngày) và `marketing-daily.ts` cộng
  // khoản ADS gõ tay CHỒNG lên chi tiêu tài khoản QC, và cộng PURCHASE / cước trùng vận đơn vào chi
  // phí vận hành, mà cổng vẫn xanh. Nay chỉ còn cửa của Profit Engine được coi là hợp lệ.
  for (const file of ["lib/queries/profit-nominal.ts", "lib/queries/profit-cash.ts", "lib/queries/payroll.ts", "lib/queries/dashboard.ts", "lib/queries/financial-truth.ts", "lib/queries/reports.ts", "lib/queries/marketing-daily.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      /getOperatingCost|getRecognizedCosts/.test(src),
      `${file}: phải lấy chi phí vận hành qua Profit Engine, không tự cộng theo cách riêng`,
    );
  }

  // PHÉP RẢI THEO NGÀY là một nguyên tố KHÔNG biết thẩm quyền — chỉ Profit Engine được gọi nó. Tệp
  // nào khác gọi thẳng là dựng lại đúng đường vòng qua sổ thẩm quyền vừa bị bịt. Và cái tên cũ
  // không được sống lại dưới bất kỳ hình thức nào.
  const tatCaTepMa = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f));
  const goiThangPhepRai = tatCaTepMa.filter(
    (f) => !["lib/queries/cost-allocation.ts", "lib/queries/cost-engine.ts"].includes(f) && /\bspreadExpenseByDay\b/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(goiThangPhepRai, [], `gọi thẳng phép rải chi phí theo ngày, bỏ qua sổ thẩm quyền: ${goiThangPhepRai.join(", ")} — dùng getOperatingCostByDay`);
  const tenCu = tatCaTepMa.filter((f) => /\ballocatedExpenseByDay\s*\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(tenCu, [], `allocatedExpenseByDay đã bị bỏ vì không lọc thẩm quyền: ${tenCu.join(", ")}`);

  // Danh sách miễn trừ phải sạch: khai cho tệp không còn cộng thô là rác, và che mất ca thật.
  const thuaMienTru = Object.keys(MIEN_TRU_CHI_PHI).filter((f) => !CONG_THO.test(readFileSync(f, "utf8")));
  assert.deepEqual(thuaMienTru, [], `MIEN_TRU_CHI_PHI còn khai tệp không còn cộng thô: ${thuaMienTru.join(", ")}`);

  console.log(
    "✓ Phân bổ chi phí theo kỳ: thuê tháng không còn cộng nguyên vào một tuần · hai khoảng liền nhau cộng đúng tổng · khoản một lần đúng kỳ · tháng nhuận đúng · SQL khớp TypeScript · rải đều theo ngày",
  );
  console.log(
    "✓ Rủi ro tồn kho đi theo HÀNG BÁN RA: tuần bán 1/10 lô chỉ gánh 1/10 dự phòng, cộng cả vòng đời vẫn đúng % giá trị lô, phần hàng chưa bán hiện riêng · chia chi phí cho các mã cộng lại đúng tổng",
  );
}

/**
 * ═══════ CHI PHÍ THEO NGÀY ĐI QUA SỔ THẨM QUYỀN — ĐỐI CHIẾU VỚI PROFIT ENGINE, KHÔNG VỚI CHÍNH NÓ ═══════
 *
 * Bản cũ (`allocatedExpenseByDay`) chia bảng Chi phí làm hai rổ "quảng cáo" / "còn lại" và bỏ qua sổ
 * thẩm quyền. Bài đối soát của trang marketing so với `getDailyBreakdown` — hai bên cùng gọi một hàm
 * — nên nó xanh dù cả hai cùng sai. Ở đây kỳ vọng dựng từ `getOperatingCost()` / `getRecognizedCosts()`:
 * một đường tính KHÁC, đọc cùng sổ thẩm quyền bằng SQL.
 *
 * Tháng 6/2027 có 30 ngày, không fixture nào khác đụng tới.
 */
async function testOperatingCostByDayAuthority(db: Db) {
  const KY: Period = { key: "custom", from: d("2027-06-01"), to: dEnd("2027-06-30"), label: "Tháng 6/2027", fromKey: "2027-06-01", toKey: "2027-06-30" };
  const TUAN: Period = { key: "custom", from: d("2027-06-01"), to: dEnd("2027-06-07"), label: "Tuần 1 tháng 6/2027", fromKey: "2027-06-01", toKey: "2027-06-07" };
  // Vắt qua hai tháng dài khác nhau (30 và 31 ngày): lương cứng phải rải theo SỐ NGÀY THẬT của từng tháng.
  const VAT: Period = { key: "custom", from: d("2027-06-25"), to: dEnd("2027-07-05"), label: "25/06–05/07/2027", fromKey: "2027-06-25", toKey: "2027-07-05" };
  const donDep = async () => {
    await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'ob-%'`);
    clearMemo();
  };
  const truocDo = {
    mode: await getSettingJson<unknown>(PAYROLL_RECOGNITION_KEY, null),
    employees: await getSettingJson<unknown>(PAYROLL_EMPLOYEES_KEY, null),
  };
  await donDep();
  await db.insert(schema.expenses).values([
    { id: "ob-rent", category: "RENT", description: "Thuê mặt bằng tháng 6", amount: 3_000_000, occurredAt: d("2027-06-01"), allocationMethod: "PERIOD_PRORATA", periodStart: d("2027-06-01"), periodEnd: dEnd("2027-06-30") },
    { id: "ob-oneoff", category: "OTHER", description: "Sửa máy in", amount: 500_000, occurredAt: d("2027-06-10") },
    // Ba khoản mà sổ thẩm quyền LOẠI khỏi chi phí vận hành:
    { id: "ob-ads", category: "ADS", description: "Nạp tiền quảng cáo (gõ tay, trùng tài khoản QC)", amount: 700_000, occurredAt: d("2027-06-05") },
    { id: "ob-purchase", category: "PURCHASE", description: "Trả xưởng (dòng tiền, giá vốn đi theo phiếu kho)", amount: 5_000_000, occurredAt: d("2027-06-06") },
    { id: "ob-ship-dup", category: "SHIPPING", description: "Cước tháng 6 gõ tay (trùng vận đơn)", amount: 40_000, occurredAt: d("2027-06-07"), costSource: "MANUAL" },
    // Khoản ĐIỀU CHỈNH có lý do: engine tính vào thành phần Cước, KHÔNG vào khối vận hành.
    { id: "ob-ship-adj", category: "SHIPPING", description: "Đền bù kiện vỡ", amount: 150_000, occurredAt: d("2027-06-08"), costSource: "MANUAL_ADJUSTMENT", reason: "Đền bù ngoài cước vận đơn" },
    // Nhóm Lương: 12.000.000 ghi hai ngày, NHIỀU hơn lương cứng 9.000.000 ⇒ phần dư là hoa hồng.
    { id: "ob-salary-1", category: "SALARY", description: "Lương + hoa hồng đợt 1", amount: 6_000_000, occurredAt: d("2027-06-15") },
    { id: "ob-salary-2", category: "SALARY", description: "Lương + hoa hồng đợt 2", amount: 6_000_000, occurredAt: d("2027-06-20") },
  ]);

  const tong = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + v, 0);
  const doiChieu = async (ky: Period, nhan: string) => {
    clearMemo();
    const [theoNgay, engine, recognized] = await Promise.all([getOperatingCostByDay(ky, db), getOperatingCost(ky), getRecognizedCosts(ky)]);
    assert.equal(tong(theoNgay.byDay), engine.amount, `${nhan}: Σ các ngày phải BẰNG getOperatingCost() của cùng kỳ, tới từng đồng`);
    assert.equal(theoNgay.total, engine.amount, `${nhan}: tổng khai kèm phải bằng Σ các ngày`);
    assert.equal(engine.amount, recognized.operatingTotal, `${nhan}: hai cửa của engine nói cùng một con số`);
    return theoNgay;
  };

  // ══ A. Bảng Lương CHƯA cầm quyền (mặc định) ══
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  let ngay = await doiChieu(KY, "A. tháng, lương từ bảng Chi phí");
  assert.equal(tong(ngay.byDay), 3_000_000 + 500_000 + 12_000_000, "A. vận hành = thuê + sửa chữa + nhóm Lương; KHÔNG có ADS / PURCHASE / cước gõ tay");
  assert.equal(ngay.byDay.get("2027-06-05"), 100_000, "A. ngày 05/06 chỉ có phần thuê — 700.000 ADS gõ tay KHÔNG được cộng vào chi phí vận hành");
  assert.equal(ngay.byDay.get("2027-06-06"), 100_000, "A. ngày 06/06 chỉ có phần thuê — 5.000.000 trả xưởng là dòng tiền, không phải chi phí vận hành");
  assert.equal(ngay.byDay.get("2027-06-15"), 6_100_000, "A. lương chưa có bảng Lương cầm quyền ⇒ nằm đúng ngày ghi sổ");
  const loai = new Map(ngay.excluded.map((x) => [`${x.category}:${x.rule}`, x.amount]));
  assert.equal(loai.get("ADS:EXCLUDED_BY_AUTHORITY"), 700_000, "A. khoản ADS gõ tay phải được NÊU RA là bị loại, không biến mất im lặng");
  assert.equal(loai.get("PURCHASE:EXCLUDED_BY_AUTHORITY"), 5_000_000, "A. khoản trả xưởng phải được nêu ra là bị loại");
  assert.equal(loai.get("SHIPPING:DUPLICATE_LOGISTICS_COST_SOURCE"), 40_000, "A. cước gõ tay không khai điều chỉnh phải được nêu ra là trùng vận đơn");
  assert.deepEqual(
    { amount: ngay.logisticsAdjustment.amount, count: ngay.logisticsAdjustment.count, cuoc: ngay.logisticsAdjustment.shipping.amount, phiHoan: ngay.logisticsAdjustment.returnFee.amount },
    { amount: 150_000, count: 1, cuoc: 150_000, phiHoan: 0 },
    "A. khoản điều chỉnh cước có lý do: tách riêng, không vào khối vận hành, không bị vứt",
  );
  ngay = await doiChieu(TUAN, "A. tuần 01–07/06");
  assert.equal(tong(ngay.byDay), 700_000, "A. tuần = 7/30 tiền thuê; ADS / PURCHASE / cước gõ tay trong tuần đều không cộng");

  // Báo cáo lợi nhuận THEO NGÀY: cột chi QC chỉ đọc tài khoản QC, cột vận hành cộng lại = engine.
  clearMemo();
  const [daily, engineKy] = await Promise.all([getDailyBreakdown(KY, "created"), getOperatingCost(KY)]);
  const [qc] = await db
    .select({ v: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
    .from(schema.adSpends)
    .where(and(eq(schema.adSpends.excluded, false), sql`${schema.adSpends.spendDate} >= ${KY.from} and ${schema.adSpends.spendDate} <= ${KY.to}`));
  assert.equal(daily.reduce((t, r) => t + r.adSpend, 0), Number(qc?.v ?? 0), "biểu đồ theo ngày: chi QC = đúng tài khoản QC, KHÔNG cộng thêm 700.000 gõ tay (trừ hai lần)");
  assert.equal(daily.reduce((t, r) => t + r.operating, 0), engineKy.amount, "biểu đồ theo ngày: Σ chi phí vận hành = getOperatingCost() của cùng kỳ");

  // ══ B. Bảng Lương CẦM QUYỀN, lương cứng 9.000.000/tháng ══
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [{ id: "ob-emp-1", name: "Nhân sự kiểm thử", shortName: "KT", department: "Quản lý", aliases: [], accountIds: [], fixed: 9_000_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "" }] });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  ngay = await doiChieu(KY, "B. tháng, bảng Lương cầm quyền");
  assert.ok(ngay.payrollCovered, "B. bảng Lương phải đang cầm quyền ở ca này");
  // 3.000.000 thuê + 500.000 + 9.000.000 lương cứng + 3.000.000 phần dư (hoa hồng) — không mất, không trùng.
  assert.equal(tong(ngay.byDay), 15_500_000, "B. lương cứng từ bảng Lương + phần nhóm Lương vượt lương cứng, không cộng nguyên nhóm Lương lần nữa");
  assert.equal(ngay.byDay.get("2027-06-03"), 100_000 + 300_000, "B. lương cứng đi theo THỜI GIAN: mỗi ngày tháng 6 gánh 9.000.000 / 30");
  assert.equal(ngay.byDay.get("2027-06-15"), 100_000 + 300_000 + 1_500_000, "B. phần dư (hoa hồng) đi theo NGÀY của khoản chi đã ghi, KHÔNG chia đều theo lịch");
  ngay = await doiChieu(TUAN, "B. tuần 01–07/06");
  assert.equal(tong(ngay.byDay), 700_000 + 2_100_000, "B. tuần: 7/30 thuê + 7/30 lương cứng; tuần không có khoản Lương nào thì không có hoa hồng");
  ngay = await doiChieu(VAT, "B. kỳ vắt tháng 6 (30 ngày) → tháng 7 (31 ngày)");
  const luongNgayThang6 = (ngay.byDay.get("2027-06-26") ?? 0) - 100_000; // trừ phần thuê của ngày ấy
  const luongNgayThang7 = ngay.byDay.get("2027-07-02") ?? 0; // tháng 7 không có khoản thuê nào
  assert.ok(luongNgayThang6 > luongNgayThang7 && luongNgayThang7 > 0, `B. một ngày lương tháng 6 (30 ngày) đắt hơn một ngày tháng 7 (31 ngày): ${luongNgayThang6} vs ${luongNgayThang7}`);

  await setSettingJson(PAYROLL_RECOGNITION_KEY, truocDo.mode ?? { mode: "LEGACY_EXPENSES" });
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, truocDo.employees ?? { list: [] });
  await donDep();
  console.log(
    "✓ Chi phí theo ngày đi qua SỔ THẨM QUYỀN: Σ các ngày = getOperatingCost() ở tháng / tuần / kỳ vắt tháng, cả khi bảng Lương chưa và đã cầm quyền · ADS / PURCHASE / cước trùng vận đơn gõ tay không vào ngày nào và được NÊU RA · chi QC theo ngày chỉ đọc tài khoản QC · lương cứng theo thời gian, phần dư hoa hồng theo ngày ghi sổ",
  );
}

/**
 * ═══════ CƯỚC / PHÍ HOÀN ĐIỀU CHỈNH TAY: MỘT ĐƯỜNG (ENGINE), MỌI BÁO CÁO CÙNG MỘT SỐ ═══════
 *
 * Trước bản này Profit Engine tính khoản `MANUAL_ADJUSTMENT` có lý do vào thành phần Cước, còn
 * `pnl()`, bảng theo ngày, dòng tiền, bậc thang Sự thật tài chính và lợi nhuận danh nghĩa đều chỉ
 * cộng cước theo đơn — nên chúng khớp NHAU vì cùng THIẾU khoản ấy. Đối chiếu từng báo cáo với chính
 * nó thì không bao giờ thấy.
 *
 * Cách đo: chụp mọi báo cáo ba lần trên cùng kỳ — (0) chỉ có đơn + vận đơn; (1) thêm khoản cước /
 * phí hoàn gõ tay KHÔNG khai điều chỉnh; (2) thêm khoản ĐIỀU CHỈNH có lý do. (0)→(1) phải KHÔNG đổi
 * một đồng nào (trùng vận đơn, bị loại và được NÊU RA). (1)→(2) phải đổi ĐÚNG bằng khoản điều chỉnh
 * mà engine báo — không hơn (cộng hai lần), không kém (bỏ sót).
 *
 * Tháng 10/2027 (31 ngày), không fixture nào khác đụng tới.
 */
async function testLogisticsAdjustmentOnePath(db: Db) {
  const KY: Period = { key: "custom", from: d("2027-10-01"), to: dEnd("2027-10-31"), label: "Tháng 10/2027", fromKey: "2027-10-01", toKey: "2027-10-31" };
  const TUAN: Period = { key: "custom", from: d("2027-10-01"), to: dEnd("2027-10-07"), label: "Tuần 1 tháng 10/2027", fromKey: "2027-10-01", toKey: "2027-10-07" };
  const donDep = async () => {
    await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'lc-%'`);
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'lc-%'`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like 'lc-%'`);
    clearMemo();
  };
  await donDep();

  // Đơn GIAO THÀNH CÔNG có cước thật 30.000 và đơn HOÀN có cước 25.000 + phí hoàn 20.000, cùng kỳ.
  await db.insert(schema.orders).values([
    { id: "lc-order-giao", insertedAt: d("2027-10-05"), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: 600_000, partnerFee: 30_000, returnFee: 0, cod: 600_000 },
    { id: "lc-order-hoan", insertedAt: d("2027-10-06"), stage: "RETURNED", status: 6, totalPriceAfterDiscount: 400_000, partnerFee: 25_000, returnFee: 20_000, cod: 400_000 },
  ]);
  await db.insert(schema.orderItems).values([
    { id: "lc-item-giao", orderId: "lc-order-giao", productId: "lc-product", productName: "Mã kiểm thử cước", quantity: 1, unitPrice: 600_000, lineTotal: 600_000 },
    { id: "lc-item-hoan", orderId: "lc-order-hoan", productId: "lc-product", productName: "Mã kiểm thử cước", quantity: 1, unitPrice: 400_000, lineTotal: 400_000 },
  ]);
  await db.insert(schema.shipments).values([
    { id: "lc-ship-giao", orderId: "lc-order-giao", vtpOrderNumber: "LC0000000001", stage: "DELIVERED", shippingFee: 30_000, codAmount: 600_000, codCollected: 600_000, codStatus: "RECONCILED", deliveredAt: d("2027-10-07") },
    { id: "lc-ship-hoan", orderId: "lc-order-hoan", vtpOrderNumber: "LC0000000002", stage: "RETURNED", shippingFee: 0, codAmount: 400_000, codCollected: 0, codStatus: "PENDING", returnedAt: d("2027-10-12") },
  ]);

  const chup = async (ky: Period) => {
    clearMemo();
    const engine = await getRecognizedCosts(ky);
    const theoNgay = await getOperatingCostByDay(ky, db);
    const bc = await getProfitReport(ky, "created");
    const cash = await getCashProfitReport(ky);
    const truth = await getFinancialTruth(ky);
    const mkt = await getMarketingDaily(ky, "created");
    const nominal = await getNominalProfitReport(ky);
    const luong = (await getMarketerReport(ky, "profit1")).totals;
    const dong = (key: string) => truth.waterfall.find((l) => l.key === key)?.amount ?? Number.NaN;
    return {
      engine,
      theoNgay,
      pnl: bc.current,
      daily: bc.daily,
      cash,
      truth: { dieuChinh: dong("shipping_adjustment"), contribution: truth.contribution, estimatedProfit: truth.estimatedProfit },
      mkt: { cuoc: mkt.totals.shippingCost, rows: mkt.rows, warnings: mkt.warnings },
      nominal: { shipCost: nominal.totals.shipCost, rowsShip: nominal.rows.reduce((t, r) => t + r.shipCost, 0), expectedProfit: nominal.totals.expectedProfit, netProfit: nominal.totals.netProfit, adj: nominal.totals.logisticsAdjustment },
      luong: { profit: luong.profit, shipping: luong.shipping, adj: luong.logisticsAdjustment, adjCount: luong.logisticsAdjustmentCount, chuaChia: luong.logisticsAdjustmentUnallocated },
    };
  };
  const tong = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + v, 0);

  // ══ (0) Chỉ có đơn + vận đơn ══
  const s0 = await chup(KY);
  assert.equal(s0.engine.logisticsAdjustment.amount, 0, "(0) chưa có khoản điều chỉnh nào");
  assert.equal(s0.pnl.shipping, 55_000, "(0) cước theo đơn = 30.000 + 25.000");
  assert.equal(s0.pnl.returnFee, 20_000, "(0) phí hoàn ghi trên đơn");

  // ══ (1) Cước / phí hoàn gõ tay KHÔNG khai điều chỉnh — trùng vận đơn ⇒ KHÔNG được đổi một đồng nào ══
  await db.insert(schema.expenses).values([
    { id: "lc-ship-dup", category: "SHIPPING", description: "Cước tháng 10 gõ tay (trùng vận đơn)", amount: 30_000, occurredAt: d("2027-10-07"), costSource: "MANUAL" },
    { id: "lc-ret-dup", category: "RETURN_FEE", description: "Phí hoàn gõ tay (trùng vận đơn)", amount: 20_000, occurredAt: d("2027-10-12"), costSource: "MANUAL" },
  ]);
  // "Điều chỉnh" mà KHÔNG có lý do không lọt được vào CSDL — nên "không lý do" chỉ có một nghĩa: khoản thường, bị loại.
  await assert.rejects(
    async () => {
      await db.insert(schema.expenses).values({ id: "lc-adj-no-reason", category: "SHIPPING", description: "Điều chỉnh không lý do", amount: 99_000, occurredAt: d("2027-10-09"), costSource: "MANUAL_ADJUSTMENT", reason: "  " });
    },
    "CSDL phải chặn khoản điều chỉnh không kèm lý do (expenses_adjustment_reason_check)",
  );
  const s1 = await chup(KY);
  assert.equal(s1.engine.logisticsAdjustment.amount, 0, "(1) khoản gõ tay không khai điều chỉnh KHÔNG phải điều chỉnh");
  assert.equal(s1.engine.components.SHIPPING.amount, s0.engine.components.SHIPPING.amount, "(1) engine: cước không đổi — khoản trùng bị loại");
  assert.equal(s1.engine.components.RETURN_COST.amount, s0.engine.components.RETURN_COST.amount, "(1) engine: phí hoàn không đổi — khoản trùng bị loại");
  for (const k of ["shipping", "returnFee", "netProfit"] as const) assert.equal(s1.pnl[k], s0.pnl[k], `(1) pnl().${k} không đổi vì khoản trùng vận đơn`);
  assert.equal(s1.cash.cashOut.total, s0.cash.cashOut.total, "(1) dòng tiền: tiền ra không đổi");
  assert.equal(s1.truth.estimatedProfit, s0.truth.estimatedProfit, "(1) Sự thật tài chính không đổi");
  assert.equal(s1.mkt.cuoc, s0.mkt.cuoc, "(1) marketing theo ngày: cột cước không đổi");
  assert.equal(s1.nominal.netProfit, s0.nominal.netProfit, "(1) lợi nhuận danh nghĩa không đổi");
  assert.equal(s1.luong.profit, s0.luong.profit, "(1) lợi nhuận tính lương không đổi — khoản trùng vận đơn không được trừ lần hai");
  assert.equal(s1.luong.adj, 0, "(1) bảng lương: khoản không khai điều chỉnh KHÔNG phải điều chỉnh");
  const loai = new Map(s1.theoNgay.excluded.map((x) => [`${x.category}:${x.rule}`, x]));
  assert.equal(loai.get("SHIPPING:DUPLICATE_LOGISTICS_COST_SOURCE")?.amount, 30_000, "(1) khoản cước trùng phải được NÊU RA");
  assert.equal(loai.get("RETURN_FEE:DUPLICATE_LOGISTICS_COST_SOURCE")?.amount, 20_000, "(1) khoản phí hoàn trùng phải được NÊU RA");
  const canhBao = s1.engine.warnings.find((w) => w.rule === "DUPLICATE_LOGISTICS_COST_SOURCE");
  assert.equal(canhBao?.amount, 50_000, "(1) engine nêu đúng số tiền bị loại");
  assert.equal(canhBao?.count, 2);

  // ══ (2) Khoản ĐIỀU CHỈNH có lý do: một lần, một theo kỳ, một phí hoàn ══
  await db.insert(schema.expenses).values([
    { id: "lc-ship-adj", category: "SHIPPING", description: "Đền bù kiện vỡ", amount: 150_000, occurredAt: d("2027-10-08"), costSource: "MANUAL_ADJUSTMENT", reason: "Đền bù cho khách, không thuộc vận đơn nào" },
    // Theo kỳ: 310.000 cho 31 ngày ⇒ đúng 10.000 mỗi ngày (luật 14: chi phí theo thời gian chia theo số ngày).
    { id: "lc-ship-adj-ky", category: "SHIPPING", description: "Thuê xe gom hàng cả tháng", amount: 310_000, occurredAt: d("2027-10-01"), allocationMethod: "PERIOD_PRORATA", periodStart: d("2027-10-01"), periodEnd: dEnd("2027-10-31"), costSource: "MANUAL_ADJUSTMENT", reason: "Cước chuyến gom hàng, không gắn vận đơn" },
    { id: "lc-ret-adj", category: "RETURN_FEE", description: "Phí lưu kho hàng hoàn", amount: 60_000, occurredAt: d("2027-10-12"), costSource: "MANUAL_ADJUSTMENT", reason: "ĐVVC thu riêng, không nằm trên bảng kê" },
  ]);
  const s2 = await chup(KY);

  // Engine — nguồn DUY NHẤT: cước điều chỉnh vào Cước, phí hoàn điều chỉnh vào Phí hoàn (không lẫn nhau).
  assert.deepEqual(s2.engine.logisticsAdjustment, { shipping: 460_000, returnFee: 60_000, amount: 520_000, count: 3 }, "(2) engine: 150.000 + 310.000 cước, 60.000 phí hoàn, 3 khoản");
  assert.equal(s2.engine.components.SHIPPING.amount - s1.engine.components.SHIPPING.amount, 460_000, "(2) engine: thành phần Cước tăng đúng phần cước điều chỉnh");
  assert.equal(s2.engine.components.RETURN_COST.amount - s1.engine.components.RETURN_COST.amount, 60_000, "(2) engine: phí hoàn điều chỉnh vào thành phần Phí hoàn, KHÔNG vào Cước");
  assert.equal(s2.engine.operatingTotal, s1.engine.operatingTotal, "(2) engine: khoản điều chỉnh cước KHÔNG vào khối vận hành");

  // Theo ngày: rải đúng phương thức phân bổ, Σ = engine tới từng đồng.
  const adj = s2.theoNgay.logisticsAdjustment;
  assert.equal(tong(adj.shipping.byDay), s2.engine.logisticsAdjustment.shipping, "(2) Σ cước điều chỉnh theo ngày = engine");
  assert.equal(tong(adj.returnFee.byDay), s2.engine.logisticsAdjustment.returnFee, "(2) Σ phí hoàn điều chỉnh theo ngày = engine");
  assert.equal(adj.count, 3);
  assert.equal(adj.shipping.byDay.get("2027-10-08"), 150_000 + 10_000, "(2) khoản một lần nằm trọn ngày phát sinh, cộng phần của khoản theo kỳ");
  assert.equal(adj.shipping.byDay.get("2027-10-20"), 10_000, "(2) khoản theo kỳ: mỗi ngày đúng 10.000, kể cả ngày không có đơn");
  assert.equal(adj.shipping.byDay.size, 31, "(2) khoản theo kỳ: CẢ 31 ngày đều gánh phần của mình");
  assert.equal(adj.returnFee.byDay.get("2027-10-12"), 60_000);
  assert.ok(!s2.theoNgay.excluded.some((x) => x.amount === 150_000 || x.amount === 310_000 || x.amount === 60_000), "(2) khoản điều chỉnh không bị nêu nhầm là bị loại");

  // Bảng kết quả kinh doanh `pnl()`: đổi ĐÚNG bằng khoản điều chỉnh, và bằng thành phần của engine.
  assert.equal(s2.pnl.shipping - s1.pnl.shipping, 460_000, "(2) pnl(): cước tăng đúng phần điều chỉnh — trước đây bỏ sót");
  assert.equal(s2.pnl.returnFee - s1.pnl.returnFee, 60_000, "(2) pnl(): phí hoàn tăng đúng phần điều chỉnh");
  assert.equal(s1.pnl.netProfit - s2.pnl.netProfit, 520_000, "(2) pnl(): lợi nhuận ròng giảm ĐÚNG 520.000 — không hơn (hai lần), không kém (bỏ sót)");
  assert.equal(s2.pnl.logisticsAdjustment, 520_000);
  assert.equal(s2.pnl.shipping, s2.engine.components.SHIPPING.amount, "(2) pnl() và engine: cùng một con số cước (fixture: mọi đơn đã gửi đều có kết cục)");
  assert.equal(s2.pnl.returnFee, s2.engine.components.RETURN_COST.amount, "(2) pnl() và engine: cùng một con số phí hoàn");

  // Báo cáo theo ngày: Σ các ngày = pnl() tới từng đồng, ở cả ba cột.
  const sumDaily = (k: "shipping" | "returnFee" | "netProfit") => s2.daily.reduce((t, r) => t + r[k], 0);
  assert.equal(sumDaily("shipping"), s2.pnl.shipping, "(2) theo ngày: Σ cước = pnl()");
  assert.equal(sumDaily("returnFee"), s2.pnl.returnFee, "(2) theo ngày: Σ phí hoàn = pnl()");
  assert.equal(sumDaily("netProfit"), s2.pnl.netProfit, "(2) theo ngày: Σ lợi nhuận ròng = pnl()");
  assert.equal(s2.daily.find((r) => r.day === "2027-10-20")?.shipping, 10_000, "(2) theo ngày: ngày không có đơn vẫn gánh phần cước theo kỳ");

  // Hiệu quả marketing theo ngày (toàn shop): cột cước gồm khoản điều chỉnh, và không còn câu cảnh báo tạm.
  assert.equal(s2.mkt.cuoc - s1.mkt.cuoc, 520_000, "(2) marketing theo ngày: cột cước + phí hoàn tăng đúng 520.000");
  assert.equal(s2.mkt.cuoc, s2.pnl.shipping + s2.pnl.returnFee + s2.pnl.marketplaceFee, "(2) marketing theo ngày = Báo cáo lợi nhuận");
  assert.ok(!s2.mkt.warnings.some((w) => w.includes("khai ĐIỀU CHỈNH có lý do")), "(2) câu cảnh báo 'không nằm trong cột' đã hết đúng — phải gỡ");

  // Dòng tiền: tiền ra tăng đúng khoản điều chỉnh (không nằm trên vận đơn, cũng không trên bảng kê).
  assert.equal(s2.cash.cashOut.logisticsAdjustment, 520_000);
  assert.equal(s2.cash.cashOut.total - s1.cash.cashOut.total, 520_000, "(2) dòng tiền: tiền ra tăng đúng khoản điều chỉnh");

  // Sự thật tài chính: dòng riêng, và lợi nhuận góp / ước tính giảm đúng bằng nó.
  assert.equal(s2.truth.dieuChinh, -520_000, "(2) bậc thang: dòng điều chỉnh mang dấu âm, đúng số");
  assert.equal(s1.truth.contribution - s2.truth.contribution, 520_000, "(2) bậc thang: lợi nhuận góp giảm đúng khoản điều chỉnh");

  // Lợi nhuận danh nghĩa: cột cước (ước tính) cộng khoản điều chỉnh (thật), Σ các mã = dòng tổng.
  assert.equal(s2.nominal.adj.amount, 520_000);
  assert.equal(s2.nominal.shipCost - s1.nominal.shipCost, 520_000, "(2) danh nghĩa: cước tăng đúng khoản điều chỉnh");
  assert.equal(s2.nominal.rowsShip, s2.nominal.shipCost, "(2) danh nghĩa: phần điều chỉnh đã chia hết cho các mã — Σ các mã = dòng tổng");
  assert.equal(s1.nominal.netProfit - s2.nominal.netProfit, 520_000, "(2) danh nghĩa: lợi nhuận ròng giảm đúng khoản điều chỉnh");

  // Cơ sở tính lương: cùng khoản, cùng nguồn (engine), cùng độ giảm với Báo cáo lợi nhuận — trước đây bỏ sót.
  assert.equal(s2.luong.adj, s2.engine.logisticsAdjustment.amount, "(2) bảng lương đọc khoản điều chỉnh từ ENGINE, không tự đọc bảng Chi phí");
  assert.equal(s2.luong.adjCount, 3);
  assert.equal(s2.luong.shipping - s1.luong.shipping, 520_000, "(2) bảng lương: cột vận chuyển tăng đúng 520.000");
  assert.equal(s1.luong.profit - s2.luong.profit, s1.pnl.netProfit - s2.pnl.netProfit, "(2) lợi nhuận tính lương giảm ĐÚNG bằng độ giảm lợi nhuận ròng của Báo cáo lợi nhuận");
  assert.equal(s1.luong.profit - s2.luong.profit, 520_000, "(2) và bằng đúng khoản điều chỉnh — không hơn (hai lần), không kém (bỏ sót)");
  assert.equal(s2.luong.chuaChia, 0, "(2) kỳ có đơn gửi ⇒ khoản điều chỉnh chia hết xuống mã");

  // ══ Tuần 01–07/10: chỉ 7/31 khoản theo kỳ, khoản một lần 08/10 và phí hoàn 12/10 nằm NGOÀI ══
  clearMemo();
  const [tuanEngine, tuanBc] = [await getRecognizedCosts(TUAN), await getProfitReport(TUAN, "created")];
  assert.deepEqual(tuanEngine.logisticsAdjustment, { shipping: 70_000, returnFee: 0, amount: 70_000, count: 1 }, "tuần: 7 ngày × 10.000 của khoản theo kỳ");
  assert.equal(tuanBc.current.shipping, 55_000 + 70_000, "tuần: pnl() = cước hai đơn trong tuần + 70.000 điều chỉnh");
  assert.equal(tuanBc.daily.reduce((t, r) => t + r.shipping, 0), tuanBc.current.shipping, "tuần: Σ theo ngày = pnl()");

  await donDep();
  console.log(
    "✓ Cước / phí hoàn điều chỉnh tay đi MỘT đường (engine): khoản không khai điều chỉnh bị loại và được nêu ra, không đổi một đồng · khoản có lý do đổi pnl() / theo ngày / marketing / dòng tiền / sự thật tài chính / danh nghĩa / lợi nhuận tính lương ĐÚNG bằng số engine báo · rải theo phương thức phân bổ của từng khoản, Σ ngày = tổng kỳ",
  );
}

/**
 * ═══════ BẢNG LƯƠNG TRỪ CƯỚC ĐIỀU CHỈNH — CHỈ Ở KỲ CHƯA KHOÁ ═══════
 *
 * Trước bản này cơ sở tính lương là báo cáo DUY NHẤT còn bỏ sót cước / phí hoàn gõ tay khai
 * `MANUAL_ADJUSTMENT` kèm lý do: lợi nhuận tính lương cao hơn sự thật đúng bằng khoản ấy, và thưởng
 * theo % lợi nhuận cao theo. Sửa nó là đổi số tiền trả người, nên bộ này khoá HAI chiều:
 *
 *  · KỲ MỞ (11/2027): lợi nhuận tính lương giảm ĐÚNG khoản điều chỉnh, bằng độ giảm của Báo cáo lợi
 *    nhuận; thưởng theo % lợi nhuận tổng giảm ĐÚNG khoản ấy × tỷ lệ; khoản gõ tay không khai điều
 *    chỉnh không đổi một đồng.
 *  · KỲ ĐÃ KHOÁ (12/2027): thêm khoản điều chỉnh SAU ngày khoá ⇒ ảnh chụp KHÔNG đổi một đồng; phần
 *    chênh chỉ hiện ở ĐỀ XUẤT ĐIỀU CHỈNH, đúng bằng khoản ấy (và × tỷ lệ ở tổng lương).
 *
 * Doanh thu lớn (20 triệu/tháng) để lợi nhuận tính lương DƯƠNG sau chi phí cố định giả định — ở kỳ
 * lỗ thì thưởng bằng 0 cả trước lẫn sau, và bài kiểm không phân biệt được "đã trừ" với "bỏ sót".
 */
async function testPayrollLogisticsAdjustment(db: Db) {
  const MO: Period = { key: "custom", from: d("2027-11-01"), to: dEnd("2027-11-30"), label: "Tháng 11/2027", fromKey: "2027-11-01", toKey: "2027-11-30" };
  const KHOA: Period = { key: "custom", from: d("2027-12-01"), to: dEnd("2027-12-31"), label: "Tháng 12/2027", fromKey: "2027-12-01", toKey: "2027-12-31" };
  const khoaKy = payrollPeriodKey(KHOA.from, KHOA.to);
  assert.ok(khoaKy, "kỳ có mốc đầu/cuối phải có khoá");
  const donDep = async () => {
    await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} = ${khoaKy}`);
    await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'pl-%'`);
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'pl-%'`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like 'pl-%'`);
    clearMemo();
  };
  const nhanSuTruocDo = await getSettingJson<unknown>(PAYROLL_EMPLOYEES_KEY, null);
  await donDep();
  // 10% lợi nhuận tổng, không lương cứng ⇒ tổng lương = đúng 10% lợi nhuận tính lương (khi dương).
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, {
    list: [{ id: "pl-emp-1", name: "Nhân sự kiểm thử cước", shortName: "KTC", department: "Quản lý", aliases: [], accountIds: [], userEmail: "", fixed: 0, percentTotal: 10, percentPersonal: 0, percentRevenue: 0, active: true, note: "" }],
  });

  const donGiao = (id: string, ngay: string, maVanDon: string) => ({
    order: { id, insertedAt: d(ngay), stage: "DELIVERED" as const, status: 3, totalPriceAfterDiscount: 20_000_000, partnerFee: 30_000, returnFee: 0, cod: 20_000_000 },
    item: { id: `${id}-item`, orderId: id, productId: "pl-product", productName: "Mã kiểm thử lương cước", quantity: 1, unitPrice: 20_000_000, lineTotal: 20_000_000 },
    ship: { id: `${id}-ship`, orderId: id, vtpOrderNumber: maVanDon, stage: "DELIVERED" as const, shippingFee: 30_000, codAmount: 20_000_000, codCollected: 20_000_000, codStatus: "RECONCILED" as const, deliveredAt: d(ngay) },
  });
  const nov = donGiao("pl-order-nov", "2027-11-10", "PL0000000011");
  const dec = donGiao("pl-order-dec", "2027-12-10", "PL0000000012");
  await db.insert(schema.orders).values([nov.order, dec.order]);
  await db.insert(schema.orderItems).values([nov.item, dec.item]);
  await db.insert(schema.shipments).values([nov.ship, dec.ship]);

  const chup = async (ky: Period) => {
    clearMemo();
    const [luong, bc, engine] = [await getPayrollReport(ky, "profit1"), await getProfitReport(ky, "created"), await getRecognizedCosts(ky)];
    const dong = luong.lines.find((l) => l.employee.id === "pl-emp-1");
    return { luong, dong, pnl: bc.current, engine };
  };

  /* ══ KỲ MỞ ══ */
  const m0 = await chup(MO);
  assert.ok(m0.luong.totalProfit > 2_000_000, `tiền đề: lợi nhuận tính lương tháng 11 phải DƯƠNG đủ lớn để thưởng phân biệt được (${m0.luong.totalProfit})`);
  assert.equal(m0.dong?.bonusTotal, Math.round(m0.luong.totalProfit * 0.1), "tiền đề: thưởng = 10% lợi nhuận tổng");

  // Khoản gõ tay KHÔNG khai điều chỉnh: trùng vận đơn ⇒ bị loại, không đổi một đồng.
  await db.insert(schema.expenses).values({ id: "pl-ship-dup", category: "SHIPPING", description: "Cước tháng 11 gõ tay (trùng vận đơn)", amount: 500_000, occurredAt: d("2027-11-12"), costSource: "MANUAL" });
  const m1 = await chup(MO);
  assert.equal(m1.luong.totalProfit, m0.luong.totalProfit, "kỳ mở: khoản trùng vận đơn không được trừ vào lợi nhuận tính lương");
  assert.equal(m1.luong.totalSalary, m0.luong.totalSalary, "kỳ mở: và không đổi lương");

  // Khoản ĐIỀU CHỈNH có lý do: một cước, một phí hoàn.
  await db.insert(schema.expenses).values([
    { id: "pl-ship-adj", category: "SHIPPING", description: "Đền bù kiện vỡ", amount: 1_000_000, occurredAt: d("2027-11-15"), costSource: "MANUAL_ADJUSTMENT", reason: "Đền bù cho khách, không thuộc vận đơn nào" },
    { id: "pl-ret-adj", category: "RETURN_FEE", description: "Phí lưu kho hàng hoàn", amount: 200_000, occurredAt: d("2027-11-18"), costSource: "MANUAL_ADJUSTMENT", reason: "ĐVVC thu riêng, không nằm trên bảng kê" },
  ]);
  const m2 = await chup(MO);
  assert.equal(m2.engine.logisticsAdjustment.amount, 1_200_000, "engine: 1.000.000 cước + 200.000 phí hoàn điều chỉnh");
  assert.equal(m2.luong.marketers.totals.logisticsAdjustment, m2.engine.logisticsAdjustment.amount, "kỳ mở: bảng lương đọc khoản điều chỉnh từ ENGINE");
  assert.equal(m2.luong.marketers.totals.logisticsAdjustmentCount, 2);
  assert.equal(m1.luong.totalProfit - m2.luong.totalProfit, 1_200_000, "kỳ mở: lợi nhuận tính lương giảm ĐÚNG khoản điều chỉnh");
  assert.equal(
    m1.luong.totalProfit - m2.luong.totalProfit,
    m1.pnl.netProfit - m2.pnl.netProfit,
    "kỳ mở: lợi nhuận tính lương và Báo cáo lợi nhuận giảm CÙNG một khoản — hai nơi không được nói hai số",
  );
  assert.equal(m2.luong.marketers.totals.shipping - m1.luong.marketers.totals.shipping, 1_200_000, "kỳ mở: cột vận chuyển của bảng lương tăng đúng khoản điều chỉnh");
  assert.equal(
    m2.luong.marketers.products.reduce((t, p) => t + p.shipping, 0) + m2.luong.marketers.totals.logisticsAdjustmentUnallocated,
    m2.luong.marketers.totals.shipping,
    "kỳ mở: Σ vận chuyển các mã + phần chưa chia = cột tổng — không đồng nào rơi ngoài",
  );
  assert.equal(m2.luong.marketers.totals.logisticsAdjustmentUnallocated, 0, "kỳ mở: có đơn gửi ⇒ chia hết xuống mã");
  assert.equal((m1.dong?.bonusTotal ?? 0) - (m2.dong?.bonusTotal ?? 0), 120_000, "kỳ mở: thưởng 10% lợi nhuận tổng giảm ĐÚNG 1.200.000 × 10%");
  assert.equal((m1.luong.totalSalary ?? 0) - (m2.luong.totalSalary ?? 0), 120_000, "kỳ mở: tổng lương giảm đúng khoản điều chỉnh × tỷ lệ");

  // Kỳ 15–18/11: có hai khoản điều chỉnh nhưng KHÔNG có đơn nào ⇒ không có căn cứ chia xuống mã.
  // Khoản ấy phải ở lại CẤP SHOP và vẫn bị trừ — không được lặng lẽ biến khỏi lợi nhuận tính lương.
  const KHONG_DON: Period = { key: "custom", from: d("2027-11-15"), to: dEnd("2027-11-18"), label: "15–18/11/2027", fromKey: "2027-11-15", toKey: "2027-11-18" };
  clearMemo();
  const trong = (await getMarketerReport(KHONG_DON, "profit1")).totals;
  assert.equal(trong.logisticsAdjustment, 1_200_000, "kỳ không đơn: engine vẫn báo đủ khoản điều chỉnh");
  assert.equal(trong.logisticsAdjustmentUnallocated, 1_200_000, "kỳ không đơn: toàn bộ khoản ở lại cấp shop");
  assert.ok(trong.shipping >= 1_200_000, "kỳ không đơn: cột vận chuyển tổng vẫn gồm khoản ấy");
  const khongDonMaHang = (await getMarketerReport(KHONG_DON, "profit1")).products.reduce((t, p) => t + p.profit, 0);
  assert.equal(
    trong.profit,
    khongDonMaHang - trong.testSpend - trong.sharedUnallocated - trong.logisticsAdjustmentUnallocated,
    "kỳ không đơn: lợi nhuận shop = Σ lợi nhuận các mã − QC test − chi phí chung chưa chia − cước điều chỉnh chưa chia",
  );

  /* ══ KỲ ĐÃ KHOÁ ══ */
  const k0 = await chup(KHOA);
  assert.ok(k0.luong.totalProfit > 2_000_000, "tiền đề: lợi nhuận tính lương tháng 12 dương");
  const anh = buildPayrollSnapshot(k0.luong, KHOA, khoaKy!);
  assert.equal(anh.calcVersion, PAYROLL_CALC_VERSION);
  const bayGio = new Date();
  await db.insert(schema.payrollPeriods).values({
    periodKey: khoaKy!,
    periodStart: KHOA.from!,
    periodEnd: KHOA.to!,
    basis: "profit1",
    status: "LOCKED",
    snapshot: anh,
    calcVersion: PAYROLL_CALC_VERSION,
    finalizedAt: bayGio,
    approvedAt: bayGio,
    lockedAt: bayGio,
  });
  // Chứng từ về SAU ngày khoá: một khoản cước điều chỉnh có lý do rơi vào tháng 12.
  await db.insert(schema.expenses).values({ id: "pl-ship-adj-dec", category: "SHIPPING", description: "Cước chuyến gom hàng tháng 12", amount: 800_000, occurredAt: d("2027-12-20"), costSource: "MANUAL_ADJUSTMENT", reason: "Chuyến gom hàng không gắn vận đơn" });
  clearMemo();
  const trangThai = await getPayrollPeriodState(KHOA, "profit1");
  assert.equal(trangThai.frozen, true, "kỳ khoá là kỳ đóng băng");
  assert.equal(trangThai.snapshot?.totalProfit, k0.luong.totalProfit, "KỲ ĐÃ KHOÁ: lợi nhuận tính lương của ảnh chụp KHÔNG đổi một đồng");
  assert.equal(trangThai.snapshot?.totalSalary, k0.luong.totalSalary, "KỲ ĐÃ KHOÁ: tổng lương KHÔNG đổi một đồng");
  assert.equal(trangThai.snapshot?.lines.find((l) => l.employeeId === "pl-emp-1")?.salary, k0.dong?.salary, "KỲ ĐÃ KHOÁ: dòng lương của từng người KHÔNG đổi");
  // Bản tính sống đã đổi — và phần chênh PHẢI hiện ra như đề xuất điều chỉnh, đúng số.
  const k1 = await chup(KHOA);
  assert.equal(k0.luong.totalProfit - k1.luong.totalProfit, 800_000, "bản tính sống của tháng 12 đã trừ khoản mới");
  const chenh = payrollDrift(trangThai.snapshot!, k1.luong);
  assert.equal(chenh.find((c) => c.field === "totalProfit")?.diff, -800_000, "đề xuất điều chỉnh nêu đúng −800.000 lợi nhuận tính lương");
  assert.equal(chenh.find((c) => c.field === "totalSalary")?.diff, -80_000, "và đúng −80.000 tổng lương (800.000 × 10%) — người quyết có sửa hay không, máy không tự sửa");

  await donDep();
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, nhanSuTruocDo ?? { list: [] });
  clearMemo();
  console.log(
    "✓ Bảng lương trừ cước / phí hoàn điều chỉnh tay có lý do: kỳ mở — lợi nhuận tính lương giảm đúng khoản engine báo, bằng độ giảm của Báo cáo lợi nhuận, thưởng giảm đúng khoản × tỷ lệ; khoản không khai điều chỉnh không đổi một đồng · kỳ đã khoá — ảnh chụp không đổi một đồng, phần chênh chỉ hiện ở đề xuất điều chỉnh",
  );
}
