import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { findIdentity, indexAccountIdentities, recordIdentity } from "@/lib/auth/identities";
import { parseLoginIdentifier, type IdentityKind } from "@/lib/auth/identity-shared";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { SessionSubject } from "@/lib/auth/session";
import type { AuthFailureReason } from "@/lib/constants/auth-failures";
import { OrgContextError, withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization } from "@/lib/platform/organizations";

/**
 * ═══════════ ĐĂNG NHẬP THEO TỔ CHỨC (tenant-readiness-audit ISO-10) ═══════════
 *
 * Tư cách thành viên = tài khoản trong CSDL của tổ chức (target-architecture P5). Nên THỨ TỰ là
 * luật, không phải chi tiết: xác định tổ chức → vào ngữ cảnh của nó → tra người → kiểm mật khẩu →
 * ký phiên mang `org` → ghi nhật ký — TẤT CẢ trong `withOrganization(mã)`. Tra email trước rồi mới
 * đặt ngữ cảnh là để người trùng email ở hai tổ chức khớp mật khẩu ở tổ chức kia.
 *
 * ─── MÃ TỔ CHỨC SAI = MẬT KHẨU SAI ───
 *
 * Một câu lỗi riêng cho "không có tổ chức này" là một máy dò danh sách khách hàng của nền tảng. Nên
 * mã không tồn tại / không hoạt động trả ĐÚNG câu của sai mật khẩu, và vẫn tốn một lượt so băm giả
 * để thời gian phản hồi không tố cáo nó (cùng lý do cho email không tồn tại).
 *
 * ─── EMAIL HOẶC SỐ ĐIỆN THOẠI (0193) ───
 *
 * Ô `email` nhận cả SĐT di động VN (`parseLoginIdentifier`). Chỉ mục danh tính toàn nền tảng (`lib/auth/identities.ts`) cho
 * trang chung biết thử những tổ chức nào (`loginCandidates`) — nó được ghi NGAY khi tài khoản dùng được bằng mật khẩu (cấp
 * phát quản trị, tạo hộ, nhận lời mời, đặt mật khẩu qua liên kết), không đợi lần đăng nhập đầu; đăng nhập đúng ghi thêm mốc
 * dùng. Chỉ mục KHÔNG mở phiên: mật khẩu vẫn kiểm trong CSDL tổ chức như cũ.
 *
 * Hàm này không đọc cookie / header: `loginAction` lo chặn dò mật khẩu và ghi cookie (qua `issue`),
 * nên nó chạy được trong bài kiểm ngoài Next.
 */

export const LOGIN_BAD_CREDENTIALS = "Email / số điện thoại hoặc mật khẩu không đúng.";
export const LOGIN_ACCOUNT_DISABLED = "Tài khoản đã bị khoá. Liên hệ quản trị viên.";

/**
 * LÝ DO THẬT của một lượt đăng nhập hỏng (sứ mệnh saas-ops-signals) — CHỈ cho sổ lỗi đăng nhập của người vận hành
 * (`lib/auth/auth-failures.ts`). Câu trả người dùng (`error`) KHÔNG đổi theo lý do: mọi lý do trừ tài khoản khoá vẫn ra đúng
 * `LOGIN_BAD_CREDENTIALS`.
 */
export type LoginFailureReason = Extract<AuthFailureReason, "NO_IDENTITY" | "BAD_PASSWORD" | "USER_INACTIVE" | "ORG_INACTIVE" | "ORG_NOT_FOUND">;

export type LoginVerdict =
  | { ok: true; subject: SessionSubject }
  /**
   * `BAD_CREDENTIALS` gộp: email sai · mật khẩu sai · mã tổ chức sai / không hoạt động. `reason` + `orgCode` (tổ chức CÓ THẬT nơi lượt
   * hỏng xảy ra, `null` khi mã không tồn tại) chỉ để ghi sổ — không bao giờ in cho người đang đăng nhập.
   */
  | { ok: false; code: "BAD_CREDENTIALS" | "DISABLED"; error: string; reason: LoginFailureReason; orgCode: string | null };

/** Mã tổ chức gõ trên form ⇒ mã dùng để tra. Bỏ trống ⇒ tổ chức nhà (đăng nhập y như trước nền tảng). */
export async function loginOrgCode(raw: string | null | undefined): Promise<string> {
  const code = String(raw ?? "").trim().toLowerCase();
  return code || (await getHomeOrganization()).code;
}

let dummyHash: Promise<string> | null = null;
/** So với một băm giả: nhánh "không có tổ chức / không có người" tốn cùng thời gian với nhánh sai mật khẩu. */
async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("khong-phai-mat-khau-cua-ai-ca");
  await verifyPassword(password, await dummyHash);
}

const badCredentials = (reason: LoginFailureReason, orgCode: string | null): LoginVerdict => ({ ok: false, code: "BAD_CREDENTIALS", error: LOGIN_BAD_CREDENTIALS, reason, orgCode });

type UserRow = typeof schema.users.$inferSelect;

/** Tra tài khoản theo email hoặc SĐT TRONG ngữ cảnh tổ chức hiện tại. */
async function findUserByIdentifier(raw: string): Promise<UserRow | undefined> {
  const id = parseLoginIdentifier(raw);
  if (!id) return undefined;
  const db = await getDb();
  return db.query.users.findFirst({ where: id.kind === "EMAIL" ? eq(schema.users.email, id.value) : eq(schema.users.phone, id.value) });
}

/** Đã đúng người ⇒ ký phiên, ghi `lastLoginAt` + nhật ký + chỉ mục danh tính. Gọi TRONG `withOrganization(org)`. */
async function openSession(user: UserRow, orgCode: string, issue: (subject: SessionSubject) => Promise<void>, via: string | null): Promise<LoginVerdict> {
  if (!user.active) return { ok: false, code: "DISABLED", error: LOGIN_ACCOUNT_DISABLED, reason: "USER_INACTIVE", orgCode };
  const subject: SessionSubject = { id: user.id, email: user.email, name: user.name, role: user.role, orgCode };
  await issue(subject);
  const db = await getDb();
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit({ userId: user.id, userEmail: user.email, action: "LOGIN", entity: "USER", entityId: user.id, ...(via ? { after: { via } } : {}) });
  // Cùng đường ghi với lúc tài khoản được tạo / kích hoạt — ở đây là một lượt ĐĂNG NHẬP nên có mốc dùng.
  await indexAccountIdentities(orgCode, user, { usedAt: new Date() });
  return { ok: true, subject };
}

/**
 * Kiểm thông tin đăng nhập TRONG tổ chức `orgCode`, và khi đúng thì gọi `issue` (ký + ghi cookie)
 * rồi ghi `lastLoginAt` + nhật ký — cùng trong ngữ cảnh tổ chức đó. `email` nhận cả SĐT.
 */
export async function verifyLogin(input: { email: string; password: string; orgCode: string }, issue: (subject: SessionSubject) => Promise<void>): Promise<LoginVerdict> {
  const org = await findOrganization(input.orgCode);
  if (!org || org.status !== "ACTIVE") {
    await burnPasswordCheck(input.password);
    return org ? badCredentials("ORG_INACTIVE", org.code) : badCredentials("ORG_NOT_FOUND", null);
  }
  try {
    return await withOrganization(org.code, async () => {
      const user = await findUserByIdentifier(input.email);
      if (!user) {
        await burnPasswordCheck(input.password);
        return badCredentials("NO_IDENTITY", org.code);
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) return badCredentials("BAD_PASSWORD", org.code);
      return openSession(user, org.code, issue, null);
    });
  } catch (error) {
    // Tổ chức bị đình chỉ GIỮA lúc tra sổ và lúc vào ngữ cảnh: vẫn là cùng một câu, không lộ gì thêm.
    if (error instanceof OrgContextError) return badCredentials("ORG_INACTIVE", org.code);
    throw error;
  }
}

export type CredentialsCheck = { ok: true } | { ok: false; reason: LoginFailureReason; orgCode: string | null };

/**
 * Mật khẩu có khớp tài khoản `email` (hoặc SĐT) ở tổ chức `orgCode` không — KHÔNG mở phiên (bước dò nhiều tổ chức) — kèm LÝ DO khi
 * không khớp (chỉ cho sổ lỗi đăng nhập). Tài khoản khoá mà mật khẩu ĐÚNG vẫn trả `ok` như trước: `verifyLogin` ngay sau đó nói «khoá».
 */
export async function credentialsCheck(input: { email: string; password: string; orgCode: string }): Promise<CredentialsCheck> {
  const org = await findOrganization(input.orgCode);
  if (!org) return { ok: false, reason: "ORG_NOT_FOUND", orgCode: null };
  if (org.status !== "ACTIVE") return { ok: false, reason: "ORG_INACTIVE", orgCode: org.code };
  try {
    return await withOrganization(org.code, async (): Promise<CredentialsCheck> => {
      const user = await findUserByIdentifier(input.email);
      if (!user) {
        await burnPasswordCheck(input.password);
        return { ok: false, reason: "NO_IDENTITY", orgCode: org.code };
      }
      return (await verifyPassword(input.password, user.passwordHash)) ? { ok: true } : { ok: false, reason: "BAD_PASSWORD", orgCode: org.code };
    });
  } catch (error) {
    if (error instanceof OrgContextError) return { ok: false, reason: "ORG_INACTIVE", orgCode: org.code };
    throw error;
  }
}

/** Mật khẩu có khớp tài khoản `email` (hoặc SĐT) ở tổ chức `orgCode` không — KHÔNG mở phiên (bước dò nhiều tổ chức). */
export async function credentialsMatch(input: { email: string; password: string; orgCode: string }): Promise<boolean> {
  return (await credentialsCheck(input)).ok;
}

const FAILURE_PRIORITY: readonly LoginFailureReason[] = ["BAD_PASSWORD", "USER_INACTIVE", "ORG_INACTIVE", "NO_IDENTITY", "ORG_NOT_FOUND"];

/**
 * Trang chung dò NHIỀU tổ chức mà không tổ chức nào khớp ⇒ MỘT lý do cho sổ: lý do nói nhiều nhất về chỗ tài khoản thật sự nằm
 * (sai mật khẩu ở tổ chức có tài khoản > tổ chức đình chỉ > không có tài khoản). «Không có tài khoản» ở tổ chức NHÀ của trang chung
 * (nhà luôn là ứng viên) KHÔNG quy về nhà — người gõ một email không có ở đâu cả chưa chắc là người của nhà. HÀM THUẦN.
 */
export function strongestLoginFailure(fails: readonly { reason: LoginFailureReason; orgCode: string | null }[], homeCode: string): { reason: LoginFailureReason; orgCode: string | null } {
  const sorted = [...fails].sort((a, b) => FAILURE_PRIORITY.indexOf(a.reason) - FAILURE_PRIORITY.indexOf(b.reason));
  const top = sorted[0];
  if (!top) return { reason: "NO_IDENTITY", orgCode: null };
  if (top.reason === "NO_IDENTITY") {
    const indexed = sorted.find((f) => f.reason === "NO_IDENTITY" && f.orgCode && f.orgCode !== homeCode);
    return { reason: "NO_IDENTITY", orgCode: indexed?.orgCode ?? null };
  }
  return top;
}

/**
 * Đăng nhập ở trang CHUNG không có mã tổ chức: những tổ chức có thể chứa tài khoản này = các tổ chức trong chỉ mục danh
 * tính + tổ chức nhà (tài khoản của nhà chưa từng đăng nhập sau 0193 thì chưa có trong chỉ mục — giữ đường cũ). Thứ tự:
 * mới dùng nhất trước, nhà cuối. Ô gõ không phải email / SĐT hợp lệ ⇒ chỉ nhà (như trước).
 */
export async function loginCandidates(identifier: string): Promise<string[]> {
  const home = (await getHomeOrganization()).code;
  const id = parseLoginIdentifier(identifier);
  const hits = id ? await findIdentity(id.kind, id.value) : [];
  const codes = [...new Set(hits.map((h) => h.orgCode))].filter((c) => c !== home);
  return [...codes, home];
}

/**
 * Đăng nhập KHÔNG mật khẩu sau khi nhà cung cấp (Google / Facebook) đã xác minh người này — chỉ gọi từ đường OAuth đã kiểm
 * `state`. Tài khoản phải còn trong tổ chức, đúng `userId`, còn hoạt động. Ghi thêm danh tính của nhà cung cấp.
 */
export async function completeProviderLogin(
  input: { orgCode: string; userId: string; provider: Extract<IdentityKind, "GOOGLE" | "FACEBOOK">; subject: string },
  issue: (subject: SessionSubject) => Promise<void>,
): Promise<LoginVerdict> {
  const org = await findOrganization(input.orgCode);
  if (!org) return badCredentials("ORG_NOT_FOUND", null);
  if (org.status !== "ACTIVE") return badCredentials("ORG_INACTIVE", org.code);
  try {
    return await withOrganization(org.code, async () => {
      const db = await getDb();
      const user = await db.query.users.findFirst({ where: eq(schema.users.id, input.userId) });
      if (!user) return badCredentials("NO_IDENTITY", org.code);
      const v = await openSession(user, org.code, issue, input.provider);
      if (v.ok) await recordIdentity(input.provider, input.subject, org.code, user.id);
      return v;
    });
  } catch (error) {
    if (error instanceof OrgContextError) return badCredentials("ORG_INACTIVE", org.code);
    throw error;
  }
}
