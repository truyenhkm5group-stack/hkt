/**
 * ═══════════ BỘ MÁY CHẠY LUẬT (Phase 3 · W5–W8) — CHỈ MÁY CHỦ ═══════════
 *
 * Hợp đồng: docs/platform/phase-3-contracts.md mục 3–4. KHÔNG phải một hàng đợi hay một lịch thứ hai: đọc
 * `domain_events` theo con trỏ, ghi sổ `workflow_runs`, cửa duyệt là `approval_requests`, chạy ké job `alerts`
 * (10 phút/lần — không thêm lịch, AGENTS.md mục 7). Mọi truy vấn qua `getDb()` ⇒ CSDL của tổ chức hiện hành.
 *
 * MỘT LƯỢT `runWorkflows()`:
 *  1. Đọc tối đa `EVENT_BATCH` sự kiện sau con trỏ (con trỏ chưa có ⇒ khởi tạo ở sự kiện mới nhất, lượt đầu
 *     KHÔNG xử lý lịch sử — xem `lib/workflow/cursor.ts`).
 *  2. Mỗi sự kiện × mỗi luật `ACTIVE` có trigger khớp ⇒ đúng MỘT dòng `workflow_runs` (`dedupe_key =
 *     <rule id>:<event id>`, `ON CONFLICT DO NOTHING` — chạy lại không bao giờ nhân đôi):
 *       · độ sâu nhân quả > `WORKFLOW_MAX_CAUSATION_DEPTH` ⇒ `FAILED` "vòng lặp" (W7);
 *       · điều kiện không khớp ⇒ `SKIPPED` (để người khai luật thấy VÌ SAO luật không chạy);
 *       · `DRY_RUN` ⇒ `DRY_RUN`, bước `PLANNED`, KHÔNG làm gì;
 *       · `LIVE` + cửa duyệt ⇒ yêu cầu duyệt nhóm `WORKFLOW` (người xin là MÁY) + `WAITING_APPROVAL`;
 *       · `LIVE` không cửa ⇒ thực thi ngay.
 *  3. Quét lượt `WAITING_APPROVAL`: `APPROVED` còn hạn ⇒ CHIẾM lượt chạy (`UPDATE … WHERE status =
 *     'WAITING_APPROVAL' RETURNING` — đúng một lượt thắng) rồi thực thi ĐÚNG MỘT LẦN và thanh toán lời duyệt
 *     (`settleMachineApproval`); `REJECTED` / `EXPIRED` / quá hạn ⇒ `REJECTED`.
 *  Trần mỗi lượt: `EVENT_BATCH` sự kiện, `ACTION_BUDGET` hành động thật — quá trần thì để lượt sau (con trỏ
 *  dừng TRƯỚC sự kiện chưa xét, không nhảy qua).
 *
 * ĐỘ SÂU NHÂN QUẢ: lượt ghi do luật làm mang `causation_id` = id lượt chạy; sự kiện sinh ra có độ sâu = độ sâu
 * của lượt chạy + 1 (tra `workflow_runs` theo `causation_id`). Sự kiện do người / miền khác phát ⇒ độ sâu 0.
 *
 * RỦI RO ĐÃ BIẾT: sự kiện của một giao dịch MỞ LÂU có `recorded_at` sớm hơn lúc nó hiện ra; nếu con trỏ đã đi
 * qua mốc đó thì sự kiện bị bỏ sót. Mọi đường phát hiện nay đều ghi + phát trong giao dịch ngắn.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { expireMachineApproval, approvalFingerprint, approvalStillValid, settleMachineApproval } from "@/lib/approvals/service";
import { audit } from "@/lib/audit";
import type { DbOrTx } from "@/lib/db-transaction";
import { isObjectKey, objectDef } from "@/lib/constants/object-registry";
import { recordExists } from "@/lib/metadata/common";
import { canUseModule } from "@/lib/platform/capabilities";
import { executeActions, planSteps } from "@/lib/workflow/actions";
import { advanceEventCursor, ensureEventCursor, RECORDED_AT_TEXT, type CursorPos } from "@/lib/workflow/cursor";
import { evaluateCondition } from "@/lib/workflow/evaluate";
import { CUSTOM_STATUS_EVENT, getRule, machineEmailOf, toRule, triggerObjectKey } from "@/lib/workflow/rules";
import { eventSubjectFields, recordSubjectFields, subjectLabel, subjectRefOf, type EventLike, type SubjectRef } from "@/lib/workflow/subject";
import {
  WORKFLOW_MAX_CAUSATION_DEPTH,
  type WorkflowMode,
  type WorkflowRule,
  type WorkflowRunRow,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepPreview,
  type WorkflowTrigger,
} from "@/lib/workflow/types";

/** Số sự kiện tối đa xét trong một lượt. */
export const EVENT_BATCH = 200;
/** Số hành động THẬT tối đa trong một lượt (lượt chạy thử không tính). */
export const ACTION_BUDGET = 50;
/** Số lượt chờ duyệt tối đa xét trong một lượt. */
const WAITING_BATCH = 200;

export type RunWorkflowsResult = { events: number; runs: number; executed: number; waiting: number; failed: number };

type EventRow = EventLike & { id: string; at: string; causationId: string | null };

/** Trigger có khớp sự kiện không — hàm THUẦN. */
export function triggerMatches(trigger: WorkflowTrigger, ev: Pick<EventLike, "name" | "payload">): boolean {
  if (trigger.kind === "event") return trigger.event === ev.name;
  if (ev.name !== CUSTOM_STATUS_EVENT) return false;
  const p = ev.payload ?? {};
  if (p.objectKey !== trigger.objectKey || p.fieldKey !== trigger.fieldKey) return false;
  if (typeof p.to !== "string" || !trigger.to.includes(p.to)) return false;
  if (trigger.from && trigger.from.length > 0) return typeof p.from === "string" && trigger.from.includes(p.from);
  return true;
}

/** Bản ghi của một lượt chạy đã lưu — `subject_type` là khoá đối tượng khi lượt chạy gắn với bản ghi. */
function runSubjectRef(subjectType: string | null, subjectId: string | null): SubjectRef | null {
  return subjectType && subjectId && isObjectKey(subjectType) ? { objectKey: subjectType, recordId: subjectId } : null;
}

async function readEventsAfter(db: Db, cursor: CursorPos, limit: number): Promise<EventRow[]> {
  const ev = schema.domainEvents;
  const rows = await db
    .select({ id: ev.id, name: ev.name, subjectType: ev.subjectType, subjectId: ev.subjectId, actorKind: ev.actorKind, payload: ev.payload, causationId: ev.causationId, at: RECORDED_AT_TEXT })
    .from(ev)
    .where(sql`(${ev.recordedAt}, ${ev.id}) > (${cursor.at}::timestamptz, ${cursor.id})`)
    .orderBy(ev.recordedAt, ev.id)
    .limit(limit);
  return rows.map((r) => ({ ...r, payload: r.payload ?? {} }));
}

async function activeRules(db: Db): Promise<WorkflowRule[]> {
  const rows = await db.select().from(schema.workflowRules).where(eq(schema.workflowRules.status, "ACTIVE"));
  return rows.map(toRule);
}

type Subject = { ref: SubjectRef | null; fields: Record<string, unknown>; label: string };

async function subjectOfEvent(ev: EventRow): Promise<Subject> {
  const ref = subjectRefOf(ev);
  const rec = ref ? await recordSubjectFields(ref) : null;
  return { ref: rec ? ref : null, fields: { ...eventSubjectFields(ev), ...(rec ?? {}) }, label: subjectLabel(rec ? ref : null, rec, `${ev.subjectType} ${ev.subjectId}`) };
}

/** Độ sâu nhân quả của một sự kiện: 0 nếu không do workflow gây ra, còn lại = độ sâu lượt chạy gây ra + 1. */
async function eventDepth(db: Db, ev: EventRow, cache: Map<string, number>): Promise<number> {
  if (!ev.causationId) return 0;
  if (cache.has(ev.causationId)) return cache.get(ev.causationId)! + 1;
  const [run] = await db.select({ depth: schema.workflowRuns.causationDepth }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, ev.causationId)).limit(1);
  if (!run) return 0;
  cache.set(ev.causationId, run.depth);
  return run.depth + 1;
}

type Counters = RunWorkflowsResult & { actions: number };

function subjectCols(s: Subject, ev: EventRow): { subjectType: string; subjectId: string } {
  return s.ref ? { subjectType: s.ref.objectKey, subjectId: s.ref.recordId } : { subjectType: ev.subjectType, subjectId: ev.subjectId };
}

async function processRule(db: Db, rule: WorkflowRule, ev: EventRow, subject: Subject, depth: number, c: Counters, now: Date) {
  const t = schema.workflowRuns;
  const base = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    mode: rule.mode,
    triggerKind: rule.trigger.kind,
    triggerRef: ev.id,
    ...subjectCols(subject, ev),
    dedupeKey: `${rule.id}:${ev.id}`,
    causationDepth: depth,
  };
  const insertRun = async (values: { status: WorkflowRunStatus; steps: WorkflowStep[]; error?: string | null; finishedAt?: Date | null }, tx: DbOrTx = db) => {
    const [row] = await tx
      .insert(t)
      .values({ ...base, status: values.status, steps: values.steps, error: values.error ?? null, finishedAt: values.finishedAt ?? null })
      .onConflictDoNothing({ target: t.dedupeKey })
      .returning({ id: t.id });
    if (row) c.runs += 1;
    return row?.id ?? null;
  };

  if (depth > WORKFLOW_MAX_CAUSATION_DEPTH) {
    const id = await insertRun({
      status: "FAILED",
      steps: rule.actions.map((a) => ({ action: a.kind, status: "SKIPPED" as const, detail: "Không chạy — vòng lặp" })),
      error: `Vòng lặp: độ sâu nhân quả ${depth} vượt ${WORKFLOW_MAX_CAUSATION_DEPTH} — các luật đang kích hoạt lẫn nhau.`,
      finishedAt: now,
    });
    if (id) c.failed += 1;
    return;
  }
  if (!evaluateCondition(rule.conditions, subject.fields)) {
    await insertRun({ status: "SKIPPED", steps: [], error: null, finishedAt: now });
    return;
  }
  if (rule.mode === "DRY_RUN") {
    await insertRun({ status: "DRY_RUN", steps: planSteps(rule, rule.gate, subject.label), finishedAt: now });
    return;
  }
  const machine = machineEmailOf(rule.key);
  if (rule.gate) {
    const created = await db.transaction(async (tx) => {
      const runId = await insertRun({ status: "WAITING_APPROVAL", steps: planSteps(rule, rule.gate, subject.label) }, tx);
      if (!runId) return null;
      const payload = { runId, ruleId: rule.id, reason: rule.gate!.reason };
      const input = { group: "WORKFLOW" as const, action: "workflow.run", entity: "WORKFLOW_RUN", entityId: runId, payload };
      const [req] = await tx
        .insert(schema.approvalRequests)
        .values({
          ...input,
          amount: null,
          summary: `Luật "${rule.name}" xin chạy: ${rule.gate!.reason} · ${subject.label}`.slice(0, 500),
          payload,
          requestedBy: null,
          requestedByEmail: machine,
          payloadFingerprint: approvalFingerprint(input),
        })
        .returning({ id: schema.approvalRequests.id });
      await tx.update(t).set({ approvalRequestId: req.id, updatedAt: now }).where(eq(t.id, runId));
      return { runId, requestId: req.id };
    });
    if (created) {
      c.waiting += 1;
      await audit({
        userId: null,
        userEmail: machine,
        actorKind: "SYSTEM",
        action: "approval.request:workflow.run",
        entity: "APPROVAL_REQUEST",
        entityId: created.requestId,
        correlationId: created.runId,
        reason: `Luật tự động "${rule.name}" (phiên bản ${rule.version}) cần người duyệt trước khi chạy: ${rule.gate.reason}`,
        detail: { group: "WORKFLOW", ruleId: rule.id, runId: created.runId, event: ev.name },
      });
    }
    return;
  }
  const runId = await insertRun({ status: "PENDING", steps: planSteps(rule, null, subject.label) });
  if (!runId) return;
  await executeRun(db, runId, rule, subject.ref, subject.label, c, now);
}

async function executeRun(db: Db, runId: string, rule: WorkflowRule, ref: SubjectRef | null, label: string, c: Counters, now: Date): Promise<{ ok: boolean; error: string | null }> {
  const r = await executeActions({ runId, rule, subject: ref, label, now });
  c.actions += rule.actions.length;
  if (r.ok) c.executed += 1;
  else c.failed += 1;
  await db
    .update(schema.workflowRuns)
    .set({ status: r.ok ? "DONE" : "FAILED", steps: r.steps, error: r.error, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.workflowRuns.id, runId));
  return { ok: r.ok, error: r.error };
}

async function finishRun(db: Db, runId: string, from: WorkflowRunStatus, status: WorkflowRunStatus, error: string): Promise<boolean> {
  const rows = await db
    .update(schema.workflowRuns)
    .set({ status, error, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.status, from)))
    .returning({ id: schema.workflowRuns.id });
  return rows.length > 0;
}

/** Lượt chờ duyệt: đã quyết ⇒ chạy đúng một lần / dừng. */
async function sweepWaiting(db: Db, c: Counters, now: Date) {
  const r = schema.workflowRuns;
  const a = schema.approvalRequests;
  const rows = await db
    .select({ run: r, req: { id: a.id, status: a.status, decidedAt: a.decidedAt, executedAt: a.executedAt, note: a.note } })
    .from(r)
    .leftJoin(a, eq(a.id, r.approvalRequestId))
    .where(eq(r.status, "WAITING_APPROVAL"))
    .orderBy(r.createdAt)
    .limit(WAITING_BATCH);
  const rules = new Map<string, WorkflowRule | null>();
  for (const { run, req } of rows) {
    if (!req) {
      if (await finishRun(db, run.id, "WAITING_APPROVAL", "FAILED", "Không tìm thấy yêu cầu duyệt của lượt chạy.")) c.failed += 1;
      continue;
    }
    if (req.status === "PENDING") continue;
    if (req.status === "REJECTED") {
      await finishRun(db, run.id, "WAITING_APPROVAL", "REJECTED", `Người duyệt từ chối${req.note ? `: ${req.note}` : ""}.`);
      continue;
    }
    if (req.status === "EXPIRED") {
      await finishRun(db, run.id, "WAITING_APPROVAL", "REJECTED", "Lời duyệt đã hết hiệu lực.");
      continue;
    }
    if (req.status !== "APPROVED") {
      if (await finishRun(db, run.id, "WAITING_APPROVAL", "FAILED", `Yêu cầu duyệt ở trạng thái ${req.status} — không chạy.`)) c.failed += 1;
      continue;
    }
    if (!rules.has(run.ruleId)) rules.set(run.ruleId, await getRule(run.ruleId));
    const rule = rules.get(run.ruleId) ?? null;
    const machine = machineEmailOf(rule?.key ?? "unknown");
    if (!approvalStillValid({ status: req.status, decidedAt: req.decidedAt, executedAt: req.executedAt }, now)) {
      await expireMachineApproval(db, req.id, { email: machine }, now);
      await finishRun(db, run.id, "WAITING_APPROVAL", "REJECTED", "Lời duyệt quá hạn hiệu lực mà luật chưa chạy.");
      continue;
    }
    // Luật đang tạm dừng / về chạy thử: lời duyệt còn hạn thì CHỜ, không chạy mà cũng không huỷ.
    if (rule && (rule.status === "PAUSED" || (rule.status === "ACTIVE" && rule.mode !== "LIVE"))) continue;
    if (!rule || rule.status !== "ACTIVE" || rule.version !== run.ruleVersion) {
      const why = !rule ? "Luật không còn tồn tại." : rule.status !== "ACTIVE" ? `Luật đã ${rule.status} — không chạy.` : `Luật đã đổi sang phiên bản ${rule.version} (lời duyệt cho phiên bản ${run.ruleVersion}) — không chạy.`;
      if (await finishRun(db, run.id, "WAITING_APPROVAL", "SKIPPED", why)) await settleMachineApproval(db, req.id, { error: why }, { email: machine }, now);
      continue;
    }
    if (c.actions > 0 && c.actions + rule.actions.length > ACTION_BUDGET) break;
    const [claimed] = await db
      .update(r)
      .set({ status: "PENDING", updatedAt: now })
      .where(and(eq(r.id, run.id), eq(r.status, "WAITING_APPROVAL")))
      .returning({ id: r.id });
    if (!claimed) continue;
    const ref = runSubjectRef(run.subjectType, run.subjectId);
    const rec = ref ? await recordSubjectFields(ref) : null;
    const res = await executeRun(db, run.id, rule, rec ? ref : null, subjectLabel(rec ? ref : null, rec, `${run.subjectType ?? ""} ${run.subjectId ?? ""}`.trim()), c, now);
    await settleMachineApproval(db, req.id, res.ok ? { ok: true } : { error: res.error ?? "Thực thi hỏng" }, { email: machine }, now);
  }
}

/**
 * Một lượt của bộ máy — gọi từ job `alerts` (đã ở trong `withOrganization`). Không ném vì lỗi của MỘT luật;
 * lỗi hạ tầng (CSDL) thì ném để nơi gọi ghi lại.
 */
export async function runWorkflows(opts: { limit?: number } = {}): Promise<RunWorkflowsResult> {
  const c: Counters = { events: 0, runs: 0, executed: 0, waiting: 0, failed: 0, actions: 0 };
  if (!(await canUseModule("work"))) return { events: 0, runs: 0, executed: 0, waiting: 0, failed: 0 };
  const db = await getDb();
  const now = new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? EVENT_BATCH, EVENT_BATCH));
  const cursor = await ensureEventCursor(db);
  const events = await readEventsAfter(db, cursor, limit);
  const rules = events.length ? await activeRules(db) : [];
  const depthCache = new Map<string, number>();
  let last: CursorPos = cursor;
  for (const ev of events) {
    const matching = rules.filter((r) => triggerMatches(r.trigger, ev));
    const cost = matching.filter((r) => r.mode === "LIVE" && !r.gate).reduce((s, r) => s + r.actions.length, 0);
    // Quá trần hành động: dừng TRƯỚC sự kiện này, con trỏ không đi qua nó — lượt sau xét tiếp.
    if (cost > 0 && c.actions > 0 && c.actions + cost > ACTION_BUDGET) break;
    if (matching.length) {
      const subject = await subjectOfEvent(ev);
      const depth = await eventDepth(db, ev, depthCache);
      for (const rule of matching) await processRule(db, rule, ev, subject, depth, c, now);
    }
    c.events += 1;
    last = { at: ev.at, id: ev.id };
  }
  await advanceEventCursor(db, cursor, last);
  await sweepWaiting(db, c, now);
  return { events: c.events, runs: c.runs, executed: c.executed, waiting: c.waiting, failed: c.failed };
}

export type PreviewResult = { matched: boolean; wouldDo: WorkflowStepPreview[]; reason?: string };

/**
 * CHẠY THỬ một luật trên MỘT bản ghi — KHÔNG ghi gì (không lượt chạy, không việc, không nhật ký). Subject dựng y
 * như lượt chạy thật; với trigger `custom_status`, `system:payload.to` = giá trị HIỆN TẠI của field trạng thái.
 */
export async function previewRule(ruleId: string, subject: { objectKey: string; recordId: string }): Promise<PreviewResult> {
  const rule = await getRule(ruleId);
  if (!rule) return { matched: false, wouldDo: [], reason: "Luật không tồn tại." };
  const def = objectDef(subject?.objectKey ?? "");
  if (!def) return { matched: false, wouldDo: [], reason: `Đối tượng "${String(subject?.objectKey)}" không có trong sổ đối tượng.` };
  const want = triggerObjectKey(rule.trigger);
  if (want && want !== def.key) return { matched: false, wouldDo: [], reason: `Luật này nói về ${objectDef(want)?.label ?? want}, không phải ${def.label}.` };
  if (!(await recordExists(def, subject.recordId))) return { matched: false, wouldDo: [], reason: `${def.label} "${String(subject.recordId).slice(0, 80)}" không tồn tại.` };
  const ref: SubjectRef = { objectKey: def.key, recordId: subject.recordId };
  const rec = (await recordSubjectFields(ref)) ?? {};
  const payload: Record<string, unknown> =
    rule.trigger.kind === "custom_status" ? { objectKey: def.key, recordId: subject.recordId, fieldKey: rule.trigger.fieldKey, from: null, to: rec[`custom:${rule.trigger.fieldKey}`] ?? null } : {};
  const fields = { ...eventSubjectFields({ name: rule.trigger.kind === "event" ? rule.trigger.event : CUSTOM_STATUS_EVENT, subjectType: def.key, subjectId: subject.recordId, actorKind: "USER", payload }), ...rec };
  const matched = evaluateCondition(rule.conditions, fields);
  const label = subjectLabel(ref, rec, `${def.label} ${subject.recordId}`);
  const triggerNote =
    rule.trigger.kind === "custom_status" && !rule.trigger.to.includes(String(payload.to ?? ""))
      ? `Trạng thái hiện tại của bản ghi không nằm trong trạng thái đích của luật — luật chỉ chạy khi "${rule.trigger.fieldKey}" chuyển sang ${rule.trigger.to.join(" / ")}.`
      : undefined;
  return { matched, wouldDo: matched ? planSteps(rule, rule.gate, label) : [], ...(matched ? (triggerNote ? { reason: triggerNote } : {}) : { reason: "Điều kiện của luật không khớp bản ghi này." }) };
}

type RunDbRow = typeof schema.workflowRuns.$inferSelect;

function toRunRow(r: RunDbRow): WorkflowRunRow {
  return {
    id: r.id,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    mode: r.mode as WorkflowMode,
    triggerKind: r.triggerKind as WorkflowTrigger["kind"],
    triggerRef: r.triggerRef,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    status: r.status as WorkflowRunStatus,
    steps: (Array.isArray(r.steps) ? r.steps : []) as WorkflowStep[],
    causationDepth: r.causationDepth,
    approvalRequestId: r.approvalRequestId,
    error: r.error,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}

/** Lượt chạy gần đây (mới nhất trước), lọc theo luật / trạng thái. Trần 200 dòng. */
export async function listRuns(opts: { ruleId?: string; status?: WorkflowRunStatus; limit?: number } = {}): Promise<WorkflowRunRow[]> {
  const db = await getDb();
  const r = schema.workflowRuns;
  const conds = [opts.ruleId ? eq(r.ruleId, opts.ruleId) : undefined, opts.status ? eq(r.status, opts.status) : undefined].filter(Boolean);
  const rows = await db
    .select()
    .from(r)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(r.createdAt), desc(r.id))
    .limit(Math.max(1, Math.min(opts.limit ?? 50, 200)));
  return rows.map(toRunRow);
}
