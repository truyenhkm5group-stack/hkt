/**
 * ═══════ MÁY TÍNH LƯƠNG CHUNG ĐI QUA BẢNG LƯƠNG THẬT ═══════
 *
 * `tests/payroll-engine.test.ts` khoá PHÉP TÍNH bằng hàm thuần. Bộ này khoá phần NỐI: chính sách
 * khai trong CSDL có thật sự chạm tới con số mà `/payroll` in ra không, và nó có chịu ĐỨNG YÊN cho
 * tới khi chủ shop gán người không.
 *
 * ─── BÀI QUAN TRỌNG NHẤT Ở ĐÂY LÀ BÀI SỐ 1 ───
 *
 * Đối chiếu CŨ/MỚI (yêu cầu mục 30) trong kho mã này có một câu trả lời sắc hơn "sai lệch nằm
 * trong ngưỡng chấp nhận": **chưa gán chính sách thì sai lệch phải bằng ĐÚNG 0**, vì đường tính cũ
 * không bị chạm tới một dòng nào. Đó là thứ làm bản này phát hành được mà không cần một cửa sổ đối
 * soát — và bài số 1 khoá nó ở mức mã nguồn.
 *
 * Dữ liệu đặt ở tháng 03/2028 để không đụng fixture của bộ khác.
 */
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, payrollPeriodKey, type Employee } from "@/lib/constants/payroll";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { getPayrollReport } from "@/lib/queries/payroll";
import { buildPayrollSnapshot } from "@/lib/queries/payroll-period";
import { frozenPeriodRuns, periodFinalized } from "@/lib/queries/payroll-engine";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);
const ky = (from: string, to: string, label: string): Period => ({ key: "custom", from: d(from), to: dEnd(to), label, fromKey: from, toKey: to });

const THANG3 = ky("2028-03-01", "2028-03-31", "Tháng 3/2028");

/** Nhân sự kho: KHÔNG phải marketer, không có quảng cáo, không có fanpage. */
const KHO: Employee = {
  id: "pe-kho-1",
  name: "Nhân viên kho thử",
  shortName: "Kho",
  department: "Kho / Đóng gói",
  aliases: [],
  accountIds: [],
  fixed: 0,
  percentTotal: 0,
  percentPersonal: 0,
  percentRevenue: 0,
  active: true,
  note: "",
};

/** Nhân sự tính bằng ĐƯỜNG CŨ — dùng để chứng minh máy mới không chạm vào họ. */
const CU: Employee = { ...KHO, id: "pe-cu-1", name: "Nhân sự đường cũ", shortName: "Cũ", fixed: 9_000_000 };

async function reset(db: Db) {
  await db.delete(schema.payrollAdjustments).where(sql`${schema.payrollAdjustments.employeeId} like 'pe-%'`);
  await db.delete(schema.payrollInputs).where(sql`${schema.payrollInputs.employeeId} like 'pe-%'`);
  await db.delete(schema.employeePolicyAssignments).where(sql`${schema.employeePolicyAssignments.employeeId} like 'pe-%'`);
  await db.delete(schema.employmentAssignments).where(sql`${schema.employmentAssignments.employeeId} like 'pe-%'`);
  await db.delete(schema.salaryPolicies).where(sql`${schema.salaryPolicies.code} like 'PE_%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  clearMemo();
}

const dong = (report: Awaited<ReturnType<typeof getPayrollReport>>, id: string) => report.lines.find((l) => l.employee.id === id);

export async function testPayrollPolicyEngine(db: Db) {
  await reset(db);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [KHO, CU] });
  clearMemo();

  /* ═══ 1 · CHƯA GÁN CHÍNH SÁCH ⇒ KHÔNG MỘT CON SỐ NÀO ĐỔI ═══
   *
   * Đây là phép ĐỐI CHIẾU CŨ/MỚI của bản này. Nếu nhánh này đỏ thì một lượt phát hành đã lặng lẽ
   * đổi tiền của người thật, và không đường nào lần ngược lại được vì không ai bấm gì cả.
   */
  const truoc = await getPayrollReport(THANG3, "profit1");
  const kho0 = dong(truoc, KHO.id);
  const cu0 = dong(truoc, CU.id);
  assert.ok(kho0 && cu0, "1. cả hai nhân sự phải có mặt trong bảng lương");
  assert.equal(kho0.engine, null, "1. chưa gán chính sách ⇒ không đi qua máy chung");
  assert.equal(cu0.engine, null, "1. chưa gán chính sách ⇒ không đi qua máy chung");
  // Người cũ: 9 triệu/tháng, kỳ đúng một tháng ⇒ đủ 9 triệu, y như trước bản này.
  assert.equal(cu0.salary, 9_000_000, "1. đường tính cũ ra đúng con số cũ — sai lệch cũ/mới bằng ĐÚNG 0");
  assert.equal(kho0.salary, 0, "1. người chưa khai gì vẫn ra 0 như trước, không phải CHƯA BIẾT");

  /* ═══ 2 · KHAI MỘT CHÍNH SÁCH THEO GIỜ, GÁN CHO NHÂN SỰ KHO ═══
   *
   * Bốn ô trên hồ sơ nhân sự của người này đều bằng 0 — cố ý. Nếu con số cuối cùng khác 0 thì nó
   * CHỈ có thể đến từ chính sách, không thể đến từ đường cũ.
   */
  await db.insert(schema.salaryPolicies).values({ id: "pe-pol-1", code: "PE_HOURLY", name: "Kho — lương theo giờ" });
  await db.insert(schema.salaryPolicyVersions).values({
    id: "pe-ver-1",
    policyId: "pe-pol-1",
    version: 1,
    effectiveFrom: d("2028-01-01"),
    status: "ACTIVE",
  });
  await db.insert(schema.salaryPolicyComponents).values([
    {
      id: "pe-comp-1",
      versionId: "pe-ver-1",
      code: "HOURLY",
      label: "Lương giờ",
      kind: "TIME_BASED",
      calcType: "PER_UNIT",
      basisKey: "WORK_HOURS",
      calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 40_000 },
      prorate: "NONE",
      rounding: "ROUND",
      sortOrder: 10,
    },
    {
      id: "pe-comp-2",
      versionId: "pe-ver-1",
      code: "ALLOW",
      label: "Phụ cấp xăng xe",
      kind: "ALLOWANCE",
      calcType: "FIXED_AMOUNT",
      calc: { type: "FIXED_AMOUNT", amount: 600_000 },
      prorate: "PERIOD_DAYS",
      rounding: "ROUND",
      sortOrder: 20,
    },
  ]);
  await db.insert(schema.employmentAssignments).values({
    id: "pe-emp-1",
    employeeId: KHO.id,
    employmentType: "PART_TIME",
    workMode: "REMOTE",
    status: "ACTIVE",
    effectiveFrom: d("2028-01-01"),
  });
  await db.insert(schema.employeePolicyAssignments).values({ id: "pe-asg-1", employeeId: KHO.id, policyId: "pe-pol-1", effectiveFrom: d("2028-01-01") });
  clearMemo();

  /* ═══ 3 · CHƯA CHẤM CÔNG ⇒ CHƯA BIẾT, KHÔNG PHẢI 0 ═══ */
  const chuaCham = await getPayrollReport(THANG3, "profit1");
  const khoA = dong(chuaCham, KHO.id)!;
  assert.ok(khoA.engine, "3. đã gán chính sách ⇒ phải đi qua máy chung");
  assert.equal(khoA.salary, null, "3. chưa nhập giờ công ⇒ lương là CHƯA BIẾT, không phải 0 ₫");
  assert.equal(khoA.engine!.result.missing.length, 1, "3. phải nêu ĐÚNG cái đang thiếu");
  assert.match(khoA.engine!.result.missing[0].message, /Giờ công/, "3. và nói rõ nó là giờ công");
  assert.equal(chuaCham.totalSalary, null, "3. một người chưa biết thì TỔNG cũng chưa biết");
  // Và cổng chốt kỳ phải chặn, kèm câu nói rõ ai thiếu gì.
  const chan = payrollFinalizeBlockers({
    bounded: true,
    basisEligible: true,
    basisWhy: "",
    basisLabel: "",
    totalSalary: chuaCham.totalSalary,
    costWarnings: [],
    lines: chuaCham.lines.map((l) => ({
      name: l.employee.shortName || l.employee.name,
      carryEstablished: l.carry ? l.carry.openingEstablished : null,
      carryReason: l.carry?.openingReason ?? null,
      engineMissing: l.engine?.result.missing.map((m) => ({ label: m.label, message: m.message })) ?? [],
      engineProblems: l.engine?.result.problems ?? [],
    })),
  });
  assert.ok(
    chan.some((b) => b.code === "ENGINE_INPUT_MISSING" && b.message.includes("Kho")),
    "3. cổng chốt phải nói ĐÚNG người và ĐÚNG đại lượng đang thiếu, không phải 'dữ liệu chưa đủ'",
  );

  // Người đường cũ KHÔNG bị ảnh hưởng bởi bất cứ điều gì ở trên.
  assert.equal(dong(chuaCham, CU.id)!.salary, 9_000_000, "3. khai chính sách cho người này không đụng tới người kia");

  /* ═══ 4 · NHẬP GIỜ CÔNG ⇒ RA TIỀN, VÀ RA ĐÚNG SỐ ═══ */
  const key = payrollPeriodKey(THANG3.from, THANG3.to)!;
  await db.insert(schema.payrollInputs).values({
    id: "pe-in-1",
    employeeId: KHO.id,
    periodKey: key,
    inputKey: "WORK_HOURS",
    value: 120,
    evidence: "Bảng công T3/2028",
    enteredByName: "Chủ shop",
  });
  clearMemo();
  const coCong = await getPayrollReport(THANG3, "profit1");
  const khoB = dong(coCong, KHO.id)!;
  // 120 giờ × 40.000 = 4.800.000 · phụ cấp 600.000 trọn tháng (kỳ = đúng một tháng).
  assert.equal(khoB.salary, 4_800_000 + 600_000, "4. lương ra đúng tổng các thành phần của chính sách");
  assert.equal(khoB.engine!.result.grossEarnings, 5_400_000);
  assert.equal(khoB.engine!.result.totalDeductions, 0);
  assert.equal(khoB.engine!.result.missing.length, 0);
  // LÀM TỪ XA KHÔNG PHẢI MỘT CÔNG THỨC: người này `workMode = REMOTE` và vẫn ăn đúng lương giờ.
  assert.equal(khoB.engine!.result.components.find((c) => c.code === "HOURLY")?.amount, 4_800_000, "4. làm từ xa không đổi cách tính một đồng nào");

  /* ═══ 5 · TÍNH LẠI LÀ BẤT BIẾN ═══
   *
   * Mở trang hai lần không được cộng dồn giờ công, không được nhân đôi phụ cấp, không được sinh
   * thêm một dòng điều chỉnh (yêu cầu mục 28).
   */
  clearMemo();
  const lai = await getPayrollReport(THANG3, "profit1");
  assert.equal(dong(lai, KHO.id)!.salary, khoB.salary, "5. tính lại ra đúng một kết quả");
  const demInput = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollInputs).where(eq(schema.payrollInputs.employeeId, KHO.id));
  assert.equal(Number(demInput[0].n), 1, "5. tính lại không sinh thêm dòng đầu vào nào");

  /* ═══ 6 · TẠM ỨNG LÀ KHOẢN TRỪ, VÀ SỐ NHẬP DƯƠNG VẪN RA KHOẢN TRỪ ═══ */
  await db.insert(schema.payrollAdjustments).values({
    id: "pe-adj-1",
    employeeId: KHO.id,
    periodKey: key,
    kind: "ADVANCE",
    label: "Tạm ứng 10/03",
    amount: 1_000_000,
    reason: "Ứng trước theo đề nghị",
    createdByName: "Chủ shop",
  });
  clearMemo();
  const coUng = await getPayrollReport(THANG3, "profit1");
  const khoC = dong(coUng, KHO.id)!;
  assert.equal(khoC.engine!.result.totalDeductions, 1_000_000, "6. tạm ứng nhập DƯƠNG vẫn ra khoản TRỪ");
  assert.equal(khoC.salary, 5_400_000 - 1_000_000, "6. thực nhận đã trừ tạm ứng");

  /* ═══ 7 · ĐỔI CHÍNH SÁCH GIỮA KỲ: MỖI ĐOẠN THEO CHÍNH SÁCH CỦA ĐOẠN ẤY ═══ */
  await db.insert(schema.salaryPolicies).values({ id: "pe-pol-2", code: "PE_FIXED", name: "Kho — lương cứng" });
  await db.insert(schema.salaryPolicyVersions).values({ id: "pe-ver-2", policyId: "pe-pol-2", version: 1, effectiveFrom: d("2028-01-01"), status: "ACTIVE" });
  await db.insert(schema.salaryPolicyComponents).values({
    id: "pe-comp-3",
    versionId: "pe-ver-2",
    code: "BASE",
    label: "Lương cứng",
    kind: "FIXED",
    calcType: "FIXED_AMOUNT",
    calc: { type: "FIXED_AMOUNT", amount: 12_000_000 },
    prorate: "PERIOD_DAYS",
    rounding: "ROUND",
    sortOrder: 10,
  });
  // Đóng dòng gán cũ ở 15/03, mở dòng mới từ 16/03.
  await db.update(schema.employeePolicyAssignments).set({ effectiveTo: dEnd("2028-03-15") }).where(eq(schema.employeePolicyAssignments.id, "pe-asg-1"));
  await db.insert(schema.employeePolicyAssignments).values({ id: "pe-asg-2", employeeId: KHO.id, policyId: "pe-pol-2", effectiveFrom: d("2028-03-16") });
  clearMemo();
  const doiCS = await getPayrollReport(THANG3, "profit1");
  const khoD = dong(doiCS, KHO.id)!;
  assert.equal(khoD.engine!.segments.length, 2, "7. đổi chính sách giữa kỳ cắt kỳ thành hai đoạn");
  assert.ok(khoD.engine!.splitAcrossSegments, "7. và màn hình phải biết số đo của kỳ đã bị chia theo ngày");
  const base = khoD.engine!.result.components.find((c) => c.code === "BASE");
  // 16 ngày cuối tháng 3 (31 ngày) × 12 triệu = 6.193.548
  assert.equal(base?.amount, Math.round((12_000_000 * 16) / 31), "7. lương cứng của đoạn sau chỉ tính 16/31 ngày");
  assert.notEqual(base?.amount, 12_000_000, "7. KHÔNG được lấy chính sách mới tính cả tháng");
  // Đoạn đầu vẫn theo chính sách giờ công — giờ công của cả kỳ chia theo ngày cho đoạn đó.
  assert.ok(khoD.engine!.result.components.some((c) => c.code === "HOURLY"), "7. đoạn đầu vẫn tính theo chính sách của chính nó");

  /* ═══ 8 · ẢNH CHỤP MANG THEO VẾT GIẢI THÍCH ═══
   *
   * Kỳ đã chốt phải trả lời được "vì sao tháng ấy trả chừng này" mà KHÔNG truy vấn lại chính sách
   * hôm nay — chính sách hôm nay có thể đã đổi.
   */
  const anh = buildPayrollSnapshot(coUng, THANG3, key);
  const dongAnh = anh.lines.find((l) => l.employeeId === KHO.id)!;
  assert.ok(dongAnh.engine, "8. ảnh chụp phải giữ phần máy chung");
  assert.equal(dongAnh.engine!.netPay, khoC.salary, "8. và giữ đúng con số đã dùng để trả");
  assert.ok(
    dongAnh.engine!.components.every((c) => c.explain.length > 0),
    "8. mỗi thành phần phải mang vết giải thích — dựng lại nó sau bằng chính sách hôm nay là dựng bằng một luật có thể đã đổi",
  );
  assert.equal(anh.lines.find((l) => l.employeeId === CU.id)!.engine, null, "8. người đường cũ không có phần máy chung, và đó là câu trả lời đúng");
  assert.ok(anh.engineVersion >= 1, "8. ảnh chụp mang phiên bản máy tính, tách khỏi phiên bản phép tính cũ");

  /* ═══ 9 · CỔNG CHẶN ĐỌC ĐÚNG TRẠNG THÁI ĐÓNG BĂNG, TRÊN CSDL THẬT ═══
   *
   * Khối 2 của `payroll-production-readiness.test.ts` khoá mệnh đề ở tầng hàm thuần. Khối này khoá
   * TRUY VẤN — vì lỗi thật nằm ở truy vấn, không ở mệnh đề: hàm `isFrozen` vẫn luôn đúng, chỗ sai
   * là cổng chặn hỏi `where status = 'FINAL'` và không bao giờ gọi tới nó.
   *
   * Ba giá trị phải cùng chặn: `FINAL` (dữ liệu CŨ trên production), `LOCKED`, `PAID`.
   */
  const KY9 = "2028-03-01..2028-03-31";
  const anhTam = { calcVersion: 1, lines: [] };
  for (const [trangThai, moc] of [
    // Mốc thời gian phải khai đủ: ràng buộc CSDL không cho "đã duyệt / đã khoá / đã trả" mà
    // không có mốc — và chính ràng buộc ấy vừa chặn lượt gieo dữ liệu đầu tiên của bài này.
    ["FINAL", { finalizedAt: new Date() }],
    ["LOCKED", { finalizedAt: new Date(), approvedAt: new Date(), lockedAt: new Date() }],
    ["PAID", { finalizedAt: new Date(), approvedAt: new Date(), lockedAt: new Date(), paidAt: new Date() }],
  ] as const) {
    await db.delete(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, KY9));
    await db.insert(schema.payrollPeriods).values({
      periodKey: KY9,
      periodStart: d("2028-03-01"),
      periodEnd: dEnd("2028-03-31"),
      basis: "profit1",
      status: trangThai,
      snapshot: anhTam,
      ...moc,
    });
    assert.equal(
      await periodFinalized(KY9),
      true,
      `9. kỳ ở trạng thái ${trangThai} phải KHOÁ đường nhập liệu — bản trước chỉ hỏi đúng chữ 'FINAL' nên một kỳ vừa khoá vẫn nhận thêm chấm công và khoản điều chỉnh`,
    );
    const runs = await frozenPeriodRuns(KY9);
    assert.equal(runs.length, 1, `9. ${trangThai}: phải liệt kê được đúng cơ sở đang đóng băng`);
    assert.equal(runs[0].basis, "profit1", `9. ${trangThai}: và nói đúng cơ sở nào`);
  }

  // Trạng thái CÒN SỬA ĐƯỢC thì KHÔNG khoá — chặn nhầm cũng tệ ngang chặn thiếu.
  for (const trangThai of ["DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED"] as const) {
    await db.delete(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, KY9));
    await db.insert(schema.payrollPeriods).values({
      periodKey: KY9,
      periodStart: d("2028-03-01"),
      periodEnd: dEnd("2028-03-31"),
      basis: "profit1",
      status: trangThai,
      snapshot: anhTam,
      finalizedAt: new Date(),
      approvedAt: trangThai === "APPROVED" ? new Date() : null,
    });
    assert.equal(await periodFinalized(KY9), false, `9. ${trangThai} còn sửa được — đó chính là lý do bốn trạng thái ấy tồn tại`);
  }
  await db.delete(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, KY9));

  /* ═══ 10 · GHI SỔ LỖ HAI LẦN KHÔNG ĐƯỢC ĐẺ RA DÒNG THỨ HAI ═══
   *
   * Hai yêu cầu "Tính & chụp ảnh kỳ" bấm cùng lúc, hoặc một người bấm lại vì trang tải chậm. Khoá
   * tự nhiên (người, tháng, thành phần) + `onConflictDoUpdate` là thứ giữ cho sổ không nhân đôi;
   * và `setWhere: status = 'DRAFT'` giữ cho một dòng ĐÃ CHỐT không bị lượt sau ghi đè.
   */
  const c = schema.marketerProfitCarryover;
  await db.delete(c).where(sql`${c.employeeId} like 'pe-%'`);
  const dongSo = {
    employeeId: "pe-kho-1",
    monthKey: "2028-03",
    componentCode: "MARKETING_PROFIT",
    openingBalance: -5_000_000,
    openingSource: "PREV_MONTH" as const,
    realProfit: 8_000_000,
    lossApplied: 5_000_000,
    commissionBase: 3_000_000,
    commissionRateBp: 1000,
    signedCommission: 300_000,
    payableCommission: 300_000,
    closingBalance: 0,
    status: "DRAFT" as const,
    snapshot: { canCu: "bài kiểm" },
  };
  for (let i = 0; i < 3; i += 1) {
    await db.insert(c).values(dongSo).onConflictDoUpdate({
      target: [c.employeeId, c.monthKey, c.componentCode],
      set: { ...dongSo, updatedAt: new Date() },
      setWhere: eq(c.status, "DRAFT"),
    });
  }
  const demSo = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(sql`${c.employeeId} like 'pe-%'`);
  assert.equal(demSo[0].n, 1, "10. ghi ba lần vẫn đúng MỘT dòng sổ lỗ — nhân đôi ở đây là bù lỗ hai lần cho cùng một tháng");

  // Dòng đã CHỐT: lượt ghi sau KHÔNG được đè lên.
  // `marketer_carryover_final_check`: chốt mà không có ảnh chụp thì "chốt" không có nghĩa gì.
  await db.update(c).set({ status: "FINAL", finalizedAt: new Date() }).where(sql`${c.employeeId} like 'pe-%'`);
  await db.insert(c).values({ ...dongSo, closingBalance: -999_999 }).onConflictDoUpdate({
    target: [c.employeeId, c.monthKey, c.componentCode],
    set: { ...dongSo, closingBalance: -999_999, updatedAt: new Date() },
    setWhere: eq(c.status, "DRAFT"),
  });
  const [sauKhiChot] = await db.select({ closing: c.closingBalance, status: c.status }).from(c).where(sql`${c.employeeId} like 'pe-%'`);
  assert.equal(sauKhiChot.closing, 0, "10. dòng ĐÃ CHỐT không bị lượt ghi sau đè — một nghĩa vụ đã chốt mà đổi số là sửa lịch sử");
  assert.equal(sauKhiChot.status, "FINAL", "10. và vẫn ở trạng thái đã chốt");
  await db.delete(c).where(sql`${c.employeeId} like 'pe-%'`);

  /* ═══ 11 · CHẾ ĐỘ CHỈ ĐỌC: CHỨNG MINH BẰNG CÁCH THỬ GHI, KHÔNG BẰNG CÁCH ĐỌC MÃ ═══
   *
   * Script đối chiếu chạy trên production bật `default_transaction_read_only`. Quét mã nguồn chỉ
   * chứng minh được cờ ĐƯỢC ĐẶT; khối này chứng minh nó CÓ HIỆU LỰC — bằng cách thật sự thử ghi
   * và đòi CSDL từ chối.
   *
   * Đặt lại READ WRITE trong `finally`: bỏ sót thì mọi bài chạy sau đều đỏ vì một lý do hoàn toàn
   * không liên quan, và người đọc sẽ đi tìm lỗi ở đúng chỗ không có lỗi.
   */
  try {
    await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    let biTuChoi = false;
    try {
      await db.insert(schema.payrollAdjustments).values({
        employeeId: "pe-kho-1",
        periodKey: "2028-03-01..2028-03-31",
        kind: "BONUS",
        label: "Thử ghi khi chỉ đọc",
        amount: 1,
        reason: "bài kiểm chế độ chỉ đọc",
      });
    } catch {
      biTuChoi = true;
    }
    assert.equal(biTuChoi, true, "11. phiên CHỈ ĐỌC phải làm CSDL từ chối lệnh ghi — nếu không, 'chỉ đọc' chỉ là một lời hứa trong khối chú thích");

    // Và ĐỌC vẫn phải chạy được, nếu không thì chế độ ấy vô dụng.
    const van = await db.select({ n: sql<number>`count(*)::int` }).from(schema.payrollAdjustments);
    assert.ok(van[0].n >= 0, "11. đọc vẫn phải chạy được ở chế độ chỉ đọc");
  } finally {
    await db.execute(sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`);
  }

  await reset(db);
  console.log("  ✓ Máy tính lương chung nối vào bảng lương thật: chưa gán ⇒ sai lệch cũ/mới bằng ĐÚNG 0 · chấm công thiếu ⇒ CHƯA BIẾT · đổi chính sách giữa kỳ ⇒ mỗi đoạn một luật · tính lại bất biến · ảnh chụp giữ vết giải thích · cổng chặn đọc CẢ FINAL/LOCKED/PAID · sổ lỗ ghi lại không nhân đôi · phiên CHỈ ĐỌC thật sự chặn được lệnh ghi");
}
