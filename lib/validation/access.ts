/**
 * Lược đồ kiểm tra đầu vào cho ba chiều quyền truy cập.
 *
 * Để riêng khỏi `lib/actions/access.ts` vì tệp `"use server"` chỉ được xuất hàm async
 * (`tests/use-server-exports.test.ts`) — hằng số lược đồ nằm đó thì kho không dựng được.
 */
import { z } from "zod";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { ACCESS_SCOPES, ROLE_BUILDER_FORBIDDEN } from "@/lib/constants/access-scope";
import { ROLE_ORDER } from "@/lib/constants/roles";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, "Mã tối thiểu 2 ký tự")
  .max(40, "Mã tối đa 40 ký tự")
  .regex(/^[A-Z0-9_]+$/, "Mã chỉ gồm chữ không dấu, số và gạch dưới");

const name = z.string().trim().min(2, "Tên tối thiểu 2 ký tự").max(100, "Tên tối đa 100 ký tự");
const description = z.string().trim().max(300, "Mô tả tối đa 300 ký tự").default("");
const scope = z.enum(ACCESS_SCOPES, { error: "Chọn phạm vi dữ liệu" });

/**
 * Bó quyền của một vai trò tuỳ chỉnh.
 *
 * `users:manage` bị loại Ở ĐÂY chứ không chỉ ở lúc tính quyền: nếu chỉ lọc lúc tính thì cơ sở dữ
 * liệu vẫn lưu một vai trò trông như thể nó cấp quyền đó, và màn hình vẫn hiện dấu tích. Người
 * xem tưởng mình đã cấp; hệ thống thì không. Chặn ngay ở cửa vào thì hai bên nói cùng một chuyện.
 */
const bundle = z
  .array(z.enum(ALL_PERMISSIONS as [string, ...string[]]))
  .max(200)
  .refine((list) => !list.some((p) => ROLE_BUILDER_FORBIDDEN.includes(p)), {
    message: "Vai trò tuỳ chỉnh không được cấp quyền quản lý người dùng — đó là cửa để tự nâng mình lên toàn quyền",
  });

export const saveAccessRoleSchema = z.object({
  /** Rỗng = tạo mới. */
  id: z.string().trim().default(""),
  code,
  name,
  description,
  /** `ADMIN` bị loại: vai trò nền toàn quyền biến mọi giới hạn phía trên thành trang trí. */
  baseRole: z.enum(ROLE_ORDER.filter((r) => r !== "ADMIN") as [string, ...string[]], { error: "Chọn vai trò nền" }),
  permissions: bundle,
  defaultScope: scope,
  active: z.boolean().default(true),
});
export type SaveAccessRoleInput = z.infer<typeof saveAccessRoleSchema>;

export const savePositionSchema = z.object({
  id: z.string().trim().default(""),
  code,
  name,
  description,
  /** Rỗng = không gắn phòng ban nào. */
  departmentId: z.string().trim().default(""),
  active: z.boolean().default(true),
});
export type SavePositionInput = z.infer<typeof savePositionSchema>;

/** Gán ba chiều cho một người dùng. Chức danh đi cùng đường này nhưng KHÔNG ảnh hưởng tới quyền. */
export const setUserAccessSchema = z.object({
  userId: z.string().min(1),
  /** Rỗng = không dùng vai trò tuỳ chỉnh (quay về mẫu quyền của vai trò hệ thống). */
  accessRoleId: z.string().trim().default(""),
  /** Rỗng = chưa đặt chức danh. */
  positionId: z.string().trim().default(""),
  scope,
});
export type SetUserAccessInput = z.infer<typeof setUserAccessSchema>;
