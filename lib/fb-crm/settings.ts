import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { FB_CRM_SETTING_KEY, fbCrmEnabledOf } from "@/lib/constants/fb-crm";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ CÔNG TẮC TỔ CHỨC CỦA FACEBOOK FRIEND CRM ═══════════
 *
 * Bật / tắt cờ `fbCrm.enabled` của CHÍNH tổ chức đang đăng nhập (bảng `settings` của CSDL tổ chức, `setSettingJson` theo ngữ cảnh).
 * Chỉ người có `settings:manage` — đúng quyền các trang /settings của tổ chức đang dùng; không thêm khoá quyền mới. Bấm lại cùng
 * trạng thái ⇒ KHÔNG ghi gì, KHÔNG ghi nhật ký (luật 61). Giá trị lưu luôn là OBJECT `{"on": boolean}` (chuỗi trần / `true` trần đọc
 * ra TẮT — `fbCrmEnabledOf`).
 */

export type FbCrmToggleResult = { ok: true; changed: boolean; on: boolean; message: string } | { ok: false; error: string };

const toggleZ = z.object({ on: z.boolean({ error: "Thiếu trạng thái bật / tắt" }) }).strict();

export async function fbCrmSetEnabledCore(user: SessionUser, raw: unknown): Promise<FbCrmToggleResult> {
  if (!can(user, "settings:manage")) return { ok: false, error: "Chỉ quản trị cài đặt tổ chức (settings:manage) mới bật / tắt được Facebook Friend CRM." };
  const parsed = toggleZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const on = parsed.data.on;
  const before = fbCrmEnabledOf(await getSettingJson<Record<string, unknown>>(FB_CRM_SETTING_KEY, {}));
  if (before === on) return { ok: true, changed: false, on, message: on ? "Facebook Friend CRM đang bật sẵn." : "Facebook Friend CRM đang tắt sẵn." };
  await setSettingJson(FB_CRM_SETTING_KEY, { on });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "FB_CRM_TOGGLE",
    entity: "SETTING",
    entityId: FB_CRM_SETTING_KEY,
    before: { on: before },
    after: { on },
    reason: on ? "Bật Facebook Friend CRM cho tổ chức" : "Tắt Facebook Friend CRM cho tổ chức",
  });
  return { ok: true, changed: true, on, message: on ? "Đã bật Facebook Friend CRM." : "Đã tắt Facebook Friend CRM — dữ liệu đã ghi vẫn giữ nguyên." };
}
