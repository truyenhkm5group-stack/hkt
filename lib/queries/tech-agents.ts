import { chuoiSach, type ChuoiSach, type LuotChoChuoi, type ReviewVerdict } from "@/lib/constants/agent-clean-streak";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TECH_AGENT_ROLES, TECH_RUN_SORTABLE, type TechAgentRole } from "@/lib/constants/tech";
import type { ListParams } from "@/lib/search-params";

export { TECH_RUN_SORTABLE };

/**
 * ───────────── SỔ AGENT & LƯỢT CHẠY ─────────────
 *
 * Sổ agent là DỮ LIỆU ĐIỀU KHIỂN, không phải danh sách nhân sự: nó không nối vào `users`, và một
 * dòng ở đây không bao giờ được đếm như một con người ở bất kỳ báo cáo hiệu suất nào (AGENTS.md
 * mục 36). Phase 1 chưa có agent nào tự chạy, nên mọi con số "đang làm" ở đây chỉ phản ánh thứ đã
 * được ghi vào — và bảng trống là trạng thái ĐÚNG, không phải thiếu dữ liệu.
 */

export async function listTechAgents() {
  const db = await getDb();
  const agents = await db.query.techAgents.findMany({ orderBy: [asc(schema.techAgents.role), asc(schema.techAgents.key)] });

  // Số việc đang cầm và lượt chạy gần nhất, gộp một lượt truy vấn cho cả sổ thay vì N+1.
  const [viec, luot] = await Promise.all([
    db
      .select({ agentId: schema.techTasks.agentId, mo: sql<number>`count(*) filter (where ${schema.techTasks.status} <> 'DONE')`, tong: count() })
      .from(schema.techTasks)
      .groupBy(schema.techTasks.agentId),
    db
      .select({
        agentId: schema.techAgentRuns.agentId,
        lastAt: sql<Date | null>`max(${schema.techAgentRuns.startedAt})`,
        dangChay: sql<number>`count(*) filter (where ${schema.techAgentRuns.status} = 'RUNNING')`,
        loi: sql<number>`count(*) filter (where ${schema.techAgentRuns.status} = 'FAILED')`,
        tong: count(),
      })
      .from(schema.techAgentRuns)
      .groupBy(schema.techAgentRuns.agentId),
  ]);

  const mapViec = new Map(viec.map((v) => [v.agentId ?? "", v]));
  const mapLuot = new Map(luot.map((l) => [l.agentId ?? "", l]));

  return agents.map((a) => {
    const v = mapViec.get(a.id);
    const l = mapLuot.get(a.id);
    return {
      ...a,
      openTasks: Number(v?.mo ?? 0),
      totalTasks: Number(v?.tong ?? 0),
      runningRuns: Number(l?.dangChay ?? 0),
      failedRuns: Number(l?.loi ?? 0),
      totalRuns: Number(l?.tong ?? 0),
      /** `null` = CHƯA TỪNG chạy lượt nào. Không phải "chạy lúc 0 giờ". */
      lastRunAt: l?.lastAt ? new Date(l.lastAt) : null,
    };
  });
}

export type TechAgentListRow = Awaited<ReturnType<typeof listTechAgents>>[number];

/** Danh sách rút gọn để chọn trong biểu mẫu. Chỉ agent CÒN BẬT — giao việc cho agent đã tắt là giao vào hư không. */
export async function listEnabledTechAgents() {
  const db = await getDb();
  return db.query.techAgents.findMany({
    where: eq(schema.techAgents.enabled, true),
    columns: { id: true, key: true, name: true, role: true, allowedRisks: true },
    orderBy: [asc(schema.techAgents.role)],
  });
}

/** Vai trò đã có trong sổ — để màn hình biết còn thiếu vai nào so với bản khai. */
export async function techAgentRoleCoverage(): Promise<{ role: TechAgentRole; has: boolean }[]> {
  const db = await getDb();
  const rows = await db.select({ role: schema.techAgents.role }).from(schema.techAgents).groupBy(schema.techAgents.role);
  const co = new Set(rows.map((r) => r.role));
  return TECH_AGENT_ROLES.map((role) => ({ role, has: co.has(role) }));
}

export function techRunWhere(params: ListParams) {
  const r = schema.techAgentRuns;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(r.startedAt, params.period.from));
  if (params.period.to) conds.push(lte(r.startedAt, params.period.to));
  if (params.filters.status?.length) conds.push(inArray(r.status, params.filters.status));
  if (params.filters.agent?.length) conds.push(inArray(r.agentKey, params.filters.agent));
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(r.branch, like), ilike(r.summary, like), ilike(r.agentKey, like), ilike(r.resultCommit, like)));
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

/**
 * Chuỗi "lượt chạy sạch" hiện tại của TỪNG agent — tiêu chí mở nấc tiếp theo, thành một con số.
 *
 * Luật đếm sống ở `lib/constants/agent-clean-streak.ts` (hàm thuần); ở đây chỉ đọc sổ và chia theo
 * agent. Lượt chạy mỗi agent là vài chục dòng, nên đọc hết rồi đếm ở TypeScript thay vì viết lại
 * luật ấy bằng SQL — hai bản của một luật là hai luật (xem sổ ghi nhớ "luật có bản sao").
 */
export async function chuoiSachTheoAgent(): Promise<Map<string, ChuoiSach>> {
  const db = await getDb();
  const r = schema.techAgentRuns;
  const rows = await db
    .select({ id: r.id, agentId: r.agentId, taskId: r.taskId, branch: r.branch, status: r.status, startedAt: r.startedAt, reviewVerdict: r.reviewVerdict })
    .from(r);
  const theoAgent = new Map<string, LuotChoChuoi[]>();
  for (const x of rows) {
    if (!x.agentId) continue;
    const ds = theoAgent.get(x.agentId) ?? [];
    ds.push({ id: x.id, taskId: x.taskId, branch: x.branch, status: x.status, startedAt: x.startedAt, reviewVerdict: (x.reviewVerdict as ReviewVerdict | null) ?? null });
    theoAgent.set(x.agentId, ds);
  }
  const kq = new Map<string, ChuoiSach>();
  for (const [id, ds] of theoAgent) kq.set(id, chuoiSach(ds));
  return kq;
}

export async function listTechAgentRuns(params: ListParams) {
  const db = await getDb();
  const r = schema.techAgentRuns;
  const where = techRunWhere(params);
  const sortMap = { startedAt: r.startedAt, status: r.status, agentKey: r.agentKey } as const;
  const col = sortMap[params.sort as keyof typeof sortMap] ?? r.startedAt;
  const [rows, [{ total }]] = await Promise.all([
    db.query.techAgentRuns.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(col) : desc(col), desc(r.startedAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { agent: { columns: { key: true, name: true, role: true } }, task: { columns: { id: true, code: true, title: true } } },
    }),
    db.select({ total: count() }).from(r).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type TechAgentRunRow = Awaited<ReturnType<typeof listTechAgentRuns>>["rows"][number];

/**
 * Lượt chạy ĐANG CHẠY.
 *
 * Kèm luôn những lượt "đang chạy" đã quá lâu: một lượt mở ra rồi tiến trình chết sẽ nằm mãi ở
 * `RUNNING` và làm thẻ "agent đang làm" nói dối. Màn hình phải phân biệt được hai thứ đó.
 */
export async function runningTechAgentRuns(staleHours = 6) {
  const db = await getDb();
  const rows = await db.query.techAgentRuns.findMany({
    where: eq(schema.techAgentRuns.status, "RUNNING"),
    orderBy: [desc(schema.techAgentRuns.startedAt)],
    limit: 20,
    with: { agent: { columns: { key: true, name: true, role: true } }, task: { columns: { id: true, code: true, title: true } } },
  });
  const nguong = staleHours * 3600_000;
  return rows.map((r) => ({ ...r, stale: Date.now() - new Date(r.startedAt).getTime() > nguong }));
}

/** Lượt chạy chưa gắn được vào agent nào trong sổ (agent bị xoá). Đếm riêng để không lẫn với "chưa ai chạy". */
export async function orphanTechRunCount() {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(schema.techAgentRuns).where(isNull(schema.techAgentRuns.agentId));
  return Number(row?.n ?? 0);
}
