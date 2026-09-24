/**
 * TRANG "TRẢ LƯƠNG TỰ ĐỘNG" — CHỈ ĐỌC.
 *
 * Mọi con số của kỳ đọc từ ẢNH CHỤP (`payroll_periods.snapshot`), không tính lại: đây là trang duyệt
 * và trả tiền, và tính lại ở đây là để con số anh duyệt khác con số nhân viên đã xác nhận.
 * Kế hoạch "hôm nay máy sẽ làm gì" là CHÍNH hàm mà job dùng (`planAutopilot`) — màn hình in đúng thứ
 * máy sẽ làm, không một bản mô tả thứ hai.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  PAYROLL_AUTOPILOT_BASIS,
  monthPeriod,
  payDayOf,
  payslipState,
  planAutopilot,
  shiftMonth,
  summarizeConfirmations,
  targetMonth,
} from "@/lib/constants/payroll-autopilot";
import { isFrozen, normalizePayrollStatus, type PayrollRunStatus } from "@/lib/constants/payroll-lifecycle";
import { getAutopilotConfig, settlementRecordKey, type SettlementRecord } from "@/lib/payroll/autopilot";
import { payoutSummary } from "@/lib/payroll/payout";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { getSettingJson } from "@/lib/settings";
import { DEFAULT_PAYROLL_RECOGNITION, PAYROLL_RECOGNITION_KEY, type PayrollRecognitionConfig } from "@/lib/queries/payroll-cost";
import { DEFAULT_STATUTORY, STATUTORY_DEDUCTION_KEY, type StatutoryConfig } from "@/lib/constants/payroll-statutory";
import { employmentWindow } from "@/lib/constants/payroll-employment";
import { listEmployees } from "@/lib/queries/payroll";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";

/**
 * VIỆC CÀI ĐẶT MỘT LẦN — trước ngày 01 đầu tiên máy chạy. Mỗi mục nói ĐÚNG cái thiếu và chỗ sửa;
 * mục nào thiếu thì máy vẫn chạy phần làm được, nhưng hoặc bị chặn tính (nguồn ghi nhận), hoặc không
 * gửi được phiếu cho người ấy (email), hoặc không dựng được mã QR (tài khoản).
 */
export type SetupItem = { key: string; ok: boolean; title: string; detail: string; href: string };

async function setupChecklist(mp: { fromKey: string; toKey: string }): Promise<SetupItem[]> {
  const db = await getDb();
  const [recognition, statutory, employees] = await Promise.all([
    getSettingJson<PayrollRecognitionConfig>(PAYROLL_RECOGNITION_KEY, DEFAULT_PAYROLL_RECOGNITION),
    getSettingJson<StatutoryConfig>(STATUTORY_DEDUCTION_KEY, DEFAULT_STATUTORY),
    listEmployees(),
  ]);
  const inPeriod = employees.filter((e) => employmentWindow(e, vnStartOfDay(mp.fromKey), vnEndOfDay(mp.toKey)).included);
  const emails = new Set(
    (await db.select({ email: schema.users.email, active: schema.users.active }).from(schema.users)).filter((u) => u.active).map((u) => u.email.trim().toLowerCase()),
  );
  const noAccount = inPeriod.filter((e) => !e.userEmail || !emails.has(e.userEmail.trim().toLowerCase())).map((e) => e.shortName || e.name);
  const noBank = inPeriod.filter((e) => !e.bankAccount).map((e) => e.shortName || e.name);
  return [
    {
      key: "recognition",
      ok: recognition?.mode === "PAYROLL",
      title: "Chi phí nhân sự ghi nhận từ bảng Lương",
      detail:
        recognition?.mode === "PAYROLL"
          ? "Đã bật — lợi nhuận tính lương trừ lương cứng từ bảng Lương."
          : "Đang lấy từ khoản chi “Lương” gõ tay ở bảng Chi phí. Ngày 01 chưa ai nhập khoản ấy nên kỳ nào cũng bị CHẶN chốt. Bật “Nguồn ghi nhận chi phí nhân sự = bảng Lương” ở Cấu hình (một lần).",
      href: "/payroll/settings",
    },
    {
      key: "statutory",
      ok: statutory?.state === "EXEMPT" || statutory?.state === "CONFIGURED",
      title: "Thuế TNCN / BHXH",
      detail: statutory?.state === "EXEMPT" ? "Đã khai Không áp dụng." : statutory?.state === "CONFIGURED" ? "Đã khai." : "Chưa khai — phiếu lương in “Chưa cấu hình”. Anh đã chốt Không áp dụng (cộng tác viên / khoán): khai ở Cấu hình kèm căn cứ.",
      href: "/payroll/settings",
    },
    {
      key: "accounts",
      ok: noAccount.length === 0,
      title: "Nhân sự nối tài khoản ERP (để nhận phiếu)",
      detail: noAccount.length ? `Chưa nối: ${noAccount.join(", ")} — khai “Email đăng nhập ERP” trùng một tài khoản đang bật.` : "Mọi người đều nhận được phiếu.",
      href: "/payroll",
    },
    {
      key: "bank",
      ok: noBank.length === 0,
      title: "Tài khoản nhận lương (để dựng mã QR)",
      detail: noBank.length ? `Chưa khai: ${noBank.join(", ")}.` : "Mọi người đều đã khai.",
      href: "/payroll",
    },
  ];
}

export async function getAutopilotCockpit(userId: string, now: Date = new Date()) {
  const db = await getDb();
  const cfg = await getAutopilotConfig();
  const monthKey = targetMonth(now);
  const mp = monthPeriod(monthKey);
  const p = schema.payrollPeriods;
  const [row] = await db
    .select({ status: p.status, calcRuns: p.calcRuns, snapshot: p.snapshot, approvedAt: p.approvedAt, lockedAt: p.lockedAt, paidAt: p.paidAt, statusReason: p.statusReason })
    .from(p)
    .where(and(eq(p.periodKey, mp.periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS)))
    .limit(1);
  const status: "NONE" | PayrollRunStatus = row ? (row.snapshot === null ? "DRAFT" : normalizePayrollStatus(row.status)) : "NONE";
  const snapshot = (row?.snapshot ?? null) as PayrollSnapshot | null;

  const c = schema.payrollConfirmations;
  const confirmations = row ? await db.select().from(c).where(and(eq(c.periodKey, mp.periodKey), eq(c.basis, PAYROLL_AUTOPILOT_BASIS), eq(c.round, row.calcRuns))) : [];
  const summary = confirmations.length ? summarizeConfirmations(confirmations, now) : null;

  const [prevRow] = await db.select({ status: p.status }).from(p).where(and(eq(p.periodKey, monthPeriod(shiftMonth(monthKey, -1)).periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS))).limit(1);
  const payout = await payoutSummary(mp.periodKey, PAYROLL_AUTOPILOT_BASIS);
  const plan = planAutopilot({
    now,
    enabled: cfg.enabled,
    monthKey,
    status,
    blockers: null,
    confirmations: summary,
    payout,
    previousFrozen: Boolean(prevRow && isFrozen(normalizePayrollStatus(prevRow.status))),
  });

  // Lệnh chuyển: kỳ đang lo + mọi kỳ còn dòng CHỜ CHUYỂN (kỳ trước chưa trả xong không được biến mất).
  const lenhChuyen = schema.payrollPayoutLines;
  const pendingPeriods = (await db.selectDistinct({ periodKey: lenhChuyen.periodKey }).from(lenhChuyen).where(eq(lenhChuyen.status, "PENDING"))).map((r) => r.periodKey);
  const periodsForPayout = [...new Set([mp.periodKey, ...pendingPeriods])];
  const payoutLines = await db
    .select()
    .from(lenhChuyen)
    .where(and(inArray(lenhChuyen.periodKey, periodsForPayout), ne(lenhChuyen.status, "CANCELLED")))
    .orderBy(desc(lenhChuyen.periodKey), lenhChuyen.employeeName);

  const settlement = await getSettingJson<SettlementRecord | null>(settlementRecordKey(mp.periodKey), null);

  // Lý do chặn gần nhất máy đã báo (hộp thư của chính người xem) — để không phải tính lại cả bảng lương.
  const m = schema.userMessages;
  const [blocked] = await db
    .select({ body: m.body, createdAt: m.createdAt })
    .from(m)
    .where(and(eq(m.userId, userId), eq(m.kind, "PAYROLL_BLOCKED")))
    .orderBy(desc(m.createdAt))
    .limit(1);

  const setup = await setupChecklist(mp);

  return {
    config: cfg,
    setup,
    monthKey,
    period: mp,
    payDay: payDayOf(monthKey),
    status,
    calcRuns: row?.calcRuns ?? 0,
    approvedAt: row?.approvedAt ?? null,
    lockedAt: row?.lockedAt ?? null,
    paidAt: row?.paidAt ?? null,
    totalSalary: snapshot?.totalSalary ?? null,
    people: snapshot?.lines.length ?? null,
    confirmations: confirmations.map((r) => ({ ...r, state: payslipState(r, now) })),
    summary,
    plan,
    payoutLines,
    settlement,
    lastBlocked: blocked && status !== "UNDER_REVIEW" && status !== "APPROVED" && status !== "LOCKED" && status !== "PAID" ? blocked : null,
  };
}
