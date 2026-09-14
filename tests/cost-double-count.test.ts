import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import { PAYROLL_EMPLOYEES_KEY } from "@/lib/constants/payroll";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getRecognizedPayrollCost, PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ KHÔNG MỘT ĐỒNG NÀO ĐƯỢC TRỪ HAI LẦN ═══════════
 *
 * Trừ hai lần nguy hiểm hơn thiếu dữ liệu ở chỗ nó KHÔNG trông giống lỗi: lợi nhuận chỉ thấp hơn
 * thực tế một chút, và ai cũng tin. Còn mất hẳn một khoản thì lợi nhuận cao đẹp — cũng không ai
 * nghi. Bộ này khoá cả hai hướng.
 *
 * Dữ liệu đặt ở tháng 01/2027 để không chạm vào fixture của các bộ khác.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const KY: Period = { key: "custom", from: d("2027-01-01"), to: dEnd("2027-01-31"), label: "Tháng 1/2027", fromKey: "2027-01-01", toKey: "2027-01-31" };
const TUAN: Period = { key: "custom", from: d("2027-01-01"), to: dEnd("2027-01-07"), label: "Tuần 1", fromKey: "2027-01-01", toKey: "2027-01-07" };
/** Tháng 4/2027 có ĐÚNG 30 ngày — dùng cho quy ước "lương tháng 30 ngày" của yêu cầu */
const THANG30: Period = { key: "custom", from: d("2027-04-01"), to: dEnd("2027-04-30"), label: "Tháng 4/2027", fromKey: "2027-04-01", toKey: "2027-04-30" };
const TUAN30: Period = { key: "custom", from: d("2027-04-01"), to: dEnd("2027-04-07"), label: "Tuần 1 tháng 4", fromKey: "2027-04-01", toKey: "2027-04-07" };

async function reset(db: Db) {
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'dc-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'dc-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'dc-%'`);
  clearMemo();
}

export async function testCostDoubleCount(db: Db) {
  await reset(db);

  // ══ Chuẩn bị: một đơn GIAO THÀNH CÔNG có cước 20.000đ, và một đơn HOÀN có phí hoàn 25.000đ ══
  await db.insert(schema.orders).values([
    {
      id: "dc-order-delivered", insertedAt: d("2027-01-10"), stage: "DELIVERED", status: 3,
      totalPriceAfterDiscount: 500_000, partnerFee: 20_000, returnFee: 0, cod: 500_000,
    },
    {
      id: "dc-order-returned", insertedAt: d("2027-01-11"), stage: "RETURNED", status: 6,
      totalPriceAfterDiscount: 400_000, partnerFee: 0, returnFee: 25_000, cod: 400_000,
    },
  ]);
  await db.insert(schema.shipments).values([
    {
      id: "dc-ship-1", orderId: "dc-order-delivered", vtpOrderNumber: "DC0000000001", stage: "DELIVERED",
      shippingFee: 20_000, codAmount: 500_000, codCollected: 500_000, codStatus: "RECONCILED", deliveredAt: d("2027-01-12"),
    },
    {
      id: "dc-ship-2", orderId: "dc-order-returned", vtpOrderNumber: "DC0000000002", stage: "RETURNED",
      shippingFee: 0, codAmount: 400_000, codCollected: 0, codStatus: "PENDING", returnedAt: d("2027-01-13"),
    },
  ]);

  // ══ TEST 1 — CƯỚC CHIỀU ĐI ══
  // Cước 20.000đ đã nằm ở vận đơn. Ai đó ghi thêm một khoản chi "Phí giao hàng" 20.000đ cho CÙNG
  // khoản đó ⇒ chi phí cước phải vẫn là 20.000đ, KHÔNG phải 40.000đ.
  await db.insert(schema.expenses).values({
    id: "dc-exp-shipping", category: "SHIPPING", description: "Cước ĐVVC tháng 1 (ghi tay, trùng vận đơn)",
    amount: 20_000, occurredAt: d("2027-01-12"), costSource: "MANUAL",
  });
  clearMemo();
  let costs = await getRecognizedCosts(KY);
  assert.equal(costs.components.SHIPPING.amount, 20_000, "1. cước = 20.000đ theo vận đơn, KHÔNG cộng thêm khoản gõ tay trùng");
  const dupWarn = costs.warnings.find((w) => w.rule === "DUPLICATE_LOGISTICS_COST_SOURCE");
  assert.ok(dupWarn, "1. phải nêu rõ có khoản cước gõ tay bị loại, không loại im lặng");
  assert.equal(dupWarn?.amount, 20_000, "1. cảnh báo nói đúng số tiền bị loại");

  // Khoản NGOẠI LỆ có chứng cứ thì vẫn phải được tính — loại sạch cả nhóm là làm mất tiền thật.
  await db.insert(schema.expenses).values({
    id: "dc-exp-shipping-adj", category: "SHIPPING", description: "Đền bù kiện vỡ cho khách",
    amount: 150_000, occurredAt: d("2027-01-20"), costSource: "MANUAL_ADJUSTMENT", reason: "Đền bù ngoài cước vận đơn, không thuộc bảng kê nào",
  });
  clearMemo();
  costs = await getRecognizedCosts(KY);
  assert.equal(costs.components.SHIPPING.amount, 170_000, "1. khoản ĐIỀU CHỈNH có lý do vẫn được cộng (20.000 + 150.000)");

  // ══ TEST 2 — PHÍ HOÀN ══
  await db.insert(schema.expenses).values({
    id: "dc-exp-return", category: "RETURN_FEE", description: "Phí hoàn tháng 1 (ghi tay, trùng vận đơn)",
    amount: 25_000, occurredAt: d("2027-01-13"), costSource: "MANUAL",
  });
  clearMemo();
  costs = await getRecognizedCosts(KY);
  assert.equal(costs.components.RETURN_COST.amount, 25_000, "2. phí hoàn = 25.000đ theo vận đơn, không nhân đôi");

  // ══ TEST 3 — LƯƠNG: BẢNG LƯƠNG CẦM QUYỀN ══
  // Lương cứng 9.000.000đ/tháng khai ở bảng Lương, VÀ một khoản chi 9.000.000đ ở bảng Chi phí.
  // Kết quả phải là 9.000.000đ, không phải 18.000.000đ.
  await db.insert(schema.expenses).values({
    id: "dc-exp-salary", category: "SALARY", description: "Lương tháng 1 (ghi ở bảng Chi phí)",
    amount: 9_000_000, occurredAt: d("2027-01-05"), costSource: "MANUAL",
  });
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [{ id: "dc-emp-1", name: "Nhân sự kiểm thử", shortName: "KT", department: "Quản lý", aliases: [], accountIds: [], fixed: 9_000_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "" }] });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  clearMemo();
  costs = await getRecognizedCosts(KY);
  assert.equal(costs.payroll.coverage, "COMPLETE", "3. bảng Lương đủ điều kiện cầm quyền");
  assert.equal(costs.components.SALARY.amount, 9_000_000, "3. lương = 9.000.000đ, KHÔNG phải 18.000.000đ");
  assert.equal(costs.components.SALARY.usedFallback, false, "3. đang dùng nguồn có thẩm quyền, không phải nguồn dự phòng");
  const dupPayroll = costs.warnings.find((w) => w.rule === "DUPLICATE_PAYROLL_EXPENSE_SOURCE");
  assert.ok(dupPayroll, "3. phải nói rõ khoản lương ở bảng Chi phí đang bị bỏ qua");
  assert.equal(dupPayroll?.amount, 9_000_000, "3. cảnh báo nói đúng số tiền bị bỏ qua");
  // Hoa hồng KHÔNG được cộng thêm lần nữa: nó nằm lẫn trong nhóm "Lương" của bảng Chi phí.
  assert.equal(costs.components.COMMISSION.amount, 0, "3. hoa hồng không cộng chồng lên lương");

  // ══ TEST 4 — LƯƠNG: BẢNG LƯƠNG CHƯA ĐỦ ⇒ LÙI VỀ NGUỒN CŨ, KHÔNG ĐƯỢC BẰNG 0 ══
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  clearMemo();
  costs = await getRecognizedCosts(KY);
  assert.equal(costs.payroll.coverage, "INCOMPLETE", "4. chưa bật ⇒ bảng Lương không cầm quyền");
  assert.equal(costs.components.SALARY.amount, 9_000_000, "4. LÙI VỀ khoản chi ở bảng Chi phí — lương KHÔNG được thành 0");
  assert.notEqual(costs.components.SALARY.amount, 0, "4. lương khác 0");
  assert.equal(costs.components.SALARY.usedFallback, true, "4. đánh dấu rõ là đang dùng nguồn dự phòng");
  const coverWarn = costs.warnings.find((w) => w.rule === "PAYROLL_COST_COVERAGE_INCOMPLETE");
  assert.ok(coverWarn, "4. lùi nguồn phải có cảnh báo, KHÔNG được lùi im lặng");
  assert.ok(costs.warnings.some((w) => w.rule === "COMMISSION_BASIS_NEEDS_REVIEW"), "4. cơ sở tính hoa hồng chưa chốt phải được nêu");

  // ══ TEST 5 — 9.000.000đ/THÁNG, XEM 7 NGÀY CỦA THÁNG 30 NGÀY ⇒ 2.100.000đ ══
  assert.equal(prorateMonthlyAmount(9_000_000, TUAN30.from, TUAN30.to), 2_100_000, "5. 9tr × 7/30 = 2.100.000đ");
  assert.equal(prorateMonthlyAmount(9_000_000, THANG30.from, THANG30.to), 9_000_000, "5. cả tháng ⇒ trọn khoản, không dư không thiếu");
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  clearMemo();
  const tuanPayroll = await getRecognizedPayrollCost(TUAN30);
  assert.equal(tuanPayroll.fixedSalary, 2_100_000, "5. giao diện chi phí nhân sự trả đúng 2.100.000đ cho 7/30 ngày");
  assert.equal(tuanPayroll.allocationBasis.fixedSalary, "PERIOD_PRORATA", "5. khai rõ cách phân bổ");
  const thangPayroll = await getRecognizedPayrollCost(THANG30);
  assert.equal(thangPayroll.fixedSalary, 9_000_000, "5. cả tháng = trọn lương tháng");
  // Cộng 30 ngày lẻ vẫn đúng trọn khoản — chỗ mà nhân phân số rồi làm tròn từng ngày sẽ trượt.
  let congNgay = 0;
  for (let i = 1; i <= 30; i += 1) {
    const ngay = `2027-04-${String(i).padStart(2, "0")}`;
    congNgay += prorateMonthlyAmount(9_000_000, d(ngay), dEnd(ngay));
  }
  assert.equal(congNgay, 9_000_000, "5. cộng 30 ngày lẻ = đúng lương tháng");
  // Tháng 2 có 28 ngày: một ngày của tháng 2 đắt hơn một ngày của tháng 4 — đúng hợp đồng theo tháng.
  assert.equal(prorateMonthlyAmount(9_000_000, d("2027-02-01"), dEnd("2027-02-28")), 9_000_000, "5. tháng 2 đủ 28 ngày vẫn là trọn lương tháng");
  assert.equal(prorateMonthlyAmount(9_000_000, null, null), 0, "5. kỳ không có mốc ⇒ không chia bừa");

  // ══ BẤT BIẾN: tổng = Σ các thành phần, và không thành phần nào đếm chồng lên thành phần khác ══
  clearMemo();
  costs = await getRecognizedCosts(KY);
  const cong = Object.values(costs.components).reduce((t, c) => t + c.amount, 0);
  assert.equal(cong, costs.total, "tổng engine = Σ các thành phần");
  const vanHanh = ["SALARY", "COMMISSION", "RENT", "SOFTWARE", "UTILITIES", "OTHER_OPERATING"] as const;
  assert.equal(vanHanh.reduce((t, k) => t + costs.components[k].amount, 0), costs.operatingTotal, "khối vận hành = Σ các thành phần của nó");

  // ══ CÙNG MỘT KỲ ⇒ CÙNG MỘT CON SỐ, dù gọi lại nhiều lần ══
  clearMemo();
  const lai = await getRecognizedCosts(KY);
  assert.equal(lai.operatingTotal, costs.operatingTotal, "gọi lại cùng kỳ cho cùng con số");
  assert.ok(TUAN.from && KY.from, "kỳ kiểm thử có mốc");

  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  await reset(db);

  console.log(
    "✓ Chống trừ hai lần: cước 20K + khoản gõ tay 20K = 20K (không phải 40K) · phí hoàn 25K = 25K · lương 9tr + khoản chi 9tr = 9tr (không phải 18tr) · bảng Lương chưa đủ thì LÙI về nguồn cũ, lương khác 0 và có cảnh báo · 9tr/tháng xem 7/30 ngày = 2,1tr",
  );
}
