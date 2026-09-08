import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { allocateExpenseToRange, inclusiveDays, type AllocatableExpense } from "@/lib/constants/cost-allocation";
import { allocatedExpenseSum, expenseInRange } from "@/lib/queries/cost-allocation";

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

  await db.delete(schema.expenses).where(sql`${schema.expenses.id} in ('ca-rent','ca-oneoff')`);

  console.log(
    "✓ Phân bổ chi phí theo kỳ: thuê tháng không còn cộng nguyên vào một tuần · hai khoảng liền nhau cộng đúng tổng · khoản một lần đúng kỳ · tháng nhuận đúng · SQL khớp TypeScript",
  );
}
