/**
 * ═══════════ LỆNH CHUYỂN LƯƠNG — LẬP TỪ ẢNH CHỤP, "ĐÃ TRẢ" CHỈ BẰNG SAO KÊ ═══════════
 *
 * Đặc tả: `docs/payroll-autopilot.md` §4.
 *
 * ─── BA LUẬT ───
 *
 *  1. **Lập từ ẢNH CHỤP của kỳ đã KHOÁ, không từ bản tính sống.** Số chuyển là số đã duyệt; dữ liệu
 *     về sau không được làm đổi nó (AGENTS.md mục 21).
 *  2. **Tài khoản nhận CHỤP LẠI lúc lập.** Dòng còn chờ chuyển thì cập nhật theo hồ sơ (người sửa
 *     STK trước khi được trả là chuyện thường), dòng đã trả thì đứng yên. Tài khoản khác lần trả gần
 *     nhất của cùng người ⇒ cờ `account_changed`, in đỏ ở màn hình — đổi STK là cách gian lận lương
 *     phổ biến nhất.
 *  3. **"Đã trả" chỉ có khi một dòng SAO KÊ chứng minh.** Máy khớp tiền ra bằng CẢ HAI: nội dung
 *     chứa mã riêng của dòng VÀ số tiền bằng đúng số của dòng (`matchesTransferNote`). Người khớp
 *     tay được, nhưng vẫn phải chọn một dòng sao kê có thật — không có nút "đánh dấu đã chuyển" suông.
 *     Đủ mọi dòng ⇒ kỳ tự sang `PAID` (`completePaidPeriods`), không đi qua `MARK_PAID` vốn là một
 *     lời khẳng định không ai kiểm.
 *
 * Mối nối tiền ↔ kỳ lương đi qua ĐƯỜNG GHI DUY NHẤT `lib/finance/linkage.ts::createLink` — cùng sổ đối
 * chiếu mà trang Ngân hàng dùng. Nối KHÔNG phải ghi nhận: không tạo chi phí nào (AGENTS.md mục 17).
 */
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { LINK_AUTO_ACTOR, PAYROLL_PERIOD_RE } from "@/lib/constants/finance-truth";
import { normalizePayrollStatus } from "@/lib/constants/payroll-lifecycle";
import { bankNameOf } from "@/lib/constants/vn-banks";
import { createLink } from "@/lib/finance/linkage";
import { sendInboxMessages } from "@/lib/inbox/send";
import { formatVND } from "@/lib/format";
import { listEmployees } from "@/lib/queries/payroll";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { matchesTransferNote, transferNoteFor } from "@/lib/payroll/vietqr";
import { periodLabelOf, snapshotNetPay } from "@/lib/payroll/payslip-delivery";
import type { PayrollActor } from "@/lib/payroll/run-service";

const L = schema.payrollPayoutLines;

/** Khoá `YYYY-MM` của kỳ trọn tháng — `null` nếu kỳ không phải trọn một tháng (khi ấy không nối sổ). */
export function payrollMonthOf(periodKey: string): string | null {
  const [from, to] = periodKey.split("..");
  if (!from || !to || !from.endsWith("-01") || from.slice(0, 7) !== to.slice(0, 7)) return null;
  const month = from.slice(0, 7);
  return PAYROLL_PERIOD_RE.test(month) ? month : null;
}

/**
 * LẬP / CẬP NHẬT LỆNH CHUYỂN của một kỳ đã khoá. Chạy lại bao nhiêu lần cũng ra cùng một bộ dòng —
 * khoá tự nhiên (kỳ, cơ sở, nhân sự) và nội dung chuyển khoản sinh ỔN ĐỊNH.
 */
export async function ensurePayoutLines(input: { periodKey: string; basis: string; actor: PayrollActor }): Promise<{ created: number; refreshed: number; skipped: string[]; summary: string }> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  const [period] = await db.select({ status: p.status, snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, input.periodKey), eq(p.basis, input.basis))).limit(1);
  const status = normalizePayrollStatus(period?.status);
  if (!period?.snapshot || (status !== "LOCKED" && status !== "PAID")) throw new Error("Chỉ lập lệnh chuyển cho kỳ ĐÃ KHOÁ — số chuyển phải là số đã duyệt");
  const snapshot = period.snapshot as PayrollSnapshot;
  const employees = new Map((await listEmployees()).map((e) => [e.id, e]));

  const existing = await db.select().from(L).where(and(eq(L.periodKey, input.periodKey), eq(L.basis, input.basis)));
  const byEmployee = new Map(existing.map((r) => [r.employeeId, r]));
  // Nội dung đã dùng trong CÙNG tháng (mọi cơ sở) — để hai người không bao giờ chung một nội dung.
  const samePrefix = await db.select({ note: L.transferNote }).from(L).where(sql`${L.periodKey} like ${`${input.periodKey.slice(0, 7)}%`}`);
  const taken = new Set(samePrefix.map((r) => r.note));

  // Tài khoản của lần trả GẦN NHẤT mỗi người, ở kỳ khác — để phát hiện đổi STK.
  const lastPaid = await db
    .select({ employeeId: L.employeeId, bankBin: L.bankBin, accountNumber: L.accountNumber, paidAt: L.paidAt })
    .from(L)
    .where(and(eq(L.status, "PAID"), ne(L.periodKey, input.periodKey)))
    .orderBy(desc(L.paidAt));
  const lastAccount = new Map<string, string>();
  for (const r of lastPaid) if (!lastAccount.has(r.employeeId)) lastAccount.set(r.employeeId, `${r.bankBin}:${r.accountNumber}`);

  let created = 0;
  let refreshed = 0;
  const skipped: string[] = [];
  const now = new Date();
  for (const line of snapshot.lines) {
    const net = snapshotNetPay(line);
    const name = line.shortName || line.name;
    if (net === null) {
      skipped.push(`${name}: thực nhận CHƯA BIẾT`);
      continue;
    }
    if (net <= 0) {
      skipped.push(`${name}: thực nhận ${formatVND(net)} — không có gì để chuyển`);
      continue;
    }
    const e = employees.get(line.employeeId);
    const bank = {
      bankBin: e?.bankBin ?? "",
      bankName: bankNameOf(e?.bankBin),
      accountNumber: e?.bankAccount ?? "",
      accountName: e?.bankAccountName ?? "",
    };
    const prev = lastAccount.get(line.employeeId);
    const accountChanged = Boolean(prev && bank.accountNumber && prev !== `${bank.bankBin}:${bank.accountNumber}`);
    const cur = byEmployee.get(line.employeeId);
    if (cur) {
      // Dòng đã trả / đã huỷ đứng yên: nó là chứng từ của một lần chuyển có thật.
      if (cur.status !== "PENDING") continue;
      if (cur.bankBin !== bank.bankBin || cur.accountNumber !== bank.accountNumber || cur.accountName !== bank.accountName || cur.amount !== net || cur.accountChanged !== accountChanged) {
        await db.update(L).set({ ...bank, amount: net, accountChanged, updatedAt: now }).where(eq(L.id, cur.id));
        refreshed += 1;
      }
      continue;
    }
    const note = transferNoteFor(input.periodKey, line.employeeId, taken);
    taken.add(note);
    await db
      .insert(L)
      .values({ periodKey: input.periodKey, basis: input.basis, employeeId: line.employeeId, employeeName: name, amount: net, ...bank, transferNote: note, accountChanged, createdBy: input.actor.id })
      .onConflictDoNothing({ target: [L.periodKey, L.basis, L.employeeId] });
    created += 1;
  }
  if (created || refreshed) {
    await audit({
      userId: input.actor.id,
      userEmail: input.actor.email,
      action: "PAYROLL_PAYOUT_LINES",
      entity: "PAYROLL_PERIOD",
      entityId: `${input.periodKey}:${input.basis}`,
      detail: { created, refreshed, skipped },
    });
  }
  const summary = `Lệnh chuyển ${periodLabelOf(input.periodKey)}: ${created} dòng mới${refreshed ? `, cập nhật ${refreshed}` : ""}${skipped.length ? ` · không chuyển: ${skipped.join("; ")}` : ""}`;
  return { created, refreshed, skipped, summary };
}

/** Đánh dấu một dòng ĐÃ TRẢ bằng một dòng sao kê — dùng chung cho máy khớp và người khớp tay. */
async function settleLine(line: typeof L.$inferSelect, txn: { id: string; txnAt: Date }, by: { id: string | null; email: string; confidence: "EXACT" | "MANUAL"; method: "IDENTIFIER_MATCH" | "MANUAL" }): Promise<{ ok: true; linkNote: string } | { error: string }> {
  const db = await getDb();
  const month = payrollMonthOf(line.periodKey);
  let linkNote = "";
  if (month) {
    const r = await createLink({ txnId: txn.id, targetType: "PAYROLL_PERIOD", targetId: month, amount: line.amount, confidence: by.confidence, method: by.method, confirmedBy: by.email, note: `${line.transferNote} · ${line.employeeName}` });
    // Dòng tiền đã nối sẵn tới chứng từ khác vẫn CHỨNG MINH tiền đã đi — dòng lương vẫn là đã trả,
    // nhưng phần đối chiếu sổ phải nói ra để người xem lại (có thể đã bị nối nhầm vào một khoản chi).
    if ("error" in r) linkNote = `Chưa nối được vào sổ đối chiếu: ${r.error}`;
  }
  const updated = await db
    .update(L)
    .set({ status: "PAID", bankTxnId: txn.id, paidAt: txn.txnAt, matchedBy: by.email, updatedAt: new Date() })
    .where(and(eq(L.id, line.id), eq(L.status, "PENDING")))
    .returning({ id: L.id });
  if (!updated.length) return { error: "Dòng lệnh này vừa được đánh dấu bởi một lượt khác." };
  await audit({
    userId: by.id,
    userEmail: by.email,
    action: "PAYROLL_PAYOUT_PAID",
    entity: "PAYROLL_PAYOUT_LINE",
    entityId: line.id,
    detail: { periodKey: line.periodKey, employeeId: line.employeeId, amount: line.amount, bankTxnId: txn.id, method: by.method, linkNote },
  });
  return { ok: true, linkNote };
}

/** Báo người nhận "đã chuyển" — người nhận là tài khoản đã nhận phiếu của kỳ ấy. */
async function notifyPaid(lines: (typeof L.$inferSelect)[]): Promise<void> {
  if (!lines.length) return;
  const db = await getDb();
  const c = schema.payrollConfirmations;
  const recipients = await db
    .select({ employeeId: c.employeeId, periodKey: c.periodKey, userId: c.recipientUserId })
    .from(c)
    .where(and(inArray(c.periodKey, [...new Set(lines.map((l) => l.periodKey))]), sql`${c.recipientUserId} is not null`));
  const userOf = new Map(recipients.map((r) => [`${r.periodKey}|${r.employeeId}`, r.userId!]));
  await sendInboxMessages(
    lines
      .filter((l) => userOf.has(`${l.periodKey}|${l.employeeId}`))
      .map((l) => ({
        userId: userOf.get(`${l.periodKey}|${l.employeeId}`)!,
        kind: "PAYSLIP_PAID",
        title: `Lương ${periodLabelOf(l.periodKey)} đã chuyển`,
        body: `Nội dung chuyển khoản: ${l.transferNote}. Kiểm tra tài khoản ${l.bankName || "ngân hàng"} của bạn.`,
        href: "/my-payslip",
        dedupeKey: `payslip-paid:${l.id}`,
      })),
  );
}

/**
 * MÁY KHỚP TIỀN RA VỚI LỆNH CHUYỂN. Chỉ xét dòng sao kê ÂM, ghi nhận SAU khi lệnh được lập (lùi một
 * ngày cho lệch giờ), chưa trả cho dòng lương nào khác, và khớp CẢ nội dung LẪN số tiền.
 */
export async function matchPayoutLines(): Promise<{ matched: number; notes: string[] }> {
  const db = await getDb();
  const pending = await db.select().from(L).where(eq(L.status, "PENDING"));
  if (!pending.length) return { matched: 0, notes: [] };
  const since = new Date(Math.min(...pending.map((l) => l.createdAt.getTime())) - 24 * 3600_000);
  const b = schema.bankTransactions;
  const used = new Set((await db.select({ id: L.bankTxnId }).from(L).where(sql`${L.bankTxnId} is not null`)).map((r) => r.id));
  const txns = (
    await db
      .select({ id: b.id, amount: b.amount, description: b.description, txnAt: b.txnAt })
      .from(b)
      .where(and(lt(b.amount, 0), gte(b.txnAt, since), inArray(b.amount, [...new Set(pending.map((l) => -l.amount))])))
  ).filter((t) => !used.has(t.id));

  let matched = 0;
  const notes: string[] = [];
  const paidLines: (typeof L.$inferSelect)[] = [];
  for (const line of pending) {
    const earliest = line.createdAt.getTime() - 24 * 3600_000;
    const hits = txns.filter((t) => !used.has(t.id) && t.txnAt.getTime() >= earliest && matchesTransferNote(t, line));
    if (!hits.length) continue;
    // Hai dòng sao kê cùng khớp một lệnh = chuyển trùng hai lần. Không tự chọn — nêu ra để người xem.
    if (hits.length > 1) {
      notes.push(`${line.employeeName}: ${hits.length} lần chuyển cùng khớp lệnh ${line.transferNote} — có thể đã chuyển trùng, cần người kiểm.`);
      continue;
    }
    const r = await settleLine(line, hits[0], { id: null, email: LINK_AUTO_ACTOR, confidence: "EXACT", method: "IDENTIFIER_MATCH" });
    if ("error" in r) {
      notes.push(`${line.employeeName}: ${r.error}`);
      continue;
    }
    used.add(hits[0].id);
    matched += 1;
    paidLines.push(line);
    if (r.linkNote) notes.push(`${line.employeeName}: ${r.linkNote}`);
  }
  await notifyPaid(paidLines);
  return { matched, notes };
}

/**
 * NGƯỜI KHỚP TAY một dòng lệnh với một dòng sao kê (nội dung gõ khác mã nên máy không nhận ra).
 * Vẫn đòi đúng số tiền và đúng chiều tiền ra — khớp tay là chọn CHỨNG TỪ, không phải bỏ qua nó.
 */
export async function matchPayoutLineManually(input: { lineId: string; txnId: string; actor: { id: string; email: string } }): Promise<{ ok: true } | { error: string }> {
  const db = await getDb();
  const [line] = await db.select().from(L).where(eq(L.id, input.lineId)).limit(1);
  if (!line) return { error: "Không tìm thấy dòng lệnh chuyển" };
  if (line.status !== "PENDING") return { error: "Dòng này không còn chờ chuyển" };
  const b = schema.bankTransactions;
  const [txn] = await db.select({ id: b.id, amount: b.amount, txnAt: b.txnAt }).from(b).where(eq(b.id, input.txnId)).limit(1);
  if (!txn) return { error: "Không tìm thấy dòng sao kê" };
  if (txn.amount !== -line.amount) return { error: `Dòng sao kê là ${formatVND(txn.amount)}, còn lệnh là chuyển ${formatVND(line.amount)} — số tiền phải khớp đúng.` };
  const [dung] = await db.select({ id: L.id }).from(L).where(eq(L.bankTxnId, txn.id)).limit(1);
  if (dung) return { error: "Dòng sao kê này đã được dùng để trả cho một dòng lương khác." };
  const r = await settleLine(line, txn, { id: input.actor.id, email: input.actor.email, confidence: "MANUAL", method: "MANUAL" });
  if ("error" in r) return r;
  await notifyPaid([line]);
  return { ok: true };
}

/** Dòng sao kê tiền ra ĐÚNG số tiền của một lệnh, chưa dùng — để người chọn khi khớp tay. */
export async function payoutTxnCandidates(lineId: string) {
  const db = await getDb();
  const [line] = await db.select().from(L).where(eq(L.id, lineId)).limit(1);
  if (!line) return [];
  const b = schema.bankTransactions;
  const rows = await db
    .select({ id: b.id, txnAt: b.txnAt, amount: b.amount, description: b.description, counterparty: b.counterparty })
    .from(b)
    .where(and(eq(b.amount, -line.amount), gte(b.txnAt, new Date(line.createdAt.getTime() - 3 * 24 * 3600_000))))
    .orderBy(desc(b.txnAt))
    .limit(20);
  const used = new Set((await db.select({ id: L.bankTxnId }).from(L).where(inArray(L.bankTxnId, rows.map((r) => r.id).length ? rows.map((r) => r.id) : ["-"]))).map((r) => r.id));
  return rows.filter((r) => !used.has(r.id));
}

/**
 * KỲ TỰ SANG "ĐÃ TRẢ" KHI MỌI DÒNG LỆNH ĐỀU CÓ SAO KÊ.
 *
 * Đi qua CÙNG khoá tên với mọi lượt chuyển trạng thái kỳ (`erp:payroll-run:<kỳ>:<cơ sở>`) và đọc lại
 * trạng thái trong khoá. `paid_by = NULL` là MÁY (mục 34) — chứng từ của nó là các dòng sao kê,
 * truy được từ `payroll_payout_lines.bank_txn_id`.
 */
export async function completePaidPeriods(): Promise<string[]> {
  const db = await getDb();
  const p = schema.payrollPeriods;
  // `FINAL` cũ đọc như `LOCKED` (`normalizePayrollStatus`) — kỳ khoá từ trước bản vòng đời vẫn được khép.
  const locked = await db.select({ periodKey: p.periodKey, basis: p.basis }).from(p).where(inArray(p.status, ["LOCKED", "FINAL"]));
  const done: string[] = [];
  for (const k of locked) {
    const lines = await db.select({ status: L.status, paidAt: L.paidAt }).from(L).where(and(eq(L.periodKey, k.periodKey), eq(L.basis, k.basis), ne(L.status, "CANCELLED")));
    if (!lines.length || lines.some((l) => l.status !== "PAID")) continue;
    const paidAt = new Date(Math.max(...lines.map((l) => l.paidAt!.getTime())));
    const ok = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-run:' || ${`${k.periodKey}:${k.basis}`}))`);
      const [again] = await tx.select({ status: p.status }).from(p).where(and(eq(p.periodKey, k.periodKey), eq(p.basis, k.basis))).limit(1);
      if (normalizePayrollStatus(again?.status) !== "LOCKED") return false;
      await tx.update(p).set({ status: "PAID", paidAt, paidBy: null, updatedAt: new Date(), statusReason: "" }).where(and(eq(p.periodKey, k.periodKey), eq(p.basis, k.basis)));
      return true;
    });
    if (!ok) continue;
    await audit({
      userId: null,
      userEmail: LINK_AUTO_ACTOR,
      action: "PAYROLL_RUN_PAID_BY_BANK_EVIDENCE",
      entity: "PAYROLL_PERIOD",
      entityId: `${k.periodKey}:${k.basis}`,
      before: { status: "LOCKED" },
      after: { status: "PAID" },
      detail: { lines: lines.length, paidAt: paidAt.toISOString() },
    });
    done.push(k.periodKey);
  }
  return done;
}

/** Tổng hợp lệnh chuyển của một kỳ — cho bộ lập kế hoạch và màn hình. */
export async function payoutSummary(periodKey: string, basis: string): Promise<{ lines: number; pending: number; paid: number }> {
  const db = await getDb();
  const rows = await db.select({ status: L.status }).from(L).where(and(eq(L.periodKey, periodKey), eq(L.basis, basis), ne(L.status, "CANCELLED")));
  return { lines: rows.length, pending: rows.filter((r) => r.status === "PENDING").length, paid: rows.filter((r) => r.status === "PAID").length };
}
