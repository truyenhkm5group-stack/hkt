/**
 * Cài đặt FOLLOW-UP TỰ ĐỘNG (0185) — đọc / lưu trong CSDL của tổ chức ngữ cảnh. Phần thuần (lịch, khung 24 giờ):
 * `followup-shared.ts`. Tách khỏi `followup.ts` để `fanpage.ts` (đặt hội thoại vào WAITING) đọc được mà không vòng import.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { canUseModule } from "@/lib/platform/capabilities";
import { FOLLOWUP_SETTING_KEY, parseFollowupSettings, validateFollowupSteps, type FollowupSettings } from "@/lib/sales-chatbot/followup-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { setSettingJson } from "@/lib/settings";

export async function loadFollowupSettings(): Promise<FollowupSettings> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, FOLLOWUP_SETTING_KEY)).limit(1);
  try {
    return parseFollowupSettings(row?.value ? (JSON.parse(row.value) as unknown) : null);
  } catch {
    return parseFollowupSettings(null);
  }
}

export async function saveFollowupSettings(user: SessionUser, input: { enabled: unknown; stepsMinutes: unknown }): Promise<{ ok: true } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const steps = validateFollowupSteps(input.stepsMinutes);
  if (!steps.ok) return { error: steps.error };
  const before = await loadFollowupSettings();
  const value: FollowupSettings = { enabled: Boolean(input.enabled), stepsMinutes: steps.steps };
  await setSettingJson(FOLLOWUP_SETTING_KEY, value);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_FOLLOWUP_SETTINGS", entity: "SETTINGS", entityId: FOLLOWUP_SETTING_KEY, before, after: value, reason: value.enabled ? "Bật / sửa follow-up tự động" : "Tắt follow-up tự động" });
  return { ok: true };
}
