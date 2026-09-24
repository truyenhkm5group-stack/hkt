"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { CREATIVE_CONFIG_KEY, type ConfigProblem, type CreativeLoopConfig } from "@/lib/constants/creative-loop";
import { readCreativeConfig } from "@/lib/queries/creative-sources";
import { setSettingJson } from "@/lib/settings";
import { validateCreativeConfigInput, type ClampNote } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — LƯU CẤU HÌNH + BỘ LUẬT ═══════════
 *
 * Quyền `settings:manage`: cấu hình này quyết định máy được tiêu bao nhiêu tiền quảng cáo mỗi ngày
 * và khi nào máy tự tắt một mẫu — cùng tầm với các cấu hình hệ thống khác, không phải việc của
 * người đăng ý tưởng.
 *
 * Luật hỏng ⇒ TỪ CHỐI CẢ LẦN LƯU (xem `validateCreativeConfigInput`). Giá trị vượt trần ⇒ LƯU BẢN ĐÃ
 * KẸP và trả về danh sách ô bị kẹp để màn hình nói ra — trần là của mã nguồn, cấu hình chỉ làm hẹp.
 */

type SaveResult =
  | { ok: true; config: CreativeLoopConfig; problems: ConfigProblem[]; clamped: ClampNote[] }
  | { error: string; problems: ConfigProblem[] };

export async function saveCreativeConfig(input: unknown): Promise<SaveResult> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) return { error: "Chỉ người có quyền “Cấu hình hệ thống khác” mới sửa được cấu hình vòng mẫu", problems: [] };

  const truoc = await readCreativeConfig();
  // Hai danh sách mockup được bật / tắt bằng công tắc ở tab Nguồn ảnh (`setDailyMockup`), không ở form
  // này. Form không gửi chúng ⇒ GIỮ danh sách đang lưu: lưu form không được lặng lẽ tắt mockup của ai.
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const merged = { ...rec, mockupSourceIds: rec.mockupSourceIds ?? truoc.config.mockupSourceIds, mockupProductIds: rec.mockupProductIds ?? truoc.config.mockupProductIds };
  const v = validateCreativeConfigInput(merged);
  if (!v.ok) return { error: v.error, problems: v.problems };

  await setSettingJson(CREATIVE_CONFIG_KEY, v.config);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_CONFIG_SAVE",
    entity: "SETTINGS",
    entityId: CREATIVE_CONFIG_KEY,
    before: truoc.saved ? truoc.config : null,
    after: v.config,
    reason: v.clamped.length ? `Máy kẹp ${v.clamped.length} ô về trần của mã nguồn: ${v.clamped.map((c) => `${c.field} ${c.from} → ${c.to}`).join("; ")}` : undefined,
  });
  revalidatePath("/marketing/creatives");
  return { ok: true, config: v.config, problems: v.problems, clamped: v.clamped };
}
