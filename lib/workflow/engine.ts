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
 *  3. Quét lượt `WAITING_APPROVAL`: `APPROVED` còn hạn ⇒ CHIẾM lượt chạy (`claimRun` — đúng một lượt thắng) rồi
 *     thực thi ĐÚNG MỘT LẦN và thanh toán lời duyệt (`settleMachineApproval`); `REJECTED` / `EXPIRED` / quá hạn
 *     ⇒ `REJECTED`.
 *  4. Phục hồi lượt treo (`recoverStaleRuns`, xem dưới).
 *  Trần mỗi lượt: `EVENT_BATCH` sự kiện, `ACTION_BUDGET` hành động thật — quá trần thì để lượt sau (con trỏ
 *  dừng TRƯỚC sự kiện chưa xét, không nhảy qua).
 *
 * ĐỘ SÂU NHÂN QUẢ: lượt ghi do luật làm mang `causation_id` = id lượt chạy; sự kiện sinh ra có độ sâu = độ sâu
 * của lượt chạy + 1 (tra `workflow_runs` theo `causation_id`). Sự kiện do người / miền khác phát ⇒ độ sâu 0.
 *
 * RỦI RO ĐÃ BIẾT: sự kiện của một giao dịch MỞ LÂU có `recorded_at` sớm hơn lúc nó hiện ra; nếu con trỏ đã đi
 * qua mốc đó thì sự kiện bị bỏ sót. Mọi đường phát hiện nay đều ghi + phát trong giao dịch ngắn.
 *
 * ═══ PHỤC HỒI LƯỢT CHẠY BỊ TREO (Phase 3.1) ═══
 * Trước 3.1, lượt chạy chỉ ở PENDING trong lúc một tiến trình đang thực thi nó, và không đường nào đưa nó ra khỏi
 * PENDING nếu tiến trình ấy chết: sau lúc chiếm (lượt có cửa duyệt) hoặc sau lúc chèn (lượt không cửa duyệt) ⇒ kẹt
 * PENDING VĨNH VIỄN, lời duyệt nằm APPROVED không ai thanh toán, và sự kiện không bao giờ được xử lý lại
 * (`dedupe_key` đã có). Nay:
 *  · CHIẾM = `claimRun`: `UPDATE … SET status='PENDING', attempt=attempt+1, lease_until=now()+hạn WHERE id=? AND
 *    attempt < trần AND (status='WAITING_APPROVAL' OR PENDING-quá-hạn) RETURNING` — đúng một tiến trình thắng.
 *    Lượt không cửa duyệt sinh ra ĐÃ chiếm sẵn (chèn với attempt 1 + hạn giữ).
 *  · Mỗi bước xong ⇒ ghi `steps` + gia hạn, CHỈ KHI còn giữ lượt (`attempt` = lần chiếm của mình — khoá rào). Mất
 *    lượt ⇒ dừng ngay, không chốt. Lượt thử lại bỏ qua bước đã `DONE`; bước có thể đã chạy mà chưa kịp ghi thì
 *    làm lại — an toàn vì mọi hành động đã khai lũy đẳng (`ACTION_RETRY_SAFETY`); hành động chưa chứng minh được
 *    thì KHÔNG tự thử lại (FAILED, ghi rõ).
 *  · `recoverStaleRuns` (mỗi lượt, sau quét chờ duyệt): quá trần ⇒ FAILED "Treo quá số lần thử" và không thử nữa;
 *    còn lại chiếm lại và chạy tiếp; lượt đã chốt mà lời duyệt chưa thanh toán ⇒ thanh toán.
 *  · Chẩn đoán: `listStaleRuns()` (lib/workflow/stale.ts) — cùng câu hỏi cho /settings/workflows và
 *    `npm run platform:diagnostics`.
 */
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { expireMachineApproval, approvalFingerprint, approvalStillValid, settleMachineApproval } from "@/lib/approvals/service";
import { audit } from "@/lib/audit";
import type { DbOrTx } from "@/lib/db-transaction";
import { recordExists } from "@/lib/metadata/common";
import { resolveObject } from "@/lib/metadata/object-resolver";
import { canUseModule } from "@/lib/platform/capabilities";
import { executeActions, planSteps, retryBlocker } from "@/lib/workflow/actions";
import { advanceEventCursor, ensureEventCursor, RECORDED_AT_TEXT, type CursorPos } from "@/lib/workflow/cursor";
import { evaluateCondition } from "@/lib/workflow/evaluate";
import { CUSTOM_STATUS_EVENT, getRule, machineEmailOf, toRule, triggerObjectKey } from "@/lib/workflow/rules";
import { leaseExpiredSql, staleRunsOn, type StaleRun } from "@/lib/workflow/stale";
import { eventSubjectFields, isSubjectObjectKey, recordSubjectFields, subjectLabel, subjectRefOf, type EventLike, type SubjectRef } from "@/lib/workflow/subject";
import {
  WORKFLOW_LEASE_MINUTES,
  WORKFLOW_MAX_ATTEMPTS,
  WORKFLOW_MAX_CAUSATION_DEPTH,
  WORKFLOW_STUCK_ERROR_PREFIX,
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
/** Số lượt treo tối đa xét trong một lượt phục hồi. */
const RECOVERY_BATCH = 50;

export type RunWorkflowsResult = { events: number; runs: number; executed: number; waiting: number; failed: number; recovered: number };

type EventRow = EventLike & { id: string; at: string; causationId: string | null };

/** Hạn giữ tính bằng đồng hồ CSDL — mọi tiến trình so cùng một đồng hồ. */
const LEASE_UNTIL = sql`now() + ${sql.raw(`interval '${WORKFLOW_LEASE_MINUTES} minutes'`)}`;

/**
 * CHỈ bộ kiểm thử: gọi sau MỖI bước đã ghi vào sổ lượt chạy — ném ở đây là giả lập tiến trình chết giữa hai hành
 * động (lỗi đi thẳng lên, không bị bắt thành một bước FAILED).
 */
let stepHookForTests: ((runId: string, index: number) => void | Promise<void>) | null = null;
export function setWorkflowStepHookForTests(hook: ((runId: string, index: number) => void | Promise<void>) | null) {
  stepHookForTests = hook;
}

/** Trigger có khớp sự kiện không — hàm THUẦN. */
export function triggerMatches(trigger: WorkflowTrigger, ev: Pick<EventLike, "name" | "payload">): boolean {
  // `objectKey` (Phase 6): chỉ sự kiện của ĐÚNG đối tượng đó (payload `objectKey` của sự kiện trên bản ghi metadata).
  if (trigger.kind === "event") return trigger.event === ev.name && (!trigger.objectKey || ev.payload?.objectKey === trigger.objectKey);
  if (ev.name !== CUSTOM_STATUS_EVENT) return false;
  const p = ev.payload ?? {};
  if (p.objectKey !== trigger.objectKey || p.fieldKey !== trigger.fieldKey) return false;
  if (typeof p.to !== "string" || !trigger.to.includes(p.to)) return false;
  if (trigger.from && trigger.from.length > 0) return typeof p.from === "string" && trigger.from.includes(p.from);
  return true;
}

/** Bản ghi của một lượt chạy đã lưu — `subject_type` là khoá đối tượng khi lượt chạy gắn với bản ghi. */
function runSubjectRef(subjectType: string | null, subjectId: string | null): SubjectRef | null {
  return subjectType && subjectId && isSubjectObjectKey(subjectType) ? { objectKey: subjectType, recordId: subjectId } : null;
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
  return { ref: rec ? ref : null, fields: { ...eventSubjectFields(ev), ...(rec ?? {}) }, label: await subjectLabel(rec ? ref : null, rec, `${ev.subjectType} ${ev.subjectId}`) };
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

/** Lượt chạy đang được MÌNH giữ: id + lần chiếm (khoá rào) + các bước đã ghi. */
type Claimed = { id: string; attempt: number; steps: WorkflowStep[] };

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
  const insertRun = async (values: { status: WorkflowRunStatus; steps: WorkflowStep[]; error?: string | null; finishedAt?: Date | null; claim?: boolean }, tx: DbOrTx = db) => {
    const [row] = await tx
      .insert(t)
      .values({
        ...base,
        status: values.status,
        steps: values.steps,
        error: values.error ?? null,
        finishedAt: values.finishedAt ?? null,
        // Lượt thực thi ngay: sinh ra là ĐÃ chiếm (lần 1, có hạn giữ) — chết trước bước đầu vẫn được lượt sau chiếm lại.
        ...(values.claim ? { attempt: 1, leaseUntil: LEASE_UNTIL, lastHeartbeatAt: sql`now()` } : {}),
      })
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
  const steps = planSteps(rule, null, subject.label);
  const runId = await insertRun({ status: "PENDING", steps, claim: true });
  if (!runId) return;
  await executeRun(db, { id: runId, attempt: 1, steps }, rule, subject.ref, subject.label, c, now);
}

/**
 * CHIẾM một lượt chạy — so-sánh-rồi-đổi trong MỘT câu lệnh: chỉ lượt đang chờ duyệt (nơi gọi đã kiểm lời duyệt)
 * hoặc PENDING đã quá hạn giữ, và chưa vượt trần số lần thử. `null` = tiến trình khác đã thắng / không còn chiếm được.
 */
export async function claimRun(db: Db, runId: string): Promise<Claimed | null> {
  const r = schema.workflowRuns;
  const [row] = await db
    .update(r)
    .set({ status: "PENDING", attempt: sql`${r.attempt} + 1`, leaseUntil: LEASE_UNTIL, lastHeartbeatAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(r.id, runId), lt(r.attempt, WORKFLOW_MAX_ATTEMPTS), or(eq(r.status, "WAITING_APPROVAL"), leaseExpiredSql())))
    .returning({ id: r.id, attempt: r.attempt, steps: r.steps });
  return row ? { id: row.id, attempt: row.attempt, steps: (Array.isArray(row.steps) ? row.steps : []) as WorkflowStep[] } : null;
}

/** Điều kiện "lượt này vẫn là của MÌNH" — khoá rào theo lần chiếm. */
function heldBy(claimed: Pick<Claimed, "id" | "attempt">) {
  const r = schema.workflowRuns;
  return and(eq(r.id, claimed.id), eq(r.status, "PENDING"), eq(r.attempt, claimed.attempt));
}

async function executeRun(db: Db, claimed: Claimed, rule: WorkflowRule, ref: SubjectRef | null, label: string, c: Counters, now: Date): Promise<{ ok: boolean; error: string | null; lost: boolean }> {
  const r = schema.workflowRuns;
  const onStep = async (steps: WorkflowStep[], index: number): Promise<boolean> => {
    const rows = await db.update(r).set({ steps, leaseUntil: LEASE_UNTIL, lastHeartbeatAt: sql`now()`, updatedAt: new Date() }).where(heldBy(claimed)).returning({ id: r.id });
    if (rows.length === 0) return false;
    if (stepHookForTests) await stepHookForTests(claimed.id, index);
    return true;
  };
  const res = await executeActions({ runId: claimed.id, rule, subject: ref, label, now }, { previous: claimed.steps, onStep });
  c.actions += rule.actions.length;
  if (res.lostLease) return { ok: false, error: res.error, lost: true };
  const done = await db
    .update(r)
    .set({ status: res.ok ? "DONE" : "FAILED", steps: res.steps, error: res.error, finishedAt: new Date(), updatedAt: new Date(), leaseUntil: null })
    .where(heldBy(claimed))
    .returning({ id: r.id });
  if (done.length === 0) return { ok: false, error: "Mất hạn giữ trước khi chốt lượt chạy.", lost: true };
  if (res.ok) c.executed += 1;
  else c.failed += 1;
  return { ok: res.ok, error: res.error, lost: false };
}

async function finishRun(db: Db, runId: string, from: WorkflowRunStatus, status: WorkflowRunStatus, error: string): Promise<boolean> {
  const rows = await db
    .update(schema.workflowRuns)
    .set({ status, error, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.status, from)))
    .returning({ id: schema.workflowRuns.id });
  return rows.length > 0;
}

/** Luật của lượt chạy có còn chạy được không — một câu trả lời cho quét chờ duyệt lẫn phục hồi. */
type RuleVerdict = { run: true } | { wait: true } | { stop: string };
function ruleVerdict(rule: WorkflowRule | null, runVersion: number): RuleVerdict {
  // Luật đang tạm dừng / về chạy thử: CHỜ, không chạy mà cũng không huỷ.
  if (rule && (rule.status === "PAUSED" || (rule.status === "ACTIVE" && rule.mode !== "LIVE"))) return { wait: true };
  if (!rule) return { stop: "Luật không còn tồn tại." };
  if (rule.status !== "ACTIVE") return { stop: `Luật đã ${rule.status} — không chạy.` };
  if (rule.version !== runVersion) return { stop: `Luật đã đổi sang phiên bản ${rule.version} (lượt chạy của phiên bản ${runVersion}) — không chạy.` };
  return { run: true };
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
    const verdict = ruleVerdict(rule, run.ruleVersion);
    if ("wait" in verdict) continue;
    if ("stop" in verdict) {
      if (await finishRun(db, run.id, "WAITING_APPROVAL", "SKIPPED", verdict.stop)) await settleMachineApproval(db, req.id, { error: verdict.stop }, { email: machine }, now);
      continue;
    }
    if (c.actions > 0 && c.actions + rule!.actions.length > ACTION_BUDGET) break;
    const claimed = await claimRun(db, run.id);
    if (!claimed) continue;
    const ref = runSubjectRef(run.subjectType, run.subjectId);
    const rec = ref ? await recordSubjectFields(ref) : null;
    const res = await executeRun(db, claimed, rule!, rec ? ref : null, await subjectLabel(rec ? ref : null, rec, `${run.subjectType ?? ""} ${run.subjectId ?? ""}`.trim()), c, now);
    if (res.lost) continue;
    await settleMachineApproval(db, req.id, res.ok ? { ok: true } : { error: res.error ?? "Thực thi hỏng" }, { email: machine }, now);
  }
}

/**
 * PHỤC HỒI lượt treo — ba việc, theo thứ tự:
 *  1. PENDING quá hạn giữ mà đã chiếm đủ `WORKFLOW_MAX_ATTEMPTS` lần ⇒ FAILED "Treo quá số lần thử", KHÔNG thử nữa.
 *  2. PENDING quá hạn giữ còn lượt thử ⇒ kiểm luật (cùng `ruleVerdict` với quét chờ duyệt) + kiểm lũy đẳng của phần
 *     chưa xong ⇒ chiếm lại (`claimRun`) và chạy tiếp từ bước chưa `DONE`.
 *  3. Lượt đã chốt mà lời duyệt vẫn APPROVED chưa thanh toán (chết giữa lúc chốt và lúc thanh toán) ⇒ thanh toán.
 */
async function recoverStaleRuns(db: Db, c: Counters, now: Date) {
  const r = schema.workflowRuns;
  const a = schema.approvalRequests;

  // 1. Quá trần.
  const overLimit = await db
    .update(r)
    .set({
      status: "FAILED",
      error: sql`${`${WORKFLOW_STUCK_ERROR_PREFIX} quá số lần thử: `}::text || ${r.attempt}::text || ${` lần chiếm đều không hoàn tất trong hạn giữ ${WORKFLOW_LEASE_MINUTES} phút — máy không thử lại, người cần xem các bước đã làm.`}::text`,
      finishedAt: new Date(),
      updatedAt: new Date(),
      leaseUntil: null,
    })
    .where(and(leaseExpiredSql(), sql`${r.attempt} >= ${WORKFLOW_MAX_ATTEMPTS}`))
    .returning({ id: r.id, ruleId: r.ruleId, approvalRequestId: r.approvalRequestId, error: r.error });
  for (const x of overLimit) {
    c.failed += 1;
    if (x.approvalRequestId) await settleMachineApproval(db, x.approvalRequestId, { error: x.error ?? "Treo quá số lần thử" }, { email: machineEmailOf((await getRule(x.ruleId))?.key ?? "unknown") }, now);
  }

  // 2. Chiếm lại.
  const stale = await db.select().from(r).where(leaseExpiredSql()).orderBy(r.updatedAt).limit(RECOVERY_BATCH);
  const rules = new Map<string, WorkflowRule | null>();
  for (const run of stale) {
    if (!rules.has(run.ruleId)) rules.set(run.ruleId, await getRule(run.ruleId));
    const rule = rules.get(run.ruleId) ?? null;
    const machine = machineEmailOf(rule?.key ?? "unknown");
    const steps = (Array.isArray(run.steps) ? run.steps : []) as WorkflowStep[];
    const settle = async (outcome: { ok: true } | { error: string }) => {
      if (run.approvalRequestId) await settleMachineApproval(db, run.approvalRequestId, outcome, { email: machine }, now);
    };
    /** Dừng hẳn. Luật đổi / tắt mà chưa bước nào xong ⇒ SKIPPED (như quét chờ duyệt); đã làm dở, hoặc bị chặn vì lũy đẳng ⇒ FAILED. */
    const stop = async (why: string, forceFailed: boolean) => {
      const failed = forceFailed || steps.some((s) => s.status === "DONE");
      // Chỉ dừng lượt VẪN còn quá hạn — một tiến trình khác vừa chiếm lại thì để yên cho nó.
      const [row] = await db
        .update(r)
        .set({ status: failed ? "FAILED" : "SKIPPED", error: why, finishedAt: new Date(), updatedAt: new Date(), leaseUntil: null })
        .where(and(eq(r.id, run.id), eq(r.attempt, run.attempt), leaseExpiredSql()))
        .returning({ id: r.id });
      if (row) {
        if (failed) c.failed += 1;
        await settle({ error: why });
      }
    };
    const verdict = ruleVerdict(rule, run.ruleVersion);
    if ("wait" in verdict) continue;
    if ("stop" in verdict) {
      await stop(`${WORKFLOW_STUCK_ERROR_PREFIX} giữa chừng rồi không chạy tiếp: ${verdict.stop}`, false);
      continue;
    }
    const blocker = retryBlocker(rule!.actions, steps);
    if (blocker) {
      await stop(`${WORKFLOW_STUCK_ERROR_PREFIX} giữa chừng và hành động «${blocker}» chưa chứng minh được làm lại không sinh bản sao — máy không tự thử lại, người cần xem.`, true);
      continue;
    }
    if (c.actions > 0 && c.actions + rule!.actions.length > ACTION_BUDGET) break;
    const claimed = await claimRun(db, run.id);
    if (!claimed) continue;
    c.recovered += 1;
    const ref = runSubjectRef(run.subjectType, run.subjectId);
    const rec = ref ? await recordSubjectFields(ref) : null;
    const res = await executeRun(db, claimed, rule!, rec ? ref : null, await subjectLabel(rec ? ref : null, rec, `${run.subjectType ?? ""} ${run.subjectId ?? ""}`.trim()), c, now);
    if (res.lost) continue;
    await settle(res.ok ? { ok: true } : { error: res.error ?? "Thực thi hỏng" });
  }

  // 3. Lượt đã chốt, lời duyệt chưa thanh toán.
  const unsettled = await db
    .select({ id: r.id, ruleId: r.ruleId, status: r.status, error: r.error, requestId: a.id })
    .from(r)
    .innerJoin(a, eq(a.id, r.approvalRequestId))
    .where(and(sql`${r.status} in ('DONE','FAILED','SKIPPED')`, eq(a.status, "APPROVED"), isNull(a.executedAt), isNull(a.executionError)))
    .limit(RECOVERY_BATCH);
  for (const x of unsettled) {
    const machine = machineEmailOf((await getRule(x.ruleId))?.key ?? "unknown");
    await settleMachineApproval(db, x.requestId, x.status === "DONE" ? { ok: true } : { error: x.error ?? "Lượt chạy không hoàn tất" }, { email: machine }, now);
  }
}

/**
 * Một lượt của bộ máy — gọi từ job `alerts` (đã ở trong `withOrganization`). Không ném vì lỗi của MỘT luật;
 * lỗi hạ tầng (CSDL) thì ném để nơi gọi ghi lại.
 */
export async function runWorkflows(opts: { limit?: number } = {}): Promise<RunWorkflowsResult> {
  const c: Counters = { events: 0, runs: 0, executed: 0, waiting: 0, failed: 0, recovered: 0, actions: 0 };
  if (!(await canUseModule("work"))) return { events: 0, runs: 0, executed: 0, waiting: 0, failed: 0, recovered: 0 };
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
  await recoverStaleRuns(db, c, now);
  return { events: c.events, runs: c.runs, executed: c.executed, waiting: c.waiting, failed: c.failed, recovered: c.recovered };
}

/** Lượt chạy treo của tổ chức hiện hành (xem `lib/workflow/stale.ts`) — CHỈ ĐỌC. */
export async function listStaleRuns(opts: { limit?: number } = {}): Promise<StaleRun[]> {
  return staleRunsOn(await getDb(), opts);
}

export type PreviewResult = { matched: boolean; wouldDo: WorkflowStepPreview[]; reason?: string };

/**
 * CHẠY THỬ một luật trên MỘT bản ghi — KHÔNG ghi gì (không lượt chạy, không việc, không nhật ký). Subject dựng y
 * như lượt chạy thật; với trigger `custom_status`, `system:payload.to` = giá trị HIỆN TẠI của field trạng thái.
 */
export async function previewRule(ruleId: string, subject: { objectKey: string; recordId: string }): Promise<PreviewResult> {
  const rule = await getRule(ruleId);
  if (!rule) return { matched: false, wouldDo: [], reason: "Luật không tồn tại." };
  const def = await resolveObject(subject?.objectKey ?? "");
  if (!def) return { matched: false, wouldDo: [], reason: `Đối tượng "${String(subject?.objectKey)}" không có trong sổ đối tượng.` };
  const want = triggerObjectKey(rule.trigger);
  if (want && want !== def.key) return { matched: false, wouldDo: [], reason: `Luật này nói về ${(await resolveObject(want))?.label ?? want}, không phải ${def.label}.` };
  if (!(await recordExists(def, subject.recordId))) return { matched: false, wouldDo: [], reason: `${def.label} "${String(subject.recordId).slice(0, 80)}" không tồn tại.` };
  const ref: SubjectRef = { objectKey: def.key, recordId: subject.recordId };
  const rec = (await recordSubjectFields(ref)) ?? {};
  const payload: Record<string, unknown> =
    rule.trigger.kind === "custom_status" ? { objectKey: def.key, recordId: subject.recordId, fieldKey: rule.trigger.fieldKey, from: null, to: rec[`custom:${rule.trigger.fieldKey}`] ?? null } : {};
  const fields = { ...eventSubjectFields({ name: rule.trigger.kind === "event" ? rule.trigger.event : CUSTOM_STATUS_EVENT, subjectType: def.key, subjectId: subject.recordId, actorKind: "USER", payload }), ...rec };
  const matched = evaluateCondition(rule.conditions, fields);
  const label = await subjectLabel(ref, rec, `${def.label} ${subject.recordId}`);
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
    attempt: r.attempt,
    leaseUntil: r.leaseUntil,
    lastHeartbeatAt: r.lastHeartbeatAt,
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
