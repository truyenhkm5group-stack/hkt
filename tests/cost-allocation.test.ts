import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { allocateExpenseToRange, distributeProportionally, inclusiveDays, inventoryRiskExposure, inventoryRiskOnSold, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import { allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";
import { getOperatingCost, getOperatingCostByDay, getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getDailyBreakdown } from "@/lib/queries/reports";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY } from "@/lib/constants/payroll";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
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
  assert.deepEqual(ngay.logisticsAdjustment, { amount: 150_000, count: 1 }, "A. khoản điều chỉnh cước có lý do: tách riêng, không vào khối vận hành, không bị vứt");
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
