/**
 * ═══════════ GỬI PHIẾU LƯƠNG CHO TỪNG NGƯỜI, VÀ NHẬN LỜI XÁC NHẬN ═══════════
 *
 * Đặc tả: `docs/payroll-autopilot.md` §3.
 *
 * ─── GỬI CÁI GÌ ───
 *
 * Phiếu gửi đi là ẢNH CHỤP của kỳ tại lúc chuyển soát — không phải bản tính sống. Người lao động xác
 * nhận ĐÚNG con số họ nhìn thấy; nếu kỳ bị tính lại sau đó thì lượt gửi cũ đứng yên làm lịch sử
 * (`round` cũ) và lượt mới gửi lại. Một lời "đồng ý" không bao giờ trôi sang một con số khác.
 *
 * ─── GỬI CHO AI ───
 *
 * Người nhận do MÁY CHỦ khớp: email khai trong hồ sơ nhân sự ↔ email tài khoản ERP đang bật (cùng
 * luật với `employeeMatchesUser` — khoá tài khoản, không so tên; AGENTS.md mục 34). Hồ sơ chưa nối
 * được tài khoản nào thì vẫn có dòng, `recipient_user_id = NULL`, và màn hình in "chưa gửi được" —
 * không giả vờ đã gửi.
 *
 * ─── AI ĐƯỢC TRẢ LỜI ───
 *
 * CHỈ chủ tài khoản nhận phiếu (`recipient_user_id = người đang đăng nhập`), chỉ khi kỳ còn đang soát,
 * và chỉ cho lượt gửi MỚI NHẤT. Bấm hai lần cùng một câu trả lời thì lượt sau không ghi gì (mục 61).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { payrollApproverUserIds, sendInboxMessages } from "@/lib/inbox/send";
import { PAYSLIP_CONFIRM_WINDOW_HOURS } from "@/lib/constants/payroll-autopilot";
import { normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { formatDateTime, formatVND } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import type { PayrollActor } from "@/lib/payroll/run-service";

/** Thực nhận của một dòng ảnh chụp: máy chung → `netPay`, đường cũ → `salary`. */
export function snapshotNetPay(line: PayrollSnapshot["lines"][number]): number | null {
  return line.engine ? line.engine.netPay : line.salary;
}

/** Nhãn kỳ đọc được từ khoá `YYYY-MM-DD..YYYY-MM-DD`: "tháng 09/2026" khi trọn tháng. */
export function periodLabelOf(periodKey: string): string {
  const [from, to] = periodKey.split("..");
  if (from?.endsWith("-01") && to && from.slice(0, 7) === to.slice(0, 7)) {
    const [y, m] = from.split("-");
    return `tháng ${m}/${y}`;
  }
  return `${from} → ${to}`;
}

export async function deliverPayslips(input: { periodKey: string; basis: string; actor: PayrollActor; now?: Date }): Promise<{ sent: number; undelivered: string[]; round: number; summary: string }> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db.select({ status: p.status, snapshot: p.snapshot, calcRuns: p.calcRuns }).from(p).where(and(eq(p.periodKey, input.periodKey), eq(p.basis, input.basis))).limit(1);
  if (!row || !row.snapshot) throw new Error("Kỳ chưa có ảnh chụp — không có gì để gửi");
  if (normalizePayrollStatus(row.status) !== "UNDER_REVIEW") throw new Error("Chỉ gửi phiếu khi kỳ đang ở bước soát");
  const snapshot = row.snapshot as PayrollSnapshot;
  const round = row.calcRuns;
  const now = input.now ?? new Date();
  const deadline = new Date(now.getTime() + PAYSLIP_CONFIRM_WINDOW_HOURS * 3600_000);

  const employees = await listEmployees();
  const emailOf = new Map(employees.map((e) => [e.id, (e.userEmail ?? "").trim().toLowerCase()]));
  const emails = [...new Set([...emailOf.values()].filter(Boolean))];
  const users = emails.length
    ? await db
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(and(eq(schema.users.active, true), inArray(sql`lower(${schema.users.email})`, emails)))
    : [];
  const userByEmail = new Map(users.map((u) => [u.email.trim().toLowerCase(), u.id]));

  const c = schema.payrollConfirmations;
  const values = snapshot.lines.map((l) => {
    const email = emailOf.get(l.employeeId) ?? "";
    return {
      periodKey: input.periodKey,
      basis: input.basis,
      round,
      employeeId: l.employeeId,
      employeeName: l.shortName || l.name,
      recipientUserId: email ? (userByEmail.get(email) ?? null) : null,
      amount: snapshotNetPay(l),
      status: "PENDING",
      sentAt: now,
      deadlineAt: deadline,
    };
  });
  if (values.length) await db.insert(c).values(values).onConflictDoNothing({ target: [c.periodKey, c.basis, c.round, c.employeeId] });

  // Đọc lại từ bảng: lượt gửi trước (cùng round) đã có dòng thì giữ nguyên dòng ấy, không đổi hạn.
  const rows = await db.select().from(c).where(and(eq(c.periodKey, input.periodKey), eq(c.basis, input.basis), eq(c.round, round)));
  const label = periodLabelOf(input.periodKey);
  const sent = await sendInboxMessages(
    rows
      .filter((r) => r.recipientUserId)
      .map((r) => ({
        userId: r.recipientUserId!,
        kind: "PAYSLIP_SENT",
        title: `Phiếu lương ${label} đã sẵn sàng`,
        body: `Mở để xem chi tiết và bấm Xác nhận hoặc Khiếu nại trước ${formatDateTime(r.deadlineAt)}.`,
        href: `/my-payslip?c=${r.id}`,
        dedupeKey: `payslip:${input.periodKey}:${input.basis}:${round}:${r.employeeId}`,
      })),
  );
  const undelivered = rows.filter((r) => !r.recipientUserId).map((r) => r.employeeName);
  const summary =
    `Đã gửi phiếu lương ${label} vào hộp thư ${rows.length - undelivered.length}/${rows.length} người` +
    (undelivered.length ? ` · chưa gửi được cho ${undelivered.join(", ")} (hồ sơ chưa khai email trùng một tài khoản ERP đang bật)` : "");
  await audit({
    userId: input.actor.id,
    userEmail: input.actor.email,
    action: "PAYROLL_PAYSLIPS_SENT",
    entity: "PAYROLL_PERIOD",
    entityId: `${input.periodKey}:${input.basis}`,
    detail: { round, people: rows.length, newMessages: sent, undelivered },
  });
  return { sent, undelivered, round, summary };
}

export type PayslipDecision = "CONFIRMED" | "DISPUTED";

/**
 * CỔNG SỞ HỮU PHIẾU: người đang đăng nhập có phải là người NHẬN phiếu này không.
 *
 * Đây là cổng của mọi đường chạm tới một phiếu đã gửi từ phía nhân viên (trang "Phiếu lương của tôi"
 * và lượt trả lời). Không phân biệt "không có" với "không phải của bạn" — nói khác nhau là để người
 * dò mã phiếu biết mã nào có thật.
 */
export async function payslipOwnerGate(user: { id: string }, confirmationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = await getDb();
  const c = schema.payrollConfirmations;
  const [row] = await db.select({ recipientUserId: c.recipientUserId }).from(c).where(eq(c.id, confirmationId)).limit(1);
  if (!row || !row.recipientUserId || row.recipientUserId !== user.id) return { ok: false, error: "Không tìm thấy phiếu lương này trong hộp thư của bạn." };
  return { ok: true };
}

/**
 * Ghi lời trả lời của NGƯỜI NHẬN PHIẾU. Cổng là quyền sở hữu dòng phiếu (`recipient_user_id`), không
 * phải một khoá quyền lương: người được gửi phiếu thì trả lời được phiếu của chính mình, và không gì
 * khác — không xem được dòng của ai, không xem được bảng lương.
 */
export async function recordPayslipResponse(input: { userId: string; userEmail: string; confirmationId: string; decision: PayslipDecision; note: string; now?: Date }): Promise<{ ok: true; changed: boolean } | { error: string }> {
  const db = await getDb();
  const c = schema.payrollConfirmations;
  const [row] = await db.select().from(c).where(eq(c.id, input.confirmationId)).limit(1);
  // Không phân biệt "không có" với "không phải của bạn": nói khác nhau là để người dò mã phiếu biết mã nào có thật.
  if (!row || row.recipientUserId !== input.userId) return { error: "Không tìm thấy phiếu lương này trong hộp thư của bạn." };

  const p = schema.payrollPeriods;
  const [period] = await db.select({ status: p.status, calcRuns: p.calcRuns }).from(p).where(and(eq(p.periodKey, row.periodKey), eq(p.basis, row.basis))).limit(1);
  const status = normalizePayrollStatus(period?.status);
  if (!period || (status !== "UNDER_REVIEW" && status !== "APPROVED")) {
    return { error: "Kỳ lương này không còn ở bước soát nên không nhận xác nhận nữa. Có sai sót thì nhắn người phụ trách lương để điều chỉnh ở kỳ sau." };
  }
  if (period.calcRuns !== row.round) {
    return { error: "Phiếu này đã được tính lại sau khi gửi. Mở phiếu mới nhất trong hộp thư để xác nhận đúng con số hiện hành." };
  }
  const note = input.note.trim();
  if (input.decision === "DISPUTED" && note.length < 3) return { error: "Khiếu nại cần ghi rõ sai ở đâu (ít nhất vài chữ)." };
  // Bấm hai lần cùng một câu trả lời: không ghi gì thêm (AGENTS.md mục 61).
  if (row.status === input.decision && row.note === note) return { ok: true, changed: false };

  const now = input.now ?? new Date();
  await db.update(c).set({ status: input.decision, note, respondedAt: now, respondedBy: input.userId, updatedAt: now }).where(eq(c.id, row.id));
  await audit({
    userId: input.userId,
    userEmail: input.userEmail,
    action: input.decision === "CONFIRMED" ? "PAYROLL_PAYSLIP_CONFIRM" : "PAYROLL_PAYSLIP_DISPUTE",
    entity: "PAYROLL_CONFIRMATION",
    entityId: row.id,
    before: { status: row.status, note: row.note },
    after: { status: input.decision, note },
    detail: { periodKey: row.periodKey, basis: row.basis, round: row.round, employeeId: row.employeeId },
  });
  if (input.decision === "DISPUTED") {
    const label = periodLabelOf(row.periodKey);
    const approvers = await payrollApproverUserIds();
    await sendInboxMessages(
      approvers.map((uid) => ({
        userId: uid,
        kind: "PAYROLL_DISPUTE",
        // Không in số tiền, không in nguyên văn lý do ở tiêu đề — mở trang để đọc.
        title: `${row.employeeName} khiếu nại phiếu lương ${label}`,
        body: "Mở trang Trả lương tự động để đọc lý do và quyết định: trả lại để tính lại, hay trả đúng hạn rồi điều chỉnh kỳ sau.",
        href: "/payroll/autopilot",
        dedupeKey: `payroll-dispute:${row.id}:${now.toISOString()}`,
      })),
    );
  }
  return { ok: true, changed: true };
}

/** Phiếu lương đã gửi cho CHÍNH người đang đăng nhập — mới nhất trước. */
export async function listMyPayslips(userId: string, limit = 12) {
  const db = await getDb();
  const c = schema.payrollConfirmations;
  return db.select().from(c).where(eq(c.recipientUserId, userId)).orderBy(desc(c.sentAt)).limit(limit);
}

/** Dòng ảnh chụp của MỘT phiếu đã gửi — đọc từ `payroll_periods.snapshot`, không tính lại. */
export async function payslipSnapshotLine(periodKey: string, basis: string, employeeId: string) {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [row] = await db.select({ snapshot: p.snapshot, status: p.status, calcRuns: p.calcRuns, lockedAt: p.lockedAt, paidAt: p.paidAt }).from(p).where(and(eq(p.periodKey, periodKey), eq(p.basis, basis))).limit(1);
  const snap = (row?.snapshot ?? null) as PayrollSnapshot | null;
  return {
    line: snap?.lines.find((l) => l.employeeId === employeeId) ?? null,
    status: normalizePayrollStatus(row?.status),
    calcRuns: row?.calcRuns ?? 0,
    lockedAt: row?.lockedAt ?? null,
    paidAt: row?.paidAt ?? null,
    periodLabel: periodLabelOf(periodKey),
  };
}

/** Câu tóm tắt để nhắn chủ shop — không có số tiền của từng người. */
export function readyMessageBody(total: number | null, people: number, disputed: number): string {
  return `${people} người · tổng ${total === null ? "chưa biết" : formatVND(total)}${disputed ? ` · ${disputed} khiếu nại cần đọc` : ""}. Bấm để duyệt và lập lệnh chuyển.`;
}
