/**
 * ═══════════ VÀO VIỆC NGAY THEO KÊNH — KHÔNG BẮT BUỘC PANCAKE (docs/messaging-providers.md) ═══════════
 *
 * Trước đây ô «Vào việc ngay» là MỘT danh sách cố định: kết nối fanpage QUA PANCAKE → dán URL webhook VÀO PANCAKE → bật bot.
 * Shop chưa từng nghe tới Pancake không có đường nào. Giờ bước kênh do shop CHỌN cách quản lý tin nhắn:
 *  · `DIRECT`  — nối thẳng Facebook Page (đăng nhập Facebook → chọn page; không webhook, không phần mềm thứ ba) — khuyên dùng;
 *  · `PANCAKE` — shop đang dùng Pancake: nối page qua Pancake + dán URL webhook (bước này CHỈ hiện cho lối này);
 *  · `OTHER`   — shop dùng phần mềm khác: các kênh nối thẳng còn lại (Zalo OA, ô chat website) + lối gửi yêu cầu kết nối.
 * Lối đang dùng SUY RA từ kết nối thật (không lưu lựa chọn): đã nối Pancake ⇒ PANCAKE, đã nối Messenger ⇒ DIRECT, đã nối
 * Zalo ⇒ OTHER; chưa nối gì ⇒ `null` (màn hình cho chọn, khuyên DIRECT).
 *
 * Mốc onboarding là HÀM THUẦN của dữ liệu thật — không có ô bấm cho xong. Tổ chức tới được ACTIVATED mà không cần Pancake.
 */

export const GO_LIVE_PATHS = ["DIRECT", "PANCAKE", "OTHER"] as const;
export type GoLivePath = (typeof GO_LIVE_PATHS)[number];

export const ONBOARDING_STAGES = ["ACCOUNT_CREATED", "CHANNEL_CONNECTED", "MESSAGING_READY", "CATALOG_READY", "AI_CONFIGURED", "TEST_PASSED", "ACTIVATED"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const ONBOARDING_STAGE_LABEL: Record<OnboardingStage, string> = {
  ACCOUNT_CREATED: "Đã có tài khoản",
  CHANNEL_CONNECTED: "Đã nối kênh bán hàng",
  MESSAGING_READY: "Đã nhận tin khách",
  CATALOG_READY: "Đã có sản phẩm có giá",
  AI_CONFIGURED: "AI dùng được",
  TEST_PASSED: "Đã thử lên đơn",
  ACTIVATED: "Bot đang trả lời khách",
};

export type ChannelFacts = { pancake: boolean; messenger: boolean; zalo: boolean; webChat: boolean };

/** Lối đang dùng, suy từ kết nối thật. Pancake đứng trước: shop đã nối Pancake thì hướng dẫn webhook vẫn phải hiện. HÀM THUẦN. */
export function goLivePathOf(c: ChannelFacts): GoLivePath | null {
  if (c.pancake) return "PANCAKE";
  if (c.messenger) return "DIRECT";
  if (c.zalo || c.webChat) return "OTHER";
  return null;
}

export type StageFacts = ChannelFacts & { messagesReceived: number; pricedVariants: number; aiReady: boolean; testDrafts: number; botEnabled: boolean };

/**
 * Mốc xa nhất đã tới, đi THEO THỨ TỰ (thiếu một mốc thì dừng ở mốc trước nó — bot bật mà chưa có kênh không phải «đang trả
 * lời khách»). Kèm danh sách mốc đã / chưa để màn hình vẽ. HÀM THUẦN.
 */
export function onboardingStage(f: StageFacts): { stage: OnboardingStage; done: Record<OnboardingStage, boolean> } {
  const done: Record<OnboardingStage, boolean> = {
    ACCOUNT_CREATED: true,
    CHANNEL_CONNECTED: f.pancake || f.messenger || f.zalo || f.webChat,
    MESSAGING_READY: f.messagesReceived > 0,
    CATALOG_READY: f.pricedVariants > 0,
    AI_CONFIGURED: f.aiReady,
    TEST_PASSED: f.testDrafts > 0,
    ACTIVATED: f.botEnabled,
  };
  let stage: OnboardingStage = "ACCOUNT_CREATED";
  for (const s of ONBOARDING_STAGES) {
    if (!done[s]) break;
    stage = s;
  }
  return { stage, done };
}
