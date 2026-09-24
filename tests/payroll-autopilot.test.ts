import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { employmentWindow } from "@/lib/constants/payroll-employment";
import {
  PAYROLL_AUTOPILOT_KEY,
  closeMomentOf,
  monthPeriod,
  payslipState,
  planAutopilot,
  summarizeConfirmations,
  targetMonth,
  type AutopilotInput,
} from "@/lib/constants/payroll-autopilot";
import { applySettlement, runPayrollAutopilot, MACHINE } from "@/lib/payroll/autopilot";
import { completePaidPeriods, ensurePayoutLines, matchPayoutLineManually, matchPayoutLines } from "@/lib/payroll/payout";
import { recordPayslipResponse } from "@/lib/payroll/payslip-delivery";
import { transitionPayrollRunAs } from "@/lib/payroll/run-service";
import { settlementFor } from "@/lib/payroll/settlement";
import { buildVietQrPayload, crc16, matchesTransferNote, toTransferText, transferNoteFor } from "@/lib/payroll/vietqr";
import { getPayrollReport } from "@/lib/queries/payroll";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ LƯƠNG TỰ ĐỘNG — docs/payroll-autopilot.md ═══════════
 *
 * Chủ shop chốt 25/09/2026: chốt số ngày 01, trả ngày 15, phiếu gửi riêng từng người, khiếu nại không
 * chặn trả lương. Bộ này khoá những điều mà sai một cái là sai TIỀN của người thật:
 *
 *   1. mã QR đúng chuẩn NAPAS (CRC kiểm bằng véc-tơ chuẩn, không bằng chính hàm đang kiểm);
 *   2. hai người KHÔNG BAO GIỜ chung (hay lồng) nội dung chuyển khoản;
 *   3. "đã trả" chỉ có khi một dòng sao kê khớp CẢ nội dung LẪN số tiền;
 *   4. nghỉ giữa tháng vẫn được trả những ngày còn làm;
 *   5. máy không bao giờ ký thay người (duyệt · khoá);
 *   6. quyết toán kỳ trước đi bằng TỶ LỆ ĐÃ CHỐT và không đụng dòng người nhập;
 *   7. im lặng quá hạn KHÔNG phải "đã xác nhận".
 *
 * Mọi mốc thời gian là THAM SỐ tường minh (AGENTS.md mục 50): không bài nào đọc đồng hồ thật để quyết
 * định đúng/sai. Dữ liệu CSDL đặt ở năm 2029 để không chạm fixture của bộ khác.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

export function testPayrollAutopilotPure() {
  /* ═══ 1 · VIETQR ═══ */
  // Véc-tơ chuẩn của CRC-16/CCITT-FALSE — nếu hàm sai thuật toán thì mọi mã QR đều bị app từ chối.
  assert.equal(crc16("123456789"), "29B1", "1. CRC-16/CCITT-FALSE của '123456789' phải là 29B1");
  const qr = buildVietQrPayload({ bin: "970422", accountNumber: "0123456789", amount: 8_000_000, note: "LUONG T082029 AB2C" });
  assert.ok(qr.ok, "1. dữ liệu hợp lệ phải dựng được mã");
  if (qr.ok) {
    assert.ok(qr.payload.startsWith("000201010212"), "1. phiên bản 01 + mã ĐỘNG (12) vì có số tiền");
    assert.ok(qr.payload.includes("0010A000000727"), "1. định danh NAPAS");
    assert.ok(qr.payload.includes("00069704220110" + "0123456789"), "1. BIN + số tài khoản nằm trong trường người thụ hưởng");
    assert.ok(qr.payload.includes("0208QRIBFTTA"), "1. dịch vụ chuyển tới SỐ TÀI KHOẢN");
    assert.ok(qr.payload.includes("5303704") && qr.payload.includes("54078000000") && qr.payload.includes("5802VN"), "1. tiền tệ VND, số tiền, quốc gia");
    assert.ok(qr.payload.includes("0818LUONG T082029 AB2C"), "1. nội dung chuyển khoản ở trường 62/08");
    const body = qr.payload.slice(0, -4);
    assert.ok(body.endsWith("6304"), "1. trường CRC đứng cuối");
    assert.equal(qr.payload.slice(-4), crc16(body), "1. CRC tính trên toàn chuỗi kể cả '6304'");
  }
  assert.equal(buildVietQrPayload({ bin: "97042", accountNumber: "0123456789", amount: 1, note: "" }).ok, false, "1. BIN sai độ dài bị từ chối — sai BIN là tiền đi sang ngân hàng khác");
  assert.equal(buildVietQrPayload({ bin: "970422", accountNumber: "0123456789", amount: 0, note: "" }).ok, false, "1. số tiền 0 không dựng mã");
  assert.equal(buildVietQrPayload({ bin: "970422", accountNumber: "0123456789", amount: 1.5, note: "" }).ok, false, "1. VND không có số lẻ");
  assert.equal(toTransferText("Lương tháng 9 — Đặng"), "LUONG THANG 9 DANG", "1. nội dung bỏ dấu, viết hoa, bỏ ký tự lạ");

  /* ═══ 2 · NỘI DUNG CHUYỂN KHOẢN: ỔN ĐỊNH, KHÔNG TRÙNG, KHÔNG LỒNG ═══ */
  const kk = "2029-08-01..2029-08-31";
  assert.equal(transferNoteFor(kk, "emp-a"), transferNoteFor(kk, "emp-a"), "2. chạy lại ra CÙNG nội dung — lập lại lệnh không đổi mã");
  assert.ok(transferNoteFor(kk, "emp-a").startsWith("LUONG T082029 "), "2. người nhận đọc sao kê là biết khoản lương tháng nào");
  const taken = new Set<string>();
  for (let i = 0; i < 300; i += 1) taken.add(transferNoteFor(kk, `nhan-su-${i}`, taken));
  assert.equal(taken.size, 300, "2. 300 người, 300 nội dung khác nhau");
  const squash = (s: string) => s.replace(/ /g, "");
  const list = [...taken];
  for (const a of list) for (const b of list) if (a !== b) assert.ok(!squash(b).startsWith(squash(a)), `2. "${a}" là tiền tố của "${b}" — một lần chuyển cho người này sẽ khớp cả người kia`);

  /* ═══ 3 · KHỚP TIỀN RA: CẢ NỘI DUNG LẪN SỐ TIỀN ═══ */
  const lenh = { amount: 8_000_000, transferNote: "LUONG T082029 AB2C" };
  assert.ok(matchesTransferNote({ amount: -8_000_000, description: "MBVCB.1234.LUONG T082029 AB2C.CT tu 9972165264 toi 0123" }, lenh), "3. ngân hàng chèn tiền tố vẫn khớp");
  assert.ok(matchesTransferNote({ amount: -8_000_000, description: "luong t082029ab2c" }, lenh), "3. khác hoa thường / khoảng trắng vẫn khớp");
  assert.ok(!matchesTransferNote({ amount: -7_000_000, description: "LUONG T082029 AB2C" }, lenh), "3. chuyển THIẾU không phải đã trả đủ");
  assert.ok(!matchesTransferNote({ amount: 8_000_000, description: "LUONG T082029 AB2C" }, lenh), "3. tiền VÀO không phải trả lương");
  assert.ok(!matchesTransferNote({ amount: -8_000_000, description: "LUONG T082029 XY9Z" }, lenh), "3. cùng số tiền nhưng mã người khác ⇒ không khớp (hai người cùng lương cứng)");

  /* ═══ 4 · NGÀY VÀO / NGÀY NGHỈ ═══ */
  const tu = vn("2029-08-01T00:00:00");
  const den = vn("2029-08-31T23:59:59.999");
  const w1 = employmentWindow({ active: true }, tu, den);
  assert.ok(w1.included && !w1.clipped, "4. không khai ngày ⇒ y như trước: có mặt cả kỳ");
  assert.equal(employmentWindow({ active: false }, tu, den).included, false, "4. tắt cờ mà không khai ngày ⇒ vắng mặt như trước (không đoán ngày)");
  const w2 = employmentWindow({ active: false, leftOn: "2029-08-10" }, tu, den);
  assert.ok(w2.included && w2.clipped, "4. NGHỈ GIỮA THÁNG vẫn có dòng lương của tháng ấy — đây là lỗi bản này sửa");
  if (w2.included) assert.equal(w2.to?.toISOString(), vn("2029-08-10T23:59:59.999").toISOString(), "4. tính tới HẾT ngày làm cuối");
  assert.equal(employmentWindow({ active: false, leftOn: "2029-07-31" }, tu, den).included, false, "4. nghỉ trước kỳ ⇒ không có dòng");
  const w3 = employmentWindow({ active: true, startedOn: "2029-08-20" }, tu, den);
  assert.ok(w3.included && w3.clipped && w3.from?.getTime() === vn("2029-08-20T00:00:00").getTime(), "4. vào làm giữa tháng ⇒ tính từ ngày vào");
  assert.equal(employmentWindow({ active: true, startedOn: "2029-09-02" }, tu, den).included, false, "4. vào làm sau kỳ ⇒ không có dòng");

  /* ═══ 5 · LỊCH CỦA MÁY ═══ */
  assert.equal(targetMonth(vn("2029-09-01T10:00:00")), "2029-08", "5. ngày 01/09 máy lo kỳ tháng 08");
  assert.equal(targetMonth(vn("2029-01-05T10:00:00")), "2028-12", "5. qua năm");
  assert.equal(targetMonth(new Date("2029-08-31T17:30:00Z")), "2029-08", "5. 00:30 ngày 01/09 giờ VN (17:30Z hôm trước) — ngày tính theo lịch VIỆT NAM");
  assert.equal(closeMomentOf("2029-08").toISOString(), vn("2029-09-01T09:00:00").toISOString(), "5. máy bắt đầu thử tính lúc 09:00 ngày chốt");
  assert.deepEqual(monthPeriod("2028-02"), { monthKey: "2028-02", fromKey: "2028-02-01", toKey: "2028-02-29", periodKey: "2028-02-01..2028-02-29", label: "tháng 02/2028" }, "5. tháng 2 năm nhuận");
  const base: AutopilotInput = { now: vn("2029-09-01T10:00:00"), enabled: true, monthKey: "2029-08", status: "NONE", blockers: null, confirmations: null, payout: null, previousFrozen: false };
  const kinds = (i: AutopilotInput) => planAutopilot(i).map((s) => s.kind);
  assert.deepEqual(kinds({ ...base, enabled: false }), ["WAIT"], "5. công tắc TẮT ⇒ máy không làm gì với kỳ");
  assert.deepEqual(kinds({ ...base, now: vn("2029-09-01T08:59:00") }), ["WAIT"], "5. trước 09:00 ngày chốt ⇒ chờ");
  assert.deepEqual(kinds(base), ["CALCULATE_AND_SEND"], "5. sau giờ chốt, kỳ chưa tính ⇒ tính & gửi");
  assert.deepEqual(kinds({ ...base, previousFrozen: true }), ["SETTLE_PREVIOUS", "CALCULATE_AND_SEND"], "5. kỳ trước đã khoá ⇒ quyết toán TRƯỚC rồi mới tính (điều chỉnh phải nằm trong ảnh chụp)");
  assert.deepEqual(kinds({ ...base, status: "CALCULATED" }), ["HUMAN"], "5. kỳ bị trả về rồi tính lại ⇒ người sửa tự gửi lại, máy không đoán");
  const cho = summarizeConfirmations([{ status: "PENDING", deadlineAt: vn("2029-09-03T10:00:00"), recipientUserId: "u" }], vn("2029-09-02T10:00:00"));
  assert.deepEqual(kinds({ ...base, status: "UNDER_REVIEW", confirmations: cho, now: vn("2029-09-02T10:00:00") }), ["WAIT"], "5. còn người trong hạn ⇒ chờ");
  const xong = summarizeConfirmations([{ status: "CONFIRMED", deadlineAt: vn("2029-09-03T10:00:00"), recipientUserId: "u" }], vn("2029-09-02T10:00:00"));
  assert.deepEqual(kinds({ ...base, status: "UNDER_REVIEW", confirmations: xong }), ["NOTIFY_READY"], "5. đủ trả lời ⇒ báo duyệt");
  assert.deepEqual(kinds({ ...base, status: "UNDER_REVIEW", confirmations: xong, now: vn("2029-09-13T10:00:00") }), ["NOTIFY_READY", "REMIND_APPROVAL"], "5. ngày 13 chưa duyệt ⇒ nhắc");
  assert.deepEqual(kinds({ ...base, status: "LOCKED", payout: { lines: 2, pending: 1, paid: 1 }, now: vn("2029-09-14T10:00:00") }), ["ENSURE_PAYOUT"], "5. trước ngày 15 không nhắc chuyển");
  assert.deepEqual(kinds({ ...base, status: "LOCKED", payout: { lines: 2, pending: 1, paid: 1 }, now: vn("2029-09-15T08:00:00") }), ["ENSURE_PAYOUT", "REMIND_PAYDAY"], "5. ngày 15 còn người chưa chuyển ⇒ nhắc");
  assert.deepEqual(kinds({ ...base, status: "PAID" }), ["DONE"], "5. đã trả ⇒ xong");
  for (const s of ["NONE", "DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED", "LOCKED", "PAID"] as const) {
    assert.ok(!planAutopilot({ ...base, status: s }).some((x) => /APPROVE|LOCK$|MARK_PAID/.test(x.kind)), `5. ở ${s} kế hoạch KHÔNG có bước nào là chữ ký của người`);
  }

  /* ═══ 7 · IM LẶNG KHÔNG PHẢI ĐỒNG Ý ═══ */
  const han = vn("2029-09-03T10:00:00");
  assert.equal(payslipState({ status: "PENDING", deadlineAt: han, recipientUserId: "u" }, vn("2029-09-03T09:59:00")), "PENDING");
  assert.equal(payslipState({ status: "PENDING", deadlineAt: han, recipientUserId: "u" }, vn("2029-09-03T10:01:00")), "NO_RESPONSE", "7. quá hạn ⇒ KHÔNG PHẢN HỒI, không phải ĐÃ XÁC NHẬN");
  assert.equal(payslipState({ status: "PENDING", deadlineAt: han, recipientUserId: null }, vn("2029-09-02T00:00:00")), "NOT_DELIVERED", "7. chưa nối tài khoản ⇒ nói là chưa gửi được, không giả vờ đang chờ");
  assert.equal(payslipState({ status: "CONFIRMED", deadlineAt: han, recipientUserId: "u" }, vn("2029-09-09T00:00:00")), "CONFIRMED");

  /* ═══ 6 · QUYẾT TOÁN BẰNG TỶ LỆ ĐÃ CHỐT ═══ */
  const snap = (over: Partial<PayrollSnapshot["lines"][number]> = {}): PayrollSnapshot["lines"][number] => ({
    employeeId: "e1",
    name: "Nguyễn A",
    shortName: "A",
    department: "Marketing",
    percentTotal: 0,
    percentPersonal: 20,
    percentRevenue: 1,
    fixedMonthly: 5_000_000,
    fixed: 5_000_000,
    totalProfit: 50_000_000,
    personalProfit: 10_000_000,
    personalRevenue: 100_000_000,
    bonusTotal: 0,
    bonusPersonal: 2_000_000,
    bonusRevenue: 1_000_000,
    salary: 8_000_000,
    carry: null,
    engine: null,
    ...over,
  });
  const song = { employeeId: "e1", totalProfit: 60_000_000, personalProfit: 14_000_000, personalRevenue: 130_000_000, engine: null };
  const r1 = settlementFor(snap(), song);
  assert.ok(r1.status === "OK", "6. đường cũ quyết toán được");
  if (r1.status === "OK") assert.equal(r1.delta, 2_800_000 + 1_300_000 - 3_000_000, "6. Δ = (20% × 14tr + 1% × 130tr) − (2tr + 1tr) = 1.100.000 — lương cứng KHÔNG quyết toán");
  const r2 = settlementFor(snap({ percentPersonal: 20 }), { ...song, personalProfit: -5_000_000, personalRevenue: 100_000_000 });
  if (r2.status === "OK") assert.equal(r2.delta, -2_000_000, "6. LN cá nhân về âm (hoàn muộn) ⇒ TRUY THU phần hoa hồng đã trả, không trả hoa hồng âm");
  assert.equal(settlementFor(snap({ carry: { monthKey: "2029-08", openingBalance: 0, openingReason: "", realProfit: 0, lossApplied: 0, commissionBase: 0, signedCommission: 0, closingBalance: 0 } }), song).status, "MANUAL", "6. có sổ lỗ lũy kế ⇒ người quyết toán, máy không đoán chuỗi số dư");
  assert.equal(settlementFor(snap(), { ...song, personalProfit: null }).status, "UNKNOWN", "6. LN cá nhân CHƯA BIẾT ⇒ không quy về 0");
  assert.equal(settlementFor(snap(), null).status, "UNKNOWN", "6. người không còn trong sổ ⇒ nói ra");
  const eng = (amount: number | null, carry: unknown = null) => ({ policy: [], components: [{ code: "HH", label: "Hoa hồng", kind: "COMMISSION", amount, basisKey: null, basisValue: null, explain: [], carry: carry as null }], adjustments: [], grossEarnings: null, totalDeductions: null, netPay: null, segments: [] });
  const r3 = settlementFor(snap({ engine: eng(1_000_000) }), { ...song, engine: { components: [{ kind: "COMMISSION", amount: 1_400_000, carry: null }, { kind: "FIXED", amount: 9_000_000, carry: null }] } });
  if (r3.status === "OK") assert.equal(r3.delta, 400_000, "6. máy chung: chỉ chênh phần HOA HỒNG, không cộng lương cứng");
  assert.equal(settlementFor(snap({ engine: eng(1_000_000, { openingBalance: 0 }) }), song).status, "MANUAL", "6. hoa hồng máy chung có bù lỗ ⇒ người quyết toán");

  console.log("  ✓ Lương tự động (thuần): VietQR đúng chuẩn · nội dung CK không trùng/lồng · khớp cả nội dung lẫn số tiền · nghỉ giữa tháng vẫn được trả · lịch máy theo giờ VN và không bao giờ ký thay · quyết toán bằng tỷ lệ đã chốt · im lặng ≠ đồng ý");
}

/* ═══════════════════════ LUỒNG THẬT TRÊN CSDL ═══════════════════════ */

const P = "pa29-";

export async function testPayrollAutopilotFlow(db: Db) {
  const truocNhanSu = await getSettingJson<{ list: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] });
  const truocCongTac = await getSettingJson<unknown>(PAYROLL_AUTOPILOT_KEY, null);
  const truocGhiNhan = await getSettingJson<unknown>(PAYROLL_RECOGNITION_KEY, null);
  const aug = monthPeriod("2029-08");
  const sep = monthPeriod("2029-09");
  const don = async () => {
    await db.delete(schema.payrollPayoutLines).where(sql`${schema.payrollPayoutLines.periodKey} like '2029-%'`);
    await db.delete(schema.bankTransactionLinks).where(sql`${schema.bankTransactionLinks.txnId} like ${`${P}%`}`);
    await db.delete(schema.bankTransactions).where(sql`${schema.bankTransactions.id} like ${`${P}%`}`);
    await db.delete(schema.payrollConfirmations).where(sql`${schema.payrollConfirmations.periodKey} like '2029-%'`);
    await db.delete(schema.payrollAdjustments).where(sql`${schema.payrollAdjustments.periodKey} like '2029-%'`);
    await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} like '2029-%'`);
    await db.delete(schema.userMessages).where(sql`${schema.userMessages.userId} like ${`${P}%`}`);
    await db.delete(schema.users).where(sql`${schema.users.id} like ${`${P}%`}`);
  };
  await don();

  await db.insert(schema.users).values([
    { id: `${P}admin`, email: `${P}admin@t.local`, name: "Chủ shop", role: "ADMIN", passwordHash: "x", active: true },
    { id: `${P}an`, email: `${P}an@t.local`, name: "An", role: "WAREHOUSE", passwordHash: "x", active: true },
  ]);
  const an: Employee = {
    id: `${P}e-an`, name: "Lê Văn An", shortName: "An", department: "Kho / Đóng gói", aliases: [], accountIds: [], userEmail: `${P}an@t.local`,
    fixed: 9_000_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "",
    bankBin: "970422", bankAccount: "0011223344", bankAccountName: "LE VAN AN",
  };
  // Nghỉ 10/08, đã tắt cờ, KHÔNG có tài khoản ERP và KHÔNG khai STK.
  const binh: Employee = {
    id: `${P}e-binh`, name: "Trần Bình", shortName: "Bình", department: "Kho / Đóng gói", aliases: [], accountIds: [], userEmail: "",
    fixed: 6_200_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: false, note: "", leftOn: "2029-08-10",
  };
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [an, binh] });
  await setSettingJson(PAYROLL_AUTOPILOT_KEY, { enabled: true });
  /*
    Lương tự động đòi bảng Lương là NGUỒN ghi nhận chi phí nhân sự: ngày 01 chưa ai nhập khoản chi
    "Lương" của tháng trước vào bảng Chi phí, nên ở chế độ cũ kỳ nào cũng bị chặn chốt (lợi nhuận chưa
    trừ đồng lương nào). Đây là bước cài đặt một lần của chủ shop — docs/payroll-autopilot.md §0.
  */
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  clearMemo();
  const chan = await runPayrollAutopilot(vn("2029-09-01T09:30:00"));
  assert.ok(chan.notes.some((n) => n.includes("bảng Chi phí")), "0. chế độ ghi nhận cũ + chưa có chi phí lương ⇒ máy KHÔNG chốt, và nói ĐỦ lý do (không chỉ dòng đầu)");
  assert.equal((await db.select().from(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, aug.periodKey))).length, 0, "0. bị chặn thì không có ảnh chụp nào");
  assert.equal((await db.select().from(schema.userMessages).where(and(eq(schema.userMessages.userId, `${P}admin`), eq(schema.userMessages.kind, "PAYROLL_BLOCKED")))).length, 1, "0. chủ shop nhận MỘT tin chặn trong ngày");
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  // Tạm ứng giữa tháng của An — người ở ĐƯỜNG TÍNH CŨ, trước bản này khoản này bị bỏ qua im lặng.
  await db.insert(schema.payrollAdjustments).values({ employeeId: an.id, periodKey: aug.periodKey, kind: "ADVANCE", label: "Tạm ứng 15/08", amount: 1_000_000, reason: "Ứng tiền nhà" });
  clearMemo();

  /* ── A · bảng lương thật: điều chỉnh vào lương đường cũ, người nghỉ giữa tháng vẫn có dòng ── */
  const report = await getPayrollReport({ key: "custom", from: vn(`${aug.fromKey}T00:00:00`), to: vn(`${aug.toKey}T23:59:59.999`), fromKey: aug.fromKey, toKey: aug.toKey, label: aug.label }, "profit1");
  const dongAn = report.lines.find((l) => l.employee.id === an.id);
  const dongBinh = report.lines.find((l) => l.employee.id === binh.id);
  assert.equal(dongAn?.salary, 8_000_000, "A. 9tr lương cứng − 1tr tạm ứng: khoản điều chỉnh PHẢI vào lương người đi đường cũ");
  assert.equal(dongAn?.legacyAdjustments?.total, -1_000_000, "A. tạm ứng mang dấu TRỪ");
  assert.ok(dongBinh, "A. nghỉ ngày 10 vẫn có dòng lương tháng 8 — trước bản này người này biến mất");
  assert.equal(dongBinh?.fixed, 2_000_000, "A. 6,2tr × 10/31 ngày = 2.000.000");
  assert.deepEqual(dongBinh?.employmentClip, { from: "2029-08-01", to: "2029-08-10", days: 10 });

  /* ── B · máy tự tính & gửi phiếu ── */
  const lan1 = await runPayrollAutopilot(vn("2029-09-01T10:00:00"));
  assert.ok(lan1.plan.some((s) => s.kind === "CALCULATE_AND_SEND"), "B. ngày 01 sau 09:00 máy tính & gửi");
  const [ky] = await db.select().from(schema.payrollPeriods).where(and(eq(schema.payrollPeriods.periodKey, aug.periodKey), eq(schema.payrollPeriods.basis, "profit1")));
  assert.equal(ky?.status, "UNDER_REVIEW", `B. kỳ phải sang bước soát (ghi chú máy: ${lan1.notes.join(" | ")})`);
  assert.equal(ky?.finalizedBy, null, "B. người tính là MÁY (NULL), không phải một tài khoản nào");
  const phieu = await db.select().from(schema.payrollConfirmations).where(eq(schema.payrollConfirmations.periodKey, aug.periodKey));
  const phieuAn = phieu.find((r) => r.employeeId === an.id)!;
  const phieuBinh = phieu.find((r) => r.employeeId === binh.id)!;
  assert.equal(phieuAn.recipientUserId, `${P}an`, "B. người nhận khớp bằng email hồ sơ ↔ tài khoản (máy chủ khớp)");
  assert.equal(phieuAn.amount, 8_000_000, "B. phiếu mang số THỰC NHẬN của ảnh chụp");
  assert.equal(phieuBinh.recipientUserId, null, "B. không có tài khoản ⇒ không giả vờ đã gửi");
  const hopThuAn = await db.select().from(schema.userMessages).where(eq(schema.userMessages.userId, `${P}an`));
  assert.equal(hopThuAn.length, 1, "B. An nhận đúng MỘT tin");
  assert.ok(!/\d{1,3}(\.\d{3})+/.test(hopThuAn[0].title), "B. tiêu đề tin KHÔNG in số tiền (chuông hiện trên màn hình)");
  const lanLai = await runPayrollAutopilot(vn("2029-09-01T11:00:00"));
  assert.ok(!lanLai.did.some((x) => /Tính & chụp/.test(x)), "B. chạy lại một giờ sau KHÔNG tính lại kỳ đang soát");
  assert.equal((await db.select().from(schema.userMessages).where(eq(schema.userMessages.userId, `${P}an`))).length, 1, "B. và không gửi trùng tin");

  /* ── C · trả lời phiếu: chỉ chủ phiếu, bấm hai lần không ghi thêm ── */
  assert.ok("error" in (await recordPayslipResponse({ userId: `${P}admin`, userEmail: "x", confirmationId: phieuAn.id, decision: "CONFIRMED", note: "" })), "C. người KHÁC (kể cả chủ shop) không trả lời thay được phiếu của An");
  assert.ok("error" in (await recordPayslipResponse({ userId: `${P}an`, userEmail: "x", confirmationId: phieuAn.id, decision: "DISPUTED", note: "" })), "C. khiếu nại không lý do bị từ chối");
  const tl = await recordPayslipResponse({ userId: `${P}an`, userEmail: `${P}an@t.local`, confirmationId: phieuAn.id, decision: "CONFIRMED", note: "" });
  assert.deepEqual(tl, { ok: true, changed: true });
  assert.deepEqual(await recordPayslipResponse({ userId: `${P}an`, userEmail: `${P}an@t.local`, confirmationId: phieuAn.id, decision: "CONFIRMED", note: "" }), { ok: true, changed: false }, "C. bấm lần hai cùng câu trả lời ⇒ không ghi gì (AGENTS.md mục 61)");

  /* ── D · đủ trả lời ⇒ báo chủ shop, nhưng máy KHÔNG duyệt ── */
  const lan2 = await runPayrollAutopilot(vn("2029-09-02T10:00:00"));
  assert.ok(lan2.plan.some((s) => s.kind === "NOTIFY_READY"), "D. An xác nhận, Bình không gửi được ⇒ vòng xác nhận đã khép");
  const tinChu = await db.select().from(schema.userMessages).where(and(eq(schema.userMessages.userId, `${P}admin`), eq(schema.userMessages.kind, "PAYROLL_READY")));
  assert.equal(tinChu.length, 1, "D. chủ shop nhận MỘT tin sẵn sàng duyệt");
  assert.ok("error" in (await transitionPayrollRunAs(MACHINE, { periodKey: aug.periodKey, basis: "profit1", action: "APPROVE", reason: "" })), "D. MÁY không được duyệt — duyệt là chữ ký");
  assert.ok("error" in (await transitionPayrollRunAs(MACHINE, { periodKey: aug.periodKey, basis: "profit1", action: "LOCK", reason: "" })), "D. MÁY không được khoá");

  /* ── E · người duyệt & khoá ⇒ lệnh chuyển lập từ ảnh chụp ── */
  const chu = { id: `${P}admin`, email: `${P}admin@t.local` };
  assert.ok(!("error" in (await transitionPayrollRunAs(chu, { periodKey: aug.periodKey, basis: "profit1", action: "APPROVE", reason: "" }))));
  const khoa = await transitionPayrollRunAs(chu, { periodKey: aug.periodKey, basis: "profit1", action: "LOCK", reason: "" });
  assert.ok(!("error" in khoa), "E. khoá được");
  const lenh = await db.select().from(schema.payrollPayoutLines).where(eq(schema.payrollPayoutLines.periodKey, aug.periodKey));
  const lenhAn = lenh.find((l) => l.employeeId === an.id)!;
  const lenhBinh = lenh.find((l) => l.employeeId === binh.id)!;
  assert.equal(lenhAn.amount, 8_000_000, "E. số chuyển = thực nhận đã duyệt");
  assert.equal(lenhAn.accountNumber, "0011223344", "E. tài khoản chụp từ hồ sơ");
  assert.equal(lenhBinh.accountNumber, "", "E. thiếu STK vẫn có dòng lệnh — để màn hình nói ra, không lặng lẽ bỏ người");
  assert.notEqual(lenhAn.transferNote, lenhBinh.transferNote);
  await ensurePayoutLines({ periodKey: aug.periodKey, basis: "profit1", actor: MACHINE });
  assert.equal((await db.select().from(schema.payrollPayoutLines).where(eq(schema.payrollPayoutLines.periodKey, aug.periodKey))).length, 2, "E. lập lại không đẻ dòng mới");

  /* ── F · "đã trả" chỉ bằng sao kê ── */
  await db.insert(schema.bankTransactions).values([
    // Chuyển THIẾU cho An: không được khớp.
    { id: `${P}t0`, txnAt: vn("2029-09-15T09:00:00"), amount: -7_000_000, description: `CT ${lenhAn.transferNote}`, bankRef: `${P}REF0` },
    { id: `${P}t1`, txnAt: vn("2029-09-15T09:05:00"), amount: -8_000_000, description: `MBVCB.99.${lenhAn.transferNote}.CT tu shop`, bankRef: `${P}REF1` },
    // Chuyển cho Bình, nội dung gõ tay khác mã — máy không nhận ra, người khớp tay.
    { id: `${P}t2`, txnAt: vn("2029-09-15T09:10:00"), amount: -2_000_000, description: "tra luong binh", bankRef: `${P}REF2` },
  ]);
  const khop = await matchPayoutLines();
  assert.equal(khop.matched, 1, "F. máy khớp đúng MỘT dòng: của An, bằng nội dung + số tiền");
  const [anSau] = await db.select().from(schema.payrollPayoutLines).where(eq(schema.payrollPayoutLines.id, lenhAn.id));
  assert.equal(anSau.status, "PAID");
  assert.equal(anSau.bankTxnId, `${P}t1`, "F. chứng từ là dòng 8tr, không phải dòng chuyển thiếu");
  const noi = await db.select().from(schema.bankTransactionLinks).where(eq(schema.bankTransactionLinks.txnId, `${P}t1`));
  assert.equal(noi[0]?.targetType, "PAYROLL_PERIOD", "F. dòng tiền nối vào sổ đối chiếu, đúng đường ghi duy nhất");
  assert.equal(noi[0]?.targetId, "2029-08");
  assert.deepEqual(await completePaidPeriods(), [], "F. còn Bình chưa trả ⇒ kỳ CHƯA được sang Đã trả");
  assert.ok("error" in (await matchPayoutLineManually({ lineId: lenhBinh.id, txnId: `${P}t0`, actor: chu })), "F. khớp tay vẫn đòi ĐÚNG số tiền");
  assert.ok(!("error" in (await matchPayoutLineManually({ lineId: lenhBinh.id, txnId: `${P}t2`, actor: chu }))), "F. người chọn đúng dòng sao kê ⇒ đã trả");
  assert.ok("error" in (await matchPayoutLineManually({ lineId: lenhBinh.id, txnId: `${P}t1`, actor: chu })), "F. một dòng sao kê không trả được hai người");
  assert.deepEqual(await completePaidPeriods(), [aug.periodKey], "F. đủ mọi dòng ⇒ kỳ tự sang Đã trả");
  const [kySau] = await db.select().from(schema.payrollPeriods).where(eq(schema.payrollPeriods.periodKey, aug.periodKey));
  assert.equal(kySau.status, "PAID");
  assert.equal(kySau.paidBy, null, "F. người khép là MÁY — chứng từ là các dòng sao kê");
  assert.equal((await db.select().from(schema.userMessages).where(and(eq(schema.userMessages.userId, `${P}an`), eq(schema.userMessages.kind, "PAYSLIP_PAID")))).length, 1, "F. An nhận tin đã chuyển");

  /* ── G · quyết toán kỳ trước: tỷ lệ đã chốt, không đụng dòng người nhập, chạy lại không nhân đôi ── */
  // Dựng tình huống: ảnh chụp tháng 8 đã trả 500.000đ thưởng 10% LN toàn shop; tính lại hôm nay LN = 0.
  const anh = kySau.snapshot as PayrollSnapshot;
  const anhSua = { ...anh, lines: anh.lines.map((l) => (l.employeeId === an.id ? { ...l, percentTotal: 10, totalProfit: 5_000_000, bonusTotal: 500_000 } : l)) };
  await db.update(schema.payrollPeriods).set({ snapshot: anhSua }).where(eq(schema.payrollPeriods.periodKey, aug.periodKey));
  await db.insert(schema.payrollAdjustments).values({ employeeId: an.id, periodKey: sep.periodKey, kind: "BONUS", label: "Thưởng tay", amount: 300_000, reason: "Người nhập", reference: `AUTO_SETTLEMENT:${aug.periodKey}`, createdBy: `${P}admin` });
  clearMemo();
  const qt = await applySettlement("2029-09");
  assert.ok(!("skipped" in qt), "G. kỳ trước đã khoá ⇒ quyết toán chạy");
  await applySettlement("2029-09");
  const dieuChinh = await db.select().from(schema.payrollAdjustments).where(eq(schema.payrollAdjustments.periodKey, sep.periodKey));
  const may = dieuChinh.filter((r) => r.createdBy === null);
  assert.equal(may.length, 1, "G. chạy hai lần vẫn MỘT dòng của máy");
  assert.equal(may[0].kind, "DEDUCTION");
  assert.equal(may[0].amount, 500_000, "G. truy thu đúng phần thưởng đã trả trên LN không còn");
  assert.ok(may[0].label.includes("truy thu") && may[0].reason.includes("tỷ lệ đã chốt"), "G. dòng nói rõ nó là gì và căn cứ");
  assert.equal(dieuChinh.filter((r) => r.createdBy === `${P}admin`).length, 1, "G. dòng NGƯỜI nhập (dù trùng mã tham chiếu) không bị máy xoá");

  await don();
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, truocNhanSu);
  await setSettingJson(PAYROLL_AUTOPILOT_KEY, truocCongTac ?? { enabled: false });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, truocGhiNhan ?? { mode: "LEGACY_EXPENSES" });
  clearMemo();
  console.log("  ✓ Lương tự động (CSDL): điều chỉnh vào lương đường cũ · nghỉ giữa tháng vẫn có dòng · máy tính & gửi đúng người, không gửi trùng · chỉ chủ phiếu trả lời được · máy không duyệt/khoá · lệnh chuyển từ ảnh chụp · đã trả chỉ bằng sao kê đúng nội dung + số tiền · kỳ tự khép khi đủ · quyết toán bằng tỷ lệ đã chốt, lũy đẳng, không đụng dòng người nhập");
}
