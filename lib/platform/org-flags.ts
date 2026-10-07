import { and, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ CỜ NỀN TẢNG THEO TỔ CHỨC — `platform_flag_overrides` (CSDL NHÀ) ═══════════
 *
 * Bảng có từ 0152 ("cờ nền tảng theo tổ chức, khác cấu hình module"). Cờ đầu tiên có người đọc là công tắc khẩn
 * `workflows.paused`: người vận hành tạm dừng MỌI luật tự động của một tổ chức mà không deploy, không sửa luật của họ.
 *
 * Đọc ở mỗi lượt `runWorkflows()` ⇒ đệm 5 giây như cấu hình module; lượt ghi trong cùng tiến trình xoá đệm ngay. Bảng
 * chưa có (máy chưa migrate) ⇒ không cờ nào bật — đúng hành vi trước bản này. Lỗi KHÁC ném: không đọc được cờ tạm dừng
 * thì lượt chạy hỏng CÓ DẤU VẾT, không đoán là "không dừng" cũng không đoán là "dừng".
 *
 * Chỉ `lib/platform/kill-switches.ts` GHI (kèm quyền vận hành + nhật ký nền tảng).
 */

export const WORKFLOWS_PAUSED_FLAG = "workflows.paused";
/**
 * Số dư AI + nạp QR (0235 · docs/saas/AI_BALANCE_V1.md): mặc định TẮT ⇒ màn khách không hiện, không tạo được phiếu nạp.
 * Người vận hành bật từng tổ chức (canary) — tiền về mang mã `ERPNAP…` vẫn được cộng kể cả khi cờ đã tắt lại sau đó.
 */
export const AI_BALANCE_FLAG = "ai_balance.enabled";
export const ORG_FLAG_KEYS = [WORKFLOWS_PAUSED_FLAG, AI_BALANCE_FLAG] as const;
export type OrgFlagKey = (typeof ORG_FLAG_KEYS)[number];

export type OrgFlag = { enabled: boolean; updatedAt: Date; updatedBy: string | null };

const TTL_MS = 5_000;
const holder = globalThis as unknown as { __erpOrgFlags?: Map<string, { at: number; value: OrgFlag | null }> };
if (!holder.__erpOrgFlags) holder.__erpOrgFlags = new Map();
const cache = holder.__erpOrgFlags;

function isMissingTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

/** Dòng cờ của tổ chức (`null` = chưa từng đặt ⇒ tắt). Tổ chức không có trong sổ ⇒ `null`. */
export async function readOrgFlag(orgCode: string, flagKey: OrgFlagKey, opts: { fresh?: boolean } = {}): Promise<OrgFlag | null> {
  const key = `${orgCode}\u0000${flagKey}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const org = await findOrganization(orgCode);
  if (!org) return null;
  const pdb = await getPlatformDb();
  let value: OrgFlag | null = null;
  try {
    const row = await pdb.query.platformFlagOverrides.findFirst({ where: and(eq(schema.platformFlagOverrides.organizationId, org.id), eq(schema.platformFlagOverrides.flagKey, flagKey)) });
    value = row ? { enabled: row.enabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Luật tự động của tổ chức có đang bị người vận hành tạm dừng không. */
export async function workflowsPaused(orgCode: string): Promise<OrgFlag | null> {
  const flag = await readOrgFlag(orgCode, WORKFLOWS_PAUSED_FLAG);
  return flag?.enabled ? flag : null;
}

/** Ghi một cờ (upsert). CHỈ gọi từ `lib/platform/kill-switches.ts` — nơi đã kiểm quyền và ghi nhật ký. */
export async function writeOrgFlag(organizationId: string, flagKey: OrgFlagKey, enabled: boolean, updatedBy: string): Promise<void> {
  const pdb = await getPlatformDb();
  const now = new Date();
  await pdb
    .insert(schema.platformFlagOverrides)
    .values({ organizationId, flagKey, enabled, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: [schema.platformFlagOverrides.organizationId, schema.platformFlagOverrides.flagKey], set: { enabled, updatedBy, updatedAt: now } });
  invalidateOrgFlags();
}

export function invalidateOrgFlags() {
  cache.clear();
}
