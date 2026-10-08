/**
 * ═══════════ LIÊN KẾT ĐẶT LẠI MẬT KHẨU — CHỈ MÁY CHỦ (docs/platform/password-reset.md) ═══════════
 *
 * Khách quên mật khẩu là việc hỗ trợ đầu tiên của mọi phần mềm bán theo tháng. Chưa có bộ gửi thư (dịch vụ ngoài mới cần
 * chủ nền tảng duyệt), nên liên kết được TẠO trong ERP rồi gửi qua kênh của người dùng (Zalo, Messenger):
 *  · Quản trị tổ chức (`users:manage`) tạo cho một tài khoản trong CHÍNH tổ chức mình (/settings/users).
 *  · Người vận hành nền tảng tạo cho một tài khoản của tổ chức khách (/platform/org/<mã>) — lối ra khi chính quản trị
 *    của khách quên mật khẩu. Bắt buộc lý do, ghi nhật ký nền tảng.
 * Người được đặt lại TỰ chọn mật khẩu mới: không ai khác biết nó (khác lối «Đặt lại mật khẩu» cũ, nơi quản trị gõ hộ).
 *
 * ─── MÃ ─── 32 byte ngẫu nhiên base64url; CSDL chỉ giữ `sha256`. Dùng MỘT lần (câu `UPDATE … WHERE used_at IS NULL AND
 * revoked_at IS NULL AND expires_at > now()` trong cùng giao dịch với lượt ghi mật khẩu), hết hạn sau 24 giờ. Tạo liên kết
 * mới cho cùng người ⇒ liên kết cũ chưa dùng bị thu hồi. Đặt xong ⇒ thu hồi MỌI phiên của người đó (`PASSWORD_RESET`).
 *
 * ─── TRANG CÔNG KHAI ─── `/reset/<mã tổ chức>/<mã>` không có phiên: mọi lượt tra chạy trong `withOrganization(mã trong
 * đường dẫn)` TƯỜNG MINH. Mọi lý do không hợp lệ ra CÙNG một câu, và mỗi lượt sai đếm vào bộ chặn dò theo IP (cùng bộ đếm
 * với màn đăng nhập) — không ai dò được tổ chức nào / mã nào tồn tại.
 *
 * ─── KÍCH HOẠT ─── Quản trị khách do job cấp phát tạo có mật khẩu ngẫu nhiên không ai biết; liên kết này là đường KÍCH HOẠT của
 * họ (`purpose: "ACTIVATION"` trong nhật ký nền tảng). Đặt xong ⇒ chỉ mục đăng nhập (email ⇒ tổ chức) chắc chắn có — idempotent —
 * để lượt đăng nhập ngay sau ở trang chung không đòi «mã tổ chức» (P0 08/10/2026, lib/auth/identities.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { recordAuthFailure } from "@/lib/platform/auth-failures";
import { indexAccountIdentities } from "@/lib/auth/identities";
import { hashPassword } from "@/lib/auth/password";
import { loginAllowed, loginLockOf, recordLoginFailure } from "@/lib/auth/login-throttle";
import type { AuthFailureReason } from "@/lib/constants/auth-failures";
import { applySessionRevocation } from "@/lib/auth/session-revoke";
import { can, type SessionUser } from "@/lib/auth/session";
import { ACCEPTANCE_ACTOR_LABEL, ACCEPTANCE_REGISTRY_REFUSAL, acceptanceWorkspaceOf } from "@/lib/constants/saas-acceptance";
import { env } from "@/lib/env";
import { ACCEPTANCE_NOT_OWNED_REFUSAL, acceptanceRuntimeRefusal, acceptanceWorkspaceOwned } from "@/lib/saas/acceptance-guard";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { OrgContextError, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { organizationBaseUrl } from "@/lib/platform/publish";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { completeResetSchema, PASSWORD_RESET_INVALID, PASSWORD_RESET_PATH, PASSWORD_RESET_THROTTLED, PASSWORD_RESET_TTL_HOURS } from "@/lib/users/password-reset-shared";

const OPERATOR_REASON_MIN = 5;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(`erp-password-reset:${token}`).digest("hex");
}

export function resetLinkFor(orgCode: string, token: string, baseUrl: string = env.appUrl): string {
  return `${baseUrl.replace(/\/+$/, "")}${PASSWORD_RESET_PATH}/${encodeURIComponent(orgCode)}/${encodeURIComponent(token)}`;
}

// ═══ CHẶN DÒ ═══

function ipKeys(ip: string): string[] {
  const h = createHash("sha256").update(`${env.authSecret}:reset-ip:${ip || "unknown"}`).digest("hex").slice(0, 32);
  return [`ip:reset:${h}`];
}

type Gate = { ok: true; keys: string[] } | { ok: false; error: string; keys: string[] };
function throttleGate(ip: string): Gate {
  const keys = ipKeys(ip);
  return loginAllowed(keys).ok ? { ok: true, keys } : { ok: false, error: PASSWORD_RESET_THROTTLED, keys };
}

async function activeOrg(orgCode: string) {
  const code = String(orgCode ?? "").trim().toLowerCase();
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return null;
  const org = await findOrganization(code);
  return org && org.status === "ACTIVE" ? org : null;
}

// ═══ LỖI CÓ LÝ DO (sứ mệnh saas-ops-signals) ═══
// Người mở liên kết hỏng vẫn nhận ĐÚNG một câu chung (`PASSWORD_RESET_INVALID`); lý do thật chỉ vào sổ `platform_auth_failures`
// cho người vận hành («khách bấm liên kết kích hoạt không vào được» ⇒ hết hạn? đã dùng? đã có liên kết mới hơn?). Lượt tra lý do
// chạy ĐÚNG ở nhánh hỏng, mỗi lượt hỏng đã bị bộ chặn dò theo IP giới hạn (30 / máy / 15 phút).

/** Mã tổ chức của đường dẫn không dùng được vì sao — `null` = tổ chức có và đang chạy. */
async function linkOrgFailure(orgCode: string): Promise<AuthFailureReason | null> {
  const code = String(orgCode ?? "").trim().toLowerCase();
  const org = ORGANIZATION_CODE_PATTERN.test(code) ? await findOrganization(code) : null;
  if (!org) return "ORG_NOT_FOUND";
  return org.status === "ACTIVE" ? null : "ORG_INACTIVE";
}

/** Liên kết không còn dùng được vì sao — chỉ gọi trong `withOrganization` của tổ chức đường dẫn, SAU khi lượt tra «còn dùng được» hỏng. */
async function resetTokenFailure(token: string): Promise<{ reason: AuthFailureReason; email: string | null }> {
  const db = await getDb();
  const t = schema.passwordResetTokens;
  const [row] = await db
    .select({ usedAt: t.usedAt, revokedAt: t.revokedAt, expiresAt: t.expiresAt, email: schema.users.email, active: schema.users.active })
    .from(t)
    .innerJoin(schema.users, eq(schema.users.id, t.userId))
    .where(eq(t.tokenHash, hashResetToken(token)))
    .limit(1);
  if (!row) return { reason: "RESET_LINK_INVALID", email: null };
  if (row.usedAt) return { reason: "RESET_LINK_USED", email: row.email };
  if (row.revokedAt) return { reason: "RESET_LINK_REVOKED", email: row.email };
  if (row.expiresAt.getTime() <= Date.now()) return { reason: "RESET_LINK_EXPIRED", email: row.email };
  if (!row.active) return { reason: "USER_INACTIVE", email: row.email };
  return { reason: "RESET_LINK_INVALID", email: row.email };
}

/**
 * Lý do của một lượt hỏng — KHÔNG BAO GIỜ ném: cả phần tra tổ chức (`linkOrgFailure`) cũng nằm trong try, vì lỗi tra lý do (CSDL nhà chập)
 * mà bay lên là người mở liên kết nhận trang 500 thay cho câu chung. Lỗi ⇒ «liên kết sai» (không đoán).
 */
async function resetFailureWhy(orgCode: string, token: string): Promise<{ reason: AuthFailureReason; email: string | null }> {
  try {
    return await resetFailureWhyCore(orgCode, token);
  } catch {
    return { reason: "RESET_LINK_INVALID", email: null };
  }
}

async function resetFailureWhyCore(orgCode: string, token: string): Promise<{ reason: AuthFailureReason; email: string | null }> {
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return { reason: "RESET_LINK_INVALID", email: null };
  const orgWhy = await linkOrgFailure(orgCode);
  if (orgWhy) return { reason: orgWhy, email: null };
  try {
    return await withOrganization(String(orgCode).trim().toLowerCase(), () => resetTokenFailure(token));
  } catch (error) {
    // Tổ chức vừa bị đình chỉ giữa chừng ⇒ đúng lý do; lỗi khác (CSDL) ⇒ không đoán, ghi «liên kết sai».
    return { reason: error instanceof OrgContextError ? "ORG_INACTIVE" : "RESET_LINK_INVALID", email: null };
  }
}

async function noteResetFailure(orgCode: string, ip: string, why: { reason: AuthFailureReason; email: string | null }, lockKeys?: string[]): Promise<void> {
  await recordAuthFailure({ flow: "RESET_LINK", reason: why.reason, orgCode, identifier: why.email, ip, lock: lockKeys ? loginLockOf(lockKeys) : null });
}

// ═══ TẠO LIÊN KẾT ═══

export type CreatedResetLink = { ok: true; link: string; expiresAt: Date; email: string };

/** Trong ngữ cảnh tổ chức đích: thu hồi liên kết cũ chưa dùng của người đó rồi phát một liên kết mới. */
async function issueInContext(target: { id: string; email: string }, via: "ORG_ADMIN" | "PLATFORM", by: { id: string | null; email: string }) {
  const db = await getDb();
  const t = schema.passwordResetTokens;
  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 3_600_000);
  await db.transaction(async (tx) => {
    await tx.update(t).set({ revokedAt: new Date() }).where(and(eq(t.userId, target.id), isNull(t.usedAt), isNull(t.revokedAt)));
    await tx.insert(t).values({ userId: target.id, tokenHash: hashResetToken(token), createdVia: via, createdByUserId: by.id, createdByEmail: by.email, expiresAt });
  });
  await audit({ userId: by.id, userEmail: by.email, action: "PASSWORD_RESET_LINK", entity: "USER", entityId: target.id, after: { email: target.email, via, expiresAt: expiresAt.toISOString() }, reason: "Tạo liên kết đặt lại mật khẩu dùng một lần" });
  return { token, expiresAt };
}

/** Quản trị tổ chức tạo liên kết cho một tài khoản ĐANG HOẠT ĐỘNG trong chính tổ chức của phiên. */
export async function createResetLinkCore(user: SessionUser, targetUserId: string): Promise<CreatedResetLink | { error: string }> {
  if (!can(user, "users:manage")) return { error: "Bạn không có quyền quản lý người dùng (users:manage)." };
  const org = user.organization;
  if (!org) return { error: "Không xác định được tổ chức của phiên." };
  const db = await getDb();
  const [target] = await db.select({ id: schema.users.id, email: schema.users.email, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, targetUserId)).limit(1);
  if (!target) return { error: "Không có tài khoản này." };
  if (!target.active) return { error: "Tài khoản đang khoá — mở khoá trước rồi mới đặt lại mật khẩu." };
  const { token, expiresAt } = await issueInContext(target, "ORG_ADMIN", { id: user.id, email: user.email });
  return { ok: true, link: resetLinkFor(org.code, token, await organizationBaseUrl(org.code)), expiresAt, email: target.email };
}

/**
 * Người vận hành nền tảng tạo liên kết cho một tài khoản (theo email) của tổ chức khách — lối ra khi chính quản trị của
 * khách quên mật khẩu, và đường KÍCH HOẠT quản trị khách mới / gửi lại kích hoạt (`opts.purpose = "ACTIVATION"` — chỉ lõi máy
 * chủ truyền, ghi vào nhật ký nền tảng). Hỏi người vận hành TRƯỚC mọi lượt đọc; bắt buộc lý do; nhật ký nền tảng ghi trước khi
 * trả liên kết.
 */
export async function createResetLinkAsOperator(user: SessionUser, raw: { orgCode?: unknown; email?: unknown; reason?: unknown }, opts: { purpose?: "RESET" | "ACTIVATION" } = {}): Promise<CreatedResetLink | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  return issueCustomerAccountLink(raw, { actor: { orgCode: user.organization!.code, userId: user.id, email: user.email }, by: user.email, source: "UI" }, opts);
}

/**
 * ĐƯỜNG CỦA MÁY — ops `saas-acceptance` kích hoạt / đặt lại mật khẩu cho TÀI KHOẢN THỬ của chính nó bằng ĐÚNG lõi của nút người
 * vận hành (thu hồi liên kết cũ, chỉ băm trong CSDL, lý do bắt buộc, nhật ký nền tảng TRƯỚC khi trả liên kết). Người thao tác là
 * MÁY: nhật ký nền tảng `actor = null` nguồn SCRIPT, nhãn cố định — không mượn tên người nào (AGENTS 34).
 *
 * Ba lá chắn, theo thứ tự, TRƯỚC mọi lượt ghi (docs/saas/SECURITY.md §2):
 *  1. Chỉ trong tiến trình ops — máy chủ ứng dụng (NEXT_RUNTIME có giá trị) bị từ chối (`acceptanceRuntimeRefusal`).
 *  2. Đúng CẶP (mã workspace, email quản trị) của sổ khai — mã khác, hay tài khoản khác trong cùng workspace, đều bị từ chối.
 *  3. Workspace mang mã ấy ĐÚNG do ops tạo (`acceptanceWorkspaceOwned`: job khoá `saas-acceptance:<mã>` + tài khoản đúng sổ).
 *     Sổ khai một mình KHÔNG đủ: kho mã PUBLIC, mã đã lộ — một người tự đăng ký trùng cả mã lẫn email sẽ qua được lá chắn 2.
 * Nơi gọi duy nhất là lõi ops `lib/saas/acceptance.ts` (tests/saas-acceptance.test.ts quét MỌI lần nhắc tới định danh này).
 */
export async function createAcceptanceResetLink(raw: { orgCode?: unknown; email?: unknown; reason?: unknown }, opts: { purpose?: "RESET" | "ACTIVATION" } = {}): Promise<CreatedResetLink | { error: string }> {
  const runtime = acceptanceRuntimeRefusal();
  if (runtime) return { error: runtime };
  const entry = acceptanceWorkspaceOf(typeof raw.orgCode === "string" ? raw.orgCode : null);
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!entry || email !== entry.ownerEmail) return { error: ACCEPTANCE_REGISTRY_REFUSAL };
  if (!(await acceptanceWorkspaceOwned(entry))) return { error: ACCEPTANCE_NOT_OWNED_REFUSAL };
  return issueCustomerAccountLink(raw, { actor: null, by: ACCEPTANCE_ACTOR_LABEL, source: "SCRIPT" }, opts);
}

/** Lõi chung SAU cổng (người vận hành đã qua `platformOperatorDenial`, hoặc máy đã qua ba lá chắn của `createAcceptanceResetLink`). Không xuất. */
async function issueCustomerAccountLink(raw: { orgCode?: unknown; email?: unknown; reason?: unknown }, by: { actor: PlatformActor; by: string; source: PlatformAuditSource }, opts: { purpose?: "RESET" | "ACTIVATION" }): Promise<CreatedResetLink | { error: string }> {
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  if (reason.length < OPERATOR_REASON_MIN) return { error: `Ghi lý do (ít nhất ${OPERATOR_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.` };
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!email) return { error: "Nhập email tài khoản cần đặt lại." };
  const org = await activeOrg(typeof raw.orgCode === "string" ? raw.orgCode : "");
  if (!org || org.isHome) return { error: "Chỉ đặt lại cho tài khoản của tổ chức khách đang hoạt động — tài khoản nhà dùng trang Người dùng." };
  const target = await withOrganization(org.code, async () => {
    const db = await getDb();
    const [row] = await db.select({ id: schema.users.id, email: schema.users.email, active: schema.users.active }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
    return row ?? null;
  });
  if (!target) return { error: `Tổ chức «${org.name}» không có tài khoản ${email}.` };
  if (!target.active) return { error: "Tài khoản đang khoá — quản trị tổ chức mở khoá trước." };
  await platformAudit({ action: "PASSWORD_RESET_LINK", targetOrgCode: org.code, subject: `user:${target.email}`, after: { expiresInHours: PASSWORD_RESET_TTL_HOURS, ...(opts.purpose === "ACTIVATION" ? { purpose: "ACTIVATION" } : {}) }, reason, source: by.source, actor: by.actor });
  const { token, expiresAt } = await withOrganization(org.code, () => issueInContext(target, "PLATFORM", { id: null, email: `platform:${by.by}` }));
  return { ok: true, link: resetLinkFor(org.code, token, await organizationBaseUrl(org.code)), expiresAt, email: target.email };
}

// ═══ TRANG CÔNG KHAI ═══

async function activeTokenRow(token: string) {
  const db = await getDb();
  const t = schema.passwordResetTokens;
  const [row] = await db
    .select({ id: t.id, userId: t.userId, expiresAt: t.expiresAt, email: schema.users.email, phone: schema.users.phone, active: schema.users.active })
    .from(t)
    .innerJoin(schema.users, eq(schema.users.id, t.userId))
    .where(and(eq(t.tokenHash, hashResetToken(token)), isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)))
    .limit(1);
  return row && row.active ? row : null;
}

export type ResetLookup = { ok: true; orgCode: string; orgName: string; email: string; expiresAt: Date } | { ok: false; error: string };

/** Mở trang: CHỈ ĐỌC, không tiêu mã (bot xem trước liên kết của Zalo / Messenger không làm hỏng liên kết). */
export async function lookupResetToken(orgCode: string, token: string, opts: { ip: string }): Promise<ResetLookup> {
  const gate = throttleGate(opts.ip);
  if (!gate.ok) {
    await noteResetFailure(orgCode, opts.ip, { reason: "THROTTLED", email: null }, gate.keys);
    return { ok: false, error: gate.error };
  }
  const fail = async (): Promise<ResetLookup> => {
    recordLoginFailure(gate.keys);
    await noteResetFailure(orgCode, opts.ip, await resetFailureWhy(orgCode, token));
    return { ok: false, error: PASSWORD_RESET_INVALID };
  };
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return fail();
  const org = await activeOrg(orgCode);
  if (!org) return fail();
  try {
    const row = await withOrganization(org.code, () => activeTokenRow(token));
    if (!row) return fail();
    return { ok: true, orgCode: org.code, orgName: org.name, email: row.email, expiresAt: row.expiresAt };
  } catch (error) {
    if (error instanceof OrgContextError) return fail();
    throw error;
  }
}

/** Đặt mật khẩu mới: tiêu mã + ghi mật khẩu trong MỘT giao dịch, rồi thu hồi mọi phiên của người đó. Không tự đăng nhập. */
export async function completePasswordResetCore(orgCode: string, token: string, input: unknown, opts: { ip: string }): Promise<{ ok: true; orgCode: string; email: string } | { error: string }> {
  const gate = throttleGate(opts.ip);
  if (!gate.ok) {
    await noteResetFailure(orgCode, opts.ip, { reason: "THROTTLED", email: null }, gate.keys);
    return { error: gate.error };
  }
  const parsed = completeResetSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const invalid = async () => {
    recordLoginFailure(gate.keys);
    await noteResetFailure(orgCode, opts.ip, await resetFailureWhy(orgCode, token));
    return { error: PASSWORD_RESET_INVALID };
  };
  if (!TOKEN_PATTERN.test(String(token ?? ""))) return invalid();
  const org = await activeOrg(orgCode);
  if (!org) return invalid();
  const passwordHash = await hashPassword(parsed.data.password);
  let done: { userId: string; email: string } | null;
  try {
    done = await withOrganization(org.code, async () => {
      const row = await activeTokenRow(token);
      if (!row) return null;
      const db = await getDb();
      const t = schema.passwordResetTokens;
      const ok = await db.transaction(async (tx) => {
        const [won] = await tx
          .update(t)
          .set({ usedAt: new Date() })
          .where(and(eq(t.id, row.id), isNull(t.usedAt), isNull(t.revokedAt), gt(t.expiresAt, sql`now()`)))
          .returning({ id: t.id });
        if (!won) return false;
        await tx.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
        return true;
      });
      if (!ok) return null;
      // Đặt lại mà phiên cũ vẫn sống thì việc đặt lại vô nghĩa — thu hồi bắt buộc, không cờ tắt.
      await applySessionRevocation({ targetUserId: row.userId, targetEmail: row.email, trigger: "PASSWORD_RESET", actor: { id: null, label: "liên kết đặt lại mật khẩu" } });
      await audit({ userId: row.userId, userEmail: row.email, action: "PASSWORD_RESET_COMPLETE", entity: "USER", entityId: row.userId, after: { via: "LINK" }, reason: "Người dùng tự đặt mật khẩu mới qua liên kết dùng một lần" });
      // Kích hoạt / đặt lại xong ⇒ chỉ mục đăng nhập CHẮC CHẮN có (idempotent): tài khoản tạo trước bản vá 08/10/2026 chưa có dòng
      // nào, và đặt mật khẩu không phải một lượt đăng nhập — mốc dùng để trống (lib/auth/identities.ts).
      await indexAccountIdentities(org.code, { id: row.userId, email: row.email, phone: row.phone, active: row.active });
      return { userId: row.userId, email: row.email };
    });
  } catch (error) {
    if (error instanceof OrgContextError) return invalid();
    throw error;
  }
  if (!done) return invalid();
  return { ok: true, orgCode: org.code, email: done.email };
}
