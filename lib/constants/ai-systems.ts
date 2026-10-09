/**
 * ═══════════ SỔ HỆ THỐNG AI (M-AI-REG · Luật AI 134/2025 Điều 15 — giải thích khi cơ quan hỏi) — KHÔNG UI ═══════════
 *
 * AI-01…AI-05 theo `docs/legal/VIETNAM_LEGAL_COMPLIANCE.md` §11. AI-06…AI-08 là phần BỔ SUNG từ kiểm kê mã: mọi giá trị
 * `feature` của sổ dùng AI (`AI_USAGE_FEATURES`) phải thuộc một hệ thống, nên ba đường gọi AI §11 chưa kể tới (AI Builder,
 * lời chào khách sỉ, sáng tạo quảng cáo) được khai thay vì bị bỏ ngoài sổ.
 *
 * ─── NHÀ CUNG CẤP / MODEL ĐỌC TỪ CẤU HÌNH, KHÔNG GÕ LẠI ───
 * Danh sách kết nối và model mặc định lấy từ chính hằng mà máy chủ dùng (`SALES_BOT_CONNECTORS`, `PLATFORM_AI_PROVIDERS`,
 * `PLATFORM_GEMINI_DEFAULT_MODEL`, `MODEL_BY_TIER`). Model ĐANG CHẠY trên production là cấu hình lúc chạy (biến môi trường,
 * ô model của tổ chức) ⇒ ghi «đọc lúc chạy» và chỗ đọc, không ghi một tên model như thể đã biết (M-OBSERVE đo).
 *
 * ─── MỨC RỦI RO MẶC ĐỊNH `UNCLASSIFIED` ───
 * Phase 1 đánh giá TẠM «ít nhất TRUNG BÌNH» cho bot bán hàng (§11), nhưng phân loại là việc của luật sư (G-4) và danh mục
 * rủi ro cao chưa được ban hành ⇒ không hệ thống nào mang mức khác `UNCLASSIFIED` khi chưa có bằng chứng phân loại.
 *
 * Bài kiểm (`tests/legal-registers.test.ts`) quét mã nguồn: mỗi tệp gọi `recordAiUsage(` phải nằm trong `callSites` của một
 * hệ thống, và `feature` / `workload` viết trong tệp đó phải thuộc hệ thống ấy.
 */
import { PLATFORM_AI_ENV, PLATFORM_AI_PROVIDERS, PLATFORM_GEMINI_DEFAULT_MODEL } from "@/lib/ai-usage/platform-ai";
import type { AiUsageFeature, PlatformWorkload } from "@/lib/ai-usage/types";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { SALES_BOT_CONNECTORS } from "@/lib/sales-chatbot/config";

export const AI_SYSTEM_IDS = ["AI-01", "AI-02", "AI-03", "AI-04", "AI-05", "AI-06", "AI-07", "AI-08"] as const;
export type AiSystemId = (typeof AI_SYSTEM_IDS)[number];

export const AI_RISK_LEVELS = ["HIGH", "MEDIUM", "LOW", "UNCLASSIFIED"] as const;
export type AiRiskLevel = (typeof AI_RISK_LEVELS)[number];

/** `SECTION_11` — khai ở §11 tài liệu; `CODE_INVENTORY` — bổ sung từ kiểm kê mã, §11 chưa kể. */
export const AI_SYSTEM_ORIGINS = ["SECTION_11", "CODE_INVENTORY"] as const;
export type AiSystemOrigin = (typeof AI_SYSTEM_ORIGINS)[number];

export type AiSystem = {
  id: AiSystemId;
  name: string;
  origin: AiSystemOrigin;
  purpose: string;
  /** Ai tương tác với đầu ra: khách hàng cuối (Luật AI Điều 11.1 áp) hay chỉ nhân viên / người vận hành. */
  facesEndCustomer: boolean;
  /** Giá trị `feature` của sổ dùng AI mà hệ thống ghi. */
  features: readonly AiUsageFeature[];
  /** Loại việc của Platform AI Policy mà hệ thống ghi. */
  workloads: readonly PlatformWorkload[];
  /** Tệp gọi model (bài kiểm mở từng tệp). */
  callSites: readonly string[];
  /** Nhà cung cấp có thể chạy — từ hằng cấu hình. */
  providers: readonly string[];
  /** Model: mặc định khai trong mã (từ hằng) + nơi đọc model đang chạy. */
  model: { defaults: readonly string[]; runtimeSource: string };
  risk: AiRiskLevel;
  /** Bằng chứng phân loại — `null` khi `UNCLASSIFIED`. */
  riskEvidence: string | null;
  riskNote: string;
  /** Giám sát con người: tệp / hàm. */
  humanOversight: readonly string[];
  /** Phát hiện / xử lý sự cố: tệp / job. */
  incidentHandling: readonly string[];
  /** Lịch sử thay đổi theo tài liệu. */
  changeHistory: string;
};

const SALES_PROVIDERS: readonly string[] = [...SALES_BOT_CONNECTORS.map((c) => `connector:${c}`), ...PLATFORM_AI_PROVIDERS.map((p) => `platform:${p}`)];
const SALES_DEFAULT_MODELS: readonly string[] = [PLATFORM_GEMINI_DEFAULT_MODEL, MODEL_BY_TIER.anthropic.copilot];
const SALES_MODEL_SOURCE = `Ô model của tổ chức (SalesChatbotConfig.model) · kết nối BYOK · ${PLATFORM_AI_ENV.provider} / ${PLATFORM_AI_ENV.model} — đọc lúc chạy (lib/sales-chatbot/engine.ts, lib/ai-usage/platform-ai.ts)`;
const UNCLASSIFIED_NOTE = "Chưa phân loại: chờ G-4 (mức rủi ro, ngoại lệ Điều 11.1, Điều 35) và danh mục rủi ro cao của Thủ tướng (PL-5)";

export const AI_SYSTEMS: readonly AiSystem[] = [
  {
    id: "AI-01",
    name: "Sales Agent — Messenger / Zalo / chat web",
    origin: "SECTION_11",
    purpose: "Tư vấn bán hàng, gom thông tin đơn, tạo nháp đơn, ghi đơn từ hội thoại nhân viên",
    facesEndCustomer: true,
    features: ["sales_chatbot"],
    workloads: ["sales_chatbot", "quick_extract", "order_sync"],
    callSites: ["lib/sales-chatbot/engine.ts", "lib/sales-chatbot/order-sync.ts"],
    providers: SALES_PROVIDERS,
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: SALES_MODEL_SOURCE },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: `Phase 1 tạm đánh giá «ít nhất TRUNG BÌNH» (§11, Điều 9). ${UNCLASSIFIED_NOTE}`,
    humanOversight: ["lib/sales-chatbot/conversation-control.ts", "lib/sales-chatbot/operating-mode.ts", "lib/sales-chatbot/config.ts"],
    incidentHandling: ["lib/ai-usage/sales-health.ts", "lib/tech/ai-incident-watch.ts"],
    changeHistory: "PR #552 → #688 (VIETNAM_LEGAL_COMPLIANCE.md §11)",
  },
  {
    id: "AI-02",
    name: "Đọc ảnh / nghe ghi âm khách gửi",
    origin: "SECTION_11",
    purpose: "Hiểu ảnh sản phẩm khách gửi; chép ghi âm giọng khách (bot nhà)",
    facesEndCustomer: true,
    features: ["sales_chatbot"],
    workloads: ["vision"],
    callSites: ["lib/sales-chatbot/vision.ts", "lib/sales-chatbot/engine.ts", "chatbot/src/gemini.js", "chatbot/src/voice.js"],
    providers: SALES_PROVIDERS,
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: `${SALES_MODEL_SOURCE}; bot nhà: chatbot/src/config.js (biến môi trường của container bot)` },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: `Ghi âm có là DLCN nhạy cảm không — G (U). ${UNCLASSIFIED_NOTE}`,
    humanOversight: ["lib/sales-chatbot/conversation-control.ts"],
    incidentHandling: ["lib/ai-usage/sales-health.ts"],
    changeHistory: "PR #480 (bot nghe ghi âm)",
  },
  {
    id: "AI-03",
    name: "Follow-up tự động",
    origin: "SECTION_11",
    purpose: "Viết tin nhắc khách trong cửa sổ 24 giờ",
    facesEndCustomer: true,
    features: ["sales_chatbot"],
    workloads: [],
    callSites: ["lib/sales-chatbot/followup.ts"],
    providers: SALES_PROVIDERS,
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: SALES_MODEL_SOURCE },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: `Tin tiếp thị lại ⇒ quyền phản đối (M-OPTOUT). ${UNCLASSIFIED_NOTE}`,
    humanOversight: ["lib/sales-chatbot/followup-settings.ts", "lib/sales-chatbot/conversation-control.ts"],
    incidentHandling: ["lib/ai-usage/sales-health.ts"],
    changeHistory: "followup.ts — mặc định BẬT, ba mốc 60 / 360 / 1320 phút (DATA_FLOW_MAP.md §4)",
  },
  {
    id: "AI-04",
    name: "Bot tự học từ hội thoại",
    origin: "SECTION_11",
    purpose: "Rút bài học / sổ tay từ hội thoại cũ và phản hồi của nhân viên (che SĐT / tên trước khi học)",
    facesEndCustomer: false,
    features: ["sales_playbook"],
    workloads: [],
    callSites: ["lib/sales-chatbot/playbook.ts", "lib/sales-chatbot/lessons.ts", "lib/sales-chatbot/inbox-feedback.ts", "lib/sales-chatbot/quick-replies-learn.ts"],
    providers: SALES_PROVIDERS,
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: SALES_MODEL_SOURCE },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: UNCLASSIFIED_NOTE,
    humanOversight: ["lib/sales-chatbot/lessons.ts", "lib/sales-chatbot/quick-replies.ts"],
    incidentHandling: ["lib/ai-usage/sales-health.ts"],
    changeHistory: "PR #496 (bot tự học) · 09/10/2026 tự nạp câu trả lời mẫu (quick-replies-learn.ts — mặc định tắt, câu mới chờ người duyệt)",
  },
  {
    id: "AI-05",
    name: "Copilot / agent nội bộ (ERP nhà)",
    origin: "SECTION_11",
    purpose: "Trợ lý cho nhân viên VNX; phân loại hội thoại CSKH",
    facesEndCustomer: false,
    features: ["copilot"],
    workloads: [],
    callSites: ["lib/ai/copilot.ts", "lib/cs/chat-detect.ts"],
    providers: ["anthropic", "openai"],
    model: { defaults: [MODEL_BY_TIER.anthropic.copilot], runtimeSource: "lib/ai/router.ts (MODEL_BY_TIER, AI_PROVIDER của nhà) — đọc lúc chạy" },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: UNCLASSIFIED_NOTE,
    humanOversight: ["lib/ai/copilot.ts"],
    incidentHandling: ["lib/tech/ai-incident-watch.ts"],
    changeHistory: "ERP nhà (VIETNAM_LEGAL_COMPLIANCE.md §11)",
  },
  {
    id: "AI-06",
    name: "AI Builder (soạn bản thiết kế module)",
    origin: "CODE_INVENTORY",
    purpose: "Soạn nháp cấu hình / module cho quản trị tổ chức",
    facesEndCustomer: false,
    features: ["ai_builder"],
    workloads: [],
    callSites: ["lib/ai-builder/service.ts", "lib/ai-builder/providers.ts"],
    providers: ["anthropic-byok", "openai-byok", "gemini-byok", ...PLATFORM_AI_PROVIDERS.map((p) => `platform:${p}`)],
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: "lib/ai-builder/providers.ts — kết nối của tổ chức / khoá nền tảng, đọc lúc chạy" },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: UNCLASSIFIED_NOTE,
    humanOversight: ["lib/ai-builder/service.ts"],
    incidentHandling: ["lib/ai-usage/ledger.ts"],
    changeHistory: "Kiểm kê mã 09/10/2026 — §11 chưa kể",
  },
  {
    id: "AI-07",
    name: "Lời chào khách sỉ",
    origin: "CODE_INVENTORY",
    purpose: "Soạn lời mở đầu nhắn cơ sở kinh doanh tìm qua Google Places",
    facesEndCustomer: true,
    features: ["lead_hunter"],
    workloads: [],
    callSites: ["lib/wholesale/outreach.ts"],
    providers: SALES_PROVIDERS,
    model: { defaults: SALES_DEFAULT_MODELS, runtimeSource: "lib/wholesale/outreach.ts — kết nối AI của tổ chức, đọc lúc chạy" },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: `Tiếp thị tới người chưa đồng ý — NĐ 91 / Luật 91 (DATA_PROCESSING_REGISTER.md D17). ${UNCLASSIFIED_NOTE}`,
    humanOversight: ["lib/wholesale/outreach.ts"],
    incidentHandling: ["lib/ai-usage/ledger.ts"],
    changeHistory: "PR #521 / #543 (săn khách sỉ) — kiểm kê mã 09/10/2026",
  },
  {
    id: "AI-08",
    name: "Sáng tạo quảng cáo (ảnh · câu chữ · video)",
    origin: "CODE_INVENTORY",
    purpose: "Vẽ ảnh, viết câu chữ quảng cáo; sinh video (Video Scale, nhà)",
    facesEndCustomer: false,
    features: ["creative_image", "creative_copy"],
    workloads: [],
    callSites: ["lib/creative/org-ai.ts", "lib/creative/byok-image.ts", "lib/video-scale/providers/omni.ts", "lib/video-scale/providers/veo.ts"],
    providers: ["gemini-byok", "openai-byok", "openai", "gemini"],
    model: { defaults: [], runtimeSource: "lib/creative/org-ai.ts · lib/video-scale/providers/* — kết nối của tổ chức / khoá nhà, đọc lúc chạy" },
    risk: "UNCLASSIFIED",
    riskEvidence: null,
    riskNote: `Gắn nhãn nội dung do AI tạo (Điều 11.3) — G. ${UNCLASSIFIED_NOTE}`,
    humanOversight: ["lib/creative/org-ai.ts"],
    incidentHandling: ["lib/ai-usage/ledger.ts"],
    changeHistory: "Kiểm kê mã 09/10/2026 — §11 chưa kể",
  },
];

/**
 * Tệp gọi `recordAiUsage(` mà KHÔNG phải một đường gọi model — miễn trừ quét, kèm lý do.
 */
export const AI_USAGE_SCAN_EXEMPT_FILES: Readonly<Record<string, string>> = {
  "lib/ai-usage/ledger.ts": "Định nghĩa của chính đường ghi sổ",
  "lib/constants/ai-systems.ts": "Chính sổ này — chỉ nhắc tên hàm trong chú thích",
  "lib/pricing/entitlements.ts": "`recordUsageEvent` chỉ chuyển tiếp tới `recordAiUsage` kèm khoá sự kiện bắt buộc — không gọi model; nơi gọi nó phải tự nằm trong một hệ thống",
};

/** Hệ thống chứa tệp gọi AI này. */
export function aiSystemsForFile(file: string): AiSystem[] {
  return AI_SYSTEMS.filter((s) => s.callSites.includes(file));
}
