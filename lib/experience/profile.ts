import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { EXPERIENCE_PRESET_SETTING_KEY, resolveExperienceProfile, type ExperienceResolution } from "@/lib/constants/experience-profile";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";

/**
 * Hồ sơ trải nghiệm của tổ chức NGỮ CẢNH (chỉ máy chủ). Đọc mẫu ngành ở sổ tổ chức + ghi đè `experience.preset` trong
 * `settings` của CHÍNH tổ chức — cùng khuôn với `readCreativeIndustry`. Mọi lỗi đọc rơi về bộ mặc định (giao diện cũ),
 * không bao giờ về một ngành đoán.
 */
export async function readExperienceProfile(): Promise<ExperienceResolution> {
  const org = await currentOrganization();
  if (org.isHome) return resolveExperienceProfile({ isHome: true, templateKey: null });
  const db = await getDb();
  const [row, setting] = await Promise.all([
    findOrganization(org.code).catch(() => null),
    db.query.settings.findFirst({ where: eq(schema.settings.key, EXPERIENCE_PRESET_SETTING_KEY) }).catch(() => null),
  ]);
  let override: unknown = null;
  if (setting) {
    try {
      override = JSON.parse(setting.value);
    } catch {
      override = null;
    }
  }
  return resolveExperienceProfile({ isHome: false, templateKey: row?.templateKey ?? null, override });
}
