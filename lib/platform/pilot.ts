import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { connectionStatusRows } from "@/lib/connectors/service";
import { evaluateBackupHealth } from "@/lib/constants/backup";
import {
  evaluatePilotChecklist,
  isPilotStage,
  missingForStage,
  PILOT_REASON_MIN,
  PILOT_STAGE_LABEL,
  PILOT_STAGES,
  planPilotTransition,
  type PilotCheck,
  type PilotFacts,
  type PilotStage,
} from "@/lib/constants/pilot";
import { moduleDef } from "@/lib/constants/platform-modules";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import type { Organization } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { backupStatusDir, backupTargetFor, readBackupStatusFiles } from "@/lib/queries/backup-status";

/**
 * ═══════════ VÒNG ĐỜI KHÁCH PILOT — ĐƯỜNG ĐỌC + ĐƯỜNG GHI DUY NHẤT CỦA `platform_organizations.pilot_stage` ═══════════
 *
 * Luật (thuần) ở `lib/constants/pilot.ts`; tệp này ĐO sự kiện từ dữ liệu thật và GHI giai đoạn. Không nơi nào khác ghi
 * cột `pilot_stage` hay `settings.pilot`.
 *
 *  · ĐO: mở CSDL của tổ chức bằng `getDbFor` (như chẩn đoán H4) — chỉ ĐẾM, không đọc một dòng nghiệp vụ nào; đọc cấu
 *    hình module ở control plane; đọc trạng thái sao lưu của ĐÚNG CSDL tổ chức (`backupTargetFor`). Đo không được ⇒
 *    `null` ⇒ mục `UNKNOWN` ⇒ không cho qua cổng (không kết luận được thì không cho qua).
 *  · GHI: chỉ người vận hành nền tảng (`platformOperatorDenial`); một câu `UPDATE` có ĐIỀU KIỆN trên giai đoạn cũ (hai
 *    người bấm cùng lúc thì một người thua, không ai đè ai); rồi `platform_audit_log` (`PILOT_STAGE`, kèm danh sách
 *    kiểm lúc bấm + cờ ghi đè). Nhật ký hỏng ⇒ hoàn giai đoạn cũ, báo lỗi — một cổng bị vượt mà không có vết thì không
 *    được tồn tại.
 *  · Hai bước TỰ ĐỘNG của luồng `/start` (máy, có nhật ký): tổ chức mới ⇒ `CREATED`; cài mẫu xong ⇒ `CONFIGURING`.
 */

export type PilotUat = { at: string; byEmail: string | null; byOrg: string | null; note: string };
export type PilotRecord = { orgCode: string; isHome: boolean; status: string; stage: PilotStage | null; uat: PilotUat | null; stageChangedAt: string | null };

type Row = typeof schema.platformOrganizations.$inferSelect;

async function orgRow(code: string): Promise<Row | undefined> {
  const pdb = await getPlatformDb();
  return pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
}

function pilotSettings(row: Row): Record<string, unknown> {
  const raw = (row.settings as Record<string, unknown> | null)?.pilot;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function uatOf(pilot: Record<string, unknown>): PilotUat | null {
  const u = pilot.uat as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object" || typeof u.at !== "string" || typeof u.note !== "string") return null;
  return { at: u.at, note: u.note, byEmail: typeof u.byEmail === "string" ? u.byEmail : null, byOrg: typeof u.byOrg === "string" ? u.byOrg : null };
}

function recordOf(row: Row): PilotRecord {
  const pilot = pilotSettings(row);
  return {
    orgCode: row.code,
    isHome: row.isHome,
    status: row.status,
    stage: isPilotStage(row.pilotStage) ? row.pilotStage : null,
    uat: uatOf(pilot),
    stageChangedAt: typeof pilot.stageChangedAt === "string" ? pilot.stageChangedAt : null,
  };
}

export async function readPilotRecord(code: string): Promise<PilotRecord | null> {
  const row = await orgRow(code);
  return row ? recordOf(row) : null;
}

/** Giai đoạn của mọi tổ chức (cho cột tóm tắt ở `/platform`) — một câu ở control plane. */
export async function listPilotStages(): Promise<Record<string, PilotStage | null>> {
  const pdb = await getPlatformDb();
  const rows = await pdb.select({ code: schema.platformOrganizations.code, stage: schema.platformOrganizations.pilotStage }).from(schema.platformOrganizations);
  return Object.fromEntries(rows.map((r) => [r.code, isPilotStage(r.stage) ? r.stage : null]));
}

// ═══════════ ĐO ═══════════

async function num(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Khoá blueprint đã cài xong (lượt DONE) — chỉ khoá, không nội dung. */
async function doneInstallKeys(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ key: schema.blueprintInstalls.blueprintKey }).from(schema.blueprintInstalls).where(eq(schema.blueprintInstalls.status, "DONE"));
  return rows.map((r) => r.key);
}

async function backupSucceeded(org: Organization): Promise<boolean | null> {
  try {
    const target = backupTargetFor(org);
    const files = await readBackupStatusFiles(backupStatusDir(), target);
    if (!files.dirReadable) return null;
    return evaluateBackupHealth(files, new Date(), target).lastSuccess !== null;
  } catch {
    return null;
  }
}

export type PilotMeasurement = { facts: PilotFacts; suggested: string[]; connectNote: string | null };

/**
 * Đo sự kiện của danh sách kiểm. Tuần tự, một CSDL — không dựng bão truy vấn vào CSDL khách. CSDL không mở được ⇒ mọi
 * mục từ CSDL là `null` (UNKNOWN) kèm lý do, cấu hình module + sao lưu vẫn đo.
 */
export async function measurePilot(org: Organization, record: PilotRecord | null): Promise<PilotMeasurement> {
  const enabled = await getEnabledModules(org.code).catch(() => null);
  const nonCoreModules = enabled ? [...enabled].filter((k) => !moduleDef(k)?.core).length : null;
  const backup = await backupSucceeded(org);
  const uatConfirmed = Boolean(record?.uat);
  let db: Db | null = null;
  let connectNote: string | null = null;
  try {
    db = await getDbFor(org);
    await db.execute(sql`select 1`);
  } catch (error) {
    db = null;
    connectNote = `Không mở được CSDL của tổ chức: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
  }
  if (!db) {
    return {
      facts: { doneInstalls: null, activeAdmins: null, activeUsers: null, nonCoreModules, suggestedIntegrations: null, testedConnections: null, publishedPages: null, liveRules: null, activeRules: null, backupSucceeded: backup, uatConfirmed },
      suggested: [],
      connectNote,
    };
  }
  const d = db;
  let keys: string[] | null = null;
  try {
    keys = await doneInstallKeys(d);
  } catch {
    keys = null;
  }
  // Gợi ý kết nối = `integrations` của MẪU đã cài, lọc như lượt cắt mẫu của /start (connector mà module phụ thuộc chưa
  // bật thì mẫu đã bỏ). Blueprint không phải mẫu dựng sẵn (trắng / AI / từ tệp) ⇒ không gợi ý gì.
  const suggested = keys
    ? [
        ...new Set(
          keys.flatMap((k) => (templateBlueprint(k)?.integrations ?? []).filter((i) => (moduleDef(i.connectorKey)?.dependsOn ?? []).every((dep) => !enabled || enabled.has(dep))).map((i) => i.connectorKey)),
        ),
      ]
    : [];
  const u = schema.users;
  const facts: PilotFacts = {
    doneInstalls: keys ? keys.length : null,
    activeAdmins: await num(async () => Number((await d.select({ n: count() }).from(u).where(and(eq(u.active, true), eq(u.role, "ADMIN"))))[0]?.n ?? 0)),
    activeUsers: await num(async () => Number((await d.select({ n: count() }).from(u).where(eq(u.active, true)))[0]?.n ?? 0)),
    nonCoreModules,
    suggestedIntegrations: keys ? suggested.length : null,
    // Đường đọc trạng thái DUY NHẤT của sổ kết nối; dòng mang mã tổ chức khác (dây bẫy) không tính.
    testedConnections: await num(async () => (await connectionStatusRows(d)).filter((r) => r.orgCode === org.code && r.lastTestOk === true).length),
    publishedPages: await num(async () => Number((await d.select({ n: count() }).from(schema.metaPages).where(and(ne(schema.metaPages.status, "ARCHIVED"), sql`${schema.metaPages.published} is not null`)))[0]?.n ?? 0)),
    liveRules: await num(async () => Number((await d.select({ n: count() }).from(schema.workflowRules).where(ne(schema.workflowRules.status, "ARCHIVED")))[0]?.n ?? 0)),
    activeRules: await num(async () => Number((await d.select({ n: count() }).from(schema.workflowRules).where(eq(schema.workflowRules.status, "ACTIVE")))[0]?.n ?? 0)),
    backupSucceeded: backup,
    uatConfirmed,
  };
  return { facts, suggested, connectNote };
}

export type PilotView = {
  record: PilotRecord;
  checks: PilotCheck[];
  suggested: { key: string; label: string }[];
  connectNote: string | null;
  /** Bậc kế tiếp (null = đã ở bậc cuối, hoặc tổ chức nhà). */
  next: PilotStage | null;
  missingNext: PilotCheck[];
};

export async function loadPilotView(org: Organization): Promise<PilotView | null> {
  const record = await readPilotRecord(org.code);
  if (!record) return null;
  const m = await measurePilot(org, record);
  const checks = evaluatePilotChecklist(m.facts);
  const idx = record.stage ? PILOT_STAGES.indexOf(record.stage) : -1;
  const next = org.isHome ? null : record.stage === null ? "CREATED" : (PILOT_STAGES[idx + 1] ?? null);
  return {
    record,
    checks,
    suggested: m.suggested.map((k) => ({ key: k, label: moduleDef(k)?.label ?? k })),
    connectNote: m.connectNote,
    next,
    missingNext: next && record.stage !== null ? missingForStage(next, checks) : [],
  };
}

// ═══════════ GHI ═══════════

export type PilotWriteResult = { ok: true; changed: boolean; stage: PilotStage | null; override?: boolean } | { error: string };

function actorOf(user: SessionUser): NonNullable<PlatformActor> {
  return { orgCode: user.organization!.code, userId: user.id, email: user.email };
}

/** Ghi giai đoạn có điều kiện (giai đoạn cũ phải còn đúng `from`). `patch` gộp vào `settings.pilot`. */
async function writeStage(code: string, from: PilotStage | null, to: PilotStage | null, patch: Record<string, unknown>): Promise<boolean> {
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const won = await pdb
    .update(t)
    .set({
      pilotStage: to,
      settings: sql`jsonb_set(coalesce(${t.settings}, '{}'::jsonb), '{pilot}', coalesce(${t.settings}->'pilot', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(eq(t.code, code), from === null ? isNull(t.pilotStage) : eq(t.pilotStage, from)))
    .returning({ id: t.id });
  invalidateOrganizations();
  return won.length > 0;
}

/**
 * Người vận hành chuyển giai đoạn. `override` + lý do ≥ 10 ký tự mới vượt được danh sách kiểm chưa đạt; KHÔNG BAO GIỜ
 * nhảy bậc. Lùi bậc về dưới «Sẵn sàng UAT» thì xoá xác nhận UAT cũ (cấu hình sẽ đổi — UAT cũ không còn chứng minh gì).
 */
export async function setPilotStage(user: SessionUser, input: unknown): Promise<PilotWriteResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; stage?: unknown; reason?: unknown; override?: unknown };
  const code = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  if (!isPilotStage(raw.stage)) return { error: `Giai đoạn chỉ nhận ${PILOT_STAGES.join(" · ")}.` };
  const to = raw.stage;
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  const org = code ? await findOrganization(code) : null;
  if (!org) return { error: `Không có tổ chức mã «${code.slice(0, 40)}».` };
  if (org.isHome) return { error: "Tổ chức nhà không có vòng đời pilot." };
  const record = await readPilotRecord(org.code);
  if (!record) return { error: `Không có tổ chức mã «${code}».` };
  const view = await measurePilot(org, record);
  const checks = evaluatePilotChecklist(view.facts);
  const verdict = planPilotTransition({ from: record.stage, to, checks, override: raw.override === true, reason });
  if (!verdict.ok) return { error: verdict.error };
  if (verdict.direction === "SAME") return { ok: true, changed: false, stage: record.stage };

  const now = new Date().toISOString();
  const clearUat = verdict.direction === "BACKWARD" && PILOT_STAGES.indexOf(to) < PILOT_STAGES.indexOf("READY_FOR_UAT") && record.uat !== null;
  const patch: Record<string, unknown> = { stageChangedAt: now, ...(clearUat ? { uat: null } : {}) };
  if (!(await writeStage(org.code, record.stage, to, patch))) return { error: "Giai đoạn vừa được người khác đổi — tải lại trang rồi xem lại." };
  try {
    await platformAudit({
      action: "PILOT_STAGE",
      targetOrgCode: org.code,
      subject: "pilot_stage",
      before: { stage: record.stage },
      after: {
        stage: to,
        direction: verdict.direction,
        override: verdict.override,
        // Danh sách kiểm LÚC BẤM — người đọc nhật ký thấy cổng nào đã bị vượt, không phải cổng của hôm nay.
        checklist: checks.map((c) => ({ key: c.key, state: c.state })),
        missing: verdict.missing.map((c) => c.key),
        ...(clearUat ? { uatCleared: true } : {}),
      },
      reason: reason || null,
      source: "UI",
      actor: actorOf(user),
    });
  } catch {
    await writeStage(org.code, to, record.stage, clearUat ? { stageChangedAt: record.stageChangedAt, uat: record.uat } : { stageChangedAt: record.stageChangedAt });
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại giai đoạn cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true, stage: to, override: verdict.override };
}

/** Người vận hành xác nhận UAT (chỉ ở «Sẵn sàng UAT»), kèm ghi chú — đó là mục cuối của cổng sang «Đang dùng thật». */
export async function confirmPilotUat(user: SessionUser, input: unknown): Promise<PilotWriteResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; note?: unknown };
  const code = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) : "";
  if (note.length < PILOT_REASON_MIN) return { error: `Ghi chú UAT (ít nhất ${PILOT_REASON_MIN} ký tự): ai đã thử, thử những gì.` };
  const org = code ? await findOrganization(code) : null;
  if (!org || org.isHome) return { error: `Không có tổ chức pilot mã «${code.slice(0, 40)}».` };
  const record = await readPilotRecord(org.code);
  if (!record || record.stage !== "READY_FOR_UAT") return { error: `Chỉ xác nhận UAT được khi tổ chức ở «${PILOT_STAGE_LABEL.READY_FOR_UAT}».` };
  const actor = actorOf(user);
  const uat: PilotUat = { at: new Date().toISOString(), byEmail: actor.email, byOrg: actor.orgCode, note };
  if (!(await writeStage(org.code, "READY_FOR_UAT", "READY_FOR_UAT", { uat }))) return { error: "Giai đoạn vừa được người khác đổi — tải lại trang." };
  try {
    await platformAudit({ action: "PILOT_UAT", targetOrgCode: org.code, subject: "pilot_uat", before: { uat: record.uat }, after: { uat: { at: uat.at } }, reason: note, source: "UI", actor });
  } catch {
    await writeStage(org.code, "READY_FOR_UAT", "READY_FOR_UAT", { uat: record.uat });
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại, chưa xác nhận." };
  }
  return { ok: true, changed: true, stage: "READY_FOR_UAT" };
}

// ─── Hai bước tự động của luồng /start (máy làm, có nhật ký) ───

async function systemStep(code: string, from: PilotStage | null, to: PilotStage, reason: string, source: PlatformAuditSource, actor: PlatformActor): Promise<boolean> {
  const moved = await writeStage(code, from, to, { stageChangedAt: new Date().toISOString() });
  if (moved) await platformAudit({ action: "PILOT_STAGE", targetOrgCode: code, subject: "pilot_stage", before: { stage: from }, after: { stage: to, direction: from === null ? "START" : "FORWARD", override: false, automatic: true }, reason, source, actor });
  return moved;
}

/** Tổ chức MỚI vừa có dòng trong sổ qua `/start` ⇒ `CREATED`. Chỉ khi chưa có giai đoạn (không đè). */
export async function markPilotCreated(code: string, actor: PlatformActor, source: PlatformAuditSource = "UI"): Promise<boolean> {
  return systemStep(code, null, "CREATED", "Tổ chức mới tạo qua luồng /start", source, actor);
}

/** Cài mẫu xong ⇒ `CREATED` → `CONFIGURING`. Giai đoạn khác thì không đụng (người vận hành đã đổi tay). */
export async function markPilotConfigured(code: string, actor: PlatformActor, source: PlatformAuditSource = "UI"): Promise<boolean> {
  return systemStep(code, "CREATED", "CONFIGURING", "Cài mẫu xong trong luồng /start", source, actor);
}
