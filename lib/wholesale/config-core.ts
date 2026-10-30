import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { z } from "zod";
import { leadHunterConfigSchema, MAX_EXTRA_TEMPLATES, messageTemplateSchema } from "@/lib/wholesale/config";
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

/**
 * Khung «Mẫu nội dung» ở tab Liên hệ (30/10/2026): sửa ĐÚNG ba trường chữ của cấu hình — câu mở Zalo, lời chào, và các mẫu
 * thêm — đọc lại cấu hình hiện tại trên MÁY CHỦ rồi thay ba trường ấy, nên không ghi đè trần chi tiêu / vùng phục vụ bằng
 * một bản cũ trong trình duyệt. Chỉ `wholesale:config` (như mọi lượt sửa cấu hình).
 */
const templatesInput = z.object({
  zaloTemplate: z.string().trim().min(10, "Câu mở Zalo quá ngắn").max(2000),
  openerTemplate: z.string().trim().min(10, "Lời chào quá ngắn").max(1500),
  extraTemplates: z.array(messageTemplateSchema).max(MAX_EXTRA_TEMPLATES, `Tối đa ${MAX_EXTRA_TEMPLATES} mẫu thêm`),
});

export async function saveMessageTemplatesCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) sửa được mẫu nội dung." };
  const parsed = templatesInput.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { error: i ? `${i.path.join(".")}: ${i.message}` : "Mẫu không hợp lệ" };
  }
  const ids = parsed.data.extraTemplates.map((t) => t.id);
  if (new Set(ids).size !== ids.length) return { error: "Hai mẫu trùng mã — tải lại trang rồi thử lại." };
  const before = await getLeadHunterConfig();
  const next = leadHunterConfigSchema.parse({ ...before, outreach: { ...before.outreach, ...parsed.data } });
  await saveLeadHunterConfig(next);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "WHOLESALE_CONFIG_UPDATE",
    entity: "SETTINGS",
    entityId: "wholesale.leadHunter",
    before: { templates: before.outreach.extraTemplates.length, zaloTemplate: before.outreach.zaloTemplate.length },
    after: { templates: next.outreach.extraTemplates.length, zaloTemplate: next.outreach.zaloTemplate.length },
    reason: "Sửa mẫu nội dung liên hệ",
  });
  return { ok: true };
}
