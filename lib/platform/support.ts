import { and, count, desc, eq, gte, max, sql } from "drizzle-orm";
import { getDbFor, schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { loadOrgAiUsage } from "@/lib/ai-usage/view";
import { evaluateBackupHealth } from "@/lib/constants/backup";
import type { HealthState } from "@/lib/queries/integration-health";
import type { PilotStage } from "@/lib/constants/pilot";
import { connectionStatusRows } from "@/lib/connectors/service";
import { planKeyOf } from "@/lib/entitlements/check";
import { recentFailures } from "@/lib/perf/registry";
import { platformAudit, type PlatformAuditSource } from "@/lib/platform/audit";
import { killSwitchState, type KillSwitchState } from "@/lib/platform/kill-switches";
import { readOrgFlag, WORKFLOWS_PAUSED_FLAG } from "@/lib/platform/org-flags";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { listPilotStages, loadPilotView, type PilotView } from "@/lib/platform/pilot";
import { ORGANIZATION_CODE_PATTERN, type Organization } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { backupStatusDir, backupTargetFor, readBackupStatusFiles } from "@/lib/queries/backup-status";
import { rowsOf } from "@/lib/sql-rows";
import { countStaleRunsOn } from "@/lib/workflow/stale";

/**
 * ═══════════ SỨC KHOẺ / HỖ TRỢ MỘT TỔ CHỨC — `/platform/org/<mã>` (docs/platform/pilot-operations.md §5) ═══════════
 *
 * Bổ sung cho chẩn đoán H4 (`lib/queries/platform-org-diagnostics.ts`): H4 trả lời "cấu hình hỏng ở đâu", tệp này trả
 * lời "khách có đang dùng được không": giai đoạn pilot, người dùng + lần đăng nhập cuối, dung lượng, luật lỗi / treo 7
 * ngày, kết nối, hoạt động cuối, sao lưu cuối, lỗi job / khối trang, công tắc khẩn.
 *
 * ─── HỖ TRỢ CÓ VẾT ───
 * MỖI lượt mở (`loadOrgSupport`) ghi `platform_audit_log` `SUPPORT_VIEW` (ai · tổ chức nào · lúc nào) TRƯỚC khi đọc
 * một câu nào vào CSDL của khách. Không ghi được vết ⇒ KHÔNG mở — nhìn vào tổ chức của khách mà không để lại dấu thì
 * không được tồn tại, kể cả khi lỗi là của nhật ký.
 *
 * ─── KHÔNG DỮ LIỆU NGHIỆP VỤ ───
 * Chỉ SỐ ĐẾM, TỔNG DUNG LƯỢNG và MỐC THỜI GIAN + LOẠI (tên hành động trong nhật ký, tên sự kiện miền). Không email, không
 * tên khách, không số đơn, không số tiền, không giá trị field, không câu lỗi (câu lỗi có thể mang dữ liệu bản ghi). Bài
 * kiểm `tests/pilot-ops.test.ts` gieo tên khách / số tiền / giá trị field rồi quét JSON kết quả.
 *
 * ─── CHƯA ĐO ĐƯỢC ≠ 0 ─── (luật 42) mỗi ô là `{ value, note }`.
 */

export type Measured<T> = { value: T | null; note: string | null };

export type SupportUsers = { active: number; total: number; admins: number; lastLoginAt: string | null };
export type SupportStorage = { databaseBytes: number | null; databaseNote: string | null; fileBytes: number; fileCount: number };
export type SupportAutomation = { failed7d: number; stale: number; waitingApproval: number };
export type SupportConnections = { total: number; active: number; disabled: number; draft: number; failingTests: number; lastTestAt: string | null };
export type SupportActivity = { audit: { at: string; action: string } | null; event: { at: string; name: string } | null };
export type SupportErrors = { failedJobs7d: number; lastFailedJobAt: string | null; blockFailures: number; blockSince: string };
export type SupportBackup = { state: HealthState; reason: string; lastSuccessAt: string | null; ageHours: number | null };

export type OrgSupport = {
  checkedAt: string;
  organization: { code: string; name: string; status: string; isHome: boolean; planKey: string };
  pilot: PilotView | null;
  killSwitches: KillSwitchState;
  users: Measured<SupportUsers>;
  storage: Measured<SupportStorage>;
  /** Ô "Dùng AI" — đọc sổ `platform_ai_usage` (mặt phẳng điều khiển), CHỈ số đếm + tiền ước tính; không prompt, không khoá. */
  aiUsage: Measured<SupportAiUsage>;
  automation: Measured<SupportAutomation>;
  connections: Measured<SupportConnections>;
  lastActivity: Measured<SupportActivity>;
  errors: Measured<SupportErrors>;
  backup: SupportBackup;
};

export type OrgSupportResult = { ok: true; value: OrgSupport } | { ok: false; code: "FORBIDDEN" | "NOT_FOUND" | "AUDIT_FAILED"; error: string };

export type SupportAiUsage = {
  /** Lý do AI Builder của tổ chức đang bị chặn (công tắc nền tảng hoặc công tắc tổ chức); `null` = đang mở. */
  disabledReason: string | null;
  requestsToday: number;
  requestsMonth: number;
  /** Tổng USD ước tính của các lượt ĐÃ định giá trong tháng; `null` khi không lượt nào định giá được (CHƯA BIẾT ≠ 0). */
  costUsdMonth: number | null;
  unknownCostMonth: number;
  blockedMonth: number;
  planName: string | null;
};

/** Gộp các nguồn trả tiền (BYOK · PLATFORM · HOME) thành một ô; tiền chỉ cộng phần ĐÃ định giá. */
async function aiUsageOf(orgCode: string, now: Date): Promise<SupportAiUsage> {
  const v = await loadOrgAiUsage(orgCode, now);
  const sum = (rows: typeof v.today, k: "requests" | "unknownCost" | "blocked") => rows.reduce((a, r) => a + r[k], 0);
  const priced = v.month.filter((r) => r.costUsd !== null);
  return {
    disabledReason: v.disabledReason,
    requestsToday: sum(v.today, "requests"),
    requestsMonth: sum(v.month, "requests"),
    costUsdMonth: priced.length === 0 ? null : priced.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    unknownCostMonth: sum(v.month, "unknownCost"),
    blockedMonth: sum(v.month, "blocked"),
    planName: v.limits?.planName ?? null,
  };
}

const DAY_MS = 86_400_000;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function measure<T>(what: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), note: null };
  } catch (error) {
    // KHÔNG trả câu lỗi thô (có thể mang dữ liệu) — chỉ tên lỗi.
    return { value: null, note: `Chưa đo được ${what} (${error instanceof Error ? error.name : "lỗi"}).` };
  }
}

async function users(db: Db): Promise<SupportUsers> {
  const u = schema.users;
  const [r] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${u.active})::int`,
      admins: sql<number>`count(*) filter (where ${u.active} and ${u.role} = 'ADMIN')::int`,
      lastLoginAt: max(u.lastLoginAt),
    })
    .from(u);
  return { total: Number(r?.total ?? 0), active: Number(r?.active ?? 0), admins: Number(r?.admins ?? 0), lastLoginAt: iso(r?.lastLoginAt) };
}

async function storage(db: Db): Promise<SupportStorage> {
  const f = schema.customFiles;
  const [files] = await db.select({ bytes: sql<string>`coalesce(sum(${f.size}), 0)::text`, n: count() }).from(f);
  let databaseBytes: number | null = null;
  let databaseNote: string | null = null;
  try {
    const [r] = rowsOf<{ b: unknown }>(await db.execute(sql`select pg_database_size(current_database())::text as b`));
    const n = Number(r?.b);
    databaseBytes = Number.isFinite(n) ? n : null;
    if (databaseBytes === null) databaseNote = "Máy CSDL không trả dung lượng.";
  } catch {
    databaseNote = "Máy CSDL không cho đọc dung lượng (pg_database_size).";
  }
  return { databaseBytes, databaseNote, fileBytes: Number(files?.bytes ?? 0), fileCount: Number(files?.n ?? 0) };
}

async function automation(db: Db, now: Date): Promise<SupportAutomation> {
  const w = schema.workflowRuns;
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [r] = await db
    .select({
      failed7d: sql<number>`count(*) filter (where ${w.status} = 'FAILED' and ${w.updatedAt} >= ${since})::int`,
      waiting: sql<number>`count(*) filter (where ${w.status} = 'WAITING_APPROVAL')::int`,
    })
    .from(w);
  const stale = await countStaleRunsOn(db);
  return { failed7d: Number(r?.failed7d ?? 0), stale: stale.total, waitingApproval: Number(r?.waiting ?? 0) };
}

async function connections(db: Db, orgCode: string): Promise<SupportConnections> {
  // Đường đọc trạng thái DUY NHẤT của sổ kết nối (không bí mật, không cấu hình); dòng mang mã tổ chức khác là dây bẫy.
  const rows = (await connectionStatusRows(db)).filter((r) => r.orgCode === orgCode);
  const last = rows.reduce<Date | null>((a, r) => (r.lastTestAt && (!a || r.lastTestAt > a) ? r.lastTestAt : a), null);
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "ACTIVE").length,
    disabled: rows.filter((r) => r.status === "DISABLED").length,
    draft: rows.filter((r) => r.status === "DRAFT").length,
    failingTests: rows.filter((r) => r.lastTestOk === false).length,
    lastTestAt: iso(last),
  };
}

async function lastActivity(db: Db): Promise<SupportActivity> {
  // Chỉ MỐC + LOẠI. Không `detail`, không email, không `payload`, không `subject_id`.
  const [a] = await db.select({ at: schema.auditLogs.createdAt, action: schema.auditLogs.action }).from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(1);
  const [e] = await db.select({ at: schema.domainEvents.recordedAt, name: schema.domainEvents.name }).from(schema.domainEvents).orderBy(desc(schema.domainEvents.recordedAt)).limit(1);
  return { audit: a ? { at: a.at.toISOString(), action: a.action } : null, event: e ? { at: e.at.toISOString(), name: e.name } : null };
}

async function errors(db: Db, orgCode: string, now: Date): Promise<SupportErrors> {
  const s = schema.syncRuns;
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [r] = await db.select({ n: count(), last: max(s.startedAt) }).from(s).where(and(eq(s.status, "FAILED"), gte(s.startedAt, since)));
  const blocks = recentFailures(orgCode);
  return { failedJobs7d: Number(r?.n ?? 0), lastFailedJobAt: iso(r?.last), blockFailures: blocks.failures.length, blockSince: new Date(blocks.since).toISOString() };
}

async function backup(org: Organization, now: Date): Promise<SupportBackup> {
  const target = backupTargetFor(org);
  const h = evaluateBackupHealth(await readBackupStatusFiles(backupStatusDir(), target), now, target);
  return { state: h.state, reason: h.reason, lastSuccessAt: iso(h.lastSuccess?.finishedAt), ageHours: h.ageHours };
}

/**
 * Mở trang sức khoẻ MỘT tổ chức. Người không phải người vận hành ⇒ `FORBIDDEN` (không một câu nào vào CSDL tổ chức,
 * không dòng nhật ký — họ không mở được gì). Ghi vết TRƯỚC khi đọc; vết hỏng ⇒ `AUDIT_FAILED`, không mở.
 */
export async function loadOrgSupport(user: SessionUser, code: string, opts: { source?: PlatformAuditSource } = {}): Promise<OrgSupportResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, code: "FORBIDDEN", error: denial };
  const org = typeof code === "string" && ORGANIZATION_CODE_PATTERN.test(code) ? await findOrganization(code) : null;
  if (!org) return { ok: false, code: "NOT_FOUND", error: `Không có tổ chức mã «${String(code).slice(0, 40)}» trong sổ.` };
  const now = new Date();
  try {
    await platformAudit({
      action: "SUPPORT_VIEW",
      targetOrgCode: org.code,
      subject: "support_page",
      after: { page: "/platform/org", at: now.toISOString() },
      source: opts.source ?? "UI",
      actor: { orgCode: user.organization!.code, userId: user.id, email: user.email },
    });
  } catch {
    return { ok: false, code: "AUDIT_FAILED", error: "Không ghi được vết truy cập hỗ trợ vào nhật ký nền tảng — không mở trang sức khoẻ của tổ chức." };
  }

  const [pilot, switches, bk] = [await loadPilotView(org), await killSwitchState(org), await backup(org, now).catch((e: unknown): SupportBackup => ({ state: "UNKNOWN", reason: `Không đọc được trạng thái sao lưu (${e instanceof Error ? e.name : "lỗi"}).`, lastSuccessAt: null, ageHours: null }))];
  const aiUsage = await measure("sổ dùng AI", () => aiUsageOf(org.code, now));
  const base = {
    checkedAt: now.toISOString(),
    organization: { code: org.code, name: org.name, status: org.status, isHome: org.isHome, planKey: planKeyOf(org) },
    pilot,
    killSwitches: switches,
    aiUsage,
    backup: bk,
  };

  let db: Db;
  try {
    db = await getDbFor(org);
    await db.execute(sql`select 1`);
  } catch (error) {
    const none = { value: null, note: `Chưa đo — không mở được CSDL của tổ chức (${error instanceof Error ? error.name : "lỗi"}).` };
    return { ok: true, value: { ...base, users: none, storage: none, automation: none, connections: none, lastActivity: none, errors: none } };
  }
  // Tuần tự: một CSDL, bể kết nối nhỏ — không dựng bão truy vấn vào CSDL của khách.
  const value: OrgSupport = {
    ...base,
    users: await measure("người dùng", () => users(db)),
    storage: await measure("dung lượng", () => storage(db)),
    automation: await measure("luật tự động", () => automation(db, now)),
    connections: await measure("kết nối", () => connections(db, org.code)),
    lastActivity: await measure("hoạt động cuối", () => lastActivity(db)),
    errors: await measure("lỗi job", () => errors(db, org.code, now)),
  };
  return { ok: true, value };
}

// ═══════════ TÓM TẮT cho bảng `/platform` (không ghi vết: chỉ giai đoạn, cờ, số người, mốc đăng nhập) ═══════════

export type OrgSupportSummary = { stage: PilotStage | null; workflowsPaused: boolean; activeUsers: number | null; lastLoginAt: string | null; note: string | null };

export async function listOrgSupportSummaries(user: SessionUser): Promise<Record<string, OrgSupportSummary>> {
  if (platformOperatorDenial(user)) return {};
  const [orgs, stages] = [await listOrganizations(), await listPilotStages()];
  const out: Record<string, OrgSupportSummary> = {};
  for (const org of orgs) {
    const paused = (await readOrgFlag(org.code, WORKFLOWS_PAUSED_FLAG).catch(() => null))?.enabled === true;
    let activeUsers: number | null = null;
    let lastLoginAt: string | null = null;
    let note: string | null = null;
    try {
      const u = await users(await getDbFor(org));
      activeUsers = u.active;
      lastLoginAt = u.lastLoginAt;
    } catch (error) {
      note = `Chưa đo (${error instanceof Error ? error.name : "lỗi"}).`;
    }
    out[org.code] = { stage: stages[org.code] ?? null, workflowsPaused: paused, activeUsers, lastLoginAt, note };
  }
  return out;
}
