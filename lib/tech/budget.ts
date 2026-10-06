import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { API_RUN_RESERVE_USD, EMPTY_BUDGET, TECH_BUDGET_SCOPES, resolveBudget, type TechBudgetLimits, type TechBudgetScope } from "@/lib/constants/tech-policy";
import { recordTechEvent } from "@/lib/tech/control-plane";
import type { TechActor, TechResult } from "@/lib/tech/service";

/**
 * ═══════════ NGÂN SÁCH — ĐỌC TRẦN HIỆU LỰC, ĐẾM TIỀN THẬT (Pha 4) ═══════════
 *
 * docs/tech-control-plane/README.md mục 11. Luật gộp tầng ở `resolveBudget` (thuần). Tiền API đếm từ CHÍNH sổ lượt
 * chạy (`tech_agent_runs.metadata.cost.usd` của lượt `billing = API`) — không bảng tiền thứ hai. Tiền của lượt gói
 * thuê bao là ƯỚC TÍNH do CLI tự báo và KHÔNG BAO GIỜ cộng vào tiền API.
 */

const toLimits = (r: typeof schema.techBudgets.$inferSelect | undefined): TechBudgetLimits | null =>
  r ? { apiUsdDaily: r.apiUsdDaily, apiUsdTotal: r.apiUsdTotal, maxRunMinutes: r.maxRunMinutes, maxAttempts: r.maxAttempts, maxConcurrentRuns: r.maxConcurrentRuns } : null;

/** Trần hiệu lực cho một sứ mệnh (công ty → dự án → mục tiêu → sứ mệnh). `missionId` rỗng = chỉ tầng công ty. */
export async function effectiveBudget(missionId?: string | null): Promise<TechBudgetLimits> {
  const db = await getDb();
  const rows = await db.select().from(schema.techBudgets);
  const lay = (k: TechBudgetScope, id: string | null | undefined) => toLimits(rows.find((r) => r.scopeKind === k && r.scopeId === (id ?? "")));
  if (!missionId) return resolveBudget([lay("COMPANY", "")]);
  const m = await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, missionId), columns: { id: true, goalId: true, projectId: true } });
  if (!m) return resolveBudget([lay("COMPANY", "")]);
  return resolveBudget([lay("COMPANY", ""), m.projectId ? lay("PROJECT", m.projectId) : null, m.goalId ? lay("GOAL", m.goalId) : null, lay("MISSION", m.id)]);
}

/*
  Tiền API của một lượt: tiền thật nếu CLI đã báo; CHƯA BIẾT (đang chạy · quá giờ · huỷ · thu hồi · không báo) ⇒ GIỮ CHỖ
  `API_RUN_RESERVE_USD` (review 07/10, mục 3 — NULL không phải 0; trần chi tính trên tiền giữ chỗ như mục 72).
  Lượt API nhận diện bằng `provider` (máy chủ ghi lúc nhận việc), không bằng lời khai `billing` của lúc kết thúc.
*/
const apiCost = sql<number>`coalesce(sum(coalesce(nullif(${schema.techAgentRuns.metadata}->'cost'->>'usd', '')::float8, ${API_RUN_RESERVE_USD})) filter (where ${schema.techAgentRuns.provider} = 'ANTHROPIC_API'), 0)`;

/** Tiền API THẬT đã chi: hôm nay (theo giờ VN) và tổng — toàn công ty, hoặc của một sứ mệnh. */
export async function apiSpend(opts: { missionId?: string | null; now?: Date } = {}): Promise<{ todayUsd: number; totalUsd: number }> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  // Đầu ngày theo giờ Việt Nam (UTC+7) — cùng quy ước hiển thị của ERP.
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const dauNgay = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3600_000);
  const theoSuMenh = opts.missionId ? sql`${schema.techAgentRuns.taskId} in (select id from tech_tasks where mission_id = ${opts.missionId})` : sql`true`;
  const [tong] = await db.select({ usd: apiCost }).from(schema.techAgentRuns).where(and(isNotNull(schema.techAgentRuns.workerId), theoSuMenh));
  const [ngay] = await db.select({ usd: apiCost }).from(schema.techAgentRuns).where(and(isNotNull(schema.techAgentRuns.workerId), theoSuMenh, gte(schema.techAgentRuns.startedAt, dauNgay)));
  return { todayUsd: Number(ngay?.usd ?? 0), totalUsd: Number(tong?.usd ?? 0) };
}

/** Số lượt worker đang chạy trên cả công ty — cho trần đồng thời. */
export async function runningWorkerRuns(): Promise<number> {
  const db = await getDb();
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.techAgentRuns).where(and(isNotNull(schema.techAgentRuns.workerId), eq(schema.techAgentRuns.status, "RUNNING")));
  return Number(r?.n ?? 0);
}

export type SetBudgetInput = { scopeKind: TechBudgetScope; scopeId?: string | null } & Partial<TechBudgetLimits> & { note?: string };

/** Ghi trần một phạm vi — chỉ NGƯỜI. Ô bỏ trống (null) = CHƯA KHAI, không phải 0. */
export async function setTechBudget(input: SetBudgetInput, actor: TechActor): Promise<TechResult> {
  if (actor.kind !== "HUMAN") return { error: "Chỉ NGƯỜI đặt ngân sách — máy và agent không tự nới trần tiêu tiền." };
  if (!TECH_BUDGET_SCOPES.includes(input.scopeKind)) return { error: "Phạm vi ngân sách lạ." };
  const scopeId = input.scopeKind === "COMPANY" ? "" : (input.scopeId ?? "").trim();
  if (input.scopeKind !== "COMPANY" && !scopeId) return { error: "Thiếu phạm vi (dự án / mục tiêu / sứ mệnh)." };
  const v: TechBudgetLimits = { ...EMPTY_BUDGET, ...Object.fromEntries(Object.entries(input).filter(([k]) => k in EMPTY_BUDGET)) } as TechBudgetLimits;
  const db = await getDb();
  try {
    await db
      .insert(schema.techBudgets)
      .values({ scopeKind: input.scopeKind, scopeId, ...v, note: input.note?.trim() ?? "", updatedById: actor.id ?? null })
      .onConflictDoUpdate({ target: [schema.techBudgets.scopeKind, schema.techBudgets.scopeId], set: { ...v, note: input.note?.trim() ?? "", updatedById: actor.id ?? null, updatedAt: new Date() } });
  } catch (e) {
    if (String(e).includes("tech_budgets_values_check")) return { error: "Giá trị ngoài khoảng cho phép (phút 5–240 · lần thử 1–10 · đồng thời 1–16 · tiền ≥ 0)." };
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await recordTechEvent(db, { name: "budget.updated", subjectType: "BUDGET", subjectId: `${input.scopeKind}:${scopeId}`, missionId: input.scopeKind === "MISSION" ? scopeId : null, goalId: input.scopeKind === "GOAL" ? scopeId : null, payload: { scope: input.scopeKind, ...v } }, actor);
  return { ok: true };
}

export async function getBudgetRow(scopeKind: TechBudgetScope, scopeId = "") {
  const db = await getDb();
  return (await db.query.techBudgets.findFirst({ where: and(eq(schema.techBudgets.scopeKind, scopeKind), eq(schema.techBudgets.scopeId, scopeId)) })) ?? null;
}
