import { count, desc, gte, sql } from "drizzle-orm";
import { getDbFor, schema, type Db } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import type { SessionUser } from "@/lib/auth/session";
import { CONNECTION_STATUS_LABEL, findConnector, type ConnectionStatus } from "@/lib/connectors/registry";
import { connectionStatusRows } from "@/lib/connectors/service";
import { getPlanUsage, planKeyOf, type PlanUsage } from "@/lib/entitlements/check";
import { recentFailures } from "@/lib/perf/registry";
import { getModuleRows } from "@/lib/platform/capabilities";
import { findOrganization } from "@/lib/platform/organizations";
import type { Organization } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { buildModuleView } from "@/lib/queries/platform-modules";
import { errorText, readJournalCount } from "@/lib/queries/platform-health";
import { rowsOf } from "@/lib/sql-rows";
import { STALE_RUN_KIND_LABEL, STALE_RUN_KINDS, staleRunsOn, type StaleRunKind } from "@/lib/workflow/stale";

/**
 * ═══════════ CHẨN ĐOÁN MỘT TỔ CHỨC — `/platform/org/<mã>` (Phase 11 · H4) — CHỈ MÁY CHỦ, CHỈ ĐỌC ═══════════
 *
 * Trang `/platform` trả lời "tổ chức nào có vấn đề"; trang này trả lời "vấn đề ấy nằm ở đâu" cho ĐÚNG MỘT tổ chức:
 * gói, module bật, số metadata, lượt luật treo, kết nối, nháp AI, blueprint đã cài, migration, lỗi khối trang, job.
 *
 *  · QUYỀN: `platformOperatorDenial` (người của tổ chức nhà có `platform:operate`) — kiểm Ở ĐÂY, không chỉ ở trang,
 *    vì hàm này nhìn xuyên ranh giới tổ chức. Mã tổ chức là đường dẫn do người vận hành gõ; nó chỉ chọn CSDL để ĐỌC.
 *  · CSDL: `getDbFor(org)` — đúng khuôn của `/platform` (mở lần đầu = migrate như khi người của tổ chức đăng nhập).
 *    Mọi câu là SELECT; không ghi một dòng nào, không đổi ngữ cảnh tổ chức của phiên.
 *  · KHÔNG BÍ MẬT, KHÔNG DỮ LIỆU KHÁCH: kết nối chỉ trả khoá · trạng thái · lần kiểm cuối (không `settings`,
 *    không `secret_hints`, không `secrets_enc`, không câu kết quả kiểm tra — câu đó do bên ngoài trả về). Nháp AI chỉ
 *    trả số + mốc (không `prompt` — người dùng gõ tự do, có thể chứa SĐT / email khách — không email người tạo).
 *    Blueprint / job không trả email người bấm, không câu lỗi thô. Bài kiểm quét JSON kết quả tìm bí mật đã gieo.
 *  · CHƯA ĐO ĐƯỢC ≠ 0 (luật 42): mỗi mục là `{ value, note }`; bảng chưa có / câu hỏng ⇒ `value: null` + lý do.
 */

export type Measured<T> = { value: T | null; note: string | null };

export type MetadataCounts = {
  fields: { active: number; archived: number };
  forms: { total: number; published: number };
  lists: { total: number; published: number };
  pages: { active: number; published: number; archived: number };
  objects: { active: number; archived: number };
  records: { live: number; deleted: number };
  workflows: Record<"DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED", number>;
};

export type StaleRunRow = { kind: StaleRunKind; kindLabel: string; ruleName: string; status: string; attempt: number; updatedAt: string };
export type ConnectionRow = { connectorKey: string; label: string; status: ConnectionStatus; statusLabel: string; lastTestAt: string | null; lastTestOk: boolean | null; activatedAt: string | null; updatedAt: string };
export type AiDraftStats = { total: number; today: number; byStatus: Record<string, number>; lastCreatedAt: string | null; applied: number };
export type BlueprintRow = { blueprintKey: string; installedVersion: string | null; lastStatus: string; lastVersion: string; lastAt: string; installs: number };
export type MigrationInfo = { applied: number; expected: number | null; lastAppliedAt: string | null };
export type JobRow = { source: string; job: string; status: string; startedAt: string; finishedAt: string | null; imported: number; updated: number; failed: number };
export type BlockFailureRow = { name: string; count: number; lastAt: string };

export type OrgDiagnostics = {
  checkedAt: string;
  organization: Pick<Organization, "code" | "name" | "status" | "isHome" | "templateKey" | "moduleDefault">;
  planKey: string;
  plan: Measured<PlanUsage>;
  modules: { enabled: { key: string; label: string }[]; total: number; dependencyErrors: string[]; unknownKeys: string[] };
  connected: boolean;
  connectNote: string | null;
  metadata: Measured<MetadataCounts>;
  staleRuns: Measured<{ total: number; byKind: Record<StaleRunKind, number>; rows: StaleRunRow[] }>;
  connections: Measured<ConnectionRow[]>;
  aiDrafts: Measured<AiDraftStats>;
  blueprints: Measured<BlueprintRow[]>;
  migrations: Measured<MigrationInfo>;
  jobs: Measured<JobRow[]>;
  blockFailures: { since: string; rows: BlockFailureRow[]; note: string };
};

export type OrgDiagnosticsResult = { ok: true; value: OrgDiagnostics } | { ok: false; code: "FORBIDDEN" | "NOT_FOUND"; error: string };

async function measure<T>(what: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), note: null };
  } catch (error) {
    return { value: null, note: `Chưa đo được ${what}: ${errorText(error)}` };
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Đếm theo cột `status`. Tên bảng lấy từ tập ĐÓNG trong mã, không từ đầu vào — nội suy an toàn. */
async function statusCounts(db: Db, table: "meta_custom_fields" | "meta_objects" | "workflow_rules" | "ai_blueprint_drafts"): Promise<Record<string, number>> {
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql.raw(`select status::text as k, count(*)::int as n from ${table} group by 1`)));
  return Object.fromEntries(rows.map((r) => [String(r.k), Number(r.n)]));
}

async function metadataCounts(db: Db): Promise<MetadataCounts> {
  const f = await statusCounts(db, "meta_custom_fields");
  const [forms] = await db.select({ total: count(), published: sql<number>`count(*) filter (where ${schema.metaForms.published} is not null)::int` }).from(schema.metaForms);
  const [lists] = await db.select({ total: count(), published: sql<number>`count(*) filter (where ${schema.metaListViews.published} is not null)::int` }).from(schema.metaListViews);
  const [pages] = await db
    .select({
      active: sql<number>`count(*) filter (where ${schema.metaPages.status} <> 'ARCHIVED')::int`,
      published: sql<number>`count(*) filter (where ${schema.metaPages.status} <> 'ARCHIVED' and ${schema.metaPages.published} is not null)::int`,
      archived: sql<number>`count(*) filter (where ${schema.metaPages.status} = 'ARCHIVED')::int`,
    })
    .from(schema.metaPages);
  const o = await statusCounts(db, "meta_objects");
  const [records] = await db.select({ live: sql<number>`count(*) filter (where ${schema.customRecords.deletedAt} is null)::int`, deleted: sql<number>`count(*) filter (where ${schema.customRecords.deletedAt} is not null)::int` }).from(schema.customRecords);
  const w = await statusCounts(db, "workflow_rules");
  return {
    fields: { active: f.ACTIVE ?? 0, archived: f.ARCHIVED ?? 0 },
    forms: { total: Number(forms?.total ?? 0), published: Number(forms?.published ?? 0) },
    lists: { total: Number(lists?.total ?? 0), published: Number(lists?.published ?? 0) },
    pages: { active: Number(pages?.active ?? 0), published: Number(pages?.published ?? 0), archived: Number(pages?.archived ?? 0) },
    objects: { active: o.ACTIVE ?? 0, archived: o.ARCHIVED ?? 0 },
    records: { live: Number(records?.live ?? 0), deleted: Number(records?.deleted ?? 0) },
    workflows: { DRAFT: w.DRAFT ?? 0, ACTIVE: w.ACTIVE ?? 0, PAUSED: w.PAUSED ?? 0, ARCHIVED: w.ARCHIVED ?? 0 },
  };
}

async function staleRunInfo(db: Db) {
  const runs = await staleRunsOn(db, { limit: 500 });
  const byKind = Object.fromEntries(STALE_RUN_KINDS.map((k) => [k, 0])) as Record<StaleRunKind, number>;
  for (const r of runs) byKind[r.kind] += 1;
  const shown = runs.slice(0, 20);
  const ruleIds = [...new Set(shown.map((r) => r.ruleId))];
  const names = new Map<string, string>();
  if (ruleIds.length) {
    const rules = await db.select({ id: schema.workflowRules.id, name: schema.workflowRules.name }).from(schema.workflowRules);
    for (const r of rules) if (ruleIds.includes(r.id)) names.set(r.id, r.name);
  }
  // Không trả `error` / `subject_id` của lượt chạy: câu lỗi có thể mang dữ liệu của bản ghi — xem chi tiết ở màn hình
  // luật của chính tổ chức đó.
  const rows: StaleRunRow[] = shown.map((r) => ({ kind: r.kind, kindLabel: STALE_RUN_KIND_LABEL[r.kind], ruleName: names.get(r.ruleId) ?? "(luật không còn)", status: r.status, attempt: r.attempt, updatedAt: r.updatedAt.toISOString() }));
  return { total: runs.length, byKind, rows };
}

async function connectionRows(db: Db, orgCode: string): Promise<ConnectionRow[]> {
  // Đường đọc duy nhất của bảng kết nối (lib/connectors/service.ts) — chỉ cột trạng thái, không bí mật.
  const rows = await connectionStatusRows(db);
  return rows.map((r) => {
    const status = r.status;
    const mismatch = r.orgCode !== orgCode;
    return {
      connectorKey: r.connectorKey,
      label: `${findConnector(r.connectorKey)?.label ?? r.connectorKey}${mismatch ? ` — DÒNG MANG MÃ TỔ CHỨC KHÁC («${r.orgCode}»)` : ""}`,
      status,
      statusLabel: CONNECTION_STATUS_LABEL[status] ?? r.status,
      lastTestAt: iso(r.lastTestAt),
      lastTestOk: r.lastTestOk,
      activatedAt: iso(r.activatedAt),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function aiDraftStats(db: Db): Promise<AiDraftStats> {
  const d = schema.aiBlueprintDrafts;
  const byStatus = await statusCounts(db, "ai_blueprint_drafts");
  const [today] = await db.select({ n: count() }).from(d).where(gte(d.createdAt, dauNgayVN(new Date())));
  const [last] = await db.select({ at: d.createdAt }).from(d).orderBy(desc(d.createdAt)).limit(1);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, today: Number(today?.n ?? 0), byStatus, lastCreatedAt: iso(last?.at), applied: byStatus.APPLIED ?? 0 };
}

async function blueprintRows(db: Db): Promise<BlueprintRow[]> {
  const b = schema.blueprintInstalls;
  const rows = await db.select({ key: b.blueprintKey, version: b.version, status: b.status, at: b.installedAt }).from(b).orderBy(desc(b.installedAt), desc(b.id));
  const out = new Map<string, BlueprintRow>();
  for (const r of rows) {
    const cur = out.get(r.key);
    if (!cur) out.set(r.key, { blueprintKey: r.key, installedVersion: r.status === "DONE" ? r.version : null, lastStatus: r.status, lastVersion: r.version, lastAt: r.at.toISOString(), installs: 1 });
    else {
      cur.installs += 1;
      // Phiên bản ĐÃ CÀI = lượt DONE mới nhất (lượt mới nhất có thể hỏng giữa chừng).
      if (!cur.installedVersion && r.status === "DONE") cur.installedVersion = r.version;
    }
  }
  return [...out.values()].sort((a, b) => a.blueprintKey.localeCompare(b.blueprintKey));
}

async function migrationInfo(db: Db): Promise<MigrationInfo> {
  const [r] = rowsOf<Record<string, unknown>>(await db.execute(sql`select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`));
  const n = Number(r?.n);
  if (!Number.isFinite(n)) throw new Error("drizzle.__drizzle_migrations không trả số dòng.");
  const lastMs = r?.last === null || r?.last === undefined ? NaN : Number(r.last);
  return { applied: n, expected: readJournalCount().count, lastAppliedAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null };
}

async function jobRows(db: Db): Promise<JobRow[]> {
  const s = schema.syncRuns;
  // Không trả `detail` / `error` / `actor`: câu chữ của job có thể mang tên khách, SĐT, email người bấm.
  const rows = await db.select({ source: s.source, job: s.job, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, imported: s.imported, updated: s.updated, failed: s.failed }).from(s).orderBy(desc(s.startedAt)).limit(15);
  return rows.map((r) => ({ source: r.source, job: r.job, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), imported: r.imported, updated: r.updated, failed: r.failed }));
}

/**
 * Chẩn đoán MỘT tổ chức. `code` là mã trong sổ tổ chức; người không phải người vận hành nền tảng ⇒ `FORBIDDEN` (không
 * một câu truy vấn nào vào CSDL tổ chức). Tổ chức không có ⇒ `NOT_FOUND`.
 */
export async function loadOrgDiagnostics(user: SessionUser, code: string): Promise<OrgDiagnosticsResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, code: "FORBIDDEN", error: denial };
  const org = typeof code === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(code) ? await findOrganization(code) : null;
  if (!org) return { ok: false, code: "NOT_FOUND", error: `Không có tổ chức mã «${String(code).slice(0, 40)}» trong sổ.` };

  const { rows: moduleRows } = await getModuleRows(org.code);
  const view = buildModuleView(org, moduleRows);
  const enabled = view.groups.flatMap((g) => g.rows).filter((r) => r.enabled).map((r) => ({ key: r.key, label: r.label }));
  const base = {
    checkedAt: new Date().toISOString(),
    organization: { code: org.code, name: org.name, status: org.status, isHome: org.isHome, templateKey: org.templateKey, moduleDefault: org.moduleDefault },
    planKey: planKeyOf(org),
    plan: await measure("mức dùng gói", () => getPlanUsage(org.code)),
    modules: { enabled, total: view.total, dependencyErrors: view.groups.flatMap((g) => g.rows).flatMap((r) => (r.dependencyError ? [`${r.label}: ${r.dependencyError}`] : [])), unknownKeys: view.unknownKeys },
    blockFailures: blockFailuresOf(org.code),
  };

  let db: Db;
  try {
    db = await getDbFor(org);
    await db.execute(sql`select 1`);
  } catch (error) {
    const why = `Chưa đo — không mở được CSDL: ${errorText(error)}`;
    const none = { value: null, note: why };
    return { ok: true, value: { ...base, connected: false, connectNote: why, metadata: none, staleRuns: none, connections: none, aiDrafts: none, blueprints: none, migrations: none, jobs: none } };
  }

  // Tuần tự: một CSDL, một bể kết nối nhỏ (5) — không dựng bão truy vấn vào CSDL của khách.
  const metadata = await measure("số metadata", () => metadataCounts(db));
  const staleRuns = await measure("lượt chạy treo", () => staleRunInfo(db));
  const connections = await measure("kết nối", () => connectionRows(db, org.code));
  const aiDrafts = await measure("nháp AI", () => aiDraftStats(db));
  const blueprints = await measure("blueprint đã cài", () => blueprintRows(db));
  const migrations = await measure("migration", () => migrationInfo(db));
  const jobs = await measure("job", () => jobRows(db));
  return { ok: true, value: { ...base, connected: true, connectNote: null, metadata, staleRuns, connections, aiDrafts, blueprints, migrations, jobs } };
}

function blockFailuresOf(orgCode: string): OrgDiagnostics["blockFailures"] {
  const { since, failures } = recentFailures(orgCode);
  const byName = new Map<string, BlockFailureRow>();
  for (const f of failures) {
    const row = byName.get(f.name) ?? { name: f.name, count: 0, lastAt: new Date(f.at).toISOString() };
    row.count += 1;
    if (f.at > Date.parse(row.lastAt)) row.lastAt = new Date(f.at).toISOString();
    byName.set(f.name, row);
  }
  return {
    since: new Date(since).toISOString(),
    rows: [...byName.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    note: "Sổ đo trong RAM của TIẾN TRÌNH này (mất khi khởi động lại, không gộp nhiều máy). Chỉ đếm lỗi BẤT NGỜ của khối (DATA_ERROR) — lỗi cấu hình / thiếu quyền hiện ngay trên trang cho người xem, không ghi ở đây. Không giữ câu lỗi: chi tiết ở log máy chủ dòng [page-block].",
  };
}
