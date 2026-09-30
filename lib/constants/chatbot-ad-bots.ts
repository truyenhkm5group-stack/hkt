import { z } from "zod";

/**
 * ═══════════ BOT CHAT RIÊNG CHO TỪNG CAMP TEST — THEO ID QUẢNG CÁO ═══════════
 *
 * Mỗi mẫu test (Thư viện Media · tab ④ Đang chạy) là một quảng cáo "INBOX NGAY" mang `fb_ad_id`. Khách bấm
 * quảng cáo ⇒ hội thoại Pancake mang đúng ID đó ⇒ bot chat (container `erp-chatbot`) dùng BOT RIÊNG của camp:
 * mặc định khách đang hỏi ĐÚNG mẫu đang test, cộng hướng dẫn riêng chủ shop viết cho camp ấy.
 *
 * Ba luật:
 *  1. ERP là NGUỒN DUY NHẤT của danh sách: mẫu nào gắn với quảng cáo nào đọc từ bảng quảng cáo test
 *     (`creative_variants` · `creative_scale_drafts` · `video_scale_ads`), không gõ lại. Người chỉ thêm LỚP
 *     GHI ĐÈ (bật/tắt · đổi mã mẫu · hướng dẫn riêng) — lưu ở `settings` khoá `CHATBOT_AD_BOTS_KEY`.
 *  2. Bot riêng chỉ ĐỊNH HƯỚNG mẫu. Giá vẫn chỉ từ bảng giá / danh mục POS của bot; nội dung quảng cáo đưa
 *     sang bị che số tiền ở phía bot (`chatbot/src/adpersona.js::maskMoney`).
 *  3. Quảng cáo KHÔNG gắn mã và chưa ai viết hướng dẫn ⇒ KHÔNG có bot riêng (`NO_PRODUCT`), in ra màn hình
 *     để người gắn — không đoán mẫu theo tên chiến dịch.
 */

export const CHATBOT_AD_BOTS_KEY = "chatbot.ad-bots";

/** Quảng cáo test đã dừng vẫn còn khách nhắn tới (bấm từ trước) — giữ bot riêng thêm chừng ấy ngày. */
export const AD_BOT_WINDOW_DAYS = 45;

export const AD_ID_PATTERN = /^\d{6,25}$/;
export const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const AD_BOT_INSTRUCTIONS_MAX = 4000;

export const AD_BOT_SOURCES = ["CREATIVE_TEST", "CREATIVE_SCALE", "VIDEO_SCALE"] as const;
export type AdBotSource = (typeof AD_BOT_SOURCES)[number];
export const AD_BOT_SOURCE_LABEL: Record<AdBotSource, string> = {
  CREATIVE_TEST: "Camp test (Thư viện Media)",
  CREATIVE_SCALE: "Camp scale mẫu thắng",
  VIDEO_SCALE: "Quảng cáo video",
};

export type AdBotOverride = {
  enabled?: boolean;
  /** Mã mẫu ghi đè (vd quảng cáo test "không gắn mã"). Rỗng = theo mẫu gắn trên quảng cáo. */
  productCode?: string;
  instructions?: string;
  updatedByUserId: string | null;
  updatedByName: string;
  updatedAt: string;
};

export type AdBotConfig = {
  /** Công tắc chung. Tắt ⇒ bot nhận danh sách rỗng, mọi hội thoại chạy như trước. */
  enabled: boolean;
  overrides: Record<string, AdBotOverride>;
};

export const DEFAULT_AD_BOT_CONFIG: AdBotConfig = { enabled: true, overrides: {} };

/** Một quảng cáo test đọc từ CSDL (trước khi áp lớp ghi đè). */
export type AdBotSourceRow = {
  adId: string;
  source: AdBotSource;
  status: string;
  campaignName: string;
  adName: string;
  adCopy: string;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  publishedAt: Date | null;
};

/** Đúng hình dạng bot nhận (`PUT /api/erp/ad-bots`, xem `normalizeAdBot` phía bot). */
export type AdBotPush = {
  adId: string;
  enabled: true;
  productCode: string;
  productName: string;
  campaignName: string;
  adName: string;
  adCopy: string;
  instructions: string;
  source: AdBotSource;
  status: string;
};

export type AdBotState = "ACTIVE" | "OFF_BY_USER" | "NO_PRODUCT" | "GLOBAL_OFF";
export const AD_BOT_STATE_LABEL: Record<AdBotState, string> = {
  ACTIVE: "Bot riêng đang bật",
  OFF_BY_USER: "Đã tắt bot riêng",
  NO_PRODUCT: "Chưa gắn mã mẫu — chưa có bot riêng",
  GLOBAL_OFF: "Công tắc chung đang tắt",
};

export type AdBotLine = AdBotSourceRow & {
  state: AdBotState;
  effectiveCode: string;
  override: AdBotOverride | null;
};

/** Mã mẫu như bot đọc được trong danh mục POS: `custom_id`, thiếu thì `display_id` (chatbot/src/pos.js). */
export function productCodeOf(customId: string | null | undefined, displayId: number | string | null | undefined): string | null {
  const c = String(customId ?? "").trim();
  if (c) return c;
  const d = String(displayId ?? "").trim();
  return d || null;
}

/**
 * HÀM THUẦN: nguồn + ghi đè ⇒ danh sách hiển thị và gói đẩy sang bot.
 * Một ad_id xuất hiện ở nhiều nguồn thì giữ dòng đăng GẦN NHẤT.
 */
export function buildAdBots(rows: AdBotSourceRow[], config: AdBotConfig): { lines: AdBotLine[]; push: AdBotPush[] } {
  const byAd = new Map<string, AdBotSourceRow>();
  for (const r of rows) {
    if (!AD_ID_PATTERN.test(r.adId)) continue;
    const cur = byAd.get(r.adId);
    if (!cur || (r.publishedAt?.getTime() ?? 0) > (cur.publishedAt?.getTime() ?? 0)) byAd.set(r.adId, r);
  }
  const lines: AdBotLine[] = [];
  const push: AdBotPush[] = [];
  for (const r of byAd.values()) {
    const o = config.overrides[r.adId] ?? null;
    const code = (o?.productCode?.trim() || r.productCode || "").trim();
    const effectiveCode = PRODUCT_CODE_PATTERN.test(code) ? code.toUpperCase() : "";
    const instructions = (o?.instructions ?? "").trim();
    const state: AdBotState = !config.enabled ? "GLOBAL_OFF" : o?.enabled === false ? "OFF_BY_USER" : !effectiveCode && !instructions ? "NO_PRODUCT" : "ACTIVE";
    lines.push({ ...r, state, effectiveCode, override: o });
    if (state !== "ACTIVE") continue;
    push.push({
      adId: r.adId,
      enabled: true,
      productCode: effectiveCode,
      // Tên mẫu chỉ đi theo mẫu GẮN trên quảng cáo; người đổi mã thì bot tự đọc tên trong danh mục POS.
      productName: effectiveCode && effectiveCode === (r.productCode ?? "").toUpperCase() ? (r.productName ?? "") : "",
      campaignName: r.campaignName,
      adName: r.adName,
      adCopy: r.adCopy.slice(0, 600),
      instructions: instructions.slice(0, AD_BOT_INSTRUCTIONS_MAX),
      source: r.source,
      status: r.status,
    });
  }
  lines.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return { lines, push };
}

export const saveAdBotSchema = z.object({
  adId: z.string().trim().regex(AD_ID_PATTERN, "ID quảng cáo phải toàn chữ số"),
  enabled: z.boolean(),
  productCode: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === "" || PRODUCT_CODE_PATTERN.test(v), "Mã mẫu chỉ gồm chữ, số, - và _ (vd Q004)"),
  instructions: z.string().max(AD_BOT_INSTRUCTIONS_MAX, `Hướng dẫn tối đa ${AD_BOT_INSTRUCTIONS_MAX} ký tự`),
});
export type SaveAdBotInput = z.infer<typeof saveAdBotSchema>;
