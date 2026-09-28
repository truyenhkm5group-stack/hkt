/**
 * ═══════════ ĐƯỜNG GHI DUY NHẤT CỦA VAI TRÒ TUỲ CHỈNH (`access_roles`) ═══════════
 *
 * Tách khỏi server action `saveAccessRole` (`lib/actions/access.ts`) để MỘT hàm lõi phục vụ cả màn hình Người dùng
 * lẫn bộ cài blueprint (Phase 7) — cùng mẫu với `lib/platform-ui/module-toggle.ts`: tệp "use server" chỉ đọc phiên,
 * gọi lõi, làm mới màn hình; lõi nhận một `SessionUser` nên bài kiểm (chạy ngoài Next, không cookie) gọi được mà không
 * có nhánh nào riêng cho kiểm thử.
 *
 * Lõi kiểm quyền LẦN HAI (`users:manage`) và đi qua CHÍNH lược đồ `saveAccessRoleSchema` — nơi luật 31 bị chặn ở cửa
 * vào (không `users:manage` hay khoá cấm khác trong bó quyền, không nền ADMIN). Mọi lượt ghi có nhật ký TRƯỚC/SAU.
 * KHÔNG làm mới màn hình: đó là việc của lớp action (`ORG_DEPENDENT_PATHS`).
 */
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { saveAccessRoleSchema } from "@/lib/validation/access";

export type AccessRoleWriteResult = { ok: true; id: string; changed: boolean } | { error: string };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/** Tạo / sửa một vai trò tuỳ chỉnh. Vai trò hệ thống không đi qua đây — chúng không phải dòng dữ liệu. */
export async function saveAccessRoleCore(user: SessionUser, input: unknown, opts: { reason?: string } = {}): Promise<AccessRoleWriteResult> {
  if (!can(user, "users:manage")) return { error: "Không có quyền" };
  const parsed = saveAccessRoleSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const data = parsed.data;
  const db = await getDb();

  const trung = await db.query.accessRoles.findFirst({
    where: data.id ? and(eq(schema.accessRoles.code, data.code), ne(schema.accessRoles.id, data.id)) : eq(schema.accessRoles.code, data.code),
    columns: { id: true },
  });
  if (trung) return { error: `Mã "${data.code}" đã được dùng cho một vai trò khác` };

  const values = {
    code: data.code,
    name: data.name,
    description: data.description,
    baseRole: data.baseRole as (typeof schema.accessRoles.$inferInsert)["baseRole"],
    permissions: [...new Set(data.permissions)].sort(),
    defaultScope: data.defaultScope,
    active: data.active,
  };

  if (!data.id) {
    const [row] = await db.insert(schema.accessRoles).values(values).returning({ id: schema.accessRoles.id });
    await audit({ userId: user.id, userEmail: user.email, action: "ACCESS_ROLE_CREATE", entity: "ACCESS_ROLE", entityId: row.id, detail: { after: values }, ...(opts.reason ? { reason: opts.reason } : {}) });
    return { ok: true, id: row.id, changed: true };
  }

  const cu = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.id, data.id) });
  if (!cu) return { error: "Không tìm thấy vai trò" };
  await db.update(schema.accessRoles).set(values).where(eq(schema.accessRoles.id, data.id));
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ACCESS_ROLE_UPDATE",
    entity: "ACCESS_ROLE",
    entityId: data.id,
    detail: {
      before: { code: cu.code, name: cu.name, baseRole: cu.baseRole, permissions: cu.permissions, defaultScope: cu.defaultScope, active: cu.active },
      after: values,
    },
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  return { ok: true, id: data.id, changed: true };
}
