/**
 * ═══════════ MỜI NGƯỜI DÙNG QUA LIÊN KẾT — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ tổ chức (quyền `users:manage`) nhập email + chọn vai trò ⇒ nhận MỘT liên kết `/join/<mã tổ chức>/<mã>` (hiện
 * đúng một lần) ⇒ gửi cho nhân viên qua kênh của họ (chưa có bộ gửi thư) ⇒ nhân viên mở liên kết, tự đặt tên + mật
 * khẩu ⇒ tài khoản ra đời trong CSDL của ĐÚNG tổ chức, đúng vai trò ⇒ đăng nhập luôn.
 *
 * ─── MÃ ───
 *  · 32 byte ngẫu nhiên, base64url (43 ký tự). CSDL (`user_invites.token_hash`) chỉ giữ `sha256` — lộ bảng không lộ
 *    liên kết nào dùng được. Mã thô không vào nhật ký, không vào bảng, không có cách đọc lại.
 *  · Dùng MỘT lần: lượt nhận là một câu `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at >
 *    now()` TRONG CÙNG giao dịch với câu tạo tài khoản — hai tab bấm cùng lúc thì đúng một tài khoản; tạo tài khoản
 *    hỏng thì lời mời KHÔNG bị tiêu.
 *
 * ─── TRANG CÔNG KHAI KHÔNG CÓ PHIÊN ───
 * Request không phiên mặc định rơi về TỔ CHỨC NHÀ (lib/platform/context.ts). Nên mọi đường công khai ở đây chạy trong
 * `withOrganization(mã trong đường dẫn)` TƯỜNG MINH — không có dòng nào gọi `getDb()` ngoài khối đó. Mã của tổ chức A
 * đem sang đường dẫn của B thì được tra trong CSDL của B, và không khớp gì.
 *
 * ─── MỘT CÂU LỖI ───
 * Tổ chức không có / không ACTIVE, mã sai dạng, không khớp, hết hạn, đã dùng, đã thu hồi ⇒ CÙNG `USER_INVITE_INVALID`:
 * một câu riêng cho mỗi lý do là máy dò danh sách khách hàng của nền tảng. Mọi lượt sai đếm vào bộ chặn dò theo IP (đã
 * băm) — cùng bộ đếm trong bộ nhớ với màn đăng nhập (lib/auth/login-throttle.ts), khoá riêng `ip:join:`.
 */
import { organizationBaseUrl } from "@/lib/platform/publish";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Role } from "@/db/schema";
import { audit } from "@/lib/audit";
import { recordAuthFailure } from "@/lib/auth/auth-failures";
import { verifyLogin } from "@/lib/auth/login";
import { loginAllowed, loginLockOf, recordLoginFailure } from "@/lib/auth/login-throttle";
import type { AuthFailureReason } from "@/lib/constants/auth-failures";
import { can, type SessionSubject, type SessionUser } from "@/lib/auth/session";
import { normalizeScope } from "@/lib/constants/access-scope";
import { ROLE_LABEL, ROLE_ORDER } from "@/lib/constants/roles";
import { env } from "@/lib/env";
import { currentOrganization, OrgContextError, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { auditUserCreate, checkNewUserAccount, indexNewUserAccount, insertUserAccount, pendingUserInviteCount, USER_EMAIL_TAKEN, type NewUserAccount } from "@/lib/users/create-user";
import { inviteLinkFor } from "@/lib/users/invite-link";
import {
  acceptUserInviteSchema,
  createUserInviteSchema,
  USER_INVITE_INVALID,
  USER_INVITE_THROTTLED,
  USER_INVITE_TTL_DAYS,
  userInviteStatus,
  type UserInviteStatus,
} from "@/lib/users/invite-shared";

// ═══ MÃ ═══

/** 32 byte ⇒ base64url không đệm = đúng 43 ký tự. Mọi chuỗi khác dạng này là sai, không cần tra CSDL. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateUserInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashUserInviteToken(token: string): string {
  return createHash("sha256").update(`erp-user-invite:${token}`).digest("hex");
}

// ═══ CHẶN DÒ ═══

function ipKey(ip: string): string[] {
  const h = createHash("sha256").update(`${env.authSecret}:join-ip:${ip || "unknown"}`).digest("hex").slice(0, 32);
  // Tiền tố `ip:` ⇒ trần theo máy của bộ chặn (30 lượt sai / 15 phút). Mã 256 bit không đoán được; bộ chặn ở đây để
  // một máy không quét được danh sách tổ chức bằng đường dẫn — lớp phòng thứ hai, không phải lớp duy nhất.
  return [`ip:join:${h}`];
}

type Throttle = { ok: true; keys: string[] } | { ok: false; error: string; keys: string[] };

function throttleGate(ip: string): Throttle {
  const keys = ipKey(ip);
  return loginAllowed(keys).ok ? { ok: true, keys } : { ok: false, error: USER_INVITE_THROTTLED, keys };
}

// ═══ LỖI CÓ LÝ DO (sứ mệnh saas-ops-signals) ═══
// Người mở liên kết hỏng vẫn nhận ĐÚNG `USER_INVITE_INVALID`; lý do thật (hết hạn · đã nhận · đã thu hồi · tổ chức không chạy) chỉ
// vào sổ `platform_auth_failures` cho người vận hành. Tra lý do CHỈ ở nhánh hỏng — mỗi lượt hỏng đã bị bộ chặn dò theo IP giới hạn.

async function inviteFailureWhy(orgCode: string, token: string): Promise<{ reason: AuthFailureReason; email: string | null }> {
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return { reason: "INVITE_INVALID", email: null };
  const code = String(orgCode ?? "").trim().toLowerCase();
  const org = ORGANIZATION_CODE_PATTERN.test(code) ? await findOrganization(code) : null;
  if (!org) return { reason: "ORG_NOT_FOUND", email: null };
  if (org.status !== "ACTIVE") return { reason: "ORG_INACTIVE", email: null };
  try {
    return await withOrganization(org.code, async () => {
      const db = await getDb();
      const row = await db.query.userInvites.findFirst({ where: eq(schema.userInvites.tokenHash, hashUserInviteToken(token)) });
      if (!row) return { reason: "INVITE_INVALID" as const, email: null };
      const status = userInviteStatus(row);
      const reason: AuthFailureReason = status === "ACCEPTED" ? "INVITE_USED" : status === "REVOKED" ? "INVITE_REVOKED" : status === "EXPIRED" ? "INVITE_EXPIRED" : "INVITE_INVALID";
      return { reason, email: row.email };
    });
  } catch (error) {
    return { reason: error instanceof OrgContextError ? "ORG_INACTIVE" : "INVITE_INVALID", email: null };
  }
}

async function noteInviteFailure(orgCode: string, ip: string, why: { reason: AuthFailureReason; email: string | null }, lockKeys?: string[]): Promise<void> {
  await recordAuthFailure({ flow: "INVITE", reason: why.reason, orgCode, identifier: why.email, ip, lock: lockKeys ? loginLockOf(lockKeys) : null });
}

// ═══ QUẢN TRỊ: TẠO · THU HỒI · LIỆT KÊ ═══

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/** Vai trò mà lời mời sẽ cấp, đọc lại từ CSDL: hệ thống ⇒ chính nó; tuỳ chỉnh ⇒ dòng `access_roles` đang bật. */
type ResolvedRole = { role: Role; accessRoleId: string | null; accessRoleCode: string | null; label: string; scope: ReturnType<typeof normalizeScope> };

async function resolveCustomRole(code: string): Promise<ResolvedRole | null> {
  const db = await getDb();
  const r = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.code, code) });
  // Luật 31: vai trò tuỳ chỉnh không lấy ADMIN làm nền. Lược đồ đã chặn lúc lưu; chặn LẠI ở đây — mọi nhánh lỗi rơi
  // về phía hẹp, không bao giờ về toàn quyền.
  if (!r || !r.active || r.baseRole === "ADMIN" || !ROLE_ORDER.includes(r.baseRole)) return null;
  return { role: r.baseRole, accessRoleId: r.id, accessRoleCode: r.code, label: r.name, scope: normalizeScope(r.defaultScope) };
}

export type CreatedUserInvite = { ok: true; id: string; link: string; expiresAt: Date; email: string };

/** Tạo lời mời trong tổ chức NGỮ CẢNH (phiên của người mời). Trả liên kết THÔ đúng một lần. */
export async function createUserInviteCore(user: SessionUser, input: unknown): Promise<CreatedUserInvite | { error: string }> {
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = createUserInviteSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;

  let resolved: ResolvedRole;
  if (data.accessRoleCode) {
    const r = await resolveCustomRole(data.accessRoleCode);
    if (!r) return { error: "Vai trò tuỳ chỉnh không tồn tại hoặc đang tắt" };
    resolved = r;
  } else {
    const role = data.role as Role;
    resolved = { role, accessRoleId: null, accessRoleCode: null, label: ROLE_LABEL[role], scope: "ALL" };
  }

  const db = await getDb();
  const t = schema.userInvites;
  const pending = await db.query.userInvites.findFirst({ where: and(eq(t.email, data.email), isNull(t.acceptedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)), columns: { id: true } });
  if (pending) return { error: "Email này đã có một lời mời còn hạn — thu hồi lời mời cũ ở danh sách «Lời mời» rồi tạo lại." };
  // Email đã là tài khoản ⇒ lỗi rõ; hạn mức gói tính cả ghế đã hứa cho lời mời còn hạn.
  const gate = await checkNewUserAccount(data.email, { reserved: await pendingUserInviteCount() });
  if (!gate.ok) return { error: gate.code === "EMAIL_TAKEN" ? "Email này đã có tài khoản trong tổ chức" : gate.error };

  const org = await currentOrganization();
  const token = generateUserInviteToken();
  const expiresAt = new Date(Date.now() + USER_INVITE_TTL_DAYS * 86_400_000);
  const [row] = await db
    .insert(t)
    .values({ tokenHash: hashUserInviteToken(token), email: data.email, role: resolved.role, accessRoleCode: resolved.accessRoleCode, invitedBy: user.id, invitedByEmail: user.email, expiresAt })
    .returning({ id: t.id });
  // Nhật ký KHÔNG mang mã thô (cũng không mang băm — băm là khoá tra của bảng).
  await audit({ userId: user.id, userEmail: user.email, action: "USER_INVITE_CREATE", entity: "USER_INVITE", entityId: row.id, after: { email: data.email, role: resolved.role, accessRoleCode: resolved.accessRoleCode, expiresAt: expiresAt.toISOString() } });
  return { ok: true, id: row.id, link: inviteLinkFor(org.code, token, await organizationBaseUrl(org.code)), expiresAt, email: data.email };
}

/** Thu hồi một lời mời chưa dùng. Đã dùng / đã thu hồi ⇒ lỗi rõ, không ghi gì. */
export async function revokeUserInviteCore(user: SessionUser, id: string): Promise<{ ok: true } | { error: string }> {
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  if (!id || typeof id !== "string") return { error: "Thiếu lời mời" };
  const db = await getDb();
  const t = schema.userInvites;
  const done = await db
    .update(t)
    .set({ revokedAt: new Date() })
    .where(and(eq(t.id, id), isNull(t.acceptedAt), isNull(t.revokedAt)))
    .returning({ id: t.id, email: t.email });
  if (done.length === 0) return { error: "Lời mời không còn thu hồi được (đã được nhận, đã thu hồi hoặc không có)." };
  await audit({ userId: user.id, userEmail: user.email, action: "USER_INVITE_REVOKE", entity: "USER_INVITE", entityId: id, before: { revoked: false }, after: { revoked: true, email: done[0].email } });
  return { ok: true };
}

export type UserInviteView = {
  id: string;
  email: string;
  role: Role;
  accessRoleCode: string | null;
  invitedByEmail: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  status: UserInviteStatus;
};

/** Lời mời của tổ chức ngữ cảnh, mới nhất trước. KHÔNG trả cột băm. */
export async function listUserInvites(limit = 100): Promise<UserInviteView[]> {
  const db = await getDb();
  const t = schema.userInvites;
  const rows = await db
    .select({ id: t.id, email: t.email, role: t.role, accessRoleCode: t.accessRoleCode, invitedByEmail: t.invitedByEmail, createdAt: t.createdAt, expiresAt: t.expiresAt, acceptedAt: t.acceptedAt, revokedAt: t.revokedAt })
    .from(t)
    .orderBy(desc(t.createdAt))
    .limit(limit);
  const now = new Date();
  return rows.map((r) => ({ ...r, role: r.role as Role, status: userInviteStatus(r, now) }));
}

// ═══ CÔNG KHAI: TRA · NHẬN ═══

type ActiveInvite = typeof schema.userInvites.$inferSelect;

/** Tổ chức ACTIVE của đường dẫn, hoặc `null`. Mã sai dạng không bao giờ chạm sổ tổ chức. */
async function activeOrg(orgCode: string) {
  const code = String(orgCode ?? "").trim().toLowerCase();
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return null;
  const org = await findOrganization(code);
  return org && org.status === "ACTIVE" ? org : null;
}

/** Dòng lời mời CÒN DÙNG ĐƯỢC khớp mã, trong CSDL ngữ cảnh — chỉ gọi bên trong `withOrganization`. */
async function activeInviteByToken(token: string): Promise<ActiveInvite | null> {
  const db = await getDb();
  const row = await db.query.userInvites.findFirst({ where: eq(schema.userInvites.tokenHash, hashUserInviteToken(token)) });
  return row && userInviteStatus(row) === "ACTIVE" ? row : null;
}

export type UserInviteLookup =
  | { ok: true; orgCode: string; orgName: string; email: string; roleLabel: string; expiresAt: Date }
  | { ok: false; error: string };

/** Trang `/join/<tổ chức>/<mã>`: CHỈ ĐỌC, không tiêu mã. Không hợp lệ ⇒ câu chung + một lượt sai vào bộ chặn dò. */
export async function lookupUserInvite(orgCode: string, token: string, opts: { ip: string }): Promise<UserInviteLookup> {
  const gate = throttleGate(opts.ip);
  if (!gate.ok) {
    await noteInviteFailure(orgCode, opts.ip, { reason: "THROTTLED", email: null }, gate.keys);
    return { ok: false, error: gate.error };
  }
  const fail = async (): Promise<UserInviteLookup> => {
    recordLoginFailure(gate.keys);
    await noteInviteFailure(orgCode, opts.ip, await inviteFailureWhy(orgCode, token));
    return { ok: false, error: USER_INVITE_INVALID };
  };
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return fail();
  const org = await activeOrg(orgCode);
  if (!org) return fail();
  try {
    const found = await withOrganization(org.code, async () => {
      const inv = await activeInviteByToken(token);
      if (!inv) return null;
      const label = inv.accessRoleCode ? ((await resolveCustomRole(inv.accessRoleCode))?.label ?? null) : ROLE_LABEL[inv.role as Role] ?? null;
      return label ? { email: inv.email, roleLabel: label, expiresAt: inv.expiresAt } : null;
    });
    if (!found) return fail();
    return { ok: true, orgCode: org.code, orgName: org.name, ...found };
  } catch (error) {
    // Tổ chức bị đình chỉ GIỮA lúc tra sổ và lúc vào ngữ cảnh: vẫn là cùng một câu.
    if (error instanceof OrgContextError) return fail();
    throw error;
  }
}

export type AcceptedUserInvite = { ok: true; orgCode: string; userId: string; email: string; loggedIn: boolean };

/**
 * Nhận lời mời: tạo tài khoản trong CSDL của tổ chức `orgCode` (tường minh) rồi đăng nhập bằng ĐÚNG `verifyLogin` của
 * màn đăng nhập — phiên mang claim `org` đúng tổ chức. `issue` bỏ trống ⇒ chỉ tạo, không phát phiên.
 */
export async function acceptUserInviteCore(
  orgCode: string,
  token: string,
  input: unknown,
  opts: { ip: string; issue?: (subject: SessionSubject) => Promise<void> },
): Promise<AcceptedUserInvite | { error: string }> {
  const gate = throttleGate(opts.ip);
  if (!gate.ok) {
    await noteInviteFailure(orgCode, opts.ip, { reason: "THROTTLED", email: null }, gate.keys);
    return { error: gate.error };
  }
  // Lược đồ đứng TRƯỚC mọi lượt tra: lỗi ô nhập không nói gì về mã hay tổ chức.
  const parsed = acceptUserInviteSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { name, password } = parsed.data;
  const invalid = async () => {
    recordLoginFailure(gate.keys);
    await noteInviteFailure(orgCode, opts.ip, await inviteFailureWhy(orgCode, token));
    return { error: USER_INVITE_INVALID };
  };
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return invalid();
  const org = await activeOrg(orgCode);
  if (!org) return invalid();

  type Outcome = { kind: "INVALID" } | { kind: "ERROR"; error: string } | { kind: "OK"; userId: string; email: string };
  let outcome: Outcome;
  try {
    outcome = await withOrganization(org.code, async (): Promise<Outcome> => {
      const inv = await activeInviteByToken(token);
      if (!inv) return { kind: "INVALID" };
      // Vai trò đọc LẠI lúc nhận: vai trò tuỳ chỉnh bị tắt / bị đổi nền sang ADMIN sau khi mời ⇒ không cấp.
      let resolved: ResolvedRole;
      if (inv.accessRoleCode) {
        const r = await resolveCustomRole(inv.accessRoleCode);
        if (!r) return { kind: "ERROR", error: "Vai trò của lời mời này không còn dùng được — xin người mời gửi một lời mời mới." };
        resolved = r;
      } else {
        const role = inv.role as Role;
        if (!ROLE_ORDER.includes(role)) return { kind: "INVALID" };
        resolved = { role, accessRoleId: null, accessRoleCode: null, label: ROLE_LABEL[role], scope: "ALL" };
      }
      // Email trùng + hạn mức gói, NGOÀI giao dịch (xem `checkNewUserAccount`). Ghế của chính lời mời này đã nằm
      // trong số ghế hứa lúc tạo, nên không cộng thêm lời mời nào — chỉ kiểm trần cứng.
      const check = await checkNewUserAccount(inv.email, { reserved: 0 });
      if (!check.ok) return { kind: "ERROR", error: check.code === "EMAIL_TAKEN" ? "Email này đã có tài khoản trong tổ chức — đăng nhập ở màn Đăng nhập." : check.error };

      const account: NewUserAccount = { email: inv.email, name, password, role: resolved.role, accessRoleId: resolved.accessRoleId, dataScope: resolved.scope };
      const db = await getDb();
      const t = schema.userInvites;
      let created: { id: string } | null;
      try {
        created = await db.transaction(async (tx) => {
          const [won] = await tx
            .update(t)
            .set({ acceptedAt: new Date() })
            .where(and(eq(t.id, inv.id), isNull(t.acceptedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)))
            .returning({ id: t.id });
          if (!won) return null;
          const row = await insertUserAccount(tx, account);
          await tx.update(t).set({ acceptedUserId: row.id }).where(eq(t.id, inv.id));
          return row;
        });
      } catch (error) {
        // Tab kia vừa tạo đúng email này (UNIQUE `users.email`): giao dịch đã lùi, lời mời không bị tiêu.
        if (isUniqueViolation(error)) return { kind: "ERROR", error: `${USER_EMAIL_TAKEN} — đăng nhập ở màn Đăng nhập.` };
        throw error;
      }
      if (!created) return { kind: "INVALID" };
      await auditUserCreate({ id: created.id, email: inv.email }, created.id, account, { via: "INVITE", inviteId: inv.id });
      await audit({ userId: created.id, userEmail: inv.email, action: "USER_INVITE_ACCEPT", entity: "USER_INVITE", entityId: inv.id, after: { userId: created.id, role: resolved.role, accessRoleCode: resolved.accessRoleCode, invitedBy: inv.invitedByEmail } });
      // SAU giao dịch, trong ngữ cảnh TƯỜNG MINH của tổ chức đích: lượt đăng nhập ngay sau đây (nếu có) chỉ thêm mốc dùng; không
      // có lượt ấy (`issue` bỏ trống, tổ chức vừa bị đình chỉ…) thì người mới vẫn đăng nhập được ở trang chung không cần mã.
      await indexNewUserAccount(created.id, account);
      return { kind: "OK", userId: created.id, email: inv.email };
    });
  } catch (error) {
    if (error instanceof OrgContextError) return invalid();
    throw error;
  }
  if (outcome.kind === "INVALID") return invalid();
  if (outcome.kind === "ERROR") return { error: outcome.error };

  let loggedIn = false;
  if (opts.issue) {
    const v = await verifyLogin({ email: outcome.email, password, orgCode: org.code }, opts.issue);
    loggedIn = v.ok;
  }
  return { ok: true, orgCode: org.code, userId: outcome.userId, email: outcome.email, loggedIn };
}

/** Lỗi vi phạm UNIQUE của Postgres (23505) — drizzle bọc lỗi gốc ở `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
