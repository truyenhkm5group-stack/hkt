"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { EXPERIENCE_PRESET_SETTING_KEY, EXPERIENCE_PRESETS } from "@/lib/constants/experience-profile";
import { readExperienceProfile } from "@/lib/experience/profile";
import { currentOrganization } from "@/lib/platform/context";

const presetSchema = z.object({ preset: z.enum(EXPERIENCE_PRESETS).nullable() }).strict();

/**
 * Quản trị tổ chức chọn NGÀNH cho giao diện (ô sản phẩm, thuật ngữ, ma trận Màu × Size). `null` ⇒ bỏ ghi đè, quay về
 * mẫu ngành của tổ chức. Chỉ đổi GIAO DIỆN — không xoá / không viết lại dữ liệu mẫu mã nào. Tổ chức nhà luôn thời trang.
 */
export async function setExperiencePresetAction(raw: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "modules:manage")) return { error: "Đổi ngành của tổ chức cần quyền bật / tắt module (modules:manage)." };
  const parsed = presetSchema.safeParse(raw);
  if (!parsed.success) return { error: "Ngành không hợp lệ." };
  const org = await currentOrganization();
  if (org.isHome) return { error: "Tổ chức nhà luôn dùng giao diện thời trang — không đổi ở đây." };
  const db = await getDb();
  const before = await readExperienceProfile();
  if (parsed.data.preset === null) await db.delete(schema.settings).where(eq(schema.settings.key, EXPERIENCE_PRESET_SETTING_KEY));
  else {
    const value = JSON.stringify(parsed.data.preset);
    await db.insert(schema.settings).values({ key: EXPERIENCE_PRESET_SETTING_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  }
  await audit({ userId: user.id, userEmail: user.email, action: "EXPERIENCE_PRESET_SET", entity: "SETTING", entityId: EXPERIENCE_PRESET_SETTING_KEY, before: { preset: before.profile.preset, basis: before.basis }, after: { preset: parsed.data.preset } });
  revalidatePath("/", "layout");
  return { ok: true };
}
