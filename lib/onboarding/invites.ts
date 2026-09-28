/**
 * ═══════════ MÃ MỜI TỰ ĐĂNG KÝ (Phase 10 · §1) — CHỈ MÁY CHỦ ═══════════
 *
 *  · Mã thô sinh bằng `crypto.randomBytes` (120 bit), hiện ĐÚNG MỘT LẦN cho người vận hành lúc tạo; CSDL chỉ giữ
 *    `sha256` của dạng chuẩn hoá. Lộ bảng = không lộ mã nào dùng được.
 *  · Dùng MỘT lần: lượt nhận mã là một câu `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at >
 *    now()` — hai lượt đua nhau thì đúng một lượt thắng, không đọc-rồi-ghi.
 *  · Mã đã gắn vào mã tổ chức X thì lượt CHẠY LẠI cho đúng X (sau khi dựng hỏng) vẫn được đi tiếp — idempotent theo mã
 *    tổ chức — còn mọi mã tổ chức khác bị từ chối.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";

export const INVITE_TTL_DAYS_DEFAULT = 7;
export const INVITE_TTL_DAYS_MAX = 30;

/** Bảng chữ không nhầm lẫn (bỏ 0/O, 1/I/L) — người nhận gõ tay được. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Mã thô mới: `XXXXX-XXXXX-XXXXX-XXXXX-XXXX` (24 ký tự ngẫu nhiên, ~118 bit). */
export function generateInviteCode(): string {
  const bytes = randomBytes(24);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{1,5}/g)!.join("-");
}

/** Dạng chuẩn hoá trước khi băm: bỏ khoảng trắng / gạch, viết HOA. */
export function normalizeInviteCode(raw: string): string {
  return String(raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
}

export function hashInviteCode(raw: string): string {
  return createHash("sha256").update(`erp-signup-invite:${normalizeInviteCode(raw)}`).digest("hex");
}

export type InviteRow = typeof schema.platformSignupInvites.$inferSelect;
export type InviteStatus = "ACTIVE" | "USED" | "EXPIRED" | "REVOKED";

export function inviteStatus(row: Pick<InviteRow, "usedAt" | "revokedAt" | "expiresAt">, now = new Date()): InviteStatus {
  if (row.revokedAt) return "REVOKED";
  if (row.usedAt) return "USED";
  if (row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = { ACTIVE: "Còn dùng được", USED: "Đã dùng", EXPIRED: "Hết hạn", REVOKED: "Đã thu hồi" };

/** Tạo mã mời. Trả mã THÔ đúng một lần — không có cách đọc lại. */
export async function createInvite(input: { actor: PlatformActor; note?: string | null; planKey?: string | null; ttlDays?: number }): Promise<{ id: string; code: string; expiresAt: Date }> {
  const days = Math.min(INVITE_TTL_DAYS_MAX, Math.max(1, Math.floor(input.ttlDays ?? INVITE_TTL_DAYS_DEFAULT)));
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const pdb = await getPlatformDb();
  const [row] = await pdb
    .insert(schema.platformSignupInvites)
    .values({
      codeHash: hashInviteCode(code),
      note: input.note?.trim() || null,
      planKey: input.planKey?.trim() || null,
      expiresAt,
      createdByOrg: input.actor?.orgCode ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdByEmail: input.actor?.email ?? null,
    })
    .returning({ id: schema.platformSignupInvites.id });
  const home = await getHomeOrganization();
  await platformAudit({ action: "INVITE_CREATE", targetOrgCode: home.code, subject: row.id, after: { note: input.note ?? null, planKey: input.planKey ?? null, expiresAt: expiresAt.toISOString() }, source: input.actor ? "UI" : "SCRIPT", actor: input.actor });
  return { id: row.id, code, expiresAt };
}

export async function listInvites(limit = 50): Promise<(InviteRow & { status: InviteStatus })[]> {
  const pdb = await getPlatformDb();
  const rows = await pdb.select().from(schema.platformSignupInvites).orderBy(desc(schema.platformSignupInvites.createdAt)).limit(limit);
  const now = new Date();
  return rows.map((r) => ({ ...r, status: inviteStatus(r, now) }));
}

export async function revokeInvite(id: string, actor: PlatformActor): Promise<{ ok: true } | { error: string }> {
  const pdb = await getPlatformDb();
  const done = await pdb
    .update(schema.platformSignupInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.platformSignupInvites.id, id), isNull(schema.platformSignupInvites.usedAt), isNull(schema.platformSignupInvites.revokedAt)))
    .returning({ id: schema.platformSignupInvites.id });
  if (done.length === 0) return { error: "Mã mời không còn thu hồi được (đã dùng, đã thu hồi hoặc không có)." };
  const home = await getHomeOrganization();
  await platformAudit({ action: "INVITE_REVOKE", targetOrgCode: home.code, subject: id, before: { revoked: false }, after: { revoked: true }, source: "UI", actor });
  return { ok: true };
}

export type InviteLookup = { ok: true; invite: InviteRow } | { ok: false; reason: "NOT_FOUND" | InviteStatus; error: string };

const INVITE_ERROR: Record<"NOT_FOUND" | Exclude<InviteStatus, "ACTIVE">, string> = {
  NOT_FOUND: "Mã mời không đúng.",
  USED: "Mã mời này đã được dùng.",
  EXPIRED: "Mã mời đã hết hạn — xin người vận hành một mã mới.",
  REVOKED: "Mã mời đã bị thu hồi.",
};

/**
 * Tra một mã (CHỈ ĐỌC, không tiêu mã). `forOrgCode`: mã đã dùng cho ĐÚNG tổ chức này vẫn tính là hợp lệ — đó là lượt
 * chạy lại sau khi dựng hỏng, không phải một lượt dùng thứ hai.
 */
export async function lookupInvite(rawCode: string, forOrgCode?: string | null): Promise<InviteLookup> {
  const code = normalizeInviteCode(rawCode);
  if (code.length < 8) return { ok: false, reason: "NOT_FOUND", error: INVITE_ERROR.NOT_FOUND };
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSignupInvites.findFirst({ where: eq(schema.platformSignupInvites.codeHash, hashInviteCode(code)) });
  if (!row) return { ok: false, reason: "NOT_FOUND", error: INVITE_ERROR.NOT_FOUND };
  const status = inviteStatus(row);
  if (status === "ACTIVE") return { ok: true, invite: row };
  if (status === "USED" && forOrgCode && row.organizationCode === forOrgCode && !row.revokedAt) return { ok: true, invite: row };
  return { ok: false, reason: status, error: INVITE_ERROR[status] };
}

/**
 * Nhận mã cho `orgCode` — MỘT câu điều kiện. `true` = lượt này đã giữ mã (hoặc mã đã được giữ cho đúng tổ chức này
 * từ lượt trước). `false` = mã đã về tay tổ chức khác / hết hạn / bị thu hồi giữa lúc tra và lúc nhận.
 */
export async function claimInvite(inviteId: string, orgCode: string): Promise<boolean> {
  const pdb = await getPlatformDb();
  const t = schema.platformSignupInvites;
  const won = await pdb
    .update(t)
    .set({ usedAt: new Date(), organizationCode: orgCode })
    .where(and(eq(t.id, inviteId), isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)))
    .returning({ id: t.id });
  if (won.length > 0) return true;
  const row = await pdb.query.platformSignupInvites.findFirst({ where: eq(t.id, inviteId) });
  return Boolean(row && !row.revokedAt && row.organizationCode === orgCode);
}
