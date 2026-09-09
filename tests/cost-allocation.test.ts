import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { allocateExpenseToRange, distributeProportionally, inclusiveDays, inventoryRiskExposure, inventoryRiskOnSold, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import { allocatedExpenseByDay, allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";

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
  const byDay = await allocatedExpenseByDay(db, d("2026-09-01"), dEnd("2026-09-30"));
  const ngay01 = byDay.get("2026-09-01")?.other ?? 0;
  const ngay20 = byDay.get("2026-09-20")?.other ?? 0;
  assert.ok(ngay01 > 0 && ngay20 > 0, "theo ngày: mọi ngày trong kỳ thuê đều có chi phí, không chỉ ngày ghi sổ");
  assert.ok(Math.abs(ngay01 - ngay20) <= 1, "theo ngày: tiền thuê rải đều, hai ngày bất kỳ chênh nhau tối đa 1đ");
  assert.ok(ngay01 < 100_000, "theo ngày: KHÔNG được dồn cả 2.000.000đ vào ngày 01/09");
  const tongTheoNgay = [...byDay.values()].reduce((t, v) => t + v.ads + v.other, 0);
  assert.equal(tongTheoNgay, 2_500_000, "theo ngày: cộng 30 ngày = đúng tổng đã phân bổ của kỳ, không thừa không thiếu");
  const ngay10 = byDay.get("2026-09-10")?.other ?? 0;
  assert.ok(Math.abs(ngay10 - (ngay01 + 500_000)) <= 1, "theo ngày: ngày 10 = phần thuê của ngày đó + trọn khoản một lần 500K");

  await db.delete(schema.expenses).where(sql`${schema.expenses.id} in ('ca-rent','ca-oneoff')`);

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
  const PHAI_DUNG_BO_MAY_PHAN_BO = [
    "lib/queries/profit-nominal.ts",
    "lib/queries/profit-cash.ts",
    "lib/queries/payroll.ts",
    "lib/queries/dashboard.ts",
    "lib/queries/financial-truth.ts",
    "lib/queries/reports.ts",
  ];
  for (const file of PHAI_DUNG_BO_MAY_PHAN_BO) {
    const src = readFileSync(file, "utf8");
    const thoSo = /sum\(\s*\$\{\s*schema\.expenses\.amount\s*\}\s*\)/.test(src) || /sum\(schema\.expenses\.amount\)/.test(src);
    assert.equal(thoSo, false, `${file}: cộng thẳng expenses.amount — phải đi qua Profit Engine, nếu không khoản theo kỳ lại rơi trọn vào một kỳ`);
    // Báo cáo KHÔNG được tự quyết định nguồn nào có thẩm quyền: phải hỏi Profit Engine
    // (`getOperatingCost` / `getRecognizedCosts`) hoặc dùng bộ phân bổ theo ngày dùng chung.
    assert.ok(
      /getOperatingCost|getRecognizedCosts|allocatedExpenseByDay/.test(src),
      `${file}: phải lấy chi phí vận hành qua Profit Engine, không tự cộng theo cách riêng`,
    );
    // Không trang nào được tự gõ lại danh sách nhóm bị loại — đó chính là chỗ SHIPPING và
    // RETURN_FEE bị bỏ sót và bị trừ hai lần suốt một thời gian dài.
    assert.equal(/not in \('ADS','PURCHASE'\)/.test(src), false, `${file}: còn gõ tay danh sách nhóm bị loại`);
  }

  console.log(
    "✓ Phân bổ chi phí theo kỳ: thuê tháng không còn cộng nguyên vào một tuần · hai khoảng liền nhau cộng đúng tổng · khoản một lần đúng kỳ · tháng nhuận đúng · SQL khớp TypeScript · rải đều theo ngày",
  );
  console.log(
    "✓ Rủi ro tồn kho đi theo HÀNG BÁN RA: tuần bán 1/10 lô chỉ gánh 1/10 dự phòng, cộng cả vòng đời vẫn đúng % giá trị lô, phần hàng chưa bán hiện riêng · chia chi phí cho các mã cộng lại đúng tổng",
  );
}
