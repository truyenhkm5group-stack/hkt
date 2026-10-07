import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiSpendAlert } from "@/lib/constants/tech-policy";
import { workerLiveness } from "@/lib/constants/tech-worker";
import { apiSpend, effectiveBudget } from "@/lib/tech/budget";
import { recordTechEvent } from "@/lib/tech/control-plane";
import type { TechActor } from "@/lib/tech/service";
import { reapExpiredTechLeases } from "@/lib/tech/worker-service";

/**
 * ═══════════ WATCHDOG CỦA MẶT PHẲNG ĐIỀU KHIỂN (Pha 4) ═══════════
 *
 * docs/tech-control-plane/README.md mục 11. Không gọi model, không thêm lịch: một bước của `task-advance-watch`
 * (15′). Mọi phát hiện là một SỰ KIỆN có khoá chống trùng — một worker mất liên lạc là MỘT dòng cho mỗi lần mất,
 * không phải một dòng mỗi 15 phút.
 *
 *  · Lease hết hạn ⇒ thu hồi, việc về hàng đợi (đếm lần thử, lùi dần; hết lần ⇒ FAILED) — `reapExpiredTechLeases`.
 *  · Worker MẤT nhịp tim khi còn giữ lượt chạy ⇒ `worker.lost` (việc của nó được thả ở bước trên khi lease hết hạn).
 *  · Chi API ≥ 80% trần ngày ⇒ `budget.warning`; chạm trần ⇒ `budget.exceeded` (worker API tự dừng ở lượt nhận việc).
 * Vòng thử lại vô hạn không tồn tại: trần `max_attempts` + trần sửa CI + trần tiền đều là luật cứng ở chỗ khác.
 */

const MAY: TechActor = { kind: "SYSTEM", name: "job:tech-watchdog" };

export async function runTechWatchdog(now = new Date()) {
  const db = await getDb();
  const out = { reaped: 0, lostWorkers: 0, apiAlert: null as string | null };
  out.reaped = (await reapExpiredTechLeases(now)).reaped;

  const dangChay = await db
    .select({ workerId: schema.techAgentRuns.workerId, runId: schema.techAgentRuns.id, taskId: schema.techAgentRuns.taskId })
    .from(schema.techAgentRuns)
    .where(and(isNotNull(schema.techAgentRuns.workerId), eq(schema.techAgentRuns.status, "RUNNING")));
  const ids = [...new Set(dangChay.map((r) => r.workerId!))];
  for (const id of ids) {
    const w = await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, id), columns: { id: true, key: true, lastHeartbeatAt: true } });
    if (!w || workerLiveness(w.lastHeartbeatAt, now) !== "LOST") continue;
    const runs = dangChay.filter((r) => r.workerId === id);
    const moi = await recordTechEvent(
      db,
      { name: "worker.lost", subjectType: "WORKER", subjectId: w.id, payload: { key: w.key, lastHeartbeatAt: w.lastHeartbeatAt?.toISOString() ?? null, runs: runs.map((r) => r.runId) }, dedupeKey: `lost:${w.id}:${w.lastHeartbeatAt?.toISOString() ?? "never"}` },
      MAY,
    );
    if (moi) out.lostWorkers += 1;
  }

  const ngan = await effectiveBudget(null);
  const chi = await apiSpend({ now });
  const muc = apiSpendAlert(ngan, chi.todayUsd);
  out.apiAlert = muc;
  if (muc === "WARN" || muc === "EXCEEDED") {
    const ngay = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    await recordTechEvent(
      db,
      { name: muc === "WARN" ? "budget.warning" : "budget.exceeded", subjectType: "BUDGET", subjectId: "COMPANY:", payload: { todayUsd: chi.todayUsd, capUsd: ngan.apiUsdDaily }, dedupeKey: `api:${muc}:${ngay}` },
      MAY,
    );
  }
  return out;
}
