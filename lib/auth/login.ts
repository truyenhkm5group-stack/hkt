import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
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
 * Hàm này không đọc cookie / header: `loginAction` lo chặn dò mật khẩu và ghi cookie (qua `issue`),
 * nên nó chạy được trong bài kiểm ngoài Next.
 */

export const LOGIN_BAD_CREDENTIALS = "Email hoặc mật khẩu không đúng.";
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

/**
 * Kiểm thông tin đăng nhập TRONG tổ chức `orgCode`, và khi đúng thì gọi `issue` (ký + ghi cookie)
 * rồi ghi `lastLoginAt` + nhật ký — cùng trong ngữ cảnh tổ chức đó.
 */
export async function verifyLogin(
  input: { email: string; password: string; orgCode: string },
  issue: (subject: SessionSubject) => Promise<void>,
): Promise<LoginVerdict> {
  const org = await findOrganization(input.orgCode);
  if (!org || org.status !== "ACTIVE") {
    await burnPasswordCheck(input.password);
    return badCredentials();
  }
  try {
    return await withOrganization(org.code, async () => {
      const db = await getDb();
      const user = await db.query.users.findFirst({ where: eq(schema.users.email, input.email) });
      if (!user) {
        await burnPasswordCheck(input.password);
        return badCredentials();
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) return badCredentials();
      if (!user.active) return { ok: false, code: "DISABLED", error: LOGIN_ACCOUNT_DISABLED } as const;
      const subject: SessionSubject = { id: user.id, email: user.email, name: user.name, role: user.role, orgCode: org.code };
      await issue(subject);
      await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
      await audit({ userId: user.id, userEmail: user.email, action: "LOGIN", entity: "USER", entityId: user.id });
      return { ok: true, subject } as const;
    });
  } catch (error) {
    // Tổ chức bị đình chỉ GIỮA lúc tra sổ và lúc vào ngữ cảnh: vẫn là cùng một câu, không lộ gì thêm.
    if (error instanceof OrgContextError) return badCredentials();
    throw error;
  }
}
