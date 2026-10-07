import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TECH_GATE_RESULTS, isTechOwnerEscalation, type TechGateResult, type TechOwnerEscalation, type TechTaskStatus } from "@/lib/constants/tech";
import { CAPABILITY_BY_TASK_TYPE, TECH_AUTONOMOUS_CAPABILITIES, isTechCapability, taskCapability } from "@/lib/constants/tech-capabilities";
import {
  TECH_AUTONOMOUS_RISKS,
  TECH_LEASE,
  TECH_QUEUE_PROVIDERS,
  backoffMinutes,
  decideCompletion,
  leaseExpiry,
  taskBranchName,
  WORKER_BRANCH_PATTERN,
  forbiddenTouched,
  WORKER_POLICY_CEILING_SETTING,
  workerPolicyCeiling,
  claimablePolicyLevels,
  type TechExecutionProvider,
  type TechRunOutcome,
} from "@/lib/constants/tech-worker";
import { rowsOf } from "@/lib/sql-rows";
import { BUDGET_DEFAULTS, apiSpendAllowed } from "@/lib/constants/tech-policy";
import { MODEL_ROUTING_SETTING, modelForCapability } from "@/lib/constants/tech-routing";
import { getSettingJson } from "@/lib/settings";
import { apiSpend, effectiveBudget, runningWorkerRuns } from "@/lib/tech/budget";
import { recordTechEvent } from "@/lib/tech/control-plane";
import { requestWorkerPullRequest } from "@/lib/tech/delivery";
import { recordTechTaskEvent, setTechTaskStatus, type TechActor, type TechResult } from "@/lib/tech/service";

/**
 * ═══════════ HÀNG ĐỢI WORKER — POSTGRESQL LÀ NGUỒN SỰ THẬT VÀ LÀ HÀNG ĐỢI ═══════════
 *
 * Kiến trúc: docs/tech-control-plane/README.md mục 4. Không Redis, không Kafka: vài chục việc mỗi ngày, một
 * bảng có chỉ mục + `FOR UPDATE SKIP LOCKED` là đủ, và kiểm thử được bằng PGlite.
 *
 *  · NHẬN VIỆC: một câu `UPDATE … FROM (SELECT … FOR UPDATE OF t SKIP LOCKED LIMIT 1)` — hai worker hỏi cùng
 *    lúc không bao giờ nhận cùng một việc.
 *  · LEASE có FENCING TOKEN (`lease_generation`, tăng mỗi lần nhận): worker chết ⇒ lease hết hạn ⇒ thu hồi ⇒
 *    việc về hàng đợi (đếm `attempts`, lùi dần). Worker cũ sống lại gửi kết quả với generation cũ ⇒ bị từ chối.
 *  · THU HỒI LƯỜI: mỗi lượt nhận việc thu hồi lease hết hạn TRƯỚC — không cần thêm lịch chạy (đổi lịch là việc
 *    phải hỏi chủ shop, AGENTS.md mục 7). Không worker nào hỏi thì cũng không ai cần việc được thả ra.
 *  · Câu chữ của model KHÔNG BAO GIỜ đổi trạng thái: worker báo một kết cục trong danh sách đóng, máy quyết
 *    (`decideCompletion`) và đi qua CÙNG đường ghi `setTechTaskStatus` của người.
 */

type Db = Awaited<ReturnType<typeof getDb>>;

export type TechWorkerRow = typeof schema.techWorkers.$inferSelect;

/** Danh tính trên nhật ký việc: một worker là MÁY làm theo luật (SYSTEM), không phải người, không phải agent tự quyết. */
export function workerActor(w: { key: string }): TechActor {
  return { kind: "SYSTEM", name: `worker:${w.key}` };
}

/* ═════════════════════ ĐĂNG KÝ & XÁC THỰC ═════════════════════ */

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TOKEN_PREFIX = "tw_";

export type RegisterTechWorkerInput = {
  key: string;
  name: string;
  host?: string;
  provider: TechExecutionProvider;
  capabilities: string[];
  maxConcurrency?: number;
};

/**
 * Chỉ NGƯỜI đăng ký worker. Khoá bí mật in ra ĐÚNG MỘT LẦN; CSDL chỉ giữ băm. Năng lực khai phải là năng lực
 * tự động được (`autonomous`) — khai `deploy-production` cho worker là tự cấp quyền deploy.
 */
export async function registerTechWorker(input: RegisterTechWorkerInput, actor: TechActor): Promise<TechResult<{ id: string; token: string }>> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ NGƯỜI đăng ký được worker." };
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(key)) return { error: "Mã worker: chữ thường, số, gạch nối, 3–40 ký tự." };
  if (!TECH_QUEUE_PROVIDERS.includes(input.provider)) return { error: "Worker chỉ chạy được Claude Code (gói thuê bao) hoặc Anthropic API." };
  const caps = [...new Set(input.capabilities)];
  if (!caps.length) return { error: "Khai ít nhất một năng lực." };
  const sai = caps.filter((c) => !isTechCapability(c) || !TECH_AUTONOMOUS_CAPABILITIES.includes(c));
  if (sai.length) return { error: `Năng lực không giao được cho worker tự động: ${sai.join(", ")}.` };
  const maxConcurrency = Math.min(TECH_LEASE.maxConcurrencyCeiling, Math.max(1, Math.trunc(input.maxConcurrency ?? 1)));
  const secret = randomBytes(24).toString("base64url");
  const db = await getDb();
  try {
    const [row] = await db
      .insert(schema.techWorkers)
      .values({
        key,
        name: input.name.trim() || key,
        host: input.host?.trim() ?? "",
        provider: input.provider,
        capabilities: caps,
        maxConcurrency,
        secretHash: sha256(secret),
        createdById: actor.id ?? null,
      })
      .returning({ id: schema.techWorkers.id });
    await recordTechEvent(db, { name: "worker.registered", subjectType: "WORKER", subjectId: row.id, payload: { key, provider: input.provider, capabilities: caps } }, actor);
    return { ok: true, id: row.id, token: `${TOKEN_PREFIX}${row.id}.${secret}` };
  } catch (e) {
    if (String(e).includes("tech_workers_key_uq")) return { error: "Mã worker đã tồn tại." };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Bật / tắt worker. Tắt ⇒ worker không nhận việc mới; lượt đang chạy nhận lệnh DỪNG ở nhịp tim kế tiếp. */
export async function setTechWorkerEnabled(input: { workerId: string; enabled: boolean; reason?: string }, actor: TechActor): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ NGƯỜI bật / tắt được worker." };
  const db = await getDb();
  const [row] = await db
    .update(schema.techWorkers)
    .set({ enabled: input.enabled, disabledReason: input.enabled ? "" : (input.reason?.trim() ?? "") })
    .where(eq(schema.techWorkers.id, input.workerId))
    .returning({ id: schema.techWorkers.id });
  if (!row) return { error: "Không tìm thấy worker." };
  // Tắt ⇒ bộ cài đang chờ (mã ghi danh còn hạn) cũng chết: đổi mã sẽ BẬT lại worker, nên để mã sống là để tắt vô nghĩa.
  if (!input.enabled) {
    await db
      .update(schema.techWorkerEnrollments)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.techWorkerEnrollments.workerId, row.id), sql`${schema.techWorkerEnrollments.usedAt} IS NULL AND ${schema.techWorkerEnrollments.revokedAt} IS NULL`));
  }
  await recordTechEvent(db, { name: input.enabled ? "worker.enabled" : "worker.disabled", subjectType: "WORKER", subjectId: row.id, payload: { reason: input.reason ?? "" } }, actor);
  return { ok: true };
}

/** `Authorization: Bearer tw_<id>.<secret>` ⇒ worker còn bật, hoặc `null`. So bằng băm, thời gian hằng. */
export async function authenticateTechWorker(header: string | null | undefined): Promise<TechWorkerRow | null> {
  const m = /^Bearer\s+tw_([A-Za-z0-9-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(header?.trim() ?? "");
  if (!m) return null;
  const db = await getDb();
  const w = await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, m[1]) });
  // Khoá đã thu hồi (lộ / tạo lại token / gỡ worker) ⇒ không khoá nào hợp lệ, kể cả khi băm tình cờ khớp (mục 15).
  if (!w || w.secretRevokedAt || w.removedAt) return null;
  const a = Buffer.from(sha256(m[2]), "hex");
  const b = Buffer.from(w.secretHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return w;
}

/* ═════════════════════ TRẦN LẦN THỬ HIỆU LỰC ═════════════════════ */

/**
 * Trần lần thử của MỘT việc = nhỏ nhất của cột việc và ngân sách hiệu lực (sứ mệnh → mục tiêu → dự án → công ty).
 * Dùng CÙNG một hàm ở nhận việc, kết thúc lượt và thu hồi (review 07/10, mục 9: trước đây ba chỗ ba trần ⇒ việc kẹt
 * SPEC_READY mãi, không bao giờ FAILED).
 */
export async function effectiveMaxAttempts(task: { maxAttempts: number; missionId?: string | null; id?: string }): Promise<number> {
  let missionId = task.missionId;
  if (missionId === undefined && task.id) {
    const db = await getDb();
    missionId = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, task.id), columns: { missionId: true } }))?.missionId ?? null;
  }
  const b = await effectiveBudget(missionId ?? null);
  return Math.min(task.maxAttempts, b.maxAttempts ?? Number.POSITIVE_INFINITY);
}

/* ═════════════════════ THU HỒI LEASE HẾT HẠN ═════════════════════ */

/**
 * Mọi việc có lease đã hết hạn: đóng lượt chạy đang mở của generation đó (FAILED, "mất nhịp tim"), nhả lease,
 * và đưa việc về hàng đợi nếu còn lần thử (lùi dần) — hết lần thì `FAILED`. Gọi nhiều lần không sao: lượt sau
 * không còn gì để thu.
 */
export async function reapExpiredTechLeases(now = new Date()): Promise<{ reaped: number }> {
  const db = await getDb();
  const t = schema.techTasks;
  const expired = await db
    .select({ id: t.id, code: t.code, status: t.status, attempts: t.attempts, maxAttempts: t.maxAttempts, leaseWorkerId: t.leaseWorkerId, leaseGeneration: t.leaseGeneration })
    .from(t)
    .where(sql`${t.leaseWorkerId} IS NOT NULL AND ${t.leaseExpiresAt} <= ${now}`);
  const may: TechActor = { kind: "SYSTEM", name: "job:tech-lease-reaper" };
  let reaped = 0;
  for (const row of expired) {
    /*
      Nhả lease + đóng lượt chạy trong MỘT giao dịch, có điều kiện generation đã đọc (worker vừa gia hạn kịp thì
      thôi). Nhả lease TĂNG generation (review 07/10, mục 7): mọi lời gọi về sau của worker cũ — kể cả một `complete`
      chen giữa — trượt fencing thay vì ghi đè lượt đã đóng.
    */
    const released = await db.transaction(async (tx) => {
      const r = await tx
        .update(t)
        .set({ leaseWorkerId: null, leaseExpiresAt: null, leaseGeneration: sql`${t.leaseGeneration} + 1` })
        .where(and(eq(t.id, row.id), eq(t.leaseGeneration, row.leaseGeneration), sql`${t.leaseExpiresAt} <= ${now}`))
        .returning({ id: t.id });
      if (!r.length) return false;
      await tx
        .update(schema.techAgentRuns)
        .set({ status: "FAILED", endedAt: now, error: "Lease hết hạn — worker mất nhịp tim; việc đã được thả về hàng đợi." })
        .where(and(eq(schema.techAgentRuns.taskId, row.id), eq(schema.techAgentRuns.leaseGeneration, row.leaseGeneration), eq(schema.techAgentRuns.status, "RUNNING")));
      return true;
    });
    if (!released) continue;
    reaped += 1;
    const conLan = row.attempts < (await effectiveMaxAttempts(row));
    if (row.status === "BUILDING" || row.status === "SPEC_READY") {
      if (conLan) {
        if (row.status === "BUILDING") await setTechTaskStatus({ taskId: row.id, to: "SPEC_READY", note: "Lease hết hạn — trả về hàng đợi" }, may);
        await db.update(t).set({ nextAttemptAt: new Date(now.getTime() + backoffMinutes(row.attempts) * 60_000) }).where(eq(t.id, row.id));
      } else {
        if (row.status === "SPEC_READY") await setTechTaskStatus({ taskId: row.id, to: "BUILDING", note: "Lease hết hạn ở lần thử cuối" }, may);
        await setTechTaskStatus({ taskId: row.id, to: "FAILED", note: `Hết lần thử — lần cuối mất nhịp tim` }, may);
      }
    }
    await db.update(t).set({ lastError: "Lease hết hạn — worker mất nhịp tim" }).where(eq(t.id, row.id));
    await recordTechEvent(
      db,
      { name: "run.lease_expired", subjectType: "TASK", subjectId: row.id, taskId: row.id, payload: { taskCode: row.code, workerId: row.leaseWorkerId, leaseGeneration: row.leaseGeneration, requeued: conLan } },
      may,
    );
  }
  return { reaped };
}

/* ═════════════════════ NHẬN VIỆC ═════════════════════ */

/**
 * CASE SQL dựng TỪ bảng hằng — không gõ lại danh sách lần thứ hai. Viết theo bí danh `c` của câu con nhận việc
 * (cột của bảng ngoài sẽ thành tham chiếu tương quan — sai lặng lẽ).
 */
function capabilitySql() {
  const nhanh = Object.entries(CAPABILITY_BY_TASK_TYPE).map(([type, cap]) => sql`WHEN ${type} THEN ${cap}`);
  return sql`(CASE WHEN c.capability <> '' THEN c.capability ELSE (CASE c.task_type ${sql.join(nhanh, sql` `)} ELSE 'implement-feature' END) END)`;
}

export type ClaimedTask = {
  runId: string;
  taskId: string;
  code: string;
  title: string;
  description: string;
  taskType: string;
  module: string;
  risk: string;
  capability: string;
  attempt: number;
  maxAttempts: number;
  leaseGeneration: number;
  leaseExpiresAt: string;
  branch: string;
  /**
   * `true` ⇒ làm TRÊN nhánh đã có (việc sửa CI đỏ: nhánh của PR đang mở) — worker checkout `origin/<branch>` và đẩy
   * tiếp lên chính nhánh đó (PR tự cập nhật). `false` ⇒ nhánh mới tất định theo mã việc + lần thử.
   */
  existingBranch: boolean;
  /** Trần thời gian một lượt (ngân sách `maxRunMinutes`, mặc định 45′) — worker dừng agent khi quá. */
  timeoutMinutes: number;
  /** Model do máy chủ định tuyến theo năng lực (`modelForCapability`) — hạng + bí danh / mã. */
  modelTier: string;
  model: string;
  mission: { code: string; title: string; definitionOfDone: string } | null;
};

/**
 * Worker xin MỘT việc. Trả `null` kèm lý do khi không có gì: worker tắt · đầy chỗ · hàng rỗng. Không bao giờ ném
 * lỗi vì "không có việc" — đó là trạng thái bình thường của một hàng đợi.
 */
export async function claimNextTechTask(worker: TechWorkerRow, now = new Date()): Promise<{ task: ClaimedTask | null; reason?: string }> {
  if (!worker.enabled) return { task: null, reason: "WORKER_DISABLED" };
  await reapExpiredTechLeases(now);
  const db = await getDb();
  const [dang] = await db
    .select({ n: count() })
    .from(schema.techAgentRuns)
    .where(and(eq(schema.techAgentRuns.workerId, worker.id), eq(schema.techAgentRuns.status, "RUNNING")));
  if ((dang?.n ?? 0) >= worker.maxConcurrency) return { task: null, reason: "AT_CAPACITY" };

  const caps = (worker.capabilities as string[]).filter((c) => TECH_AUTONOMOUS_CAPABILITIES.includes(c as never));
  if (!caps.length) return { task: null, reason: "NO_CAPABILITY" };

  /* ───── NGÂN SÁCH TẦNG CÔNG TY (lib/tech/budget.ts) — kiểm TRƯỚC khi giữ việc ───── */
  const cty = await effectiveBudget(null);
  if ((await runningWorkerRuns()) >= (cty.maxConcurrentRuns ?? BUDGET_DEFAULTS.maxConcurrentRuns)) return { task: null, reason: "COMPANY_AT_CAPACITY" };
  if (worker.provider === "ANTHROPIC_API") {
    // Worker trả tiền API: CHƯA KHAI trần ngày ⇒ không chạy; vượt trần ⇒ không chạy. Không bao giờ rơi sang gói khác.
    const chiCty = await apiSpend({ now });
    const ok = apiSpendAllowed(cty, chiCty.todayUsd, chiCty.totalUsd);
    if (!ok.ok) return { task: null, reason: `API_BUDGET_${ok.reason}` };
  }
  const tranLan = cty.maxAttempts ?? 10;
  const expires = leaseExpiry(now);
  const t = schema.techTasks;
  const capSql = capabilitySql();
  const risks = sql.join(TECH_AUTONOMOUS_RISKS.map((r) => sql`${r}`), sql`, `);
  const capList = sql.join(caps.map((c) => sql`${c}`), sql`, `);
  // Trần chính sách (mặc định R0 — chế độ dogfood an toàn); cùng hàm `claimBlockers` dùng.
  const tranChinhSach = workerPolicyCeiling(await getSettingJson<Record<string, unknown>>(WORKER_POLICY_CEILING_SETTING, {}));
  const policyList = sql.join(claimablePolicyLevels(tranChinhSach).map((p) => sql`${p}`), sql`, `);

  const result = await db.execute(sql`
    UPDATE tech_tasks SET
      lease_worker_id = ${worker.id},
      lease_expires_at = ${expires},
      lease_generation = lease_generation + 1,
      attempts = attempts + 1,
      next_attempt_at = NULL,
      updated_at = ${now}
    WHERE id = (
      SELECT c.id FROM tech_tasks c
      LEFT JOIN tech_missions m ON m.id = c.mission_id
      LEFT JOIN tech_goals g ON g.id = m.goal_id
      WHERE c.status = 'SPEC_READY'
        AND c.risk IN (${risks})
        AND c.policy_level IN (${policyList})
        AND c.approval_status NOT IN ('PENDING', 'REJECTED')
        AND (c.mission_id IS NULL OR m.status = 'ACTIVE')
        AND (m.goal_id IS NULL OR g.status = 'ACTIVE')
        AND (c.lease_worker_id IS NULL OR c.lease_expires_at <= ${now})
        AND c.attempts < LEAST(c.max_attempts, coalesce(
          (select b.max_attempts from tech_budgets b where b.scope_kind = 'MISSION' and b.scope_id = c.mission_id and b.max_attempts is not null),
          (select b.max_attempts from tech_budgets b where b.scope_kind = 'GOAL' and b.scope_id = m.goal_id and b.max_attempts is not null),
          (select b.max_attempts from tech_budgets b where b.scope_kind = 'PROJECT' and b.scope_id = m.project_id and b.max_attempts is not null),
          ${tranLan}
        ))
        AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ${now})
        AND ${capSql} IN (${capList})
        AND NOT EXISTS (
          SELECT 1 FROM tech_task_events ev
          WHERE ev.task_id = c.id AND ev.kind = 'RUN' AND ev.payload->>'workflow' = 'agent-run.yml' AND ev.created_at > ${new Date(now.getTime() - 90 * 60_000)}
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.depends_on) d(dep_id)
          LEFT JOIN tech_tasks dt ON dt.id = d.dep_id
          WHERE dt.status IS DISTINCT FROM 'DONE'
        )
      ORDER BY CASE c.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, c.created_at
      LIMIT 1
      FOR UPDATE OF c SKIP LOCKED
    )
    RETURNING id
  `);
  const claimed = rowsOf<{ id: string }>(result)[0];
  if (!claimed) return { task: null, reason: "QUEUE_EMPTY" };

  const task = await db.query.techTasks.findFirst({
    where: eq(t.id, claimed.id),
    with: { mission: { columns: { code: true, title: true, definitionOfDone: true } } },
  });
  if (!task) return { task: null, reason: "QUEUE_EMPTY" };
  const ngan = await effectiveBudget(task.missionId);
  /*
    Trần tiền API của SỨ MỆNH (và mục tiêu / dự án) chỉ biết được khi đã biết việc ⇒ kiểm SAU khi giữ, và vượt thì
    THẢ NGAY lease vừa giữ (lần thử không bị tính — `attempts` trả lại), việc nằm nguyên hàng đợi.
  */
  if (worker.provider === "ANTHROPIC_API") {
    const chi = await apiSpend({ missionId: task.missionId, now });
    const ok = apiSpendAllowed(ngan, chi.todayUsd, chi.totalUsd);
    if (!ok.ok) {
      // Lùi giờ việc này 60′ (review 07/10, mục 10): không thì nó đứng đầu hàng đợi và chặn mọi sứ mệnh khác.
      await db
        .update(t)
        .set({ leaseWorkerId: null, leaseExpiresAt: null, attempts: sql`greatest(${t.attempts} - 1, 0)`, nextAttemptAt: new Date(now.getTime() + 60 * 60_000), lastError: `Sứ mệnh hết trần chi API: ${ok.detail}` })
        .where(and(eq(t.id, task.id), eq(t.leaseGeneration, task.leaseGeneration)));
      return { task: null, reason: `API_BUDGET_${ok.reason}` };
    }
  }
  const capability = taskCapability(task);
  const dinhTuyen = modelForCapability(capability, await getSettingJson<Record<string, unknown>>(MODEL_ROUTING_SETTING, {}));
  const tiepNhanh = capability === "ci-debug" && WORKER_BRANCH_PATTERN.test(task.branch);
  // Hậu tố theo `lease_generation` — đơn điệu, KHÔNG BAO GIỜ reset (review 07/10, mục 6): người mở lại việc làm
  // `attempts` về 0, nếu đặt tên theo `attempts` thì lượt mới đụng nhánh `-a1` cũ (worktree add / push hỏng).
  const branch = tiepNhanh ? task.branch : taskBranchName(task.code, task.leaseGeneration);
  const [run] = await db
    .insert(schema.techAgentRuns)
    .values({
      agentKey: `worker:${worker.key}`,
      taskId: task.id,
      status: "RUNNING",
      branch,
      heartbeatAt: now,
      startedAt: now,
      workerId: worker.id,
      provider: worker.provider,
      leaseGeneration: task.leaseGeneration,
      metadata: { source: "tech-worker", attempt: task.attempts, capability, modelTier: dinhTuyen.tier, modelRequested: dinhTuyen.model },
    })
    .returning({ id: schema.techAgentRuns.id });
  await recordTechTaskEvent({ taskId: task.id, kind: "RUN", note: `Worker ${worker.key} nhận việc — lần thử ${task.attempts}/${task.maxAttempts}`, nextValue: run.id, payload: { workerId: worker.id, leaseGeneration: task.leaseGeneration, branch } }, workerActor(worker));
  await recordTechEvent(db, { name: "worker.claimed", subjectType: "WORKER", subjectId: worker.id, taskId: task.id, missionId: task.missionId, payload: { taskCode: task.code, runId: run.id, attempt: task.attempts, leaseGeneration: task.leaseGeneration } }, workerActor(worker));

  return {
    task: {
      runId: run.id,
      taskId: task.id,
      code: task.code,
      title: task.title,
      description: task.description,
      taskType: task.taskType,
      module: task.module,
      risk: task.risk,
      capability,
      attempt: task.attempts,
      maxAttempts: task.maxAttempts,
      leaseGeneration: task.leaseGeneration,
      leaseExpiresAt: expires.toISOString(),
      branch,
      existingBranch: tiepNhanh,
      timeoutMinutes: ngan.maxRunMinutes ?? BUDGET_DEFAULTS.maxRunMinutes,
      modelTier: dinhTuyen.tier,
      model: dinhTuyen.model,
      mission: task.mission ? { code: task.mission.code, title: task.mission.title, definitionOfDone: task.mission.definitionOfDone } : null,
    },
  };
}

/* ═════════════════════ FENCING ═════════════════════ */

type Fence = { runId: string; leaseGeneration: number };

/** Lượt chạy còn thuộc worker này, đúng generation, còn mở — hoặc lý do không. Xuất ra cho cửa cấp token đẩy (mục 15). */
export async function fenced(db: Db, worker: TechWorkerRow, f: Fence) {
  const run = await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, f.runId) });
  if (!run || run.workerId !== worker.id) return { ok: false as const, reason: "RUN_NOT_YOURS" };
  if (run.status !== "RUNNING") return { ok: false as const, reason: "RUN_CLOSED" };
  if (run.leaseGeneration !== f.leaseGeneration || !run.taskId) return { ok: false as const, reason: "STALE_LEASE" };
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, run.taskId) });
  if (!task || task.leaseGeneration !== f.leaseGeneration) return { ok: false as const, reason: "STALE_LEASE" };
  return { ok: true as const, run, task };
}

/* ═════════════════════ NHỊP TIM ═════════════════════ */

export type HeartbeatRunInput = Fence & { progressPct?: number | null; step?: string; logs?: { level?: string; line: string }[] };
export type HeartbeatRunReply = { runId: string; action: "CONTINUE" | "ABORT"; reason?: string; leaseExpiresAt?: string };

/**
 * Một nhịp: ghi worker còn sống, gia hạn lease của từng lượt còn hợp lệ, nối nhật ký (có trần), và trả lệnh
 * DỪNG cho lượt nào không còn được phép chạy (lease mất, việc bị huỷ / chuyển sang chờ chủ shop, worker bị tắt).
 * Huỷ là HỢP TÁC: máy chủ không giết được tiến trình ở máy khác — nó nói "dừng", worker dừng.
 */
export async function techWorkerHeartbeat(worker: TechWorkerRow, input: { version?: string; runs?: HeartbeatRunInput[] }, now = new Date()): Promise<{ runs: HeartbeatRunReply[] }> {
  const db = await getDb();
  await db.update(schema.techWorkers).set({ lastHeartbeatAt: now, version: (input.version ?? worker.version).slice(0, 60) }).where(eq(schema.techWorkers.id, worker.id));
  const replies: HeartbeatRunReply[] = [];
  for (const r of input.runs ?? []) {
    const f = await fenced(db, worker, r);
    if (!f.ok) {
      replies.push({ runId: r.runId, action: "ABORT", reason: f.reason });
      continue;
    }
    if (!worker.enabled) {
      replies.push({ runId: r.runId, action: "ABORT", reason: "WORKER_DISABLED" });
      continue;
    }
    if (f.task.status !== "SPEC_READY" && f.task.status !== "BUILDING") {
      replies.push({ runId: r.runId, action: "ABORT", reason: `TASK_${f.task.status}` });
      continue;
    }
    const expires = leaseExpiry(now);
    await db
      .update(schema.techTasks)
      .set({ leaseExpiresAt: expires })
      .where(and(eq(schema.techTasks.id, f.task.id), eq(schema.techTasks.leaseGeneration, r.leaseGeneration), eq(schema.techTasks.leaseWorkerId, worker.id)));
    const meta = (f.run.metadata as Record<string, unknown> | null) ?? {};
    await db
      .update(schema.techAgentRuns)
      .set({
        heartbeatAt: now,
        metadata: { ...meta, ...(r.progressPct != null ? { progressPct: Math.max(0, Math.min(100, Math.round(r.progressPct))) } : {}), ...(r.step ? { step: r.step.slice(0, 200) } : {}) },
      })
      .where(eq(schema.techAgentRuns.id, f.run.id));
    if (r.logs?.length) await appendRunLogs(db, f.run.id, r.logs, now);
    replies.push({ runId: r.runId, action: "CONTINUE", leaseExpiresAt: expires.toISOString() });
  }
  return { runs: replies };
}

/** Nhật ký có TRẦN: mỗi lượt tối đa `maxLogLinesPerRun` dòng, mỗi dòng cắt ở `maxLogLineChars`. Vượt ⇒ đánh dấu, không ghi thêm. */
async function appendRunLogs(db: Db, runId: string, logs: { level?: string; line: string }[], now: Date) {
  const [c] = await db.select({ n: count(), max: sql<number>`coalesce(max(${schema.techRunLogs.seq}), 0)` }).from(schema.techRunLogs).where(eq(schema.techRunLogs.runId, runId));
  const con = TECH_LEASE.maxLogLinesPerRun - Number(c?.n ?? 0);
  const lay = logs.slice(0, Math.min(TECH_LEASE.maxLogLinesPerBeat, Math.max(0, con)));
  if (lay.length) {
    let seq = Number(c?.max ?? 0);
    await db.insert(schema.techRunLogs).values(
      lay.map((l) => ({
        runId,
        seq: (seq += 1),
        at: now,
        level: l.level === "error" || l.level === "warn" ? l.level : "info",
        line: l.line.slice(0, TECH_LEASE.maxLogLineChars),
      })),
    );
  }
  if (lay.length < logs.length) {
    await db.update(schema.techAgentRuns).set({ metadata: sql`coalesce(${schema.techAgentRuns.metadata}, '{}'::jsonb) || '{"logsTruncated": true}'::jsonb` }).where(eq(schema.techAgentRuns.id, runId));
  }
}

/* ═════════════════════ BẮT ĐẦU & KẾT THÚC ═════════════════════ */

/** Worker đã dựng xong cây làm việc ⇒ việc sang `BUILDING` (vòng đời chuẩn: CLAIMED → RUNNING). */
export async function startTechWorkerRun(worker: TechWorkerRow, input: Fence & { baseCommit?: string; worktree?: string; model?: string }): Promise<TechResult> {
  // Tắt worker là công tắc ngắt THẬT (review 07/10, mục 12): không bắt đầu, không nộp — lease tự hết hạn.
  if (!worker.enabled) return { error: "WORKER_DISABLED" };
  const db = await getDb();
  const f = await fenced(db, worker, input);
  if (!f.ok) return { error: f.reason };
  await db
    .update(schema.techAgentRuns)
    .set({ baseCommit: input.baseCommit?.slice(0, 64) ?? "", worktree: input.worktree?.slice(0, 300) ?? "", model: input.model?.slice(0, 100) ?? "" })
    .where(eq(schema.techAgentRuns.id, f.run.id));
  if (f.task.status === "SPEC_READY") {
    const r = await setTechTaskStatus({ taskId: f.task.id, to: "BUILDING", note: `Worker ${worker.key} bắt đầu (lần ${f.task.attempts})` }, workerActor(worker));
    if ("error" in r) return r;
  }
  return { ok: true };
}

export type CompleteRunInput = Fence & {
  outcome: TechRunOutcome;
  summary?: string;
  error?: string;
  branch?: string;
  resultCommit?: string;
  filesChanged?: string[];
  testsRun?: string;
  gates?: Partial<Record<"typecheck" | "lint" | "test" | "build", TechGateResult>>;
  model?: string;
  /** Tiền: `usd` của API là tiền THẬT; của gói thuê bao chỉ là ƯỚC TÍNH do CLI tự báo — màn hình ghi nhãn. */
  cost?: { usd?: number | null; inputTokens?: number; outputTokens?: number; estimated?: boolean } | null;
  ownerEscalation?: TechOwnerEscalation | null;
  ownerAction?: string | null;
};

const gate = (g: TechGateResult | undefined): TechGateResult => (g && (TECH_GATE_RESULTS as readonly string[]).includes(g) ? g : "UNKNOWN");

/**
 * Kết thúc một lượt. Fencing trước mọi thứ; rồi `decideCompletion` (thuần) quyết bước kế tiếp; việc đã bị người
 * đổi trạng thái giữa chừng (huỷ, chờ chủ shop) thì chỉ GHI kết quả lượt chạy, không đè quyết định của người.
 */
export async function completeTechWorkerRun(worker: TechWorkerRow, input: CompleteRunInput, now = new Date()): Promise<TechResult<{ taskStatus: TechTaskStatus }>> {
  if (!worker.enabled) return { error: "WORKER_DISABLED" };
  const db = await getDb();
  const f = await fenced(db, worker, input);
  if (!f.ok) return { error: f.reason };
  const { run, task } = f;
  // Nhánh do worker báo phải ĐÚNG nhánh máy chủ đã cấp (review 07/10, mục 8) — không thì một token lộ gắn được PR lạ.
  if (input.branch && input.branch !== run.branch) return { error: "BRANCH_MISMATCH" };
  /*
    ĐƯỜNG CẤM kiểm lại ở máy chủ (review 07/10, mục 6) — worker có thể là bản cũ / bị sửa. Chạm đường cấm thì
    THÀNH CÔNG cũng bị hạ xuống BLOCKED: không yêu cầu mở PR, việc chờ người.
  */
  const cam = forbiddenTouched(input.filesChanged ?? []);
  if (cam.length && input.outcome === "SUCCEEDED") {
    input = { ...input, outcome: "BLOCKED", error: `Diff chạm đường cấm: ${cam.join(", ")} — không mở PR tự động.` };
  }
  const d = decideCompletion(input.outcome, task.attempts, await effectiveMaxAttempts(task));
  const meta = (run.metadata as Record<string, unknown> | null) ?? {};
  const billing = worker.provider === "ANTHROPIC_API" ? "API" : "SUBSCRIPTION";

  /*
    NHẢ LEASE TRƯỚC, có điều kiện đúng generation + đúng worker (review 07/10, mục 7). Lượt thu hồi vừa chạy (đã tăng
    generation) ⇒ 0 dòng ⇒ STALE_LEASE, KHÔNG ghi đè lượt chạy đã đóng.
  */
  let trangThaiLucNop = task.status as TechTaskStatus;
  const nha = await db.transaction(async (tx) => {
   const r = await tx
    .update(schema.techTasks)
    .set({
      leaseWorkerId: null,
      leaseExpiresAt: null,
      lastError: input.outcome === "SUCCEEDED" ? "" : (input.error ?? input.summary ?? "").slice(0, 2000),
      nextAttemptAt: d.requeue && d.backoffMinutes ? new Date(now.getTime() + d.backoffMinutes * 60_000) : null,
      branch: input.outcome === "SUCCEEDED" && input.branch ? input.branch.slice(0, 255) : task.branch,
    })
    .where(and(eq(schema.techTasks.id, task.id), eq(schema.techTasks.leaseGeneration, input.leaseGeneration), eq(schema.techTasks.leaseWorkerId, worker.id)))
    .returning({ id: schema.techTasks.id });
   if (!r.length) return false;
   // Đọc LẠI trạng thái trong cùng giao dịch (review 07/10, mục C): người vừa chuyển việc (BLOCKED, huỷ, chờ chủ
   // shop) sau nhịp tim cuối thì kết quả nộp muộn KHÔNG đè quyết định đó.
   const [hienTai] = await tx.select({ status: schema.techTasks.status }).from(schema.techTasks).where(eq(schema.techTasks.id, task.id));
   trangThaiLucNop = (hienTai?.status ?? task.status) as TechTaskStatus;
   await tx
    .update(schema.techAgentRuns)
    .set({
      status: d.runStatus,
      endedAt: now,
      heartbeatAt: now,
      summary: (input.summary ?? "").slice(0, 8000),
      error: (input.error ?? "").slice(0, 8000),
      branch: input.branch?.slice(0, 255) || run.branch,
      resultCommit: input.resultCommit?.slice(0, 64) ?? "",
      filesChanged: (input.filesChanged ?? []).slice(0, 500).map((x) => x.slice(0, 500)),
      testsRun: (input.testsRun ?? "").slice(0, 8000),
      typecheckResult: gate(input.gates?.typecheck),
      lintResult: gate(input.gates?.lint),
      testResult: gate(input.gates?.test),
      buildResult: gate(input.gates?.build),
      model: input.model?.slice(0, 100) || run.model,
      metadata: {
        ...meta,
        // Bước / % cuối: lượt đã kết thúc thì màn hình không được kẹt ở bước giữa chừng của nhịp tim cuối.
        step: input.outcome === "SUCCEEDED" ? "xong — đã đẩy nhánh" : `kết thúc: ${input.outcome}`,
        progressPct: input.outcome === "SUCCEEDED" ? 100 : (meta as { progressPct?: number }).progressPct ?? null,
        outcome: input.outcome,
        billing,
        cost: input.cost ? { ...input.cost, estimated: billing === "SUBSCRIPTION" ? true : (input.cost.estimated ?? false) } : null,
      },
    })
    .where(and(eq(schema.techAgentRuns.id, run.id), eq(schema.techAgentRuns.status, "RUNNING")));
   return true;
  });
  // Nhả lease + đóng lượt chạy trong MỘT giao dịch (review 07/10, mục 10): sập giữa chừng không để lại lượt RUNNING mồ côi.
  if (!nha) return { error: "STALE_LEASE" };

  const actor = workerActor(worker);
  let status = trangThaiLucNop;
  if (status === "SPEC_READY" || status === "BUILDING") {
    // Lượt kết thúc trước khi kịp "bắt đầu" ⇒ đi qua BUILDING để nhật ký kể đúng đường đi.
    if (status === "SPEC_READY" && d.taskTo !== "SPEC_READY") {
      const r = await setTechTaskStatus({ taskId: task.id, to: "BUILDING", note: `Worker ${worker.key}` }, actor);
      if ("error" in r) return r;
      status = "BUILDING";
    }
    if (status !== d.taskTo) {
      /*
        Câu do MÁY dựng, không bao giờ rỗng (review 07/10, mục 2): `""` của agent không được làm phép chuyển bị từ chối
        sau khi lease đã nhả — việc sẽ kẹt BUILDING không lease mãi. Lý do gọi chủ shop lạ ⇒ trạng thái lạ rủi ro cao;
        câu hướng dẫn quá ngắn ⇒ câu máy chỉ đường tới nhật ký lượt chạy.
      */
      const cau = (input.summary || input.error || `Worker ${worker.key} báo ${input.outcome} (không kèm lý do) — xem nhật ký lượt ${run.id}`).slice(0, 2000);
      const viec = (input.ownerAction || "").trim();
      const r = await setTechTaskStatus(
        {
          taskId: task.id,
          to: d.taskTo,
          note: d.taskTo === "SPEC_READY" ? `Lần thử ${task.attempts} thất bại — thử lại sau ${d.backoffMinutes} phút` : cau.length >= 10 ? cau : `${cau} — xem nhật ký lượt ${run.id}`,
          ownerEscalation: isTechOwnerEscalation(input.ownerEscalation) ? input.ownerEscalation : "UNKNOWN_HIGH_RISK_STATE",
          ownerAction: [...viec].length >= 10 ? viec : `Worker ${worker.key} dừng lại cần chủ shop nhưng không nói rõ việc — mở lượt chạy ${run.id} đọc nhật ký rồi quyết. ${viec}`.trim(),
        },
        actor,
      );
      if ("error" in r) {
        // Lưới cuối: không để việc kẹt — đưa về FAILED (vẫn mở) với câu máy dựng.
        const f = await setTechTaskStatus({ taskId: task.id, to: "FAILED", note: `Không áp được kết cục ${input.outcome}: ${r.error}` }, actor);
        if ("error" in f) return r;
        status = "FAILED";
      } else status = d.taskTo;
    }
  }
  /*
    THÀNH CÔNG + nhánh worker + việc chưa có PR + không phải việc sửa CI (nhánh đó đã có PR) ⇒ máy chủ yêu cầu cầu
    nối mở PR bằng danh tính bot. Lỗi ở đây KHÔNG làm hỏng lượt kết thúc — thành sự kiện `pr.request_failed`.
  */
  if (input.outcome === "SUCCEEDED" && status === "REVIEW" && input.branch && !task.prNumber && task.capability !== "ci-debug") {
    try {
      await requestWorkerPullRequest({ id: task.id, code: task.code, title: task.title, missionId: task.missionId }, input.branch, input.summary ?? "");
    } catch (e) {
      console.error("[tech-worker] yêu cầu mở PR", task.code, e instanceof Error ? e.message : e);
    }
  }
  await recordTechEvent(
    db,
    {
      name: input.outcome === "SUCCEEDED" ? "run.succeeded" : "run.failed",
      subjectType: "RUN",
      subjectId: run.id,
      taskId: task.id,
      missionId: task.missionId,
      payload: { taskCode: task.code, outcome: input.outcome, attempt: task.attempts, requeued: d.requeue, branch: input.branch ?? null, billing },
    },
    actor,
  );
  return { ok: true, taskStatus: status };
}

/** Các lượt đang chạy của một worker — để worker khởi động lại biết mình còn đang giữ gì. */
export async function openRunsOfWorker(workerId: string) {
  const db = await getDb();
  return db
    .select({ runId: schema.techAgentRuns.id, taskId: schema.techAgentRuns.taskId, leaseGeneration: schema.techAgentRuns.leaseGeneration })
    .from(schema.techAgentRuns)
    .where(and(eq(schema.techAgentRuns.workerId, workerId), eq(schema.techAgentRuns.status, "RUNNING")))
    .orderBy(asc(schema.techAgentRuns.startedAt));
}
