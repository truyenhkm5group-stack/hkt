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
 *
 * Lỗi ở một hành động ⇒ bước đó `FAILED`, các bước sau `SKIPPED`, lượt chạy `FAILED`. Hàm KHÔNG ném: một luật
 * hỏng không được làm sập job cảnh báo đang chở nó.
 */
import { getDb, schema } from "@/db";
import type { DepartmentCode } from "@/lib/constants/departments";
import { saveCustomValues } from "@/lib/metadata/values";
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

export type ExecuteResult = { ok: boolean; steps: WorkflowStep[]; error: string | null };

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
  }
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
  }
}

/** Thực thi tuần tự mọi hành động của luật. Không bao giờ ném. */
export async function executeActions(ctx: ActionContext): Promise<ExecuteResult> {
  const steps: WorkflowStep[] = [];
  let error: string | null = null;
  for (const [i, a] of ctx.rule.actions.entries()) {
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
  }
  return { ok: error === null, steps, error };
}
