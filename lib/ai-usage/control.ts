/**
 * ═══════════ CÔNG TẮC AI + GHI ĐÈ HẠN MỨC THEO TỔ CHỨC (docs/platform/ai-usage.md §4) — CHỈ MÁY CHỦ ═══════════
 *
 * Hai công tắc, KHÔNG cần deploy, đọc qua đệm ≤ 30 giây (`AI_CONTROL_CACHE_MS`, bài kiểm khoá con số):
 *  · TOÀN NỀN TẢNG — `platform_settings['platform.ai.enabled']` (jsonb `true` / `false`). THIẾU dòng ⇒ BẬT: AI Builder
 *    đang chạy trên production, migration không được tự tắt nó.
 *  · THEO TỔ CHỨC — `platform_organizations.settings.ai.disabled`. Cùng chỗ đó giữ ghi đè hạn mức THƯA
 *    (`settings.ai.limits`, xem `AiLimitsOverride`).
 * Tắt ⇒ AI Builder trả `AI_DISABLED_BY_OPERATOR` TRƯỚC khi chọn provider — không một byte nào rời máy. Copilot và job AI
 * của tổ chức nhà KHÔNG đi qua công tắc này (chúng có trần tiền ngày riêng — `lib/ai/budget.ts`).
 *
 * ─── HỎNG VỀ PHÍA ĐÓNG ───
 * Không đọc được công tắc (CSDL hỏng) ⇒ coi như TẮT, và KHÔNG đệm lỗi để lượt sau đọc lại (AGENTS.md luật 31).
 *
 * ─── GHI ───
 * Chỉ người vận hành nền tảng (`platformOperatorDenial`), bắt buộc lý do, mọi lượt đổi ghi `platform_audit_log` TRƯỚC
 * khi coi là xong — ghi nhật ký hỏng thì hoàn lại giá trị cũ.
 */
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { platformAudit } from "@/lib/platform/audit";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { AI_DISABLED_BY_OPERATOR, AI_LIMIT_OVERRIDE_KEYS, parseAiOverride, type AiLimitsOverride } from "@/lib/ai-usage/types";

export const PLATFORM_AI_SWITCH_KEY = "platform.ai.enabled";
/** Đệm công tắc + ghi đè trong tiến trình. Bài kiểm khoá ≤ 30 giây. */
export const AI_CONTROL_CACHE_MS = 10_000;

export type PlatformAiSwitch = { enabled: boolean; stored: boolean; updatedAt: string | null; updatedByEmail: string | null; readError: boolean };
export type OrgAiControl = { disabled: boolean; limits: AiLimitsOverride; updatedAt: string | null; updatedByEmail: string | null; readError: boolean };

type Entry<T> = { at: number; value: T };
const holder = globalThis as unknown as { __erpAiControl?: { platform: Entry<PlatformAiSwitch> | null; orgs: Map<string, Entry<OrgAiControl>> } };
if (!holder.__erpAiControl) holder.__erpAiControl = { platform: null, orgs: new Map() };
const cache = holder.__erpAiControl;

/** Xoá đệm (lượt ghi gọi; bài kiểm gọi sau khi ghi thẳng vào bảng). */
export function invalidateAiControl() {
  cache.platform = null;
  cache.orgs.clear();
}

const fresh = (at: number, now: number) => now - at >= 0 && now - at < AI_CONTROL_CACHE_MS;

export async function readPlatformAiSwitch(opts: { now?: number; fresh?: boolean } = {}): Promise<PlatformAiSwitch> {
  const now = opts.now ?? Date.now();
  if (!opts.fresh && cache.platform && fresh(cache.platform.at, now)) return cache.platform.value;
  let value: PlatformAiSwitch;
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY) });
    // Chỉ đúng `false` mới tắt; giá trị lạ (gõ tay) ⇒ TẮT luôn — không đoán ý người gõ theo hướng mở.
    value = row
      ? { enabled: row.value === true, stored: true, updatedAt: row.updatedAt.toISOString(), updatedByEmail: row.updatedByEmail ?? null, readError: false }
      : { enabled: true, stored: false, updatedAt: null, updatedByEmail: null, readError: false };
  } catch {
    return { enabled: false, stored: false, updatedAt: null, updatedByEmail: null, readError: true };
  }
  cache.platform = { at: now, value };
  return value;
}

function orgAiSettingsOf(settings: unknown): Record<string, unknown> {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  const ai = s.ai;
  return ai && typeof ai === "object" && !Array.isArray(ai) ? (ai as Record<string, unknown>) : {};
}

export async function readOrgAiControl(orgCode: string, opts: { now?: number; fresh?: boolean } = {}): Promise<OrgAiControl> {
  const now = opts.now ?? Date.now();
  const hit = cache.orgs.get(orgCode);
  if (!opts.fresh && hit && fresh(hit.at, now)) return hit.value;
  let value: OrgAiControl;
  try {
    const pdb = await getPlatformDb();
    const [row] = await pdb.select({ settings: schema.platformOrganizations.settings }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, orgCode)).limit(1);
    const ai = orgAiSettingsOf(row?.settings);
    value = {
      disabled: ai.disabled === true,
      limits: parseAiOverride(ai.limits),
      updatedAt: typeof ai.updatedAt === "string" ? ai.updatedAt : null,
      updatedByEmail: typeof ai.updatedByEmail === "string" ? ai.updatedByEmail : null,
      readError: false,
    };
  } catch {
    return { disabled: true, limits: {}, updatedAt: null, updatedByEmail: null, readError: true };
  }
  if (cache.orgs.size > 500) cache.orgs.clear();
  cache.orgs.set(orgCode, { at: now, value });
  return value;
}

/** Vì sao AI của tổ chức này đang TẮT (`null` = đang bật). Gọi TRƯỚC khi chọn provider / gọi model. */
export async function aiKillSwitchDenial(orgCode: string, opts: { now?: number } = {}): Promise<string | null> {
  const platform = await readPlatformAiSwitch(opts);
  if (!platform.enabled) return `${AI_DISABLED_BY_OPERATOR} (toàn nền tảng${platform.readError ? " — không đọc được công tắc" : ""}).`;
  const org = await readOrgAiControl(orgCode, opts);
  if (org.disabled) return `${AI_DISABLED_BY_OPERATOR} (riêng tổ chức này${org.readError ? " — không đọc được công tắc" : ""}).`;
  return null;
}

// ═══ GHI — chỉ người vận hành nền tảng ═══

export type AiControlResult = { ok: true; changed: boolean } | { error: string };

function reasonOf(raw: unknown): string | { error: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < 5) return { error: "Ghi lý do (ít nhất 5 ký tự) — nó vào nhật ký nền tảng." };
  if (reason.length > 500) return { error: "Lý do dài quá 500 ký tự." };
  return reason;
}

function actorOf(user: SessionUser) {
  return { orgCode: user.organization!.code, userId: user.id, email: user.email };
}

export async function setPlatformAiEnabled(user: SessionUser, input: unknown): Promise<AiControlResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { enabled?: unknown; reason?: unknown };
  if (typeof raw.enabled !== "boolean") return { error: "Chỉ nhận bật hoặc tắt." };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const before = await readPlatformAiSwitch({ fresh: true });
  if (before.readError) return { error: "Không đọc được công tắc hiện tại — chưa đổi gì." };
  if (before.stored && before.enabled === raw.enabled) return { ok: true, changed: false };
  const actor = actorOf(user);
  const pdb = await getPlatformDb();
  const now = new Date();
  const set = { value: raw.enabled, updatedAt: now, updatedBy: `${actor.orgCode}:${actor.userId}`, updatedByEmail: actor.email };
  await pdb.insert(schema.platformSettings).values({ key: PLATFORM_AI_SWITCH_KEY, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
  invalidateAiControl();
  try {
    const home = await getHomeOrganization();
    await platformAudit({ action: "AI_SWITCH_SET", targetOrgCode: home.code, subject: PLATFORM_AI_SWITCH_KEY, before: { enabled: before.enabled, stored: before.stored }, after: { enabled: raw.enabled }, reason, source: "UI", actor });
  } catch {
    if (before.stored) await pdb.update(schema.platformSettings).set({ value: before.enabled }).where(eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY));
    else await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY));
    invalidateAiControl();
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại công tắc cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true };
}

/** Ô ghi đè từ form: chuỗi rỗng / `null` ⇒ BỎ ghi đè (theo gói); số ≥ 0 ⇒ ghi đè. Ô lạ bị bỏ qua. */
function overrideFromInput(raw: unknown): AiLimitsOverride | { error: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Hạn mức ghi đè không hợp lệ." };
  const src = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of AI_LIMIT_OVERRIDE_KEYS) {
    const v = src[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return { error: `Ô «${k}» phải là số ≥ 0.` };
    out[k] = k === "requestsPerDay" || k === "requestsPerMonth" ? Math.floor(n) : Math.round(n * 100) / 100;
  }
  return parseAiOverride(out);
}

/**
 * Người vận hành đặt công tắc AI + ghi đè hạn mức cho MỘT tổ chức. `disabled` vắng ⇒ giữ nguyên; `limits` vắng ⇒ giữ
 * nguyên, có mặt ⇒ THAY TOÀN BỘ ghi đè bằng các ô có số (ô trống = theo gói).
 */
export async function setOrgAiControl(user: SessionUser, input: unknown): Promise<AiControlResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { orgCode?: unknown; disabled?: unknown; limits?: unknown; reason?: unknown };
  const orgCode = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  if (!ORGANIZATION_CODE_PATTERN.test(orgCode)) return { error: "Mã tổ chức không hợp lệ." };
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") return { error: "Công tắc chỉ nhận bật hoặc tắt." };
  const reason = reasonOf(raw.reason);
  if (typeof reason !== "string") return reason;
  const org = await findOrganization(orgCode);
  if (!org) return { error: `Không có tổ chức "${orgCode}".` };
  const limits = raw.limits === undefined ? undefined : overrideFromInput(raw.limits);
  if (limits && "error" in limits) return { error: String(limits.error) };

  const before = await readOrgAiControl(orgCode, { fresh: true });
  if (before.readError) return { error: "Không đọc được cài đặt AI hiện tại của tổ chức — chưa đổi gì." };
  const next = { disabled: typeof raw.disabled === "boolean" ? raw.disabled : before.disabled, limits: limits ?? before.limits };
  if (next.disabled === before.disabled && JSON.stringify(next.limits) === JSON.stringify(before.limits)) return { ok: true, changed: false };

  const actor = actorOf(user);
  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const write = async (value: Record<string, unknown>) =>
    pdb
      .update(t)
      .set({ settings: sql`jsonb_set(coalesce(${t.settings}, '{}'::jsonb), '{ai}', ${JSON.stringify(value)}::jsonb, true)`, updatedAt: new Date() })
      .where(eq(t.code, orgCode));
  await write({ ...next, updatedAt: new Date().toISOString(), updatedByEmail: actor.email });
  invalidateAiControl();
  invalidateOrganizations();
  try {
    await platformAudit({ action: "AI_ORG_CONTROL_SET", targetOrgCode: orgCode, subject: "ai", before: { disabled: before.disabled, limits: before.limits }, after: next, reason, source: "UI", actor });
  } catch {
    await write({ disabled: before.disabled, limits: before.limits, updatedAt: before.updatedAt, updatedByEmail: before.updatedByEmail });
    invalidateAiControl();
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại cài đặt cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true };
}
