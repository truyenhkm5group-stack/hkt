/**
 * ═══════════ CHATBOT BÁN HÀNG CỦA TỔ CHỨC — CẤU HÌNH (0180) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Tài liệu: docs/platform/self-service-journey.md mục «Chatbot bán hàng». Bot trả lời KHÁCH của shop: tìm sản phẩm, báo
 * giá / tồn ĐỌC TỪ ERP qua công cụ (không bao giờ nằm trong lời nhắc), tính giỏ, lên đơn nháp, chốt đơn khi khách xác
 * nhận, chuyển người khi cần. Cấu hình nằm ở `settings['ai.salesChatbot']` trong CSDL của CHÍNH tổ chức; khoá AI là kết
 * nối BYOK của chính tổ chức (`anthropic-byok` / `openai-byok`) — không có đường nào lẫn sang tổ chức khác hay sang nhà.
 *
 * Tệp này KHÔNG import gì chạy được: form cấu hình và máy chủ dùng CHUNG lược đồ, mặc định và nhãn.
 */
import { z } from "zod";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { AI_CLASSES_CAN_NGUOI, classifyAiError, type AiErrorClass, type AiFailureClass } from "@/lib/constants/ai-incidents";
import { bookingConfigZ, DEFAULT_BOOKING_CONFIG } from "@/lib/constants/booking";
import { DEFAULT_FREE_SHIPPING } from "@/lib/sales-chatbot/shipping";

export const SALES_CHATBOT_SETTING_KEY = "ai.salesChatbot";

/** Mười công cụ — tập ĐÓNG. Mọi công cụ đọc / ghi CSDL của tổ chức ngữ cảnh qua lõi sẵn có. */
export const SALES_TOOLS = [
  "search_products",
  "get_product",
  "get_current_price",
  "check_inventory",
  "calculate_cart",
  "create_customer",
  "create_draft_order",
  "update_draft_order",
  "confirm_order",
  "handoff_to_human",
] as const;
export type SalesTool = (typeof SALES_TOOLS)[number];

export const SALES_TOOL_LABEL: Record<SalesTool, { label: string; write: boolean }> = {
  search_products: { label: "Tìm sản phẩm", write: false },
  get_product: { label: "Xem chi tiết sản phẩm", write: false },
  get_current_price: { label: "Giá hiện tại", write: false },
  check_inventory: { label: "Kiểm tồn", write: false },
  calculate_cart: { label: "Tính tiền giỏ hàng", write: false },
  create_customer: { label: "Tạo khách", write: true },
  create_draft_order: { label: "Lên đơn nháp", write: true },
  update_draft_order: { label: "Sửa đơn nháp", write: true },
  confirm_order: { label: "Chốt đơn (khi khách xác nhận)", write: true },
  handoff_to_human: { label: "Chuyển nhân viên", write: true },
};

export const SALES_TONES = ["FRIENDLY", "PROFESSIONAL", "CONCISE"] as const;
export type SalesTone = (typeof SALES_TONES)[number];
export const SALES_TONE_LABEL: Record<SalesTone, string> = { FRIENDLY: "Thân thiện, xưng hô gần gũi", PROFESSIONAL: "Lịch sự, chuyên nghiệp", CONCISE: "Ngắn gọn, đi thẳng vào việc" };

/**
 * Mức SUY NGHĨ của bot (01/10/2026: chủ shop thấy bot ở mức thấp nhất trả lời «ngu»). `SMART` = suy luận vừa, trả lời chậm
 * hơn vài giây nhưng hiểu ngữ cảnh tốt hơn; `FAST` = suy luận thấp, nhanh nhất. Câu trả lời mẫu không tốn suy nghĩ nào.
 */
export const SALES_THINKING = ["SMART", "FAST"] as const;
export type SalesThinking = (typeof SALES_THINKING)[number];
export const SALES_THINKING_LABEL: Record<SalesThinking, string> = { SMART: "Kỹ — hiểu ngữ cảnh tốt hơn, chậm hơn vài giây", FAST: "Nhanh — trả lời nhanh nhất" };
/** Ngân sách token đầu ra + mức suy luận của MỘT vòng chat theo mức suy nghĩ (suy luận ăn chung ngân sách — xem provider). */
export const SALES_THINKING_BUDGET: Record<SalesThinking, { maxTokens: number; reasoning: "low" | "medium" }> = { SMART: { maxTokens: 10_000, reasoning: "medium" }, FAST: { maxTokens: 4_000, reasoning: "low" } };

/**
 * Khoá AI của bot. `platform` (0193) = AI DÙNG CHUNG của nền tảng, trừ vào credit AI của gói — shop mới vào việc ngay mà
 * không phải tự đi mua khoá AI. Ba lựa chọn còn lại = khoá RIÊNG của shop (BYOK), không trừ credit của gói.
 */
export const SALES_BOT_CONNECTORS = ["platform", "anthropic-byok", "openai-byok", "gemini-byok"] as const;
export type SalesBotConnector = (typeof SALES_BOT_CONNECTORS)[number];

/**
 * Nguồn trả tiền trên sổ AI theo lựa chọn khoá — MỘT chỗ quyết, mọi lượt ghi sổ / kiểm hạn mức hỏi ở đây.
 *
 * `platform` ở tổ chức NHÀ = khoá `.env` của nhà (`HOME`) — Phase 8b, docs/saas/OWNERSHIP.md §4 chặn 4. Cùng luật với AI
 * Builder (`lib/ai-builder/provider.ts`): "AI không phải khoá riêng của tổ chức" là `HOME` ở nhà và `PLATFORM` ở mọi tổ chức
 * khác — hai nhánh loại trừ nhau theo `isHome`, nên không có lựa chọn nào để một tổ chức khách chọn trúng khoá của nhà.
 * Không truyền `home` ⇒ `PLATFORM` như trước (hỏng về phía khách, không bao giờ về phía nhà).
 */
export function salesBotBillingSource(key: SalesBotConnector, opts: { home?: boolean } = {}): AiBillingSource {
  if (key !== "platform") return "BYOK";
  return opts.home === true ? "HOME" : "PLATFORM";
}

/**
 * Khoá dự phòng ĐANG CÓ HIỆU LỰC — `null` khi chưa chọn, công tắc tắt, hoặc trùng khoá chính (cùng tài khoản thì hết credit
 * cùng lúc — chuyển sang chính nó không cứu được gì). MỘT chỗ quyết, máy chủ và form cùng hỏi. HÀM THUẦN.
 */
export function effectiveFallback(cfg: Pick<SalesChatbotConfig, "connectorKey" | "fallbackConnectorKey" | "fallbackModel" | "failoverEnabled">): { connectorKey: SalesBotConnector; model: string } | null {
  if (!cfg.failoverEnabled || !cfg.fallbackConnectorKey || cfg.fallbackConnectorKey === cfg.connectorKey) return null;
  return { connectorKey: cfg.fallbackConnectorKey, model: cfg.fallbackModel };
}

/** Lớp lỗi mịn (để chuyển nhà cung cấp) ⇒ câu cho chủ shop trên khung «Sức khoẻ khoá AI». */
export const SALES_BOT_FAILURE_LABEL: Record<AiFailureClass, string> = {
  CREDIT: "Hết tiền / hết credit",
  AUTH: "Khoá bị từ chối",
  RATE_LIMIT: "Quá tải / quá hạn mức",
  MODEL_UNAVAILABLE: "Model không dùng được",
  SERVER_ERROR: "Lỗi máy chủ / mất kết nối",
  TIMEOUT: "Quá thời gian chờ",
  INVALID_REQUEST: "Câu hỏi bị từ chối (không chuyển dự phòng)",
  OTHER: "Lỗi chưa phân loại (không chuyển dự phòng)",
};

/** Trần KỸ THUẬT (không phải ngưỡng nghiệp vụ): chặn vòng lặp công cụ và bão tin trên trang chat công khai. */
export const SALES_CHATBOT_LIMITS = { toolRounds: 10, historyMessages: 40, turnsPerConversation: 60, webMessagesPerVisitorPer10Min: 20, messageMax: 1000 } as const;

const timeZ = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Giờ dạng HH:MM");

export const salesChatbotConfigZ = z
  .object({
    enabled: z.boolean(),
    botName: z.string().trim().min(2, "Tên bot ít nhất 2 ký tự").max(60),
    connectorKey: z.enum(SALES_BOT_CONNECTORS),
    /** Để trống = model mặc định của kết nối. Chỉ chữ thường / số / chấm / gạch. */
    model: z
      .string()
      .trim()
      .max(60)
      .regex(/^$|^[a-z][a-z0-9.-]{2,60}$/, "Tên model không hợp lệ")
      .default(""),
    /**
     * KHOÁ AI DỰ PHÒNG (06/10/2026 — sự cố Google AI Studio hết credit trả trước 11:38, bot im ~2 giờ): khoá chính hỏng
     * kiểu chuyển được (hết credit · khoá bị từ chối · quá tải · lỗi máy chủ · hết giờ) ⇒ CÙNG câu hỏi gửi sang khoá này,
     * TRƯỚC khi có chữ nào tới khách (lib/sales-chatbot/provider-failover.ts). `null` = KHÔNG có dự phòng ⇒ hành vi y như
     * trước. Mặc định `null`: chọn trả tiền ở đâu khi khoá chính hỏng là quyết định của chủ shop — kể cả AI dùng chung
     * (`platform`, vẫn qua kiểm credit gói như mọi lượt).
     */
    fallbackConnectorKey: z.enum(SALES_BOT_CONNECTORS).nullable().default(null),
    /** Model của khoá dự phòng — để trống = mặc định của kết nối đó. */
    fallbackModel: z
      .string()
      .trim()
      .max(60)
      .regex(/^$|^[a-z][a-z0-9.-]{2,60}$/, "Tên model không hợp lệ")
      .default(""),
    /** Công tắc TẮT chuyển dự phòng của tổ chức (giữ nguyên khoá dự phòng đã chọn). */
    failoverEnabled: z.boolean().default(true),
    /** Hết credit / khoá bị từ chối ⇒ khoá đó bị NGẮT bấy nhiêu phút rồi mới thử lại một lượt (mạch nửa mở). */
    failoverOpenMinutes: z.number().int().min(1).max(1440).default(30),
    tone: z.enum(SALES_TONES),
    thinking: z.enum(SALES_THINKING).default("SMART"),
    greeting: z.string().trim().min(2).max(300),
    businessHours: z
      .object({
        enabled: z.boolean(),
        start: timeZ,
        end: timeZ,
        /** 0 = Chủ nhật … 6 = Thứ bảy (giờ Việt Nam). */
        days: z.array(z.number().int().min(0).max(6)).max(7),
        outsideMessage: z.string().trim().max(300),
      })
      .strict(),
    handoff: z
      .object({
        onCustomerRequest: z.boolean(),
        onComplaint: z.boolean(),
        message: z.string().trim().min(2).max(300),
        /**
         * Gửi tin «Chatbot chuyển khách cho nhân viên» vào nhóm chat vận hành (cùng nhóm báo đơn). Mặc định TẮT — chủ shop
         * Hải Sản Làng Chài 03/10/2026: nhóm chỉ cần tin ĐƠN MỚI. Chuông / hộp thư trong ERP vẫn luôn có.
         */
        notifyGroup: z.boolean().default(false),
      })
      .strict(),
    /** Chính sách chốt: LUÔN đọc lại tóm tắt (hàng, SL, đơn giá, tiền, người nhận, địa chỉ) và chờ khách xác nhận. */
    confirmation: z.enum(["RECAP_AND_WAIT"]),
    /** Phí ship cố định đưa vào đơn (đồng). `null` = CHƯA KHAI ⇒ bot nói "nhân viên báo phí ship sau", không bịa số. */
    shippingFee: z.number().int().min(0).max(10_000_000).nullable(),
    /**
     * MIỄN PHÍ SHIP (03/10/2026, lib/sales-chatbot/shipping.ts): đạt MỘT trong hai ngưỡng (tiền hàng / khối lượng) VÀ giao
     * trong `areas` ⇒ phí ship 0 trong tóm tắt và đơn. Mặc định TẮT — chính sách giá là quyết định của chủ shop.
     */
    freeShipping: z
      .object({
        enabled: z.boolean(),
        minSubtotal: z.number().int().min(0).max(1_000_000_000).nullable(),
        minWeightGrams: z.number().int().min(1).max(1_000_000).nullable(),
        areas: z.array(z.string().trim().min(1).max(60)).max(80),
      })
      .strict()
      .default(DEFAULT_FREE_SHIPPING),
    allowedTools: z.array(z.enum(SALES_TOOLS)).max(SALES_TOOLS.length),
    /** Khoá field tuỳ biến của SẢN PHẨM mà bot được đọc (quy cách, bảo quản…). Field không có ở đây bot không biết tới. */
    productFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).max(30).default([]),
    extraInstructions: z.string().trim().max(1500).default(""),
    /**
     * BÁO GIÁ THEO BẢNG GIÁ SỈ (0188, docs/verticals/seafood-os.md). TẮT ⇒ bot chỉ có giá LẺ và chuyển người với mọi
     * câu hỏi sỉ (như trước). BẬT ⇒ đơn giá của bot = `quoteUnitPrice` (bảng của khách → bảng mặc định → giá lẻ) — CÙNG
     * hàm với form đơn tay; bot nói được bậc «mua từ N». Mặc định TẮT: cho bot tự báo giá sỉ là quyết định của chủ shop.
     */
    wholesalePricing: z.boolean().default(false),
    /**
     * CHỐT KHÔNG CẦN KIỂM TỒN (chủ shop Hải Sản Làng Chài 04/10/2026: «Hàng sẽ được fill-in liên tục nên cứ chốt đơn mà không
     * cần check tồn kho»). BẬT ⇒ bot không nói còn / hết hàng và chốt cả khi sổ kho đang thiếu — đơn mang ghi chú để kho chuẩn
     * bị hàng trước khi giao. Mặc định TẮT: bán vượt tồn là quyết định của chủ shop.
     */
    sellWithoutStockCheck: z.boolean().default(false),
    /**
     * NHẬN ĐẶT LỊCH QUA CHAT (module «Lịch hẹn», lib/constants/booking.ts). Chỉ có hiệu lực khi tổ chức BẬT module đó.
     * Mặc định TẮT: cho bot tự giữ chỗ trong lịch của shop là quyết định của chủ shop.
     */
    booking: bookingConfigZ.default(DEFAULT_BOOKING_CONFIG),
  })
  .strict();

export type SalesChatbotConfig = z.infer<typeof salesChatbotConfigZ>;

export const DEFAULT_SALES_CHATBOT_CONFIG: SalesChatbotConfig = {
  enabled: false,
  botName: "Trợ lý bán hàng",
  connectorKey: "platform",
  model: "",
  fallbackConnectorKey: null,
  fallbackModel: "",
  failoverEnabled: true,
  failoverOpenMinutes: 30,
  tone: "FRIENDLY",
  thinking: "SMART",
  greeting: "Chào anh/chị! Em có thể tư vấn sản phẩm, báo giá và lên đơn giúp mình ạ.",
  businessHours: { enabled: false, start: "08:00", end: "21:00", days: [0, 1, 2, 3, 4, 5, 6], outsideMessage: "Shop đang ngoài giờ làm việc — anh/chị để lại tin nhắn, nhân viên sẽ trả lời sớm nhất ạ." },
  handoff: { onCustomerRequest: true, onComplaint: true, message: "Em đã chuyển cho nhân viên, anh/chị đợi một chút nhé.", notifyGroup: false },
  confirmation: "RECAP_AND_WAIT",
  shippingFee: null,
  freeShipping: DEFAULT_FREE_SHIPPING,
  allowedTools: [...SALES_TOOLS],
  productFields: ["package_size", "net_weight", "selling_unit", "food_category", "storage_instruction", "usage_instruction"],
  extraInstructions: "",
  wholesalePricing: false,
  sellWithoutStockCheck: false,
  booking: DEFAULT_BOOKING_CONFIG,
};

/** Cấu hình đã lưu ⇒ cấu hình dùng được. Sai hình / thiếu ⇒ mặc định (TẮT) — hỏng về phía đóng. */
export function parseSalesChatbotConfig(raw: unknown): SalesChatbotConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_SALES_CHATBOT_CONFIG;
  const merged = { ...DEFAULT_SALES_CHATBOT_CONFIG, ...(raw as Record<string, unknown>) };
  const parsed = salesChatbotConfigZ.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: false };
}

/** Giờ VN hiện tại có nằm trong giờ làm việc không. Hàm THUẦN (nhận `now`). Khung qua nửa đêm (22:00–06:00) được hiểu đúng. */
export function withinBusinessHours(cfg: SalesChatbotConfig["businessHours"], now: Date): boolean {
  if (!cfg.enabled) return true;
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const day = vn.getUTCDay();
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const [sh, sm] = cfg.start.split(":").map(Number);
  const [eh, em] = cfg.end.split(":").map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return cfg.days.includes(day);
  if (s < e) return cfg.days.includes(day) && minutes >= s && minutes < e;
  // Qua nửa đêm: phần sau 0h thuộc ngày hôm trước.
  if (minutes >= s) return cfg.days.includes(day);
  return minutes < e && cfg.days.includes((day + 6) % 7);
}

export type ChatChannel = "TEST" | "WEB" | "FANPAGE" | "ZALO";

/** Kênh có khách thật (mọi kênh trừ khung thử) — đếm lượt / thống kê. */
export const PUBLIC_CHAT_CHANNELS = ["WEB", "FANPAGE", "ZALO"] as const satisfies readonly ChatChannel[];

/**
 * Kênh CÔNG KHAI = có khách thật ở đầu kia (trang chat web của tổ chức · tin nhắn fanpage qua Pancake): ghi đơn thật,
 * áp giờ làm việc, trần tin, chuyển người khi AI hỏng. `TEST` là khung thử của chủ shop — ghi mô phỏng.
 */
export function isPublicChannel(channel: ChatChannel): boolean {
  return (PUBLIC_CHAT_CHANNELS as readonly ChatChannel[]).includes(channel);
}

/**
 * Kênh NHẮN TIN (fanpage · Zalo OA): khách ở trong ứng dụng chat, nhân viên trả lời ngay trên đó ⇒ chuyển người là bot IM
 * (không nhắn «em đã chuyển cho nhân viên…»). Khác WEB, nơi khách cần một câu để biết đã có người nhận.
 */
export function isMessagingChannel(channel: ChatChannel): boolean {
  return channel === "FANPAGE" || channel === "ZALO";
}

export const CHAT_CHANNEL_LABEL: Record<ChatChannel, string> = { TEST: "Khung thử", WEB: "Khách web", FANPAGE: "Fanpage", ZALO: "Zalo OA" };

/** Một dòng tin cho màn hình (đã lọc bỏ khối công cụ thô). */
export type ChatView = {
  conversationId: string;
  status: "OPEN" | "WAITING" | "HANDOFF" | "CLOSED";
  messages: { role: "user" | "assistant"; text: string; tools?: { name: string; ok: boolean; summary: string }[] }[];
  order: { id: string | null; stage: string | null; simulated: boolean; total: number | null } | null;
};

/**
 * LỖI NHÀ CUNG CẤP AI CỦA CHATBOT ⇒ CÂU CHO CHỦ SHOP. Lớp lỗi lấy từ `classifyAiError` (lib/constants/ai-incidents.ts — cùng
 * bộ phân loại của sự cố AI nhà), không viết bộ thứ hai. Đo UAT 30/09/2026: khoá AI của tổ chức hết credit ⇒ MỌI khách
 * nhận «em đang gặp trục trặc», màn hình chỉ in 80 ký tự đầu của phong bì JSON tiếng Anh, và không ai được báo.
 * `notify` = lớp KHÔNG tự khỏi (hết credit · khoá bị từ chối) — chỉ chúng mới đáng một thông báo cho chủ shop.
 */
export const SALES_BOT_ERROR_LABEL: Record<AiErrorClass, string> = {
  CREDIT: "Tài khoản AI của shop đã hết tiền — nạp thêm ở trang của nhà cung cấp AI",
  AUTH: "Khoá AI bị từ chối (sai, hết hạn hoặc bị thu hồi) — thay khoá ở Cài đặt → Kết nối",
  RATE_LIMIT: "Nhà cung cấp AI đang quá tải / quá hạn mức — thường tự khỏi sau vài phút",
  OTHER: "Nhà cung cấp AI trả lỗi",
};

export function salesBotError(lastError: string | null | undefined): { kind: AiErrorClass; label: string; notify: boolean } | null {
  if (!lastError || !lastError.trim()) return null;
  const kind = classifyAiError(lastError);
  return { kind, label: SALES_BOT_ERROR_LABEL[kind], notify: AI_CLASSES_CAN_NGUOI.includes(kind) };
}
