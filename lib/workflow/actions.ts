/**
 * ═══════════ HÀNH ĐỘNG CỦA LUẬT (Phase 3 · W4) — CHỈ MÁY CHỦ ═══════════
 *
 * Tập ĐÓNG ba hành động, mỗi hành động đi qua ĐÚNG đường ghi của miền sở hữu nó — không ghi thẳng bảng nào
 * mà miền khác giữ:
 *  · `create_task`      ⇒ `createWorkflowTask` (lib/work/service.ts): việc WORK nguồn `WORKFLOW_TASK`, lũy đẳng
 *                          theo `<id lượt chạy>:<vị trí>`, nhật ký nguồn `WORKFLOW`.
 *  · `notify`           ⇒ MỘT dòng `notifications` cho lượt chạy (kind `SYSTEM`, khoá `workflow:<id lượt>`) —
 *                          không một dòng mỗi bản ghi (luật 26). Kind `SYSTEM` vì job cảnh báo KHÔNG tự đóng loại
 *                          này (tin do luật gửi không có "điều kiện hết" để máy đóng hộ).
 *  · `set_custom_value` ⇒ `saveCustomValues` với người ghi là MÁY (id null) + `causationId` = id lượt chạy — vẫn
 *                          qua kiểm hợp lệ, chuyển trạng thái, khoá lạc quan.
 *  · `send_message`     ⇒ `deliverMessage` (lib/messaging/service.ts): MỘT tin tới nhóm chat qua kết nối nhắn tin
 *                          ĐANG BẬT của tổ chức, khoá chống trùng `workflow:<id lượt chạy>:<vị trí>` trong sổ
 *                          `messaging_deliveries` (dòng chèn TRƯỚC khi gọi nhà cung cấp — at-most-once).
 *
 * Lỗi ở một hành động ⇒ bước đó `FAILED`, các bước sau `SKIPPED`, lượt chạy `FAILED`. Hàm KHÔNG ném: một luật
 * hỏng không được làm sập job cảnh báo đang chở nó.
 *
 * PHỤC HỒI (Phase 3.1): tiến trình có thể chết GIỮA hai hành động. Nên (a) mỗi bước xong được ghi NGAY vào
 * `workflow_runs.steps` qua `onStep` (bộ máy ghi, có kiểm hạn giữ), (b) lượt thử lại nhận `previous` và BỎ QUA bước
 * đã `DONE`, và (c) mọi hành động phải khai trong `ACTION_RETRY_SAFETY` vì sao làm lại nó KHÔNG sinh bản sao —
 * vì bước có thể đã chạy xong mà chưa kịp ghi `DONE` (chết đúng giữa hai câu lệnh). Hành động khai
 * `retrySafe: false` thì bộ máy KHÔNG tự thử lại lượt treo chứa nó (FAILED, ghi rõ).
 */
import { getDb, schema } from "@/db";
import type { DepartmentCode } from "@/lib/constants/departments";
import { eq } from "drizzle-orm";
import { saveCustomValues } from "@/lib/metadata/values";
import { orderMessageVars } from "@/lib/messaging/order-message";
import { deliverMessage } from "@/lib/messaging/service";
import { isMessagingConnector, renderOrderTemplate, renderTemplate } from "@/lib/messaging/types";
import { createWorkflowTask } from "@/lib/work/service";
import { machineEmailOf } from "@/lib/workflow/rules";
import type { SubjectRef } from "@/lib/workflow/subject";
import type { WorkflowAction, WorkflowGate, WorkflowRule, WorkflowStep } from "@/lib/workflow/types";

export type ActionContext = {
  runId: string;
  rule: WorkflowRule;
  subject: SubjectRef | null;
  /** Nhãn ngắn của bản ghi / sự kiện đã kích hoạt — đi vào việc và thông báo. */
  label: string;
  now: Date;
};

export type ExecuteResult = { ok: boolean; steps: WorkflowStep[]; error: string | null; /** Mất hạn giữ giữa chừng — tiến trình khác đã chiếm lượt; KHÔNG được chốt kết quả. */ lostLease?: boolean };

/**
 * Làm lại hành động này có sinh bản sao không — khai TỪNG hành động của tập đóng, kèm căn cứ kiểm được (có bài
 * kiểm ở `tests/workflow-recovery.test.ts`). Thêm hành động mới mà không khai ⇒ lỗi kiểu (Record đủ khoá).
 */
export const ACTION_RETRY_SAFETY: Record<WorkflowAction["kind"], { retrySafe: boolean; why: string }> = {
  create_task: {
    retrySafe: true,
    why: "Khoá UNIQUE work_items(source_type, source_key) với source_key = <id lượt chạy>:<vị trí> + ON CONFLICT DO NOTHING — lượt làm lại gặp đúng dòng cũ, không tạo việc thứ hai.",
  },
  notify: {
    retrySafe: true,
    why: "notifications.dedupe_key UNIQUE = workflow:<id lượt chạy> + ON CONFLICT DO NOTHING; lưu luật chặn hai hành động notify trong một luật.",
  },
  set_custom_value: {
    retrySafe: true,
    why: "Ghi lại CÙNG giá trị ⇒ saveCustomValues thấy changed = [] ⇒ không tăng phiên bản, không nhật ký, không phát custom_status.changed lần hai.",
  },
  send_message: {
    retrySafe: true,
    why: "messaging_deliveries.dedupe_key UNIQUE = workflow:<id lượt chạy>:<vị trí>, dòng chèn TRƯỚC khi gọi nhà cung cấp: lượt làm lại gặp dòng SENT ⇒ không gửi; gặp PENDING (chết giữa lúc gọi) ⇒ UNKNOWN, KHÔNG gửi lại — thà thiếu một tin còn hơn hai tin.",
  },
};

/** Hành động CHƯA XONG (chưa `DONE` trong `previous`) nào không làm lại an toàn — `null` = làm lại được. Hàm THUẦN. */
export function retryBlocker(
  actions: readonly WorkflowAction[],
  previous: readonly WorkflowStep[],
  safety: Readonly<Record<string, { retrySafe: boolean }>> = ACTION_RETRY_SAFETY,
): WorkflowAction["kind"] | null {
  for (const [i, a] of actions.entries()) {
    if (previous[i]?.status === "DONE" && previous[i]?.action === a.kind) continue;
    if (!safety[a.kind]?.retrySafe) return a.kind;
  }
  return null;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Câu "SẼ làm gì" của một hành động — dùng cho chạy thử, lượt DRY_RUN và lượt đang chờ duyệt. */
export function describeAction(a: WorkflowAction, label: string): string {
  switch (a.kind) {
    case "create_task":
      return `Tạo việc "${a.title}"${a.departmentCode ? ` cho phòng ${a.departmentCode}` : ""}${a.dueInHours ? `, hạn ${a.dueInHours} giờ` : ""} — ${label}`;
    case "notify":
      return `Gửi MỘT thông báo trong ERP: "${a.message}" — ${label}`;
    case "set_custom_value":
      return `Ghi "${a.field}" = ${short(a.value)} — ${label}`;
    case "send_message":
      return `Gửi MỘT tin tới nhóm chat qua «${a.connectorKey}»${a.destination ? ` (nơi nhận ${a.destination})` : ""} — ${label}`;
  }
}

/** Sự kiện đã kích hoạt lượt chạy (tên + payload) — đọc theo `trigger_ref` của lượt. `null` khi lượt không do sự kiện. */
async function triggerEventOf(runId: string): Promise<{ name: string; payload: Record<string, unknown> } | null> {
  const db = await getDb();
  const [run] = await db.select({ ref: schema.workflowRuns.triggerRef }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1);
  if (!run?.ref) return null;
  const [ev] = await db.select({ name: schema.domainEvents.name, payload: schema.domainEvents.payload }).from(schema.domainEvents).where(eq(schema.domainEvents.id, run.ref)).limit(1);
  return ev ? { name: ev.name, payload: (ev.payload ?? {}) as Record<string, unknown> } : null;
}

/** Các bước DỰ KIẾN (PLANNED) của một luật — không ghi gì. */
export function planSteps(rule: Pick<WorkflowRule, "actions">, gate: WorkflowGate, label: string): WorkflowStep[] {
  return rule.actions.map((a) => ({ action: a.kind, status: "PLANNED" as const, detail: `${gate ? "Sau khi được duyệt: " : ""}${describeAction(a, label)}` }));
}

async function runOne(ctx: ActionContext, a: WorkflowAction, i: number): Promise<WorkflowStep> {
  const machine = machineEmailOf(ctx.rule.key);
  switch (a.kind) {
    case "create_task": {
      const r = await createWorkflowTask(
        {
          sourceKey: `${ctx.runId}:${i}`,
          title: a.title,
          summary: a.summary?.trim() || `Luật tự động "${ctx.rule.name}" · ${ctx.label}`,
          department: (a.departmentCode ?? null) as DepartmentCode | null,
          priority: a.priority ?? "NORMAL",
          dueAt: a.dueInHours ? new Date(ctx.now.getTime() + a.dueInHours * 3_600_000) : null,
          businessEntityId: ctx.subject ? `${ctx.subject.objectKey}:${ctx.subject.recordId}` : "",
        },
        { id: "", email: machine, name: `Luật ${ctx.rule.name}`, source: "WORKFLOW" },
      );
      if ("error" in r) return { action: a.kind, status: "FAILED", detail: r.error };
      return { action: a.kind, status: "DONE", detail: r.created ? `Đã tạo việc "${a.title}"` : `Việc "${a.title}" đã có từ lượt trước — không tạo thêm`, ref: r.key };
    }
    case "notify": {
      const db = await getDb();
      const dedupeKey = `workflow:${ctx.runId}`;
      await db
        .insert(schema.notifications)
        .values({
          kind: "SYSTEM",
          severity: "info",
          title: `Luật tự động · ${ctx.rule.name}`,
          body: `${a.message} — ${ctx.label}`,
          href: "/settings/workflows",
          entityType: "WORKFLOW_RUN",
          entityId: ctx.runId,
          dedupeKey,
          occurredAt: ctx.now,
        })
        .onConflictDoNothing({ target: schema.notifications.dedupeKey });
      return { action: a.kind, status: "DONE", detail: "Đã gửi một thông báo trong ERP", ref: dedupeKey };
    }
    case "set_custom_value": {
      if (!ctx.subject) return { action: a.kind, status: "FAILED", detail: "Lượt chạy không gắn với bản ghi nào — không ghi được giá trị." };
      const r = await saveCustomValues(ctx.subject.objectKey, ctx.subject.recordId, { [a.field]: a.value }, { kind: "MACHINE", id: null, email: machine }, { causationId: ctx.runId });
      if (!r.ok) return { action: a.kind, status: "FAILED", detail: r.errors.map((e) => e.message).join(" · ") || `Không ghi được (${r.code})` };
      return { action: a.kind, status: "DONE", detail: r.changed.length ? `Đã ghi "${a.field}" = ${short(a.value)}` : `"${a.field}" đã mang giá trị đó — không đổi gì`, ref: `${ctx.subject.objectKey}:${ctx.subject.recordId}` };
    }
    case "send_message": {
      if (!isMessagingConnector(a.connectorKey)) return { action: a.kind, status: "FAILED", detail: `«${a.connectorKey}» không phải kết nối nhắn tin theo tổ chức.` };
      const ev = await triggerEventOf(ctx.runId);
      const vars: Record<string, string> = { rule_name: ctx.rule.name, subject: ctx.label, event: ev?.name ?? "" };
      if (ctx.subject?.objectKey === "order") {
        const orderVars = await orderMessageVars(ctx.subject.recordId, ev);
        if (!orderVars) return { action: a.kind, status: "FAILED", detail: `Không đọc được đơn ${ctx.subject.recordId} để dựng tin.` };
        Object.assign(vars, orderVars);
      }
      const dedupeKey = `workflow:${ctx.runId}:${i}`;
      const r = await deliverMessage({
        connectorKey: a.connectorKey,
        destination: a.destination?.trim() || null,
        // Tin đơn hàng bỏ phần trống («Chiết khấu: 0 ₫», «Ghi chú: —») — `renderOrderTemplate`.
        body: ctx.subject?.objectKey === "order" ? renderOrderTemplate(a.template, vars) : renderTemplate(a.template, vars),
        dedupeKey,
        event: ev?.name ?? null,
        subject: ctx.subject ? { type: ctx.subject.objectKey, id: ctx.subject.recordId } : null,
        runId: ctx.runId,
        createdBy: machine,
      });
      if (r.status === "FAILED") return { action: a.kind, status: "FAILED", detail: `Không gửi được tin: ${r.error}`, ref: dedupeKey };
      if (r.status === "UNKNOWN") return { action: a.kind, status: "FAILED", detail: "Lượt trước dừng giữa lúc gửi — không biết tin đã tới chưa, KHÔNG gửi lại để tránh trùng. Xem sổ gửi tin.", ref: dedupeKey };
      return { action: a.kind, status: "DONE", detail: r.status === "DUPLICATE" ? "Tin đã gửi ở lượt trước — không gửi lại" : `Đã gửi tin${r.destination ? ` tới ${r.destination}` : ""}`, ref: dedupeKey };
    }
  }
}

export type ExecuteOptions = {
  /** Các bước đã ghi của lượt chạy (lượt thử lại): bước `DONE` cùng loại hành động ở cùng vị trí thì BỎ QUA. */
  previous?: readonly WorkflowStep[];
  /**
   * Ghi bước vừa xong NGAY (bộ máy ghi `steps` + gia hạn hạn giữ). Trả `false` ⇒ đã mất hạn giữ (tiến trình khác
   * chiếm lượt) ⇒ dừng, không làm bước sau. Lỗi ném ra từ đây là lỗi HẠ TẦNG và đi thẳng lên nơi gọi.
   */
  onStep?: (steps: WorkflowStep[], index: number) => Promise<boolean>;
};

/**
 * Thực thi tuần tự mọi hành động của luật. Lỗi của MỘT hành động không bao giờ ném (bước `FAILED`); chỉ lỗi của
 * `onStep` (ghi sổ lượt chạy) đi lên.
 */
export async function executeActions(ctx: ActionContext, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const previous = opts.previous ?? [];
  const steps: WorkflowStep[] = [];
  let error: string | null = null;
  // Bảng đầy đủ để ghi: bước đã làm + phần CHƯA làm giữ nguyên như đã lập kế hoạch (người xem vẫn thấy việc còn lại).
  const snapshot = (upTo: number) => [...steps, ...ctx.rule.actions.slice(upTo + 1).map((a, j) => previous[upTo + 1 + j] ?? { action: a.kind, status: "PLANNED" as const, detail: "" })];
  for (const [i, a] of ctx.rule.actions.entries()) {
    const done = previous[i];
    if (done?.status === "DONE" && done.action === a.kind) {
      steps.push(done);
      continue;
    }
    if (error) {
      steps.push({ action: a.kind, status: "SKIPPED", detail: "Bỏ qua vì bước trước hỏng" });
      continue;
    }
    let step: WorkflowStep;
    try {
      step = await runOne(ctx, a, i);
    } catch (e) {
      step = { action: a.kind, status: "FAILED", detail: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500) };
    }
    steps.push(step);
    if (step.status === "FAILED") error = `Bước ${i + 1} (${a.kind}) hỏng: ${step.detail}`;
    if (opts.onStep && !(await opts.onStep(snapshot(i), i))) return { ok: false, steps: snapshot(i), error: "Mất hạn giữ — tiến trình khác đã chiếm lượt chạy.", lostLease: true };
  }
  return { ok: error === null, steps, error };
}
