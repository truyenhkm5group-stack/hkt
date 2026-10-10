import { and, count, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  MISSION_CONTROL_STATES,
  REGISTRY_PHASE_LABEL,
  ciFromMergedDetail,
  deliveryLevel,
  latestActivity,
  manualMissionControlState,
  missionControlState,
  ownerDecisionQuestion,
  ownerEscalationLabel,
  registryLiveness,
  registryProject,
  type DeliveryLevel,
  type EvidenceClassification,
  type MissionControlState,
  type RegistryEntry,
  type RegistryLiveness,
} from "@/lib/constants/tech-registry";
import { githubConfig } from "@/lib/integrations/github/client";
import { listTechMissions } from "@/lib/queries/tech-control-plane";
import type { ListParams } from "@/lib/search-params";
import { lastRegistrySync } from "@/lib/tech/registry-sync";

/**
 * ───────────── MISSION CONTROL — ĐỌC PHÉP CHIẾU SỔ TECH ROOM ─────────────
 *
 * CHỈ CHẠY TRÊN MÁY CHỦ. Hai nguồn đứng chung một bảng: sổ Tech Room (`tech_registry_missions`, nguồn sự thật điều
 * phối) và sứ mệnh tạo tay trong `/tech` (`tech_missions`). Trạng thái chủ shop, STALE, CI và mức giao hàng TÍNH LẠI
 * LÚC ĐỌC từ dòng sổ đã lưu — không cột nào giữ kết luận để rồi cũ đi.
 *
 * Lọc / sắp / chia trang làm trong bộ nhớ: hai bảng cộng lại vài trăm dòng, và STALE là hàm của đồng hồ nên không
 * lọc được bằng SQL mà không chép luật sang SQL lần thứ hai.
 */

export type MissionControlRow = {
  key: string;
  source: "REGISTRY" | "ERP";
  code: string;
  title: string;
  href: string;
  state: MissionControlState;
  phase: string | null;
  phaseLabel: string | null;
  liveness: RegistryLiveness | null;
  priority: string;
  risk: string | null;
  owner: string;
  branch: string;
  prs: number[];
  project: string;
  ci: "SUCCESS" | "FAILURE" | "PENDING" | "";
  ciSource: "PR" | "MERGE" | null;
  delivery: DeliveryLevel | null;
  deployCheck: string;
  deployCommit: string;
  updatedAt: Date | null;
  inRegistry: boolean;
};

/** Nhãn ngắn của phiên chịu trách nhiệm: «máy:cây» ⇒ «cây». Chữ đầy đủ vẫn ở `title` của ô. */
export function shortOwner(owner: string): string {
  const i = owner.lastIndexOf(":");
  return i >= 0 ? owner.slice(i + 1) : owner;
}

const PRIO_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

type RegistryRow = typeof schema.techRegistryMissions.$inferSelect;

/** Sự kiện cuối + chi tiết MERGED cuối theo từng sứ mệnh — hai câu, cả nhật ký vài nghìn dòng. */
async function eventFacts(): Promise<{ lastAt: Map<string, Date>; mergedDetail: Map<string, string> }> {
  const db = await getDb();
  const e = schema.techRegistryEvents;
  const [last, merged] = await Promise.all([
    db.select({ missionId: e.missionId, at: max(e.at) }).from(e).groupBy(e.missionId),
    db.select({ missionId: e.missionId, detail: e.detail }).from(e).where(eq(e.kind, "MERGED")).orderBy(desc(e.at)),
  ]);
  const lastAt = new Map<string, Date>();
  for (const r of last) if (r.missionId && r.at) lastAt.set(r.missionId, r.at);
  const mergedDetail = new Map<string, string>();
  for (const r of merged) if (r.missionId && !mergedDetail.has(r.missionId)) mergedDetail.set(r.missionId, r.detail);
  return { lastAt, mergedDetail };
}

/** CI của PR đã có phép chiếu ở `tech_tasks` (job `github-pr-sync`) — khoá bằng SỐ PR, không đoán. */
async function ciByPr(prs: number[]): Promise<Map<number, string>> {
  if (!prs.length) return new Map();
  const db = await getDb();
  const t = schema.techTasks;
  const rows = await db
    .select({ pr: t.prNumber, ci: t.ciState, at: t.prSyncedAt })
    .from(t)
    .where(and(inArray(t.prNumber, [...new Set(prs)]), isNotNull(t.prSyncedAt)))
    .orderBy(desc(t.prSyncedAt));
  const out = new Map<number, string>();
  for (const r of rows) if (r.pr !== null && r.ci && !out.has(r.pr)) out.set(r.pr, r.ci);
  return out;
}

export function registryRowView(
  r: RegistryRow,
  facts: { lastAt: Map<string, Date>; mergedDetail: Map<string, string>; ci: Map<number, string> },
  now: Date,
): { row: MissionControlRow; entry: RegistryEntry; evidence: EvidenceClassification | null } {
  const entry = r.entry as unknown as RegistryEntry;
  const cs = missionControlState(entry);
  const mergedDetail = facts.mergedDetail.get(r.registryId) ?? "";
  const prCi = entry.relatedPrs.map((n) => facts.ci.get(n)).find((x): x is string => Boolean(x));
  const mergeCi = ciFromMergedDetail(mergedDetail);
  const updatedAt = latestActivity(r.srcUpdatedAt, r.lastHeartbeatAt, facts.lastAt.get(r.registryId));
  const row: MissionControlRow = {
    key: `r:${r.registryId}`,
    source: "REGISTRY",
    code: r.registryId,
    title: entry.title,
    href: `/tech/missions/registry/${encodeURIComponent(r.registryId)}`,
    state: cs.state,
    phase: cs.phase,
    phaseLabel: cs.phase ? REGISTRY_PHASE_LABEL[cs.phase] : null,
    liveness: registryLiveness(cs.state, updatedAt, now),
    priority: entry.priority,
    risk: entry.risk,
    owner: entry.owner,
    branch: entry.branch ?? "",
    prs: entry.relatedPrs,
    project: registryProject(r.registryId, entry.title),
    ci: (prCi as MissionControlRow["ci"]) ?? mergeCi,
    ciSource: prCi ? "PR" : mergeCi ? "MERGE" : null,
    delivery: deliveryLevel({ evidence: entry.evidence, mergedEventSeen: Boolean(mergedDetail), deployCheck: r.deployCheck }),
    deployCheck: r.deployCheck,
    deployCommit: r.deployCheckedCommit,
    updatedAt,
    inRegistry: r.inRegistry,
  };
  return { row, entry, evidence: cs.evidence };
}

async function allRows(now: Date, includeRemoved: boolean): Promise<MissionControlRow[]> {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const [reg, facts, manual] = await Promise.all([
    db.select().from(m).where(includeRemoved ? undefined : eq(m.inRegistry, true)),
    eventFacts(),
    listTechMissions({ includeClosed: true }),
  ]);
  const ci = await ciByPr(reg.flatMap((r) => (r.entry as unknown as RegistryEntry).relatedPrs ?? []));
  const rows: MissionControlRow[] = reg.map((r) => registryRowView(r, { ...facts, ci }, now).row);
  for (const x of manual) {
    rows.push({
      key: `m:${x.id}`,
      source: "ERP",
      code: x.code,
      title: x.title,
      href: `/tech/missions/${x.id}`,
      state: manualMissionControlState(x.status, x.execution.state, x.outcomeNote),
      phase: x.status,
      phaseLabel: null,
      liveness: null,
      priority: x.priority,
      risk: null,
      owner: x.createdByName,
      branch: "",
      prs: [],
      project: x.project?.key ?? "erp",
      ci: "",
      ciSource: null,
      delivery: null,
      deployCheck: "",
      deployCommit: "",
      updatedAt: x.updatedAt,
      inRegistry: true,
    });
  }
  return rows;
}

function matches(r: MissionControlRow, params: ListParams): boolean {
  const f = params.filters;
  if (f.state?.length && !f.state.some((s) => (s === "STALE" ? r.liveness === "STALE" : r.state === s))) return false;
  if (f.project?.length && !f.project.includes(r.project)) return false;
  if (f.owner?.length && !f.owner.includes(r.owner)) return false;
  if (f.priority?.length && !f.priority.includes(r.priority)) return false;
  if (f.source?.length && !f.source.includes(r.source)) return false;
  const q = params.q.trim().toLowerCase();
  if (q && !r.code.toLowerCase().includes(q) && !r.title.toLowerCase().includes(q) && !r.branch.toLowerCase().includes(q)) return false;
  return true;
}

function compare(sort: string, a: MissionControlRow, b: MissionControlRow): number {
  switch (sort) {
    case "priority":
      return (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9);
    case "code":
      return a.code.localeCompare(b.code);
    case "state":
      return MISSION_CONTROL_STATES.indexOf(a.state) - MISSION_CONTROL_STATES.indexOf(b.state);
    default:
      return (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0);
  }
}

function countBy<T extends string>(rows: MissionControlRow[], key: (r: MissionControlRow) => T): Map<T, number> {
  const out = new Map<T, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + 1);
  return out;
}

export async function listMissionControl(params: ListParams, now = new Date()) {
  const includeRemoved = params.filters.source?.includes("REMOVED") ?? false;
  const all = await allRows(now, includeRemoved);
  const filtered = all.filter((r) => matches(r, { ...params, filters: { ...params.filters, source: (params.filters.source ?? []).filter((s) => s !== "REMOVED") } }));
  const dir = params.dir === "asc" ? 1 : -1;
  filtered.sort((a, b) => compare(params.sort, a, b) * dir || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  const total = filtered.length;
  const rows = filtered.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);

  // Mặt lọc đếm trên TOÀN BỘ (không theo bộ lọc đang chọn) — đủ để thấy có gì mà không phải bỏ lọc.
  const facets = {
    state: [...countBy(all, (r) => r.state)].sort((a, b) => MISSION_CONTROL_STATES.indexOf(a[0]) - MISSION_CONTROL_STATES.indexOf(b[0])),
    stale: all.filter((r) => r.liveness === "STALE").length,
    project: [...countBy(all, (r) => r.project)].sort((a, b) => b[1] - a[1]),
    owner: [...countBy(all, (r) => r.owner)].sort((a, b) => b[1] - a[1]),
    priority: [...countBy(all, (r) => r.priority)].sort((a, b) => (PRIO_RANK[a[0]] ?? 9) - (PRIO_RANK[b[0]] ?? 9)),
    source: [...countBy(all, (r) => r.source)],
  };
  return { rows, total, pageCount: Math.max(1, Math.ceil(total / params.pageSize)), facets, totalAll: all.length };
}

export type MissionControlList = Awaited<ReturnType<typeof listMissionControl>>;

/** Trạng thái đọc sổ cho đầu trang: lần đọc cuối, commit sổ, kho đang đọc, số dòng đã chiếu. */
export async function registrySyncInfo() {
  const last = await lastRegistrySync();
  const cfg = githubConfig();
  const db = await getDb();
  const [r] = await db.select({ n: count() }).from(schema.techRegistryMissions);
  return { lastAt: last.at, commitSha: last.commitSha, configured: cfg.configured, reason: cfg.reason, repo: cfg.repo, rows: Number(r?.n ?? 0) };
}

/** Chi tiết MỘT sứ mệnh sổ: dòng chiếu, nhật ký, phụ thuộc hai chiều, việc `/tech` nối theo số PR. */
export async function getRegistryMission(registryId: string, now = new Date()) {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const row = await db.query.techRegistryMissions.findFirst({ where: eq(m.registryId, registryId) });
  if (!row) return null;
  const e = schema.techRegistryEvents;
  const entry = row.entry as unknown as RegistryEntry;
  const [events, facts, others, tasks] = await Promise.all([
    db.select().from(e).where(eq(e.missionId, registryId)).orderBy(desc(e.at), desc(e.seq)).limit(300),
    eventFacts(),
    db.select({ registryId: m.registryId, title: m.title, entry: m.entry, inRegistry: m.inRegistry }).from(m),
    entry.relatedPrs.length
      ? db.query.techTasks.findMany({
          where: inArray(schema.techTasks.prNumber, entry.relatedPrs),
          columns: { id: true, code: true, title: true, status: true, prNumber: true, prState: true, ciState: true, mergeState: true },
        })
      : Promise.resolve([]),
  ]);
  const ci = await ciByPr(entry.relatedPrs);
  const view = registryRowView(row, { ...facts, ci }, now);
  const stateOf = new Map(others.map((o) => [o.registryId, { title: o.title, state: missionControlState(o.entry as unknown as RegistryEntry).state, inRegistry: o.inRegistry }]));
  const deps = [...new Set([...entry.dependencies, ...entry.blockedBy])].map((id) => ({ id, ...(stateOf.get(id) ?? { title: "", state: null, inRegistry: false }) }));
  const dependents = others
    .filter((o) => {
      const oe = o.entry as unknown as RegistryEntry;
      return o.registryId !== registryId && (oe.dependencies?.includes(registryId) || oe.blockedBy?.includes(registryId));
    })
    .map((o) => ({ id: o.registryId, title: o.title, state: missionControlState(o.entry as unknown as RegistryEntry).state }));
  return { row, view, events, deps, dependents, tasks, repo: githubConfig().repo };
}

export type RegistryMissionDetail = NonNullable<Awaited<ReturnType<typeof getRegistryMission>>>;

/**
 * DECISION INBOX — phần của sổ. Mục quyết định = sứ mệnh mà `missionControlState` ra WAITING_APPROVAL: có `needs_owner`
 * (CLI `--needs-owner=LOẠI: việc`), hoặc BLOCKED + tiêu đề «QUYẾT ĐỊNH CHỦ SHOP: …». Tính lại lúc đọc.
 */
export async function registryDecisionQueue() {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const rows = await db.select().from(m).where(eq(m.inRegistry, true));
  return rows
    .map((r) => {
      const entry = r.entry as unknown as RegistryEntry;
      return { r, entry, state: missionControlState(entry).state };
    })
    .filter((x) => x.state === "WAITING_APPROVAL")
    .map(({ r, entry }) => ({
      registryId: r.registryId,
      category: entry.needsOwner?.category ?? null,
      categoryLabel: ownerEscalationLabel(entry.needsOwner?.category),
      question: entry.needsOwner?.action || ownerDecisionQuestion(entry.title),
      title: entry.title,
      priority: entry.priority,
      risk: entry.risk,
      phase: entry.status,
      waitingSince: r.stateSince,
      updatedAt: r.srcUpdatedAt,
    }))
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9) || a.waitingSince.getTime() - b.waitingSince.getTime());
}

export type RegistryDecisionItem = Awaited<ReturnType<typeof registryDecisionQueue>>[number];
