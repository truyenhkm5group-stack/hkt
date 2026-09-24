/**
 * ═══════════ LƯƠNG TỰ ĐỘNG — BỘ CHẠY MỖI GIỜ ═══════════
 *
 * Đặc tả: `docs/payroll-autopilot.md`. Kế hoạch "hôm nay làm gì" là hàm THUẦN
 * (`lib/constants/payroll-autopilot.ts::planAutopilot`); tệp này chỉ đi làm đúng những việc ấy, qua
 * ĐÚNG những cửa mà người bấm cũng đi (`lib/payroll/run-service.ts`).
 *
 * Chạy lại bao nhiêu lần cũng an toàn:
 *   · tính kỳ chỉ chạy khi kỳ còn NHÁP;
 *   · gửi phiếu, nhắc duyệt, nhắc ngày trả chống trùng bằng khoá `dedupe_key` ở CSDL;
 *   · lập lệnh chuyển và khớp sao kê là lũy đẳng theo khoá tự nhiên;
 *   · quyết toán kỳ trước XOÁ dòng máy đã tạo lần trước (cùng `reference`) rồi ghi lại — chỉ dòng
 *     của máy (`created_by IS NULL`), không bao giờ chạm dòng người nhập.
 *
 * Khớp tiền ra + khép kỳ đã trả chạy CẢ KHI CÔNG TẮC TẮT: chúng chỉ đọc chứng từ ngân hàng cho những
 * lệnh chuyển người đã lập, và không làm gì khi chưa có lệnh nào.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { sendLark } from "@/lib/alerts/lark";
import { loadAlertConfig } from "@/lib/alerts/config";
import {
  DEFAULT_PAYROLL_AUTOPILOT,
  PAYROLL_AUTOPILOT_ACTOR,
  PAYROLL_AUTOPILOT_BASIS,
  PAYROLL_AUTOPILOT_KEY,
  monthPeriod,
  payDayOf,
  planAutopilot,
  shiftMonth,
  summarizeConfirmations,
  targetMonth,
  type AutopilotStep,
  type PayrollAutopilotConfig,
} from "@/lib/constants/payroll-autopilot";
import { isFrozen, normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { formatDateTime, formatVND, vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { payrollApproverUserIds, sendInboxMessages } from "@/lib/inbox/send";
import { getPayrollReport } from "@/lib/queries/payroll";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { calculatePayrollPeriodAs, transitionPayrollRunAs, type PayrollActor } from "@/lib/payroll/run-service";
import { periodLabelOf, readyMessageBody } from "@/lib/payroll/payslip-delivery";
import { completePaidPeriods, ensurePayoutLines, matchPayoutLines, payoutSummary } from "@/lib/payroll/payout";
import { settlementFor, settlementReference, type SettlementResult } from "@/lib/payroll/settlement";
import type { Period } from "@/lib/search-params";

export const MACHINE: PayrollActor = { id: null, email: PAYROLL_AUTOPILOT_ACTOR };

export async function getAutopilotConfig(): Promise<PayrollAutopilotConfig> {
  const cfg = await getSettingJson<PayrollAutopilotConfig>(PAYROLL_AUTOPILOT_KEY, DEFAULT_PAYROLL_AUTOPILOT);
  return { enabled: cfg?.enabled === true };
}

/** Kết quả quyết toán đã chạy cho một kỳ — lưu để màn hình in ra mà không phải tính lại. */
export type SettlementRecord = { computedAt: string; previousPeriodKey: string; currentPeriodKey: string; results: SettlementResult[]; written: number };
export const settlementRecordKey = (currentPeriodKey: string) => `payroll.settlement:${currentPeriodKey}`;

function monthRange(monthKey: string): Period {
  const mp = monthPeriod(monthKey);
  return { key: "custom", from: vnStartOfDay(mp.fromKey), to: vnEndOfDay(mp.toKey), fromKey: mp.fromKey, toKey: mp.toKey, label: mp.label };
}

/**
 * QUYẾT TOÁN KỲ TRƯỚC vào kỳ hiện tại (xem `lib/payroll/settlement.ts`).
 *
 * Chỉ khi kỳ trước ĐÃ KHOÁ (có số đã trả để so) và kỳ hiện tại CHƯA KHOÁ (còn nhận điều chỉnh).
 */
export async function applySettlement(currentMonth: string, actor: PayrollActor = MACHINE): Promise<SettlementRecord | { skipped: string }> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const prev = monthPeriod(shiftMonth(currentMonth, -1));
  const cur = monthPeriod(currentMonth);
  const [prevRow] = await db.select({ status: p.status, snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, prev.periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS))).limit(1);
  if (!prevRow?.snapshot || !isFrozen(normalizePayrollStatus(prevRow.status))) return { skipped: `Kỳ ${prev.label} chưa khoá nên chưa có số đã trả để quyết toán.` };
  const [curRow] = await db.select({ status: p.status }).from(p).where(and(eq(p.periodKey, cur.periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS))).limit(1);
  if (curRow && isFrozen(normalizePayrollStatus(curRow.status))) return { skipped: `Kỳ ${cur.label} đã khoá — không nhận thêm điều chỉnh.` };

  const snapshot = prevRow.snapshot as PayrollSnapshot;
  const live = await getPayrollReport(monthRange(prev.monthKey), PAYROLL_AUTOPILOT_BASIS);
  const liveById = new Map(
    live.lines.map((l) => [
      l.employee.id,
      {
        employeeId: l.employee.id,
        totalProfit: l.totalProfit,
        personalProfit: l.personalProfit,
        personalRevenue: l.personalRevenue,
        engine: l.engine ? { components: l.engine.result.components } : null,
      },
    ]),
  );
  const results = snapshot.lines.map((s) => settlementFor(s, liveById.get(s.employeeId) ?? null));
  const reference = settlementReference(prev.periodKey);
  const now = new Date();
  const a = schema.payrollAdjustments;
  const rows = results
    .filter((r): r is Extract<SettlementResult, { status: "OK" }> => r.status === "OK" && r.delta !== 0)
    .map((r) => ({
      employeeId: r.employeeId,
      periodKey: cur.periodKey,
      kind: r.delta > 0 ? "ADJUSTMENT" : "DEDUCTION",
      label: `Quyết toán ${prev.label} — ${r.delta > 0 ? "truy lĩnh" : "truy thu"}`,
      amount: Math.abs(r.delta),
      reason:
        `Tính lại ${prev.label} ngày ${formatDateTime(now)} bằng tỷ lệ đã chốt (đơn có kết cục sau ngày chốt, chứng từ về muộn): ` +
        r.explain.map((x) => `${x.label} ${x.before === null ? "—" : formatVND(x.before)} → ${x.after === null ? "—" : formatVND(x.after)}`).join("; "),
      reference,
      createdBy: null,
      createdByName: "Máy — quyết toán tự động",
    }));
  await db.transaction(async (tx) => {
    // CHỈ dòng máy đã tạo cho CHÍNH lượt quyết toán này. Dòng người nhập không bao giờ bị chạm.
    await tx.delete(a).where(and(eq(a.periodKey, cur.periodKey), eq(a.reference, reference), isNull(a.createdBy)));
    if (rows.length) await tx.insert(a).values(rows);
  });
  const record: SettlementRecord = { computedAt: now.toISOString(), previousPeriodKey: prev.periodKey, currentPeriodKey: cur.periodKey, results, written: rows.length };
  await setSettingJson(settlementRecordKey(cur.periodKey), record);
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: "PAYROLL_SETTLEMENT",
    entity: "PAYROLL_PERIOD",
    entityId: `${cur.periodKey}:${PAYROLL_AUTOPILOT_BASIS}`,
    detail: { previous: prev.periodKey, written: rows.length, manual: results.filter((r) => r.status !== "OK").map((r) => r.name) },
  });
  return record;
}

/** Gửi tin cho người duyệt: hộp thư ERP (luôn) + nhóm Lark (khi có cấu hình, KHÔNG kèm số tiền). */
async function tellApprovers(msg: { kind: string; title: string; body: string; dedupeKey: string; larkLine?: string }): Promise<boolean> {
  const approvers = await payrollApproverUserIds();
  const moi = await sendInboxMessages(approvers.map((uid) => ({ userId: uid, kind: msg.kind, title: msg.title, body: msg.body, href: "/payroll/autopilot", dedupeKey: `${msg.dedupeKey}:${uid}` })));
  // Lark chỉ gửi ở lượt ĐẦU TIÊN (khi hộp thư vừa nhận tin mới) — cùng một khoá chống trùng cho hai kênh.
  if (moi > 0 && msg.larkLine) {
    const cfg = await loadAlertConfig();
    if (cfg.larkWebhookUrl) {
      const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
      await sendLark(cfg.larkWebhookUrl, cfg.larkSecret, msg.title, [[{ text: msg.larkLine }], ...(appUrl ? [[{ text: "Mở trang Trả lương tự động", href: `${appUrl}/payroll/autopilot` }]] : [])]).catch(() => undefined);
    }
  }
  return moi > 0;
}

export type AutopilotRunResult = { monthKey: string; plan: AutopilotStep[]; did: string[]; notes: string[] };

export async function runPayrollAutopilot(now: Date = new Date()): Promise<AutopilotRunResult> {
  const did: string[] = [];
  const notes: string[] = [];

  // ── 0. Chứng từ ngân hàng: khớp tiền ra, khép kỳ đã trả (chạy cả khi công tắc tắt) ──
  const khop = await matchPayoutLines();
  if (khop.matched) did.push(`Khớp ${khop.matched} lần chuyển lương với sao kê`);
  notes.push(...khop.notes);
  const daTra = await completePaidPeriods();
  for (const k of daTra) did.push(`Kỳ ${periodLabelOf(k)} đã trả đủ — chuyển sang ĐÃ TRẢ theo sao kê`);

  const cfg = await getAutopilotConfig();
  const monthKey = targetMonth(now);
  const mp = monthPeriod(monthKey);
  const db = await getDb();
  const p = schema.payrollPeriods;
  const read = async () =>
    (await db.select({ status: p.status, calcRuns: p.calcRuns, snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, mp.periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS))).limit(1))[0];
  let row = await read();
  const status = row ? (row.snapshot === null ? "DRAFT" : normalizePayrollStatus(row.status)) : "NONE";
  const [prevRow] = await db.select({ status: p.status }).from(p).where(and(eq(p.periodKey, monthPeriod(shiftMonth(monthKey, -1)).periodKey), eq(p.basis, PAYROLL_AUTOPILOT_BASIS))).limit(1);
  const c = schema.payrollConfirmations;
  const confRows = row ? await db.select({ status: c.status, deadlineAt: c.deadlineAt, recipientUserId: c.recipientUserId }).from(c).where(and(eq(c.periodKey, mp.periodKey), eq(c.basis, PAYROLL_AUTOPILOT_BASIS), eq(c.round, row.calcRuns))) : [];
  const confirmations = confRows.length ? summarizeConfirmations(confRows, now) : null;
  const payout = await payoutSummary(mp.periodKey, PAYROLL_AUTOPILOT_BASIS);

  const plan = planAutopilot({
    now,
    enabled: cfg.enabled,
    monthKey,
    status,
    blockers: null,
    confirmations,
    payout,
    previousFrozen: Boolean(prevRow && isFrozen(normalizePayrollStatus(prevRow.status))),
  });
  // Ngày THEO LỊCH VIỆT NAM — ngày UTC lệch 7 giờ làm tin "mỗi ngày một lần" gửi hai lần trong buổi sáng.
  const today = vnDateKey(now);

  for (const step of plan) {
    if (step.kind === "SETTLE_PREVIOUS") {
      const r = await applySettlement(monthKey);
      if ("skipped" in r) notes.push(r.skipped);
      else did.push(`Quyết toán ${periodLabelOf(r.previousPeriodKey)}: ${r.written} dòng điều chỉnh vào ${mp.label}`);
    }
    if (step.kind === "CALCULATE_AND_SEND") {
      const calc = await calculatePayrollPeriodAs(MACHINE, { from: mp.fromKey, to: mp.toKey, basis: PAYROLL_AUTOPILOT_BASIS, note: "Máy tính tự động ngày chốt" });
      if ("error" in calc) {
        // Không tính được ⇒ báo MỘT lần mỗi ngày, kèm nguyên văn việc còn thiếu.
        const moi = await tellApprovers({
          kind: "PAYROLL_BLOCKED",
          title: `Lương ${mp.label} chưa tính được`,
          body: calc.error.slice(0, 900),
          dedupeKey: `payroll-blocked:${mp.periodKey}:${today}`,
          larkLine: `Lương ${mp.label} chưa tính được — còn việc phải làm trước (mở ERP để xem danh sách). Máy thử lại mỗi giờ.`,
        });
        // Ghi ĐỦ lý do vào nhật ký lượt chạy — chỉ dòng đầu ("chưa đủ căn cứ:") thì không ai biết thiếu gì.
        notes.push(`Chưa tính được: ${calc.error.replace(/\s*\n\s*/g, " ")}`);
        if (moi) did.push("Báo chủ shop: kỳ chưa tính được");
        continue;
      }
      did.push(`Tính & chụp ảnh ${mp.label}`);
      const submit = await transitionPayrollRunAs(MACHINE, { periodKey: mp.periodKey, basis: PAYROLL_AUTOPILOT_BASIS, action: "SUBMIT_REVIEW", reason: "" });
      if ("error" in submit) {
        notes.push(`Chưa chuyển soát được: ${submit.error}`);
        continue;
      }
      did.push(...submit.sideEffects);
      row = await read();
      await tellApprovers({
        kind: "PAYROLL_SENT",
        title: `Đã gửi phiếu lương ${mp.label} cho nhân viên`,
        body: `${submit.sideEffects.join(" · ")}. Khi mọi người trả lời (hoặc hết hạn 48 giờ) ERP sẽ báo để anh duyệt.`,
        dedupeKey: `payroll-sent:${mp.periodKey}:${row?.calcRuns ?? 0}`,
        larkLine: `Lương ${mp.label}: đã tính và gửi phiếu vào hộp thư ERP của từng người. Hạn xác nhận 48 giờ.`,
      });
    }
    if (step.kind === "NOTIFY_READY" && row?.snapshot) {
      const snap = row.snapshot as PayrollSnapshot;
      const moi = await tellApprovers({
        kind: "PAYROLL_READY",
        title: `Lương ${mp.label} sẵn sàng duyệt`,
        body: readyMessageBody(snap.totalSalary, snap.lines.length, confirmations?.DISPUTED ?? 0),
        dedupeKey: `payroll-ready:${mp.periodKey}:${row.calcRuns}`,
        larkLine: `Lương ${mp.label} sẵn sàng duyệt: ${confirmations?.CONFIRMED ?? 0} xác nhận · ${confirmations?.DISPUTED ?? 0} khiếu nại · ${confirmations?.NO_RESPONSE ?? 0} không phản hồi. Hạn trả ${payDayOf(monthKey).split("-").reverse().join("/")}.`,
      });
      if (moi) did.push("Báo chủ shop: sẵn sàng duyệt");
    }
    if (step.kind === "REMIND_APPROVAL") {
      const moi = await tellApprovers({
        kind: "PAYROLL_REMIND",
        title: `Lương ${mp.label} chưa duyệt — hạn trả ${payDayOf(monthKey).split("-").reverse().join("/")}`,
        body: "Mở trang Trả lương tự động để duyệt và lập lệnh chuyển.",
        dedupeKey: `payroll-remind:${mp.periodKey}:${today}`,
        larkLine: `Nhắc: lương ${mp.label} chưa duyệt, hạn trả ${payDayOf(monthKey).split("-").reverse().join("/")}.`,
      });
      if (moi) did.push("Nhắc chủ shop duyệt");
    }
    if (step.kind === "ENSURE_PAYOUT") {
      try {
        const r = await ensurePayoutLines({ periodKey: mp.periodKey, basis: PAYROLL_AUTOPILOT_BASIS, actor: MACHINE });
        if (r.created || r.refreshed) did.push(r.summary);
      } catch (e) {
        notes.push(`Chưa lập được lệnh chuyển: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (step.kind === "REMIND_PAYDAY") {
      const moi = await tellApprovers({
        kind: "PAYROLL_PAYDAY",
        title: `Hôm nay trả lương ${mp.label}`,
        body: `Còn ${payout.pending} người chưa thấy tiền ra trong sổ ngân hàng. Mở trang để quét mã QR chuyển từng người.`,
        dedupeKey: `payroll-payday:${mp.periodKey}:${today}`,
        larkLine: `Hôm nay trả lương ${mp.label}: còn ${payout.pending} người chưa chuyển. Mở ERP để quét mã QR.`,
      });
      if (moi) did.push("Nhắc chủ shop: ngày trả lương");
    }
  }
  return { monthKey, plan, did, notes };
}

/** Bật / tắt — ghi nhật ký, vì bật là trao cho máy quyền tính và gửi phiếu thay người. */
export async function setAutopilotEnabled(enabled: boolean, actor: { id: string; email: string }): Promise<void> {
  const before = await getAutopilotConfig();
  await setSettingJson(PAYROLL_AUTOPILOT_KEY, { enabled });
  await audit({ userId: actor.id, userEmail: actor.email, action: "PAYROLL_AUTOPILOT_TOGGLE", entity: "SETTINGS", entityId: PAYROLL_AUTOPILOT_KEY, before, after: { enabled } });
}
