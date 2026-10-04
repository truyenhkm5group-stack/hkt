import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { leadHunterConfigSchema } from "@/lib/wholesale/config";
import { getLeadHunterConfig, saveLeadHunterConfig } from "@/lib/wholesale/store";

/**
 * Lưu cấu hình Săn khách sỉ (trần ngân sách, đơn giá, vùng phục vụ, ngưỡng hạng, lời chào). Chỉ `wholesale:config`.
 * Lưu NGUYÊN bản đã kiểm lược đồ; nhật ký ghi trước / sau của phần TIỀN (trần, đơn giá) để biết ai nới trần lúc nào.
 */
export async function saveLeadHunterConfigCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) sửa được cấu hình săn khách sỉ." };
  const parsed = leadHunterConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { error: i ? `${i.path.join(".")}: ${i.message}` : "Cấu hình không hợp lệ" };
  }
  const before = await getLeadHunterConfig();
  await saveLeadHunterConfig(parsed.data);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "WHOLESALE_CONFIG_UPDATE",
    entity: "SETTINGS",
    entityId: "wholesale.leadHunter",
    before: { budget: before.budget, skuPriceUsdPer1000: before.skuPriceUsdPer1000, discoveryTier: before.discoveryTier, automationLevel: before.outreach.automationLevel },
    after: { budget: parsed.data.budget, skuPriceUsdPer1000: parsed.data.skuPriceUsdPer1000, discoveryTier: parsed.data.discoveryTier, automationLevel: parsed.data.outreach.automationLevel },
    reason: "Sửa cấu hình săn khách sỉ",
  });
  return { ok: true };
}
