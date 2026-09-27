import { z } from "zod";
import { can, type SessionUser } from "@/lib/auth/session";
import { setOrganizationFeature, setOrganizationModule, type ModuleChangeResult } from "@/lib/platform/module-config";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

/**
 * ═══════════ LÕI CỦA BA SERVER ACTION BẬT / TẮT MODULE ═══════════
 *
 * `lib/actions/platform-modules.ts` ("use server") chỉ làm ba việc của Next: đọc phiên
 * (`requirePermission`), gọi hàm ở đây, `revalidatePath`. Mọi thứ còn lại — kiểm quyền lần hai, zod,
 * gọi ĐƯỜNG GHI DUY NHẤT (`setOrganizationModule` / `setOrganizationFeature`), dịch kết quả thành
 * `{ error }` — nằm ở tệp THƯỜNG này để bộ kiểm thử (chạy ngoài Next, không có cookie) gọi được với
 * một `SessionUser` dựng tay. Không có nhánh nào chỉ dành cho kiểm thử.
 *
 * Câu lỗi là NGUYÊN VĂN câu giải thích của `validateModuleChange` (CHẶN + GIẢI THÍCH, P10): không tự
 * bật dây chuyền, không viết lại câu ở tầng giao diện.
 */

export type ToggleResult = { ok: true; changed: boolean } | { error: string };

const reason = z.string().trim().max(500).optional();

const moduleInput = z.object({ moduleKey: z.string().trim().min(1).max(64), enabled: z.boolean(), reason });
const featureInput = z.object({ featureKey: z.string().trim().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "Khoá tính năng không hợp lệ"), enabled: z.boolean(), reason });
/** Đổi module của tổ chức KHÁC bắt buộc lý do — người của tổ chức ấy đọc nó trong nhật ký của họ. */
const orgModuleInput = z.object({
  orgCode: z.string().trim().regex(ORGANIZATION_CODE_PATTERN, "Mã tổ chức không hợp lệ"),
  moduleKey: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  reason: z.string().trim().min(5, "Ghi lý do (ít nhất 5 ký tự) — người của tổ chức đó sẽ đọc nó trong nhật ký").max(500),
});

function actorOf(user: SessionUser) {
  return user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null;
}

function toResult(r: ModuleChangeResult): ToggleResult {
  return r.ok ? { ok: true, changed: r.changed } : { error: r.message };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/**
 * Vì sao người này KHÔNG vận hành được nền tảng (`null` = được). Hai điều kiện, cả hai bắt buộc:
 * khoá `platform:operate` VÀ là người của tổ chức nhà. Phiên không mang tổ chức ⇒ từ chối — hỏng về
 * phía hẹp (AGENTS.md luật 31).
 */
export function platformOperatorDenial(user: SessionUser): string | null {
  // Kiểm tổ chức TRƯỚC: `can()` cũng chặn `platform:operate` ngoài tổ chức nhà, nhưng câu trả lời cụ
  // thể ("phải là người tổ chức nhà") giúp người đọc hơn câu chung "không có quyền".
  if (!user.organization?.isHome) return "Chỉ người của tổ chức nhà mới vận hành được nền tảng.";
  if (!can(user, "platform:operate")) return "Bạn không có quyền vận hành nền tảng.";
  return null;
}

/** Bật/tắt một module của CHÍNH tổ chức người gọi. */
export async function toggleOwnModule(user: SessionUser, input: unknown): Promise<ToggleResult> {
  if (!can(user, "modules:manage")) return { error: "Bạn không có quyền bật / tắt module của tổ chức." };
  if (!user.organization) return { error: "Phiên chưa gắn tổ chức — đăng nhập lại." };
  const parsed = moduleInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { moduleKey, enabled, reason: why } = parsed.data;
  return toResult(await setOrganizationModule({ orgCode: user.organization.code, moduleKey, enabled, reason: why || null, actor: actorOf(user), source: "UI" }));
}

/** Bật/tắt một tính năng (`<module>.<feature>`) của CHÍNH tổ chức người gọi. */
export async function toggleOwnFeature(user: SessionUser, input: unknown): Promise<ToggleResult> {
  if (!can(user, "modules:manage")) return { error: "Bạn không có quyền bật / tắt tính năng của tổ chức." };
  if (!user.organization) return { error: "Phiên chưa gắn tổ chức — đăng nhập lại." };
  const parsed = featureInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { featureKey, enabled, reason: why } = parsed.data;
  return toResult(await setOrganizationFeature({ orgCode: user.organization.code, featureKey, enabled, reason: why || null, actor: actorOf(user), source: "UI" }));
}

/** Người vận hành nền tảng (tổ chức nhà) bật/tắt module của MỘT tổ chức bất kỳ. */
export async function toggleModuleForOrganization(user: SessionUser, input: unknown): Promise<ToggleResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const parsed = orgModuleInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { orgCode, moduleKey, enabled, reason: why } = parsed.data;
  return toResult(await setOrganizationModule({ orgCode, moduleKey, enabled, reason: why, actor: actorOf(user), source: "UI" }));
}
