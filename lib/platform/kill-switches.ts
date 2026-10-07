import { and, desc, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { disableConnectionAsOperator } from "@/lib/connectors/service";
import { platformAudit } from "@/lib/platform/audit";
import { withOrganization } from "@/lib/platform/context";
import { AI_BALANCE_FLAG, readOrgFlag, WORKFLOWS_PAUSED_FLAG, writeOrgFlag } from "@/lib/platform/org-flags";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN, type Organization } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ CÔNG TẮC KHẨN CỦA NGƯỜI VẬN HÀNH NỀN TẢNG — KHÔNG DEPLOY (docs/platform/pilot-operations.md §4) ═══════════
 *
 * Ba công tắc theo tổ chức, mỗi cái đi qua ĐÚNG đường ghi đã có của miền nó chạm (không ghi thẳng bảng của miền khác):
 *
 *  1. ĐÌNH CHỈ tổ chức — `platform_organizations.status` ACTIVE ⇄ SUSPENDED. Hiệu lực do cơ chế SẴN CÓ: phiên của
 *     tổ chức bị từ chối ở lượt request kế tiếp (`currentOrganization` ⇒ ORG_INACTIVE), `withOrganization` ném ⇒ webhook /
 *     việc nền bị từ chối, lịch fan-out bỏ tổ chức ra, `runJob` trả SKIPPED `ORG_INACTIVE`. Cùng tiến trình: tức thì
 *     (xoá đệm sổ); tiến trình khác: trễ tối đa 10 giây (đệm sổ tổ chức). Không xoá / đổi một dòng dữ liệu nào của khách.
 *  2. TẠM DỪNG LUẬT — cờ `workflows.paused` (`platform_flag_overrides`). `runWorkflows` hỏi cờ TRƯỚC mọi thứ và trả
 *     `paused`: con trỏ không tiến, lượt chờ duyệt giữ nguyên; bật lại thì chạy tiếp đúng từ chỗ dừng, không nhân đôi.
 *  3. TẮT KẾT NỐI — `disableConnectionAsOperator` của `lib/connectors/service.ts`, trong ngữ cảnh của tổ chức đích (nhật
 *     ký CỦA tổ chức ghi người vận hành + lý do). Chỉ TẮT; bật lại là việc của quản trị tổ chức sau một lần kiểm đạt.
 *
 * Mọi công tắc: chỉ `platformOperatorDenial(user) === null` (người của tổ chức nhà có `platform:operate`), bắt buộc lý do
 * (≥ 5 ký tự), ghi `platform_audit_log`. Nhật ký hỏng ⇒ hoàn trạng thái cũ (trừ tắt kết nối — đã tắt là phía an toàn).
 *
 * Tắt AI: sổ hạn mức AI (`lib/ai-usage/control.ts`) — nút ở khung «Dùng AI» của `/platform/org/<mã>`. Tắt đăng ký công khai: cổng B ở
 * `/platform` (`lib/onboarding/signup-mode.ts`) — khung công tắc khẩn chỉ hiện trạng thái và dẫn tới đó.
 */

export const KILL_SWITCH_REASON_MIN = 5;

export type KillSwitchResult = { ok: true; changed: boolean; message: string } | { error: string };

type Actor = { orgCode: string; userId: string; email: string };

type Parsed = { org: Organization; reason: string; actor: Actor };

async function parseCommon(user: SessionUser, raw: { orgCode?: unknown; reason?: unknown }): Promise<Parsed | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const code = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return { error: "Mã tổ chức không hợp lệ." };
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi lý do (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào nhật ký nền tảng và người của tổ chức sẽ hỏi.` };
  const org = await findOrganization(code);
  if (!org) return { error: `Không có tổ chức mã «${code}».` };
  return { org, reason, actor: { orgCode: user.organization!.code, userId: user.id, email: user.email } };
}

async function setStatus(code: string, from: string, to: string): Promise<boolean> {
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const won = await pdb.update(t).set({ status: to, updatedAt: new Date() }).where(and(eq(t.code, code), eq(t.status, from))).returning({ id: t.id });
  invalidateOrganizations();
  return won.length > 0;
}

/** 1 · Đình chỉ / bật lại MỘT tổ chức. Tổ chức nhà không đình chỉ được từ đây (đó là tổ chức của chính người bấm). */
export async function setOrganizationSuspended(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; suspend?: unknown };
  const p = await parseCommon(user, raw);
  if ("error" in p) return p;
  if (typeof raw.suspend !== "boolean") return { error: "Thiếu hướng: đình chỉ hay bật lại." };
  const { org, reason, actor } = p;
  if (org.isHome) return { error: "Không đình chỉ được tổ chức nhà từ màn hình này — đó là tổ chức của chính người vận hành. Tắt khẩn nhà là việc ở máy chủ." };
  const [from, to] = raw.suspend ? ["ACTIVE", "SUSPENDED"] : ["SUSPENDED", "ACTIVE"];
  if (org.status === to) return { ok: true, changed: false, message: raw.suspend ? "Tổ chức đã đình chỉ sẵn." : "Tổ chức đang chạy sẵn." };
  if (org.status !== from) return { error: `Tổ chức đang ${org.status} — công tắc này chỉ chuyển ACTIVE ⇄ SUSPENDED.` };
  if (!(await setStatus(org.code, from, to))) return { error: "Trạng thái vừa được người khác đổi — tải lại trang." };
  try {
    await platformAudit({ action: "ORG_STATUS", targetOrgCode: org.code, subject: "kill_switch.suspend", before: { status: from }, after: { status: to }, reason, source: "UI", actor });
  } catch {
    await setStatus(org.code, to, from);
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại trạng thái cũ, chưa đổi gì." };
  }
  return {
    ok: true,
    changed: true,
    message: raw.suspend
      ? `Đã đình chỉ «${org.name}»: phiên đang mở bị chặn ở lượt bấm kế tiếp, job và webhook của tổ chức bị bỏ qua. Dữ liệu giữ nguyên.`
      : `Đã bật lại «${org.name}».`,
  };
}

/** 2 · Tạm dừng / chạy lại MỌI luật tự động của một tổ chức (kể cả nhà — không khoá người vận hành ra ngoài). */
export async function setWorkflowsPaused(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; paused?: unknown };
  const p = await parseCommon(user, raw);
  if ("error" in p) return p;
  if (typeof raw.paused !== "boolean") return { error: "Thiếu hướng: tạm dừng hay chạy lại." };
  const { org, reason, actor } = p;
  const before = await readOrgFlag(org.code, WORKFLOWS_PAUSED_FLAG, { fresh: true });
  const wasPaused = before?.enabled === true;
  if (wasPaused === raw.paused) return { ok: true, changed: false, message: raw.paused ? "Luật tự động đã tạm dừng sẵn." : "Luật tự động đang chạy sẵn." };
  const by = `${actor.orgCode}:${actor.userId}`;
  await writeOrgFlag(org.id, WORKFLOWS_PAUSED_FLAG, raw.paused, by);
  try {
    await platformAudit({ action: "FLAG_SET", targetOrgCode: org.code, subject: WORKFLOWS_PAUSED_FLAG, before: { enabled: wasPaused }, after: { enabled: raw.paused }, reason, source: "UI", actor });
  } catch {
    await writeOrgFlag(org.id, WORKFLOWS_PAUSED_FLAG, wasPaused, before?.updatedBy ?? by);
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại, chưa đổi gì." };
  }
  return {
    ok: true,
    changed: true,
    message: raw.paused
      ? `Đã tạm dừng luật tự động của «${org.name}»: lượt chạy kế tiếp bỏ qua tổ chức này, lượt chờ duyệt giữ nguyên.`
      : `Đã cho chạy lại luật tự động của «${org.name}» — lượt kế tiếp xét tiếp từ chỗ dừng, không làm lại việc đã làm.`,
  };
}

/**
 * Bật / tắt Số dư AI + nạp QR cho MỘT tổ chức (canary — 0235). Cùng đường ghi cờ + nhật ký như công tắc 2; tắt lại KHÔNG
 * đụng tiền đã nạp (sổ cái giữ nguyên, tiền về muộn vẫn được cộng) — chỉ ẩn màn khách và chặn tạo phiếu nạp mới.
 */
export async function setAiBalanceEnabled(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; enabled?: unknown };
  const p = await parseCommon(user, raw);
  if ("error" in p) return p;
  if (typeof raw.enabled !== "boolean") return { error: "Thiếu hướng: bật hay tắt Số dư AI." };
  const { org, reason, actor } = p;
  const before = await readOrgFlag(org.code, AI_BALANCE_FLAG, { fresh: true });
  const was = before?.enabled === true;
  if (was === raw.enabled) return { ok: true, changed: false, message: raw.enabled ? "Số dư AI đã bật sẵn." : "Số dư AI đang tắt sẵn." };
  const by = `${actor.orgCode}:${actor.userId}`;
  await writeOrgFlag(org.id, AI_BALANCE_FLAG, raw.enabled, by);
  try {
    await platformAudit({ action: "FLAG_SET", targetOrgCode: org.code, subject: AI_BALANCE_FLAG, before: { enabled: was }, after: { enabled: raw.enabled }, reason, source: "UI", actor });
  } catch {
    await writeOrgFlag(org.id, AI_BALANCE_FLAG, was, before?.updatedBy ?? by);
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại, chưa đổi gì." };
  }
  return { ok: true, changed: true, message: raw.enabled ? `Đã bật Số dư AI cho «${org.name}».` : `Đã tắt Số dư AI của «${org.name}» — tiền đã nạp giữ nguyên.` };
}

/** 3 · Tắt MỘT kết nối của tổ chức, qua đường ghi của sổ kết nối. */
export async function disableOrgConnection(user: SessionUser, input: unknown): Promise<KillSwitchResult> {
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; reason?: unknown; connectorKey?: unknown };
  const p = await parseCommon(user, raw);
  if ("error" in p) return p;
  const { org, reason, actor } = p;
  const connectorKey = typeof raw.connectorKey === "string" ? raw.connectorKey.trim().slice(0, 64) : "";
  if (!connectorKey) return { error: "Thiếu connector." };
  if (org.status !== "ACTIVE") return { error: `Tổ chức đang ${org.status} — không kết nối nào của nó chạy. Bật lại tổ chức trước nếu cần tắt riêng một kết nối.` };
  const r = await withOrganization(org.code, () => disableConnectionAsOperator({ connectorKey, operator: actor, reason }));
  if ("error" in r) return r;
  if (!r.changed) return { ok: true, changed: false, message: r.message ?? "Kết nối đã tắt sẵn." };
  try {
    await platformAudit({ action: "CONNECTION_DISABLE", targetOrgCode: org.code, subject: `connection:${connectorKey}`, before: null, after: { status: "DISABLED" }, reason, source: "UI", actor });
  } catch {
    // Đã tắt là phía AN TOÀN: không bật lại chỉ vì nhật ký nền tảng hỏng — nhật ký của tổ chức đã có dòng.
    return { ok: true, changed: true, message: `${r.message ?? "Đã tắt."} (Không ghi được nhật ký nền tảng — nhật ký của tổ chức vẫn có dòng.)` };
  }
  return { ok: true, changed: true, message: r.message ?? "Đã tắt." };
}

/** Kiểm người vận hành + mã tổ chức đích + lý do — dùng chung cho mọi thao tác ghi của người vận hành lên một tổ chức. */
export const parseOperatorTarget = parseCommon;

// ═══════════ ĐỌC — trạng thái công tắc của một tổ chức ═══════════

export type SwitchReason = { at: string; byEmail: string | null; reason: string | null } | null;

export type KillSwitchState = {
  orgCode: string;
  isHome: boolean;
  status: string;
  suspended: boolean;
  lastStatusChange: SwitchReason;
  workflowsPaused: boolean;
  lastPauseChange: SwitchReason;
};

async function lastAudit(orgCode: string, action: "ORG_STATUS" | "FLAG_SET", subject: string): Promise<SwitchReason> {
  const pdb = await getPlatformDb();
  const a = schema.platformAuditLog;
  const [row] = await pdb
    .select({ at: a.at, byEmail: a.actorEmail, reason: a.reason })
    .from(a)
    .where(and(eq(a.targetOrgCode, orgCode), eq(a.action, action), eq(a.subject, subject)))
    .orderBy(desc(a.at))
    .limit(1);
  return row ? { at: row.at.toISOString(), byEmail: row.byEmail, reason: row.reason } : null;
}

export async function killSwitchState(org: Organization): Promise<KillSwitchState> {
  const flag = await readOrgFlag(org.code, WORKFLOWS_PAUSED_FLAG, { fresh: true });
  return {
    orgCode: org.code,
    isHome: org.isHome,
    status: org.status,
    suspended: org.status === "SUSPENDED",
    lastStatusChange: await lastAudit(org.code, "ORG_STATUS", "kill_switch.suspend"),
    workflowsPaused: flag?.enabled === true,
    lastPauseChange: await lastAudit(org.code, "FLAG_SET", WORKFLOWS_PAUSED_FLAG),
  };
}

/** Mã các tổ chức đang bị tạm dừng luật (cho khung toàn nền tảng ở `/platform`). */
export async function pausedWorkflowOrgCodes(orgs: readonly Organization[]): Promise<string[]> {
  const out: string[] = [];
  for (const o of orgs) if ((await readOrgFlag(o.code, WORKFLOWS_PAUSED_FLAG))?.enabled) out.push(o.code);
  return out;
}
