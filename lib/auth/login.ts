import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { findIdentity, indexAccountIdentities, recordIdentity } from "@/lib/auth/identities";
import { parseLoginIdentifier, type IdentityKind } from "@/lib/auth/identity-shared";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { SessionSubject } from "@/lib/auth/session";
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

export type LoginVerdict =
  | { ok: true; subject: SessionSubject }
  /** `BAD_CREDENTIALS` gộp: email sai · mật khẩu sai · mã tổ chức sai / không hoạt động. */
  | { ok: false; code: "BAD_CREDENTIALS" | "DISABLED"; error: string };

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

const badCredentials = (): LoginVerdict => ({ ok: false, code: "BAD_CREDENTIALS", error: LOGIN_BAD_CREDENTIALS });

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
  if (!user.active) return { ok: false, code: "DISABLED", error: LOGIN_ACCOUNT_DISABLED };
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
    return badCredentials();
  }
  try {
    return await withOrganization(org.code, async () => {
      const user = await findUserByIdentifier(input.email);
      if (!user) {
        await burnPasswordCheck(input.password);
        return badCredentials();
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) return badCredentials();
      return openSession(user, org.code, issue, null);
    });
  } catch (error) {
    // Tổ chức bị đình chỉ GIỮA lúc tra sổ và lúc vào ngữ cảnh: vẫn là cùng một câu, không lộ gì thêm.
    if (error instanceof OrgContextError) return badCredentials();
    throw error;
  }
}

/** Mật khẩu có khớp tài khoản `email` (hoặc SĐT) ở tổ chức `orgCode` không — KHÔNG mở phiên (bước dò nhiều tổ chức). */
export async function credentialsMatch(input: { email: string; password: string; orgCode: string }): Promise<boolean> {
  const org = await findOrganization(input.orgCode);
  if (!org || org.status !== "ACTIVE") return false;
  try {
    return await withOrganization(org.code, async () => {
      const user = await findUserByIdentifier(input.email);
      if (!user) {
        await burnPasswordCheck(input.password);
        return false;
      }
      return verifyPassword(input.password, user.passwordHash);
    });
  } catch (error) {
    if (error instanceof OrgContextError) return false;
    throw error;
  }
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
  if (!org || org.status !== "ACTIVE") return badCredentials();
  try {
    return await withOrganization(org.code, async () => {
      const db = await getDb();
      const user = await db.query.users.findFirst({ where: eq(schema.users.id, input.userId) });
      if (!user) return badCredentials();
      const v = await openSession(user, org.code, issue, input.provider);
      if (v.ok) await recordIdentity(input.provider, input.subject, org.code, user.id);
      return v;
    });
  } catch (error) {
    if (error instanceof OrgContextError) return badCredentials();
    throw error;
  }
}
