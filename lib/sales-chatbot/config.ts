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

export const SALES_BOT_CONNECTORS = ["anthropic-byok", "openai-byok"] as const;
export type SalesBotConnector = (typeof SALES_BOT_CONNECTORS)[number];

/** Trần KỸ THUẬT (không phải ngưỡng nghiệp vụ): chặn vòng lặp công cụ và bão tin trên trang chat công khai. */
export const SALES_CHATBOT_LIMITS = { toolRounds: 8, historyMessages: 40, turnsPerConversation: 60, webMessagesPerVisitorPer10Min: 20, webTurnsPerOrgPerDay: 500, messageMax: 1000 } as const;

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
    tone: z.enum(SALES_TONES),
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
      })
      .strict(),
    /** Chính sách chốt: LUÔN đọc lại tóm tắt (hàng, SL, đơn giá, tiền, người nhận, địa chỉ) và chờ khách xác nhận. */
    confirmation: z.enum(["RECAP_AND_WAIT"]),
    /** Phí ship cố định đưa vào đơn (đồng). `null` = CHƯA KHAI ⇒ bot nói "nhân viên báo phí ship sau", không bịa số. */
    shippingFee: z.number().int().min(0).max(10_000_000).nullable(),
    allowedTools: z.array(z.enum(SALES_TOOLS)).max(SALES_TOOLS.length),
    /** Khoá field tuỳ biến của SẢN PHẨM mà bot được đọc (quy cách, bảo quản…). Field không có ở đây bot không biết tới. */
    productFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).max(30).default([]),
    extraInstructions: z.string().trim().max(1500).default(""),
  })
  .strict();

export type SalesChatbotConfig = z.infer<typeof salesChatbotConfigZ>;

export const DEFAULT_SALES_CHATBOT_CONFIG: SalesChatbotConfig = {
  enabled: false,
  botName: "Trợ lý bán hàng",
  connectorKey: "anthropic-byok",
  model: "",
  tone: "FRIENDLY",
  greeting: "Chào anh/chị! Em có thể tư vấn sản phẩm, báo giá và lên đơn giúp mình ạ.",
  businessHours: { enabled: false, start: "08:00", end: "21:00", days: [0, 1, 2, 3, 4, 5, 6], outsideMessage: "Shop đang ngoài giờ làm việc — anh/chị để lại tin nhắn, nhân viên sẽ trả lời sớm nhất ạ." },
  handoff: { onCustomerRequest: true, onComplaint: true, message: "Em đã chuyển cho nhân viên, anh/chị đợi một chút nhé." },
  confirmation: "RECAP_AND_WAIT",
  shippingFee: null,
  allowedTools: [...SALES_TOOLS],
  productFields: ["package_size", "net_weight", "selling_unit", "food_category", "storage_instruction", "usage_instruction"],
  extraInstructions: "",
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

export type ChatChannel = "TEST" | "WEB";

/** Một dòng tin cho màn hình (đã lọc bỏ khối công cụ thô). */
export type ChatView = {
  conversationId: string;
  status: "OPEN" | "HANDOFF" | "CLOSED";
  messages: { role: "user" | "assistant"; text: string; tools?: { name: string; ok: boolean; summary: string }[] }[];
  order: { id: string | null; stage: string | null; simulated: boolean; total: number | null } | null;
};
