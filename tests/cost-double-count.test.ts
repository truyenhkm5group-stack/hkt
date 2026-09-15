import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import { PAYROLL_BASES, PAYROLL_BASIS_ELIGIBILITY, PAYROLL_EMPLOYEES_KEY, parsePayrollBasis } from "@/lib/constants/payroll";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getPayrollReport } from "@/lib/queries/payroll";
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
  /*
    ═══ 4b · CƠ SỞ TÍNH HOA HỒNG ĐÃ CÓ TÊN ⇒ CẢNH BÁO THÔI TREO VÔ ĐIỀU KIỆN ═══

    Bản trước đẩy `COMMISSION_BASIS_NEEDS_REVIEW` mỗi lần tính chi phí, kể cả khi không có gì sai.
    Một cảnh báo không bao giờ tắt là một cảnh báo người ta học cách bỏ qua.

    Nay cơ sở đã khai dứt khoát ở `lib/constants/compensation-profit.ts`: hoa hồng bị loại khỏi
    CHÍNH cơ sở của nó, rồi trừ ở bước SAU. Cảnh báo chỉ còn bật khi có thứ ĐO ĐƯỢC đang sai —
    khoản nhóm "Lương" vượt quá lương cứng, tức nhiều khả năng có hoa hồng nằm trong cơ sở.

    Ở đây lương cứng khai 9.000.000đ và bảng Chi phí cũng đúng 9.000.000đ, nên KHÔNG có phần dư
    nào và KHÔNG có gì để cảnh báo.
  */
  assert.ok(
    !costs.warnings.some((w) => w.rule === "COMMISSION_BASIS_NEEDS_REVIEW"),
    "4. khoản nhóm Lương vừa đúng lương cứng ⇒ không có hoa hồng nằm trong cơ sở ⇒ không cảnh báo treo",
  );

  // Nay thêm một khoản HOA HỒNG ghi lẫn vào nhóm "Lương": phần dư ấy nằm trong chi phí vận hành,
  // tức nằm trong chính cơ sở mà lời khai vừa nói là phải loại nó ra. Đó là thứ phải báo.
  await db.insert(schema.expenses).values({
    id: "dc-exp-commission", category: "SALARY", description: "Hoa hồng tháng 12 trả tháng 1",
    amount: 3_000_000, occurredAt: d("2027-01-08"), costSource: "MANUAL",
  });
  clearMemo();
  costs = await getRecognizedCosts(KY);
  const hoaHongTrongCoSo = costs.warnings.find((w) => w.rule === "COMMISSION_BASIS_NEEDS_REVIEW");
  assert.ok(hoaHongTrongCoSo, "4. có khoản vượt quá lương cứng ⇒ PHẢI báo hoa hồng đang nằm trong cơ sở");
  assert.equal(hoaHongTrongCoSo?.amount, 3_000_000, "4. và nói đúng số tiền đang đứng nhầm bước");
  await db.delete(schema.expenses).where(eq(schema.expenses.id, "dc-exp-commission"));
  clearMemo();
  costs = await getRecognizedCosts(KY);

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

  /* ══ TEST 6 — BẢNG LƯƠNG VÀ MÁY CHI PHÍ PHẢI NÓI CÙNG MỘT CON SỐ ══
   *
   * SỰ CỐ THẬT (rà soát 14/09/2026): `getPayrollReport` chép thẳng `employee.fixed` — con số khai
   * theo THÁNG — vào cột "Lương cứng" của BẤT KỲ kỳ nào người dùng chọn, trong khi
   * `getRecognizedPayrollCost` (cửa mà Profit Engine hỏi) đã chia theo ngày. Xem 7 ngày: màn hình
   * trả tiền nói 9.000.000đ còn lợi nhuận trừ 2.100.000đ. Xem một quý: màn hình nói MỘT tháng
   * lương cho BA tháng làm việc.
   *
   * Bất biến: Σ lương cứng trên bảng lương = lương cứng máy chi phí ghi nhận, cùng kỳ, cùng luật.
   */
  clearMemo();
  const bangLuongTuan = await getPayrollReport(TUAN30, "profit1");
  const dongTuan = bangLuongTuan.lines.find((l) => l.employee.id === "dc-emp-1");
  assert.equal(dongTuan?.fixedMonthly, 9_000_000, "6. cột khai báo vẫn là lương THÁNG, không đổi");
  assert.equal(dongTuan?.fixed, 2_100_000, "6. cột lương cứng của kỳ = 9tr × 7/30, không phải trọn 9tr");
  assert.equal(dongTuan?.salary, 2_100_000, "6. tổng lương đi theo lương cứng đã chia (thưởng = 0 ở ca này)");
  assert.equal(bangLuongTuan.fixedBasis.bounded, true, "6. kỳ có mốc đầu/cuối thì chia được");
  assert.equal(bangLuongTuan.fixedBasis.days, 7, "6. và nói rõ chia theo mấy ngày");
  const chiPhiTuan = await getRecognizedPayrollCost(TUAN30);
  assert.equal(
    bangLuongTuan.lines.reduce((t, l) => t + (l.fixed ?? 0), 0),
    chiPhiTuan.fixedSalary,
    "6. Σ lương cứng trên BẢNG LƯƠNG = lương cứng MÁY CHI PHÍ ghi nhận — hai nơi không được nói hai số",
  );

  clearMemo();
  const bangLuongThang = await getPayrollReport(THANG30, "profit1");
  assert.equal(bangLuongThang.lines.find((l) => l.employee.id === "dc-emp-1")?.fixed, 9_000_000, "6. trọn tháng ⇒ trọn lương tháng, không dư không thiếu");

  /* Kỳ "Toàn bộ" không có mốc đầu/cuối: CHƯA BIẾT, không phải 0 (AGENTS.md mục 42). Ghi 0 ở đây là
     nói với chủ shop rằng kỳ ấy shop không trả đồng lương nào. */
  clearMemo();
  const bangLuongToanBo = await getPayrollReport({ key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null }, "profit1");
  assert.equal(bangLuongToanBo.fixedBasis.bounded, false, "6. kỳ Toàn bộ không chia theo ngày được");
  assert.equal(bangLuongToanBo.lines.find((l) => l.employee.id === "dc-emp-1")?.fixed, null, "6. lương cứng kỳ Toàn bộ là CHƯA BIẾT (null), không phải 0");
  assert.equal(bangLuongToanBo.totalSalary, null, "6. một phần chưa biết thì tổng lương cũng chưa biết");

  /* ══ TEST 7 — CƠ SỞ DÒNG TIỀN: KHÔNG QUY ĐỔI ĐƯỢC THÌ NÓI CHƯA BIẾT, KHÔNG NÓI 0 ══
   *
   * Cơ sở "dòng tiền thực" quy đổi LN cá nhân bằng `LN dòng tiền ÷ LN1 toàn shop`. Mẫu số ≤ 0 —
   * mọi kỳ lỗ, và mọi kỳ ngắn chưa kịp có đơn giao thành công — thì không có hệ số nào cả. Bản cũ
   * trả 0, nên bảng lương hiện LN cá nhân đúng "0 ₫" cho TẤT CẢ marketer: đọc thành "người này
   * không tạo ra đồng lợi nhuận nào", trong khi sự thật là phép tính không chạy được.
   *
   * Tháng 4/2027 không có đơn nào ⇒ LN1 toàn shop ≤ 0 ⇒ đúng ca ấy.
   */
  clearMemo();
  const dongTien = await getPayrollReport(THANG30, "cash");
  assert.ok(dongTien.marketers.totals.profit <= 0, "7. ca thử phải thật sự có mẫu số ≤ 0");
  assert.equal(dongTien.cashRatio, null, "7. mẫu số ≤ 0 ⇒ hệ số quy đổi là CHƯA TÍNH ĐƯỢC, không phải 0");
  assert.ok(dongTien.cashRatioReason && dongTien.cashRatioReason.length > 0, "7. và phải nói được VÌ SAO, để màn hình in ra thay vì im lặng");
  for (const l of dongTien.lines) {
    if (!dongTien.marketers.marketers.some((m) => m.marketerId === l.employee.id)) continue;
    assert.equal(l.personalProfit, null, "7. LN cá nhân của marketer là CHƯA BIẾT, không phải 0");
    assert.equal(l.bonusPersonal, null, "7. không biết LN cá nhân thì cũng không biết thưởng theo LN cá nhân");
    assert.equal(l.salary, null, "7. một phần chưa biết thì tổng lương cũng chưa biết");
  }

  // Cơ sở LN1 KHÔNG bị ảnh hưởng: nó không đi qua phép quy đổi nào.
  clearMemo();
  const ln1 = await getPayrollReport(THANG30, "profit1");
  assert.equal(ln1.cashRatio, 1, "7. cơ sở không phải dòng tiền thì hệ số luôn = 1, không bao giờ null");
  assert.equal(ln1.cashRatioReason, null, "7. và không có lý do nào phải nêu");

  /* ══ TEST 8 — CẢNH BÁO VỀ NGUỒN CHI PHÍ PHẢI ĐI TỚI TẬN BẢNG LƯƠNG ══
   *
   * `getOperatingCost` trả về con số LẪN lời khai về nguồn. `productEconomics` chỉ lấy `.amount`
   * rồi vứt `.warnings`, nên /expenses biết "khoản lương ở bảng Chi phí đang bị bỏ qua" còn
   * /payroll thì không — dù /payroll mới là nơi lợi nhuận biến thành tiền trả cho người thật.
   * Một khoản bị loại vì trùng nguồn làm lợi nhuận CAO HƠN thực tế, và thưởng theo % lợi nhuận
   * cao theo.
   *
   * Bất biến: bảng lương mang ĐÚNG bộ cảnh báo của máy chi phí, cùng kỳ, không thêm không bớt.
   */
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  clearMemo();
  const bangLuongThang1 = await getPayrollReport(KY, "profit1");
  const chiPhiThang1 = await getRecognizedCosts(KY);
  assert.deepEqual(
    bangLuongThang1.marketers.costWarnings.map((w) => w.rule).sort(),
    chiPhiThang1.warnings.map((w) => w.rule).sort(),
    "8. bảng lương phải mang ĐÚNG bộ cảnh báo của máy chi phí — không được rơi mất trên đường",
  );
  assert.ok(
    bangLuongThang1.marketers.costWarnings.some((w) => w.rule === "DUPLICATE_PAYROLL_EXPENSE_SOURCE"),
    "8. và phải gồm cảnh báo khoản lương ở bảng Chi phí đang bị bỏ qua — đây là khoản làm lợi nhuận trông cao hơn thực tế",
  );
  assert.equal(bangLuongThang1.marketers.payrollCovered, true, "8. nói rõ chi phí nhân sự đang lấy từ nguồn nào");
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  clearMemo();
  const bangLuongCu = await getPayrollReport(KY, "profit1");
  assert.equal(bangLuongCu.marketers.payrollCovered, false, "8. lùi nguồn thì bảng lương cũng phải biết là đang lùi");
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });

  /* ══ TEST 9 — "PHẢI TRẢ" VÀ "ĐÃ TRẢ" LÀ HAI CHIỀU, KHÔNG ĐƯỢC GỘP ══
   *
   * `dc-exp-salary` là khoản chi 9.000.000đ ghi ngày 05/01/2027. Đó là TIỀN RA của tháng 1 — một
   * sự kiện tiền có ngày của riêng nó — và nó KHÔNG phải "lương phải trả của tháng 1" (con số ấy
   * là phép tính trên kỳ làm việc). Gộp hai thứ là cách làm mất dấu một tháng lương khi shop trả
   * lương tháng trước vào tháng sau (AGENTS.md mục 17).
   *
   * Và nó phải đọc theo NGÀY PHÁT SINH THÔ: kỳ tháng 4/2027 không có khoản chi nào ⇒ đã trả = 0,
   * dù lương cứng phải trả của tháng ấy vẫn là 9.000.000đ.
   */
  clearMemo();
  const luongThang1 = await getPayrollReport(KY, "profit1");
  assert.equal(luongThang1.paid.amount, 9_000_000, "9. đã trả tháng 1 = khoản chi nhóm Lương ghi trong tháng 1");
  assert.equal(luongThang1.paid.count, 1, "9. và đếm đúng số chứng từ");
  assert.equal(luongThang1.paid.perPerson, false, "9. KHÔNG được nhận là tách được theo người — chứng từ chi không mang khoá tài khoản");
  assert.ok(luongThang1.paid.missingWhat.length > 20, "9. và phải nói CỤ THỂ thiếu gì thì mới tách được, không chỉ ghi 'chưa có'");

  clearMemo();
  const luongThang4 = await getPayrollReport(THANG30, "profit1");
  assert.equal(luongThang4.paid.amount, 0, "9. tháng 4 không có chứng từ chi nào ⇒ ĐÃ TRẢ = 0 (đây là 0 THẬT, không phải chưa biết)");
  assert.equal(luongThang4.lines.find((l) => l.employee.id === "dc-emp-1")?.fixed, 9_000_000, "9. nhưng PHẢI TRẢ của tháng 4 vẫn là trọn lương tháng — hai chiều đứng riêng");

  /* ══ TEST 10 — CHỈ MỘT CƠ SỞ ĐƯỢC PHÉP CHỐT LƯƠNG, VÀ PHẢI NÓI ĐƯỢC VÌ SAO ══
   *
   * Luật chủ shop: lợi nhuận tính lương = doanh thu thực − TOÀN BỘ chi phí thuộc phạm vi ghi nhận,
   * và tiền mua hàng CHƯA BÁN không tự thành chi phí của kỳ. Ba trong bốn cơ sở của ERP vi phạm
   * điều đó theo ba cách khác nhau — nhưng ô chọn cho cả bốn trông giống hệt nhau.
   *
   * Bất biến: đúng MỘT cơ sở đủ điều kiện, nó là MẶC ĐỊNH, và mỗi cơ sở không đủ phải nói được LÝ
   * DO cụ thể (một dòng "không dùng được" không kèm lý do thì lần sau có người gỡ nó đi).
   */
  const duDieuKien = PAYROLL_BASES.filter((b) => PAYROLL_BASIS_ELIGIBILITY[b].eligible);
  assert.deepEqual(duDieuKien, ["profit1"], "10. đúng một cơ sở đủ điều kiện chốt lương, và đó là LN1");
  assert.equal(parsePayrollBasis(undefined), "profit1", "10. và nó phải là MẶC ĐỊNH — tham số lạ không được rơi vào một cơ sở không đủ điều kiện");
  assert.equal(parsePayrollBasis("khong-ton-tai"), "profit1", "10. tham số rác cũng rơi về cơ sở đủ điều kiện");
  for (const b of PAYROLL_BASES) {
    const e = PAYROLL_BASIS_ELIGIBILITY[b];
    assert.ok(e.why.length > 60, `10. cơ sở ${b} phải nói CỤ THỂ vì sao được / không được dùng`);
  }
  assert.ok(/chưa bán/i.test(PAYROLL_BASIS_ELIGIBILITY.profit2.why), "10. lý do của LN2 phải nói đúng chỗ sai: giá vốn hàng CHƯA BÁN");
  assert.ok(/dòng tiền/i.test(PAYROLL_BASIS_ELIGIBILITY.cash.why), "10. lý do của cơ sở dòng tiền phải nói nó là dòng tiền, không phải lợi nhuận");
  assert.ok(/dự phóng|ước tính/i.test(PAYROLL_BASIS_ELIGIBILITY.nominal.why), "10. lý do của cơ sở danh nghĩa phải nói nó là số dự phóng");

  /* ══ TEST 11 — ĐỔI NGUỒN KHÔNG ĐƯỢC LÀM HOA HỒNG BIẾN MẤT ══
   *
   * Đây là chiều hỏng NGƯỢC với "trừ hai lần", và nó nguy hiểm hơn: trừ hai lần làm lợi nhuận thấp
   * đi nên có người thắc mắc; MẤT một khoản làm lợi nhuận CAO ĐẸP nên không ai đi kiểm.
   *
   * Tình huống thật: nhóm "Lương" ở bảng Chi phí đang chứa CẢ lương cứng LẪN hoa hồng — đó là cách
   * shop đang ghi. Chủ shop bật bảng Lương làm nguồn ghi nhận, mà bảng Lương chỉ góp được lương
   * cứng. Bản cũ loại TOÀN BỘ nhóm ấy theo một cờ độ phủ duy nhất, nên hoa hồng rơi khỏi lợi nhuận
   * và lợi nhuận tăng lên đúng bằng khoản ấy.
   */
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  // Thêm 3.000.000đ hoa hồng, ghi cùng nhóm "Lương" như shop vẫn ghi ⇒ nhóm cũ cộng lại 12 triệu.
  await db.insert(schema.expenses).values({
    id: "dc-exp-commission", category: "SALARY", description: "Hoa hồng tháng 1 (ghi lẫn nhóm Lương)",
    amount: 3_000_000, occurredAt: d("2027-01-06"), costSource: "MANUAL",
  });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  clearMemo();
  costs = await getRecognizedCosts(KY);

  assert.equal(costs.payroll.componentCoverage.fixedSalary, "COMPLETE", "11. bảng Lương phủ được LƯƠNG CỨNG");
  assert.equal(
    costs.payroll.componentCoverage.commission,
    "INCOMPLETE",
    "11. nhưng KHÔNG phủ được hoa hồng — và độ phủ phải khai theo TỪNG THÀNH PHẦN, không một cờ chung",
  );
  assert.equal(costs.components.SALARY.amount, 9_000_000, "11. lương cứng lấy từ bảng Lương");
  assert.equal(
    costs.components.COMMISSION.amount,
    3_000_000,
    "11. 3 triệu hoa hồng VẪN ĐƯỢC TÍNH — đây là khoản mà bản cũ làm biến mất",
  );
  assert.equal(
    costs.components.SALARY.amount + costs.components.COMMISSION.amount,
    12_000_000,
    "11. và tổng đúng bằng tiền thật đã chi: 12 triệu, không phải 9 (mất) cũng không phải 21 (cộng hai lần)",
  );
  const canhBao11 = costs.warnings.find((w) => w.rule === "DUPLICATE_PAYROLL_EXPENSE_SOURCE");
  assert.equal(canhBao11?.amount, 3_000_000, "11. cảnh báo phải nói ĐÚNG phần chưa đối chiếu được, không phải cả nhóm");
  assert.ok(
    /vẫn được tính/i.test(canhBao11?.detail ?? ""),
    "11. và phải nói rõ khoản ấy VẪN ĐƯỢC TÍNH, để không ai đi xoá chứng từ cho 'sạch'",
  );
  assert.ok(
    /không xoá chứng từ/i.test(canhBao11?.action ?? ""),
    "11. việc cần làm là TÁCH ra, không phải xoá đi",
  );

  // Dọn để các khẳng định bất biến bên dưới chạy trên đúng nền của TEST 3.
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} = 'dc-exp-commission'`);
  clearMemo();

  /* ══ TEST 12 — PHÍ HOÀN ĐỌC TỪ VẬN ĐƠN CHIỀU VỀ, KHÔNG TỪ MỘT CỘT RỖNG ══
   *
   * Vận đơn chiều về là một dòng `shipments` RIÊNG (`order_id` NULL, `order_reference` = mã gốc —
   * AGENTS.md mục 7), nên nó nằm NGOÀI phép nối vận đơn chính của mọi truy vấn khác. Cước của nó vì
   * thế không được tính ở bất cứ đâu.
   *
   * Đo trên production 15/09/2026: `orders.return_fee` bằng 0 trên TOÀN BẢNG, trong khi có 268 vận
   * đơn chiều hoàn mang 2.120.600 ₫ cước thật. Báo cáo in "phí hoàn = 0" đọc thành "shop không tốn
   * phí hoàn" — sự thật là ĐỌC NHẦM CỘT.
   */
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  clearMemo();
  const truocChieuHoan = await getRecognizedCosts(KY);
  await db.insert(schema.shipments).values({
    id: "dc-ship-return",
    // Chiều về: KHÔNG gắn đơn, chỉ mang mã gốc.
    orderId: null,
    orderReference: "DC0000000002",
    vtpOrderNumber: "DC0000000002P1",
    stage: "RETURNED",
    shippingFee: 31_000,
    deliveredAt: d("2027-01-20"),
  });
  clearMemo();
  const sauChieuHoan = await getRecognizedCosts(KY);

  assert.equal(
    sauChieuHoan.components.RETURN_COST.amount - truocChieuHoan.components.RETURN_COST.amount,
    31_000,
    "12. cước trên vận đơn CHIỀU HOÀN phải vào thành phần Phí hoàn — trước bản vá nó không được tính ở đâu cả",
  );
  assert.equal(
    sauChieuHoan.components.SHIPPING.amount,
    truocChieuHoan.components.SHIPPING.amount,
    "12. và KHÔNG được cộng thêm lần nữa vào thành phần Cước — một khoản, một chỗ",
  );
  assert.equal(
    sauChieuHoan.total - truocChieuHoan.total,
    31_000,
    "12. tổng chi phí tăng đúng 31.000đ, không gấp đôi",
  );

  /*
    MỐC KỲ LÀ NGÀY CHIỀU HOÀN XẢY RA, không phải ngày tạo đơn gốc: một đơn tháng trước hoàn về
    tháng này thì chi phí thuộc tháng này. Vận đơn hoàn ngày 20/01 KHÔNG được rơi vào kỳ tháng 4.
  */
  const kyKhac = await getRecognizedCosts(THANG30);
  assert.equal(
    kyKhac.components.RETURN_COST.amount,
    0,
    "12. vận đơn hoàn ngày 20/01 không được tính vào kỳ tháng 4 — mốc kỳ đi theo ngày hoàn thật",
  );

  await db.delete(schema.shipments).where(sql`${schema.shipments.id} = 'dc-ship-return'`);
  clearMemo();

  /* ══ TEST 13 — NGHĨA VỤ LƯƠNG CÓ THẬT MÀ LỢI NHUẬN KHÔNG TRỪ ĐỒNG NÀO ══
   *
   * Cảnh báo lùi nguồn (TEST 4) chỉ bật khi bảng Chi phí CÓ khoản lương. Nên ca nguy hiểm nhất lại
   * là ca KHÔNG có khoản nào: thành phần Lương bằng 0 và không cảnh báo nào bật — lợi nhuận đọc như
   * thể shop không trả lương cho ai, hoàn toàn im lặng.
   *
   * Đo trên production 15/09/2026: 4 nhân sự, 5.000.000 ₫/tháng lương cứng đã khai ở bảng Lương,
   * 0 khoản chi nhóm "Lương" ở bảng Chi phí. Đây là ca THẬT, không phải giả định.
   */
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} in ('dc-exp-salary','dc-exp-commission')`);
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  clearMemo();
  costs = await getRecognizedCosts(KY);

  assert.equal(costs.components.SALARY.amount, 0, "13. chuẩn bị: không khoản chi lương nào ⇒ chi phí lương ghi nhận bằng 0");
  const imLang = costs.warnings.find((w) => w.rule === "PAYROLL_OBLIGATION_NOT_RECOGNIZED");
  assert.ok(imLang, "13. PHẢI có cảnh báo — 0 đồng lương trong lợi nhuận khi đã khai nghĩa vụ là chuyện không được im lặng");
  assert.equal(imLang?.severity, "high", "13. và phải là mức HIGH, vì cổng chốt kỳ chặn trên mức ấy");
  assert.ok((imLang?.amount ?? 0) > 0, "13. cảnh báo phải nói ĐÚNG số tiền đang nằm ngoài lợi nhuận, không phải một câu chung chung");
  assert.ok(
    /không có nghĩa là không phát sinh/i.test(imLang?.detail ?? ""),
    "13. và nói thẳng: chưa có khoản nhập KHÔNG có nghĩa là không phát sinh chi phí",
  );

  /*
    KHÔNG TỰ CỘNG. ERP nêu ra con số nhưng KHÔNG đưa nó vào lợi nhuận: chuyển thẩm quyền là quyết
    định của chủ shop (AGENTS.md mục 18), và tự cộng là mở đường cho ngày mai có người nhập khoản
    chi lương rồi bị trừ hai lần.
  */
  assert.equal(
    costs.components.SALARY.amount,
    0,
    "13. nhưng KHÔNG tự cộng con số ấy vào lợi nhuận — tự cộng là mở đường cho việc trừ hai lần về sau",
  );

  // Có khoản chi lương trở lại ⇒ cảnh báo im lặng TẮT (nó chỉ dành cho ca không có khoản nào).
  await db.insert(schema.expenses).values({
    id: "dc-exp-salary", category: "SALARY", description: "Lương tháng 1 (ghi ở bảng Chi phí)",
    amount: 9_000_000, occurredAt: d("2027-01-05"), costSource: "MANUAL",
  });
  clearMemo();
  const coKhoan = await getRecognizedCosts(KY);
  assert.ok(
    !coKhoan.warnings.some((w) => w.rule === "PAYROLL_OBLIGATION_NOT_RECOGNIZED"),
    "13. có khoản chi lương rồi thì cảnh báo này TẮT — nó chỉ nói về ca lợi nhuận không trừ đồng nào",
  );
  assert.equal(coKhoan.components.SALARY.amount, 9_000_000, "13. và lương quay lại đúng con số của bảng Chi phí");

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
    "✓ Chống trừ hai lần: cước 20K + khoản gõ tay 20K = 20K (không phải 40K) · phí hoàn 25K = 25K · lương 9tr + khoản chi 9tr = 9tr (không phải 18tr) · bảng Lương chưa đủ thì LÙI về nguồn cũ, lương khác 0 và có cảnh báo · 9tr/tháng xem 7/30 ngày = 2,1tr Ở CẢ HAI NƠI (bảng lương = máy chi phí) · kỳ Toàn bộ là CHƯA BIẾT chứ không phải 0 · cơ sở dòng tiền mẫu số ≤ 0 ⇒ LN cá nhân CHƯA BIẾT, không phải 0 ₫ · cảnh báo nguồn chi phí đi tới tận bảng lương · PHẢI TRẢ và ĐÃ TRẢ đứng riêng hai chiều · đúng MỘT cơ sở được phép chốt lương và nó là mặc định · ĐỔI NGUỒN không làm hoa hồng biến mất (độ phủ theo từng thành phần) · phí hoàn đọc từ VẬN ĐƠN CHIỀU VỀ chứ không từ cột rỗng, và không cộng hai lần vào cước · nghĩa vụ lương có thật mà lợi nhuận không trừ đồng nào thì KÊU (mức high), nhưng KHÔNG tự cộng",
  );
}
