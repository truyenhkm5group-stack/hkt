/**
 * ═══════════ «BOT CỦA SHOP ĐANG THẾ NÀO?» — MỘT Ô TRẠNG THÁI ĐẦU TRANG CẤU HÌNH AI SALES — HÀM THUẦN ═══════════
 *
 * Trang `/ai/sales-chatbot` từng có mười mấy khung ngang hàng và không câu nào trả lời câu chủ shop hỏi đầu tiên: bot có đang
 * trả lời khách không, và nếu không thì làm gì tiếp. Hàm này gộp thứ trang ĐÃ NẠP SẴN (bật / tắt bot, AI dùng được chưa, hết
 * lượt của gói, chế độ trả lời, kênh chat đang bật, có sản phẩm có giá chưa) thành MỘT trạng thái + MỘT câu + MỘT đích cho nút
 * chính. Không đọc CSDL, không gọi mạng — trang truyền dữ kiện vào; bài kiểm `tests/ai-sales-settings-v2.test.ts` giữ bảng chân lý.
 *
 * Luật 42 / 52 (AGENTS.md): dữ kiện CHƯA BIẾT là `null`, không phải `false`/`0`. Thiếu dữ kiện thì kết luận là «Chưa rõ», KHÔNG
 * BAO GIỜ «Đang chạy» — một ô xanh dựng trên chỗ trống là lời nói dối dễ tin nhất của trang này.
 *
 * Chữ trong tệp này là chữ cho người ít rành máy, kể cả khách vỏ Chốt Đơn: không tên hãng AI, không thuật ngữ kỹ thuật.
 */
import { SALES_AGENT_CHANNELS_HREF, SALES_AGENT_INBOX_HREF } from "@/lib/constants/saas-nav";
import type { OperatingMode } from "@/lib/sales-chatbot/operating-mode-shared";
import { CUSTOMER_AI_STATE_HINT } from "@/lib/saas/visibility";

export type SettingsState = "RUNNING" | "NEEDS_SETUP" | "PAUSED" | "OUT_OF_QUOTA" | "PREPARING" | "UNKNOWN";

export const SETTINGS_STATE_LABEL: Record<SettingsState, string> = {
  RUNNING: "Đang chạy",
  NEEDS_SETUP: "Cần cấu hình",
  PAUSED: "Tạm dừng",
  OUT_OF_QUOTA: "Hết hạn mức",
  // Việc của đội hỗ trợ, không phải của người đọc (CUSTOMER_AI_STATE_LABEL.NEEDS_SETUP) — không gọi là «Cần cấu hình».
  PREPARING: "Đang chuẩn bị",
  UNKNOWN: "Chưa rõ",
};

/** Lý do cụ thể — mã máy để bài kiểm và `data-reason` trên màn hình đọc được, không hiện ra chữ. */
export type SettingsReason =
  | "QUOTA_EXHAUSTED"
  | "AI_PREPARING"
  | "AI_NOT_READY"
  | "NO_PRICED_PRODUCTS"
  | "CHANNEL_BROKEN"
  | "NO_CHANNEL"
  | "BOT_OFF"
  | "MODE_OBSERVE"
  | "MODE_COPILOT"
  | "FACTS_MISSING"
  | "RUNNING";

/** Trạng thái MỘT kênh chat như trang đã đọc: đang bật · chưa bật (chưa khai / khai mà chưa bật) · kiểm tra hỏng. */
export type ChannelLink = "ACTIVE" | "OFF" | "BROKEN";

/** Bốn trạng thái kết nối kênh mà `fanpageSetupView` / `zaloSetupView` trả ⇒ ba nấc ở đây. */
export function channelLinkOf(status: "NOT_CONFIGURED" | "DRAFT" | "ACTIVE" | "FAILED"): ChannelLink {
  return status === "ACTIVE" ? "ACTIVE" : status === "FAILED" ? "BROKEN" : "OFF";
}

export type SettingsChannels = {
  /** Fanpage qua Pancake. `null` = trang chưa đọc. */
  fanpage: ChannelLink | null;
  /** Zalo OA. `null` = trang chưa đọc. */
  zalo: ChannelLink | null;
  /** Số page Facebook nối thẳng. `null` = trang chưa đọc. */
  messengerPages: number | null;
  /** Trang chat công khai đã xuất bản. `null` = trang chưa đọc. */
  webChat: boolean | null;
};

export type SettingsStatusInput = {
  audience: "CUSTOMER" | "INTERNAL";
  botEnabled: boolean;
  /** Nguồn AI đang chọn dùng được (loader `loadChatbotAiView`). */
  aiReady: boolean;
  /**
   * Hết lượt khách AI xử lý của GÓI (chỉ AI dùng chung của nền tảng có hạn mức gói). Nơi không áp hạn mức gói (khoá riêng
   * của tổ chức) truyền `false` — đó là «không áp dụng», không phải «chưa đo».
   */
  quotaExhausted: boolean;
  /** Chế độ trả lời (Quan sát · Gợi ý · Thử nghiệm · Tự động). `null` = không áp / trang chưa đọc ⇒ không chặn kết luận. */
  mode: OperatingMode | null;
  /** `null` = trang không đọc được kênh nào (vd người xem không có quyền cấu hình). */
  channels: SettingsChannels | null;
  /** Có ít nhất một mẫu mã có giá bán. `null` = chưa đọc. */
  hasPricedProducts: boolean | null;
  /** Câu lý do AI chưa dùng được — CHỈ workspace nhà (khách không nhận câu kỹ thuật). */
  aiReason?: string | null;
};

export type SettingsAction = { label: string; href: string; external?: boolean };

export type SettingsStatus = {
  state: SettingsState;
  reason: SettingsReason;
  title: string;
  detail: string;
  /** Nút chính DUY NHẤT. `null` = không có việc gì người đọc bấm được (không dựng nút chết). */
  action: SettingsAction | null;
};

export type SettingsStatusOptions = {
  /** Người xem mở được đường dẫn này không (vỏ Chốt Đơn chặn một số trang — `shellAllows`). Không truyền ⇒ mọi đường đều mở. */
  allows?: (href: string) => boolean;
  /** Liên hệ hỗ trợ (Zalo) cho trạng thái «Đang chuẩn bị». Không có ⇒ không nút. */
  supportHref?: string | null;
};

/** Đích các nút — đường có thật, giữ chung để bài kiểm so được. */
export const SETTINGS_HREF = {
  plan: "/settings/plan",
  connections: "/settings/connections",
  products: "/products",
  channels: SALES_AGENT_CHANNELS_HREF,
  inbox: SALES_AGENT_INBOX_HREF,
  botConfig: "#bot-config",
  operatingMode: "#operating-mode",
} as const;

const CHANNEL_NAME = { fanpage: "Fanpage", zalo: "Zalo OA", messenger: "Facebook nối thẳng", webChat: "Trang chat" } as const;

/** Kênh đang nhận tin (tên) · có kênh hỏng không · còn kênh nào CHƯA ĐỌC không. */
function channelFacts(ch: SettingsChannels): { active: string[]; broken: boolean; unknown: boolean } {
  const active: string[] = [];
  if (ch.fanpage === "ACTIVE") active.push(CHANNEL_NAME.fanpage);
  if (ch.zalo === "ACTIVE") active.push(CHANNEL_NAME.zalo);
  if (ch.messengerPages !== null && ch.messengerPages > 0) active.push(CHANNEL_NAME.messenger);
  if (ch.webChat === true) active.push(CHANNEL_NAME.webChat);
  return {
    active,
    broken: ch.fanpage === "BROKEN" || ch.zalo === "BROKEN",
    unknown: ch.fanpage === null || ch.zalo === null || ch.messengerPages === null || ch.webChat === null,
  };
}

/**
 * Thứ tự là THỨ TỰ VIỆC PHẢI LÀM: hết lượt (chặn mọi lượt AI) → AI chưa dùng được → chưa có sản phẩm có giá → chưa có kênh →
 * bot đang tắt → chế độ không tự trả lời → thiếu dữ kiện ⇒ «Chưa rõ» → đang chạy. Cài đặt trước, bật sau: bot tắt VÀ chưa có
 * sản phẩm thì việc kế tiếp là thêm sản phẩm, vì bật lên cũng không có giá nào để báo.
 */
export function settingsStatus(i: SettingsStatusInput, opts: SettingsStatusOptions = {}): SettingsStatus {
  const allows = opts.allows ?? (() => true);
  const act = (label: string, href: string): SettingsAction | null => (href.startsWith("#") || allows(href) ? { label, href } : null);
  const customer = i.audience === "CUSTOMER";

  if (i.quotaExhausted) {
    return { state: "OUT_OF_QUOTA", reason: "QUOTA_EXHAUSTED", title: "Shop đã dùng hết lượt AI của gói", detail: CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, action: act("Mua thêm lượt", SETTINGS_HREF.plan) };
  }
  if (!i.aiReady) {
    if (customer) {
      return {
        state: "PREPARING",
        reason: "AI_PREPARING",
        title: "AI của shop đang được chuẩn bị",
        detail: CUSTOMER_AI_STATE_HINT.NEEDS_SETUP,
        action: opts.supportHref ? { label: "Nhắn hỗ trợ", href: opts.supportHref, external: true } : null,
      };
    }
    return {
      state: "NEEDS_SETUP",
      reason: "AI_NOT_READY",
      title: "Nguồn AI của bot chưa dùng được",
      detail: i.aiReason?.trim() || "Kiểm tra lại kết nối AI ở trang Kết nối, rồi chọn nguồn AI ở phần «Nâng cao» của Cấu hình bot.",
      action: act("Mở trang Kết nối", SETTINGS_HREF.connections),
    };
  }
  if (i.hasPricedProducts === false) {
    return { state: "NEEDS_SETUP", reason: "NO_PRICED_PRODUCTS", title: "Chưa có sản phẩm nào có giá", detail: "Bot chỉ báo giá đọc từ sổ sản phẩm của shop — thêm sản phẩm và giá bán trước khi để bot trả lời khách.", action: act("Thêm sản phẩm", SETTINGS_HREF.products) };
  }
  const ch = i.channels ? channelFacts(i.channels) : null;
  if (ch && ch.active.length === 0 && !ch.unknown) {
    return ch.broken
      ? { state: "NEEDS_SETUP", reason: "CHANNEL_BROKEN", title: "Kênh chat của shop đang lỗi kết nối", detail: "Lần kiểm tra gần nhất của kênh chat không đạt nên bot chưa nhận được tin khách. Mở trang kênh để kiểm tra lại.", action: act("Kiểm tra kênh chat", SETTINGS_HREF.channels) }
      : { state: "NEEDS_SETUP", reason: "NO_CHANNEL", title: "Chưa nối kênh chat nào", detail: "Bot cần một nơi để nhận tin khách: fanpage, Zalo OA hoặc trang chat của shop.", action: act("Nối kênh chat", SETTINGS_HREF.channels) };
  }
  if (!i.botEnabled) {
    return { state: "PAUSED", reason: "BOT_OFF", title: "Bot đang tắt", detail: "Bot không trả lời khách cho tới khi được bật. Khung thử bên cạnh vẫn dùng được.", action: { label: "Bật bot", href: SETTINGS_HREF.botConfig } };
  }
  // Chế độ trả lời chỉ gác kênh NHẮN TIN (fanpage · Zalo · Facebook nối thẳng — `replyGate`); trang chat web không qua cổng đó.
  // Shop chỉ có trang chat thì chế độ không làm bot im ⇒ không kết luận «Tạm dừng» vì nó.
  const gatedActive = ch ? ch.active.filter((n) => n !== CHANNEL_NAME.webChat).length : 0;
  if ((i.mode === "OBSERVE" || i.mode === "COPILOT") && (!ch || ch.unknown || gatedActive > 0)) {
    return {
      state: "PAUSED",
      reason: i.mode === "OBSERVE" ? "MODE_OBSERVE" : "MODE_COPILOT",
      title: i.mode === "OBSERVE" ? "Bot đang chỉ quan sát — người của shop trả lời" : "Bot chỉ soạn gợi ý — người của shop bấm gửi",
      detail: "Bot đang bật nhưng chưa tự trả lời tin khách nhắn vào fanpage, Zalo hay Facebook. Đổi sang «Tự động» khi shop muốn bot tự trả lời.",
      action: { label: "Đổi chế độ trả lời", href: SETTINGS_HREF.operatingMode },
    };
  }
  const missing = [i.hasPricedProducts === null ? "sản phẩm có giá" : null, !ch || (ch.active.length === 0 && ch.unknown) ? "kênh chat đã nối" : null].filter((x): x is string => x !== null);
  if (missing.length) {
    return {
      state: "UNKNOWN",
      reason: "FACTS_MISSING",
      title: "Chưa rõ bot có đang trả lời khách không",
      detail: `Bot đang bật nhưng trang chưa đọc được: ${missing.join(", ")}. Người có quyền cấu hình bot xem được đủ.`,
      action: act("Mở hộp thư", SETTINGS_HREF.inbox),
    };
  }
  const where = ch && ch.active.length ? ` Đang nhận tin từ: ${ch.active.join(", ")}.` : "";
  const split = i.mode === "EXPERIMENT" ? " Hội thoại mới đang được chia giữa bot và người của shop." : "";
  return { state: "RUNNING", reason: "RUNNING", title: "Bot đang trả lời khách", detail: `Bot tìm sản phẩm, báo giá, lên đơn và chỉ chốt khi khách xác nhận.${where}${split}`, action: act("Mở hộp thư", SETTINGS_HREF.inbox) };
}
