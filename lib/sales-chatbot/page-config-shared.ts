/**
 * ═══════════ CẤU HÌNH AI THEO PAGE — MẶC ĐỊNH TỔ CHỨC ⇒ PHẦN ĐÈ CỦA PAGE (docs/messaging-providers.md §7) — HÀM THUẦN ═══════════
 *
 * Shop 20 page không phải cấu hình AI 20 lần: page THỪA HƯỞNG cấu hình của tổ chức, chỉ khai phần KHÁC. Chỉ những trường trong
 * `PAGE_OVERRIDABLE` được đè — tên bot, giọng, lời chào, giờ làm việc, chỉ dẫn thêm (thương hiệu / persona riêng của page), phí
 * ship, miễn ship, câu chuyển người. Khoá AI, công cụ bot được dùng, chính sách chốt, giá sỉ, bán không kiểm tồn, đặt lịch ở
 * lại cấp TỔ CHỨC: đó là quyết định tiền / rủi ro của chủ shop, không phải giọng của một page.
 * Instagram gắn với page thừa hưởng phần đè của page cha (trừ khi tự có phần đè riêng). Không có phần đè ⇒ đúng cấu hình cũ.
 */
import { z } from "zod";
import { salesChatbotConfigZ, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";

export const PAGE_OVERRIDES_SETTING_KEY = "ai.salesChatbot.pageOverrides";

export const PAGE_OVERRIDABLE = ["botName", "tone", "greeting", "businessHours", "extraInstructions", "shippingFee", "freeShipping"] as const;
export type PageOverridableKey = (typeof PAGE_OVERRIDABLE)[number];

/** Lược đồ phần đè của MỘT page: đúng các trường được phép, mỗi trường cùng luật với cấu hình tổ chức. */
export const pageOverrideZ = z
  .object({
    botName: z.string().trim().min(2).max(60).optional(),
    tone: z.string().optional(),
    greeting: z.string().trim().min(2).max(300).optional(),
    businessHours: z.unknown().optional(),
    extraInstructions: z.string().trim().max(1500).optional(),
    shippingFee: z.number().int().min(0).max(10_000_000).nullable().optional(),
    freeShipping: z.unknown().optional(),
    handoffMessage: z.string().trim().min(2).max(300).optional(),
  })
  .strict();
export type PageOverride = z.infer<typeof pageOverrideZ>;
export type PageOverrides = Record<string, PageOverride>;

/** Đọc bảng phần đè đã lưu — page lỗi / trường lạ bị bỏ (không đoán). HÀM THUẦN. */
export function parsePageOverrides(v: unknown): PageOverrides {
  const out: PageOverrides = {};
  if (!v || typeof v !== "object") return out;
  for (const [pageId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_:.-]{1,80}$/.test(pageId)) continue;
    const p = pageOverrideZ.safeParse(raw);
    if (p.success && Object.keys(p.data).length) out[pageId] = p.data;
  }
  return out;
}

/**
 * Cấu hình cho MỘT page = cấu hình tổ chức + phần đè (page, hoặc page cha của Instagram). Gộp xong phải QUA LẠI lược đồ của
 * cấu hình tổ chức — phần đè nào làm cấu hình hỏng thì bị BỎ, page dùng nguyên cấu hình tổ chức (hỏng về phía cũ, không phía
 * lạ). HÀM THUẦN.
 */
export function configForPage(base: SalesChatbotConfig, overrides: PageOverrides, pageId: string | null | undefined, parentPageId: string | null = null): SalesChatbotConfig {
  const o = (pageId ? overrides[pageId] : undefined) ?? (parentPageId ? overrides[parentPageId] : undefined);
  if (!o) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const k of PAGE_OVERRIDABLE) if (o[k] !== undefined) merged[k] = o[k];
  if (o.handoffMessage !== undefined) merged.handoff = { ...base.handoff, message: o.handoffMessage };
  const checked = salesChatbotConfigZ.safeParse(merged);
  return checked.success ? checked.data : base;
}
