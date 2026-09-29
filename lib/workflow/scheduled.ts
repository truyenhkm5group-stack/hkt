/**
 * ═══════════ JOB `workflows` — LUẬT TỰ ĐỘNG CỦA TỔ CHỨC KHÁCH TỰ CHẠY (G-SCHED) — CHỈ MÁY CHỦ ═══════════
 *
 * Trước bản này luật của tổ chức khách chỉ chạy khi có người bấm «Chạy lượt kiểm tra ngay»: bộ máy chạy ké job
 * `alerts`, mà `alerts` không có trong fan-out (nó gửi Lark/Telegram — kênh là credential của nhà). Chủ nền tảng
 * duyệt 29/09/2026: automation của khách chạy mỗi 10 phút mặc định, cô lập theo tổ chức, có giới hạn; lịch VNX
 * giữ nguyên. Nên luật của khách TÁCH khỏi `alerts` thành job này, và bộ lập lịch gọi nó cho TỪNG tổ chức khách
 * (`scripts/scheduler-fanout.mjs` · `AUTOMATION_FANOUT_JOBS`).
 *
 * `runJob` đã bọc `withOrganization(mã)` và đã bỏ qua tổ chức không ACTIVE (`ORG_INACTIVE`) trước khi tới đây. Hàm
 * này hỏi thêm, theo thứ tự, TRƯỚC mọi lượt ghi — bỏ qua thì KHÔNG ghi `sync_runs` (không rác mỗi 5 phút):
 *  1. Tổ chức NHÀ ⇒ bỏ qua: luật của nhà chạy ké `alerts` như cũ, chạy thêm ở đây là hai đường cho một việc.
 *  2. Công tắc khẩn `workflows.paused` ⇒ bỏ qua (bộ máy cũng tự hỏi, nhưng hỏi ở đây thì không mở dòng `sync_runs`).
 *  3. Chưa tới kỳ (nhịp theo gói, `lib/constants/workflow-cadence.ts`) ⇒ bỏ qua. Người bấm tay (MANUAL) không bị chặn bởi nhịp.
 * Rồi chạy MỘT lượt `runWorkflows({ deadline })` trong `runSyncJob` (dòng `sync_runs`, khoá một-lượt-một-tổ-chức,
 * đồng hồ canh) với trần thời gian `WORKFLOW_ORG_TIME_BUDGET_MS`; trần sự kiện / hành động là của bộ máy.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DEFAULT_PLAN_KEY, listPlans, planKeyOf } from "@/lib/entitlements/check";
import { currentOrganization } from "@/lib/platform/context";
import { workflowsPaused } from "@/lib/platform/org-flags";
import { findOrganization } from "@/lib/platform/organizations";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { alertsCarriesWorkflows, parseWorkflowCadence, WORKFLOW_CADENCE_DEFAULT_MINUTES, WORKFLOW_ORG_TIME_BUDGET_MS, workflowRunDue, type WorkflowCadence } from "@/lib/constants/workflow-cadence";
import { runWorkflows } from "@/lib/workflow/engine";

/** Tên job trong `sync_runs` (nguồn `ERP`) — cũng là slug của `/api/sync/<job>`. */
export const WORKFLOWS_JOB = "workflows";

export type WorkflowJobSkipped =
  | { skipped: "HOME_USES_ALERTS"; job: typeof WORKFLOWS_JOB; org: string; detail: string }
  | { skipped: "WORKFLOWS_PAUSED"; job: typeof WORKFLOWS_JOB; org: string; since: string; detail: string }
  | { skipped: "NOT_DUE"; job: typeof WORKFLOWS_JOB; org: string; cadenceMinutes: number; detail: string };

/** Nhịp của tổ chức `orgCode`: gói của nó (thiếu / lạ ⇒ `trial`, như hạn mức), không đọc được dòng gói ⇒ mặc định. */
export async function workflowCadenceOf(orgCode: string): Promise<WorkflowCadence> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { minutes: WORKFLOW_CADENCE_DEFAULT_MINUTES, source: "DEFAULT" };
  const plans = await listPlans();
  const row = plans.find((p) => p.key === planKeyOf(org)) ?? plans.find((p) => p.key === DEFAULT_PLAN_KEY);
  return parseWorkflowCadence(row?.limits);
}

/** Mốc bắt đầu lượt `workflows` gần nhất của tổ chức hiện hành (CSDL của nó) — mọi trạng thái đều tính. */
async function lastStartedAt(): Promise<number | null> {
  const db = await getDb();
  const r = schema.syncRuns;
  const [row] = await db
    .select({ at: r.startedAt })
    .from(r)
    .where(and(eq(r.source, "ERP"), eq(r.job, WORKFLOWS_JOB)))
    .orderBy(desc(r.startedAt))
    .limit(1);
  return row ? row.at.getTime() : null;
}

export async function runScheduledWorkflows(o: { trigger: SyncTrigger; actor: string; now?: number }) {
  const org = await currentOrganization();
  if (alertsCarriesWorkflows(org)) {
    const skipped: WorkflowJobSkipped = { skipped: "HOME_USES_ALERTS", job: WORKFLOWS_JOB, org: org.code, detail: "Bỏ qua: luật của tổ chức nhà chạy ké job cảnh báo (lịch VNX giữ nguyên) — không chạy thêm đường thứ hai." };
    return skipped;
  }
  const pause = await workflowsPaused(org.code);
  if (pause) {
    const skipped: WorkflowJobSkipped = { skipped: "WORKFLOWS_PAUSED", job: WORKFLOWS_JOB, org: org.code, since: pause.updatedAt.toISOString(), detail: "Bỏ qua: người vận hành nền tảng đang tạm dừng luật tự động của tổ chức này (công tắc khẩn)." };
    return skipped;
  }
  const cadence = await workflowCadenceOf(org.code);
  const now = o.now ?? Date.now();
  if (o.trigger !== "MANUAL" && !workflowRunDue({ now, lastStartedAt: await lastStartedAt(), cadenceMinutes: cadence.minutes })) {
    const skipped: WorkflowJobSkipped = { skipped: "NOT_DUE", job: WORKFLOWS_JOB, org: org.code, cadenceMinutes: cadence.minutes, detail: `Chưa tới kỳ: nhịp ${cadence.minutes} phút / lượt.` };
    return skipped;
  }
  return runSyncJob({ source: "ERP", job: WORKFLOWS_JOB, trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const r = await runWorkflows({ deadline: Date.now() + WORKFLOW_ORG_TIME_BUDGET_MS });
    ctx.summary.imported = r.runs;
    ctx.summary.updated = r.executed;
    ctx.summary.failed = r.failed;
    const nhip = `nhịp ${cadence.minutes} phút (${cadence.source === "PLAN" ? "theo gói" : "mặc định"})`;
    // Nhịp sai trong dòng gói là LỖI CẤU HÌNH ⇒ PARTIAL để người vận hành thấy. Hết trần thời gian thì không: đó là
    // việc dồn, lượt sau làm tiếp — ghi vào detail.
    if (cadence.rejected) ctx.summary.warning = `nhịp trong gói ${cadence.rejected.value} ${cadence.rejected.reason} — dùng ${cadence.minutes} phút`;
    const tran = r.timeBudgetHit ? ` · hết trần ${WORKFLOW_ORG_TIME_BUDGET_MS / 1000} giây, phần còn lại để lượt sau` : "";
    ctx.summary.detail = r.paused
      ? `tạm dừng bởi người vận hành · ${nhip}`
      : `${r.events} sự kiện · ${r.runs} lượt chạy · ${r.executed} đã làm · ${r.waiting} chờ duyệt · ${r.failed} lỗi · ${r.recovered} phục hồi · ${nhip}${tran}`;
    return r;
  });
}
