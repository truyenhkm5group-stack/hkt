/**
 * ═══════════ CHE DỮ LIỆU NỘI BỘ KHỎI KHÁCH — MỘT HÀM CHUNG (chủ shop 07/10/2026) ═══════════
 *
 * «Khách» = workspace KHÔNG phải nhà (`organization.isHome !== true`). Khách KHÔNG được thấy model / nhà cung cấp AI, token,
 * giá token, chi phí AI, khoá AI, lời nhắc hệ thống, màn kỹ thuật — và KHÔNG CHỈ ẨN GIAO DIỆN: máy chủ lọc DTO TRƯỚC khi
 * gửi (loader, server action, props của RSC). Khách chỉ thấy AI bật / tắt và MỘT trong bốn trạng thái
 * (`CUSTOMER_AI_STATE_LABEL`). Người của workspace nhà (gồm người vận hành nền tảng) vẫn thấy mọi thứ.
 *
 * Tệp này THUẦN (không đọc CSDL, không import mã chỉ-máy-chủ) để client component dùng được nhãn và kiểu. Loader dùng nó
 * nằm ở `lib/saas/visibility-loaders.ts`.
 *
 * Hỏng về phía HẸP: không biết workspace (thiếu `organization`) ⇒ coi là khách.
 */
import type { AiBuilderView, AiDraftView } from "@/lib/ai-builder/types";
import { AI_DISABLED_BY_OPERATOR, type AiQuotaBlockReason } from "@/lib/ai-usage/types";
import type { ConnectionsView, ConnectorView } from "@/lib/connectors/types";
import type { AiFailureClass } from "@/lib/constants/ai-incidents";
import { AI_STOP_MESSAGE, AI_STOP_NOTE } from "@/lib/pricing/ai-entitlement";
import type { ChatView, SalesBotConnector, SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import type { HealthCheck, SalesHealth } from "@/lib/sales-chatbot/health-shared";
import type { LessonsState } from "@/lib/sales-chatbot/lessons-shared";
import type { PlaybookRun, PlaybookState } from "@/lib/sales-chatbot/playbook-shared";
import type { ReadinessCheck } from "@/lib/sales-chatbot/readiness-shared";
import { traceCodeLabel, type AiBlock, type AiBlockCode, type MessageTrace } from "@/lib/sales-chatbot/ai-status-shared";
import type { InboxThread } from "@/lib/sales-chatbot/inbox-shared";

export type VisibilityOrg = { isHome?: boolean } | null | undefined;

/** `true` ⇒ màn hình / DTO dành cho KHÁCH: không trường nội bộ nào được rời máy chủ. */
export function customerFacing(org: VisibilityOrg): boolean {
  return org?.isHome !== true;
}

// ───────────────────────── CẤU HÌNH BOT: phần «động cơ AI» là của người vận hành ─────────────────────────

/**
 * Các ô cấu hình bot thuộc về ĐỘNG CƠ AI — nguồn AI, model, dự phòng, mạch ngắt, mức suy nghĩ. Khách không thấy, không
 * ghi được: lượt lưu của khách GIỮ NGUYÊN giá trị đã lưu (`keepStoredEngineFields`), tuyệt đối không về mặc định (HSLC chạy
 * thật bằng cấu hình hiện có; sự cố #502 từng do đúng ô model). Người vận hành sửa ở `/platform/org/<mã>`.
 */
export const CHATBOT_ENGINE_FIELDS = ["connectorKey", "model", "fallbackConnectorKey", "fallbackModel", "failoverEnabled", "failoverOpenMinutes", "thinking"] as const satisfies readonly (keyof SalesChatbotConfig)[];
export type ChatbotEngineField = (typeof CHATBOT_ENGINE_FIELDS)[number];
export type ChatbotEngineConfig = Pick<SalesChatbotConfig, ChatbotEngineField>;
export type CustomerChatbotConfig = Omit<SalesChatbotConfig, ChatbotEngineField>;

export function chatbotEngineConfig(cfg: SalesChatbotConfig): ChatbotEngineConfig {
  return { connectorKey: cfg.connectorKey, model: cfg.model, fallbackConnectorKey: cfg.fallbackConnectorKey, fallbackModel: cfg.fallbackModel, failoverEnabled: cfg.failoverEnabled, failoverOpenMinutes: cfg.failoverOpenMinutes, thinking: cfg.thinking };
}

/** Cấu hình bot cho KHÁCH — bỏ hẳn các khoá động cơ AI (không phải để rỗng: khoá không tồn tại trong đối tượng). */
export function customerChatbotConfig(cfg: SalesChatbotConfig): CustomerChatbotConfig {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of CHATBOT_ENGINE_FIELDS) delete out[k];
  return out as CustomerChatbotConfig;
}

/**
 * Đầu vào lưu của KHÁCH ⇒ đầu vào đã thay các ô động cơ AI bằng ĐÚNG giá trị đang lưu. Khách gửi gì ở các ô đó (kể cả
 * không gửi) đều bị bỏ. Đầu vào không phải đối tượng ⇒ trả nguyên để lược đồ báo lỗi như cũ.
 */
export function keepStoredEngineFields(stored: SalesChatbotConfig, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of CHATBOT_ENGINE_FIELDS) delete out[k];
  return { ...out, ...chatbotEngineConfig(stored) };
}

/** Một nguồn AI chọn được cho bot — `vendor` = nhà cung cấp thật sau khoá (để cảnh báo dự phòng CÙNG nhà). */
export type EngineConnectionView = { key: SalesBotConnector; ready: boolean; configured: boolean; reason: string | null; vendor: string | null };
/** Sức khoẻ MỘT khoá AI (lib/sales-chatbot/provider-failover.ts) — hình dạng thuần để truyền từ trang máy chủ. */
export type ProviderHealthView = { key: string; lastSuccessAt: string | null; lastFailureAt: string | null; lastErrorClass: AiFailureClass | null; openUntil: string | null };

// ───────────────────────── TRẠNG THÁI AI CHO KHÁCH: bốn câu, không câu kỹ thuật ─────────────────────────

export type CustomerAiState = "ACTIVE" | "NEEDS_SETUP" | "PAUSED" | "OUT_OF_QUOTA";

export const CUSTOMER_AI_STATE_LABEL: Record<CustomerAiState, string> = {
  ACTIVE: "AI đang hoạt động",
  NEEDS_SETUP: "Cần cấu hình",
  PAUSED: "Tạm dừng",
  OUT_OF_QUOTA: "Hết lượt",
};

export const CUSTOMER_AI_STATE_HINT: Record<CustomerAiState, string> = {
  ACTIVE: "Bot đang trả lời khách của shop.",
  NEEDS_SETUP: "Bộ phận hỗ trợ đang hoàn tất cấu hình AI cho shop — liên hệ hỗ trợ nếu cần gấp.",
  PAUSED: "Bot đang tắt — bấm «Lưu và bật bot» khi muốn bot trả lời khách.",
  OUT_OF_QUOTA: "Shop đã dùng hết lượt khách AI xử lý của gói — xem Hệ thống → Gói & thanh toán để mua thêm hoặc nâng gói.",
};

/** Câu DUY NHẤT khách thấy khi AI hỏng (hết tiền · khoá bị từ chối · quá tải · lỗi nhà cung cấp) — không câu lỗi gốc. */
export const CUSTOMER_AI_INCIDENT_LABEL = "AI đang gặp sự cố — đội ngũ đã được báo";

/** Câu «AI chưa sẵn sàng» cho khách — khách không tự cấu hình AI nữa, đội ngũ vận hành xử lý. */
export const CUSTOMER_AI_NOT_READY_LABEL = "AI chưa sẵn sàng — đội ngũ đang xử lý";

/**
 * Khách gọi đường GHI khoá AI (Lưu / Kiểm tra / Bật / Tắt — màn Kết nối hay server action gọi thẳng) ⇒ máy chủ từ chối bằng câu
 * này (`lib/connectors/service.ts::guard`). Khoá đang có KHÔNG bị đụng; người vận hành sửa ở `/platform/org/<mã>`.
 */
export const CUSTOMER_AI_CONFIG_MANAGED = "Cấu hình AI của shop do đội ngũ hỗ trợ quản lý — liên hệ hỗ trợ nếu cần thay đổi.";

/** «AI dựng cấu hình» không ra gói — câu cho KHÁCH thay mọi lỗi của lượt gọi AI (hết trần, công cụ, lỗi thư viện gọi AI…). */
export const CUSTOMER_AI_DRAFT_FAILED = "AI chưa soạn được gói cấu hình — thử lại, hoặc viết mô tả ngắn gọn, rõ hơn.";

/** Đọc lịch sử tin nhắn qua Pancake hỏng (từ chối · bận · mạng) — câu cho KHÁCH, KHÔNG kèm chữ do Pancake trả về. */
export const CUSTOMER_PANCAKE_READ_FAILED = "Không đọc được tin nhắn từ Pancake — thử lại sau, hoặc kiểm tra kết nối «Fanpage qua Pancake» ở Cài đặt → Kết nối.";

/**
 * Hạn mức AI chặn một lượt — với KHÁCH đó là «hết lượt của gói» (khách tự xử ở trang gói) hay «chưa sẵn sàng» (việc của hỗ trợ:
 * đọc gói hỏng · gói không có AI dùng chung). MỘT luật cho trạng thái bốn câu (`visibility-loaders.ts`) lẫn câu lỗi lượt AI.
 */
export function customerQuotaExhausted(reason: AiQuotaBlockReason): boolean {
  return reason !== "PLAN_UNREADABLE" && reason !== "NO_PLATFORM_CREDIT";
}

/** Câu cho KHÁCH khi hạn mức AI chặn — thay `quota.error` (mang USD / số lượt nội bộ / đường dẫn cấu hình khoá AI). */
export function customerQuotaError(reason: AiQuotaBlockReason): string {
  return customerQuotaExhausted(reason) ? CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA : CUSTOMER_AI_NOT_READY_LABEL;
}

/**
 * Thông báo «vượt ngưỡng cảnh báo» của nguồn AI DÙNG CHUNG (tiền của NỀN TẢNG) tới quản trị shop khách (`lib/ai-usage/quota.ts`):
 * ngôn ngữ kinh doanh — KHÔNG số USD, KHÔNG tên nguồn nội bộ; số tiền chỉ ở phía người vận hành (sổ AI · `/platform`). Khoá riêng
 * của shop (BYOK — tiền của chính shop) giữ câu có số tiền như cũ.
 */
export const CUSTOMER_AI_SOFT_LIMIT_NOTICE = {
  title: "AI sắp chạm hạn mức tháng của gói",
  body: "AI của shop đã dùng phần lớn hạn mức tháng này của gói — xem Hệ thống → Gói & thanh toán, hoặc liên hệ hỗ trợ nếu cần thêm.",
} as const;

/** Câu của CHÍNH tệp này + câu cổng gói (`AI_STOP_MESSAGE`, viết sẵn cho chủ shop) — tới khách nguyên văn. */
const CUSTOMER_OWN_MESSAGES: ReadonlySet<string> = new Set([
  CUSTOMER_AI_INCIDENT_LABEL,
  CUSTOMER_AI_NOT_READY_LABEL,
  CUSTOMER_AI_CONFIG_MANAGED,
  CUSTOMER_AI_DRAFT_FAILED,
  CUSTOMER_PANCAKE_READ_FAILED,
  ...Object.values(CUSTOMER_AI_STATE_HINT),
  ...Object.values(AI_STOP_MESSAGE),
  ...Object.values(AI_STOP_NOTE),
]);

/**
 * Câu lỗi NỘI BỘ đã biết nghĩa ⇒ câu khách tương ứng (KHÔNG giữ chữ gốc). Đứng TRƯỚC danh sách cấm vì câu hạn mức mang USD.
 * Bài kiểm (tests/saas-hide-internal.test.ts) chạy đúng hàm thật sinh ra từng câu — đổi chữ ở nguồn mà quên ở đây thì đỏ.
 */
const CUSTOMER_ERROR_REWRITES: readonly (readonly [RegExp, string])[] = [
  // Hạn mức AI (lib/ai-usage/types.ts::evaluateAiQuota) — cùng nghĩa với `customerQuotaError`.
  [/^Đã dùng hết (?:[\d.,]+ lượt AI|credit AI)|^Chi phí AI tháng này đã tới trần/, CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA],
  [/^Gói của tổ chức không có credit AI|^Không đọc được gói dịch vụ của tổ chức|^AI của tổ chức nhà chỉ dành cho tổ chức nhà/, CUSTOMER_AI_NOT_READY_LABEL],
  // Công tắc của người vận hành (lib/ai-usage/control.ts) — khách thấy «chưa sẵn sàng», không thấy công tắc.
  [new RegExp(`^(?:AI đang tắt: )?${AI_DISABLED_BY_OPERATOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), CUSTOMER_AI_NOT_READY_LABEL],
  // Nguồn AI chưa mở được (lib/sales-chatbot/engine.ts · lib/ai-builder/provider.ts) — tên khoá, đường dẫn cấu hình khoá AI.
  [/^(?:Chưa dùng được khoá AI|Kết nối AI thiếu khoá|Nền tảng chưa bật AI dùng chung|Gói hiện tại chưa có AI dùng chung|Tổ chức nhà chưa cấu hình AI|Tổ chức chưa có kết nối AI|Không có AI \(kiểm thử\)|AI Builder đang tắt \(kiểm thử\))/, CUSTOMER_AI_NOT_READY_LABEL],
  // Pancake (lib/sales-chatbot/playbook.ts) — lỗi KÊNH của shop, không phải AI; bỏ phần chữ do Pancake trả về.
  [/^(?:Pancake (?:từ chối|bận)|Không gọi được Pancake)/, CUSTOMER_PANCAKE_READ_FAILED],
];

/** Chữ nội bộ — câu nào mang chúng (kể cả câu khớp danh sách cho phép) đều thành câu chung. */
const CUSTOMER_FORBIDDEN_ERROR = /\$|\bUSD\b|\btokens?\b|\bmodels?\b|\bproviders?\b|api[ _-]?key|gemini|openai|anthropic|claude|PLATFORM_[A-Z]/i;

/**
 * Câu lỗi được phép tới KHÁCH NGUYÊN VĂN — DANH SÁCH CHO PHÉP (review #639), so khớp ĐẦU câu. Câu không khớp mục nào (lỗi nhà
 * cung cấp, `e.message` thô, câu mới chưa ai duyệt…) ⇒ câu chung của nơi gọi. Thêm câu = thêm vào đây SAU KHI đọc chắc nó không
 * mang chữ nội bộ; KHÔNG thêm câu có phần chữ do hệ thống ngoài điền.
 */
const CUSTOMER_SAFE_ERRORS: readonly (string | RegExp)[] = [
  // Quyền · phiên · module (mọi lõi)
  "Bạn không có quyền",
  "Phiên đăng nhập thuộc tổ chức khác",
  "Phiên chưa gắn tổ chức",
  "Module AI bán hàng chưa bật",
  // Lượt chat · khung thử · điểm phát lại · gợi ý Copilot (lib/sales-chatbot/engine.ts)
  "Tin nhắn trống",
  "Không có hội thoại này",
  "Shop chưa mở chat",
  "Đang trả lời câu trước",
  // Phát lại (lib/sales-chatbot/replay.ts)
  "Số điểm không hợp lệ",
  "Khoảng ngày không hợp lệ",
  "Đang có một lượt",
  "Treo quá lâu",
  "Không có hội thoại khách thật nào",
  "Không có lượt phát lại này",
  // Học từ hội thoại cũ · bot tự học · góp ý cho AI (lib/sales-chatbot/playbook.ts · lessons.ts · inbox-feedback.ts)
  "Số hội thoại không hợp lệ",
  "Bật kết nối «Fanpage qua Pancake»",
  "Kết nối «Fanpage qua Pancake» chưa bật",
  /^Chỉ có \d+ hội thoại có cả khách lẫn shop trả lời/,
  "Sổ tay AI soạn ra rỗng",
  "Tự học đang tắt",
  "Đang có lượt học chạy",
  "AI không trả về danh sách bài học",
  "AI không trả về bài học",
  "AI trả về danh sách rỗng",
  "AI chỉ rút ra bài nhắc tới tiền",
  // Ghi đơn từ hội thoại (lib/sales-chatbot/order-sync.ts)
  "AI trả lời sai định dạng",
  // AI dựng cấu hình (lib/ai-builder/service.ts · draft.ts) + hạn mức gói (lib/entitlements/kinds.ts)
  "Chế độ phải là dựng mới hoặc sửa lặp",
  "Mô tả quá ngắn",
  "Mô tả dài quá",
  "Tổ chức đã dùng hết",
  "Đã tới hạn mức của gói «",
  "Không có bản nháp này",
  "Bản nháp đã",
  "Bản nháp không có gói",
  "Bản nháp vừa đổi trạng thái",
  "Chỉ bỏ được bản nháp",
  "Gói còn ",
  "AI từ chối yêu cầu",
];

/**
 * Câu lỗi của một lượt AI cho KHÁCH. Thứ tự: câu của khách (nguyên văn) → câu nội bộ đã biết nghĩa (đổi sang câu khách) → chữ
 * nội bộ (USD / token / model / tên nhà cung cấp…) ⇒ `fallback` → danh sách cho phép ⇒ nguyên văn → mọi câu lạ ⇒ `fallback`.
 * Hỏng về phía HẸP: một câu nghiệp vụ chưa vào danh sách chỉ thành câu chung, không bao giờ một câu nội bộ lọt ra.
 */
export function customerSafeAiError(message: string, fallback: string = CUSTOMER_AI_INCIDENT_LABEL): string {
  if (CUSTOMER_OWN_MESSAGES.has(message)) return message;
  for (const [re, to] of CUSTOMER_ERROR_REWRITES) if (re.test(message)) return to;
  if (CUSTOMER_FORBIDDEN_ERROR.test(message)) return fallback;
  return CUSTOMER_SAFE_ERRORS.some((p) => (typeof p === "string" ? message.startsWith(p) : p.test(message))) ? message : fallback;
}

/** Thứ tự: hết lượt (khách tự xử được ở trang gói) → chưa sẵn sàng (việc của hỗ trợ) → khách tự tắt → đang chạy. */
export function customerAiState(input: { enabled: boolean; aiReady: boolean; quotaExhausted: boolean }): CustomerAiState {
  if (input.quotaExhausted) return "OUT_OF_QUOTA";
  if (!input.aiReady) return "NEEDS_SETUP";
  if (!input.enabled) return "PAUSED";
  return "ACTIVE";
}

/** Bảng kiểm «sẵn sàng tự trả lời» cho khách: dòng AI nói bằng trạng thái khách, không nhắc khoá / kết nối AI. */
export function customerReadinessChecks(checks: readonly ReadinessCheck[], state: CustomerAiState): ReadinessCheck[] {
  const ready = state === "ACTIVE" || state === "PAUSED";
  return checks.map((c) =>
    c.key !== "AI_READY"
      ? c
      : ready
        ? { key: c.key, label: "AI sẵn sàng", status: "PASS", detail: "AI của shop dùng được.", href: null }
        : { key: c.key, label: CUSTOMER_AI_STATE_LABEL[state], status: "FAIL", detail: CUSTOMER_AI_STATE_HINT[state], href: state === "OUT_OF_QUOTA" ? "/settings/plan" : null },
  );
}

// ───────────────────────── KHUNG THỬ: không tên / tóm tắt công cụ ─────────────────────────

export function customerChatView(view: ChatView): ChatView {
  return { ...view, messages: view.messages.map((m) => ({ role: m.role, text: m.text })) };
}

// ───────────────────────── COCKPIT: không phần nhà cung cấp AI ─────────────────────────

/** Kiểm KHÁCH không thấy: lưới job nội bộ, hàng dead-letter (thuật ngữ vận hành), và hai kiểm nhắc nhà cung cấp AI. */
const CUSTOMER_HIDDEN_CHECKS: ReadonlySet<HealthCheck["key"]> = new Set(["SAFETY_NET", "DEAD_LETTER", "PROVIDER", "ORDER_SYNC"]);

/** Lượt «Học từ hội thoại cũ» cho KHÁCH: không tiền AI (USD) của lượt chạy, câu lỗi nhà cung cấp thành câu chung. */
export function customerPlaybookRun(run: PlaybookRun): PlaybookRun {
  if (run.state === "DONE") return { ...run, stats: { ...run.stats, costUsd: null } };
  if (run.state === "FAILED") return { ...run, error: customerSafeAiError(run.error) };
  return run;
}

/** AI có đang gặp sự cố không — gộp PROVIDER + ORDER_SYNC (cả hai là lỗi gọi AI) thành MỘT câu trả lời có / không. */
export function aiIncident(checks: readonly HealthCheck[]): boolean {
  return checks.some((c) => (c.key === "PROVIDER" || c.key === "ORDER_SYNC") && (c.level === "CRITICAL" || c.level === "WARNING"));
}

const RANK: Record<HealthCheck["level"], number> = { OK: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };

/**
 * Sức khoẻ AI bán hàng cho KHÁCH: cùng TRẠNG THÁI tổng (không làm đẹp số), nhưng phần nhà cung cấp chỉ còn MỘT dòng «AI
 * đang hoạt động / AI đang gặp sự cố — đội ngũ đã được báo» — không số lượt OK / lỗi, không lớp lỗi, không câu lỗi gốc.
 */
export function customerSalesHealth(health: SalesHealth): SalesHealth {
  const provider = health.checks.find((c) => c.key === "PROVIDER");
  const incident = aiIncident(health.checks);
  const aiRow: HealthCheck = {
    key: "PROVIDER",
    level: incident ? (health.checks.some((c) => (c.key === "PROVIDER" || c.key === "ORDER_SYNC") && c.level === "CRITICAL") ? "CRITICAL" : "WARNING") : provider?.level === "UNKNOWN" ? "UNKNOWN" : "OK",
    title: "AI",
    detail: incident ? CUSTOMER_AI_INCIDENT_LABEL : provider?.level === "UNKNOWN" ? "Chưa có lượt AI nào gần đây." : CUSTOMER_AI_STATE_LABEL.ACTIVE,
  };
  const checks: HealthCheck[] = [
    ...health.checks
      .filter((c) => !CUSTOMER_HIDDEN_CHECKS.has(c.key))
      .map((c) => ({ key: c.key, level: c.level, title: c.key === "WEBHOOK" ? "Tin khách tới" : c.title, detail: c.detail, ...(c.fix ? { fix: c.fix.replace(/;?\s*nếu provider[^.]*\.?/i, "").replace(/Tin AI hỏng[^.]*\./i, "").trim() || undefined } : {}) })),
    ...(provider || incident ? [aiRow] : []),
  ].map((c) => (c.fix === undefined ? { key: c.key, level: c.level, title: c.title, detail: c.detail } : c));
  const top = [...checks].sort((a, b) => RANK[b.level] - RANK[a.level])[0];
  const headline = health.status === "GREEN" || health.status === "OFF" || health.status === "UNKNOWN" || !top ? health.headline : `${top.title}: ${top.detail}`;
  return { status: health.status, checks, headline };
}

// ───────────────────────── KẾT NỐI: không connector nội bộ, không ô AI ─────────────────────────

/**
 * Danh mục kết nối cho KHÁCH: bỏ connector chỉ-nhà (dùng thông tin của nhà ở biến môi trường), MỌI connector AI (cấu hình AI
 * của workspace khách thuộc người vận hành — đường ghi cũng bị chặn ở `lib/connectors/service.ts::guard`) và connector của
 * module CHƯA MUA / đang tắt mà shop chưa khai gì (đã khai thì vẫn hiện kèm câu «module đang tắt» — không giấu một kết nối đang
 * có). Dòng còn lại bỏ phần mô tả nội bộ — vì sao khai thế nào, luồng mã nào đọc, đường nhận tin, cách phân giải tổ chức, kho lưu
 * — và mã khoá mã hoá của máy chủ. Còn lại: nhãn, nhà cung cấp, trạng thái, ô cấu hình — đủ để khách tự nối kết nối của mình.
 */
export function customerConnectionsView(view: ConnectionsView): ConnectionsView {
  return {
    organization: view.organization,
    secretsReady: { ok: view.secretsReady.ok, reason: view.secretsReady.ok ? null : "Máy chủ chưa sẵn sàng lưu thông tin kết nối — liên hệ bộ phận hỗ trợ.", keyIdShort: null },
    groups: view.groups
      .map((g) => ({ kind: g.kind, label: g.label, rows: g.rows.filter((r) => r.tenancy !== "HOME_ONLY" && r.kind !== "AI" && (r.moduleEnabled || r.connection !== null)).map(customerConnectorRow) }))
      .filter((g) => g.rows.length > 0),
  };
}

function customerConnectorRow(r: ConnectorView): ConnectorView {
  // Dòng cấu hình ở màn hình khác: chỉ giữ ĐƯỜNG DẪN tới màn hình đó, không câu mô tả kho lưu.
  const href = r.configWhere?.match(/\/(landing|bank|alerts|integrations)\b/)?.[0];
  return {
    key: r.key,
    label: r.label,
    vendor: r.vendor,
    kind: r.kind,
    auth: r.auth,
    capabilities: r.capabilities,
    moduleKey: r.moduleKey,
    moduleLabel: r.moduleLabel,
    moduleEnabled: r.moduleEnabled,
    hasHealthCheck: r.hasHealthCheck,
    mode: r.mode,
    homeReadiness: null,
    fields: r.fields,
    connection: r.connection,
    ...(r.mode === "ELSEWHERE" ? { configWhere: href ? `Cấu hình tại ${href}` : "Cấu hình ở màn hình nghiệp vụ tương ứng." } : {}),
  };
}

// ───────────────────────── HỘP THƯ: lý do AI không trả lời + dấu vết từng tin (#633) ─────────────────────────

/**
 * Lý do AI KHÔNG trả lời — bản cho KHÁCH. Lý do khách tự sửa được nói bằng lời thường kèm đúng chỗ sửa; lý do thuộc nguồn AI
 * (công tắc người vận hành · không nguồn AI · lỗi nhà cung cấp) gộp về MỘT mã `NO_AI_SOURCE` với câu chung, không lối sửa —
 * không câu lỗi gốc, không tên khoá / nhà cung cấp / model. `null` = không bao giờ tới khách (cổng page của workspace nhà).
 */
const CUSTOMER_AI_BLOCK: Record<AiBlockCode, { code: AiBlockCode; reason: string; fix: { href: string; label: string } | null }> = {
  PAGE_OFF: { code: "PAGE_OFF", reason: "Page chưa bật cho bot", fix: { href: "/ai/sales-chatbot#page-runtime", label: "Bật page cho bot" } },
  PAGE_SHADOW: { code: "PAGE_SHADOW", reason: "Page đang chạy thử — bot chỉ soạn, không gửi khách", fix: { href: "/ai/sales-chatbot#page-runtime", label: "Đổi chế độ page" } },
  ORG_OBSERVE: { code: "ORG_OBSERVE", reason: "Shop đang ở chế độ Quan sát — nhân viên trả lời khách", fix: { href: "/ai/sales-chatbot#operating-mode", label: "Chế độ vận hành" } },
  PAGE_AI_OFF: { code: "PAGE_AI_OFF", reason: "AI đang tắt cho page này", fix: { href: "/ai/sales-chatbot/messenger", label: "Bật AI cho page" } },
  ORG_COPILOT: { code: "ORG_COPILOT", reason: "Shop đang ở chế độ Gợi ý — AI chỉ soạn, nhân viên gửi", fix: { href: "/ai/sales-chatbot#operating-mode", label: "Chế độ vận hành" } },
  MODULE_OFF: { code: "MODULE_OFF", reason: "Module AI bán hàng chưa bật", fix: { href: "/settings/modules", label: "Bật module AI bán hàng" } },
  BOT_DISABLED: { code: "BOT_DISABLED", reason: "Bot đang tắt", fix: { href: "/ai/sales-chatbot#bot-config", label: "Bật bot" } },
  QUOTA: { code: "QUOTA", reason: "Shop đã dùng hết lượt khách AI xử lý của gói", fix: { href: "/settings/plan", label: "Xem gói & mua thêm" } },
  // Cổng gói (L5): dùng thử hết lượt / hết hạn ⇒ AI dừng tự trả lời, hộp thư + gửi tay vẫn chạy; tạm ngưng = người vận hành tạm dừng.
  TRIAL_QUOTA_EXHAUSTED: { code: "TRIAL_QUOTA_EXHAUSTED", reason: "Bạn đã sử dụng hết lượt AI của gói hiện tại.", fix: { href: "/settings/plan", label: "Chọn gói" } },
  TRIAL_EXPIRED: { code: "TRIAL_EXPIRED", reason: "Đã hết thời gian dùng thử — chọn gói để AI tiếp tục trả lời khách.", fix: { href: "/settings/plan", label: "Chọn gói" } },
  WORKSPACE_SUSPENDED: { code: "WORKSPACE_SUSPENDED", reason: "Tài khoản shop đang tạm ngưng — liên hệ đội hỗ trợ.", fix: null },
  BALANCE_EXHAUSTED: { code: "BALANCE_EXHAUSTED", reason: "Số dư AI đã hết — AI tạm không nhận khách mới. Khách đã được AI chăm trong tháng vẫn được trả lời.", fix: { href: "/settings/ai-balance", label: "Nạp tiền" } },
  KILL_SWITCH: { code: "NO_AI_SOURCE", reason: CUSTOMER_AI_NOT_READY_LABEL, fix: null },
  NO_AI_SOURCE: { code: "NO_AI_SOURCE", reason: CUSTOMER_AI_NOT_READY_LABEL, fix: null },
  AI_PROVIDER_ERROR: { code: "NO_AI_SOURCE", reason: CUSTOMER_AI_INCIDENT_LABEL, fix: null },
};

export function customerAiBlocks(blocks: readonly AiBlock[]): AiBlock[] {
  const out: AiBlock[] = [];
  for (const b of blocks) {
    const c = CUSTOMER_AI_BLOCK[b.code];
    if (out.some((x) => x.code === c.code)) continue;
    out.push({ code: c.code, reason: c.reason, fixHref: c.fix?.href ?? null, fixLabel: c.fix?.label ?? null });
  }
  return out;
}

/** Mã dấu vết thuộc nguồn AI / nhà cung cấp ⇒ nhãn thường cho khách. Mã khác dùng nhãn tiếng Việt sẵn có; mã lạ ⇒ «Chưa xác định». */
const CUSTOMER_TRACE_LABEL: Record<string, string> = {
  AI_PROVIDER_AUTH_ERROR: "AI gặp sự cố",
  AI_PROVIDER_QUOTA: "AI gặp sự cố",
  AI_MODEL_ERROR: "AI gặp sự cố",
  AI_CONTEXT_ERROR: "AI gặp sự cố",
  AI_SKIPPED_AI_DOWN_COOLDOWN: "AI gặp sự cố — chờ thử lại",
  AI_PROVIDER_NOT_CONFIGURED: "Chờ cấu hình AI",
  AI_SKIPPED_KILL_SWITCH: "AI tạm dừng — đội ngũ đang xử lý",
};

/**
 * Dấu vết một tin khách cho KHÁCH: `code` thành NHÃN THƯỜNG (không mã kỹ thuật), bỏ `detail` (ghi chú / lỗi gốc đã lưu) và
 * nguồn dữ liệu của từng bước (tên bảng / cột). Các bước và mốc giữ nguyên — đó là việc của shop.
 */
export function customerMessageTrace(t: MessageTrace): MessageTrace {
  const code = t.code === null ? null : (CUSTOMER_TRACE_LABEL[t.code] ?? (/^[A-Z][A-Z0-9_]*$/.test(t.code) && traceCodeLabel(t.code) !== t.code ? traceCodeLabel(t.code) : "Chưa xác định"));
  return { steps: t.steps.map((s) => ({ stage: s.stage, state: s.state, at: s.at, source: "" })), code, detail: null, outcome: t.outcome };
}

/**
 * Hội thoại hộp thư cho KHÁCH — lọc ở máy chủ trước khi vào props của client component. Góp ý «Gửi cho AI học» chưa học được
 * mang câu lỗi đã lưu (có thể là lỗi nguồn AI / hạn mức USD / lỗi gốc) ⇒ qua danh sách cho phép.
 */
export function customerInboxThread(thread: InboxThread): InboxThread {
  return {
    ...thread,
    customerView: true,
    aiBlocks: customerAiBlocks(thread.aiBlocks),
    items: thread.items.map((it) => (it.trace ? { ...it, trace: customerMessageTrace(it.trace) } : it)),
    feedback: thread.feedback.map((f) => (f.error === null ? f : { ...f, error: customerSafeAiError(f.error) })),
  };
}

// ───────────────────────── PHÁT LẠI · TỰ HỌC · SỔ TAY · GỢI Ý · GHI ĐƠN TỪ HỘI THOẠI (review #639) ─────────────────────────

type ReplayPointLike = { error: string | null; tools: readonly { name: string; ok: boolean; summary: string }[] };

/** Một lượt phát lại cho KHÁCH: câu lỗi lượt / điểm qua danh sách cho phép, KHÔNG tên / tóm tắt công cụ bot đã gọi. */
export function customerReplayDetail<R extends { error: string | null }, P extends ReplayPointLike>(d: { ok: true; run: R; points: P[] }): { ok: true; run: R; points: P[] } {
  return {
    ok: true,
    run: { ...d.run, error: d.run.error === null ? null : customerSafeAiError(d.run.error) },
    points: d.points.map((p) => ({ ...p, error: p.error === null ? null : customerSafeAiError(p.error), tools: [] })),
  };
}

/** «Bot tự học» cho KHÁCH: ghi chú của lượt LỖI (lỗi gốc · hạn mức USD · tên khoá) qua bộ lọc; lượt đạt / bỏ qua là câu nghiệp vụ. */
export function customerLessons(state: LessonsState): LessonsState {
  return state.lastRun?.status === "ERROR" ? { ...state, lastRun: { ...state.lastRun, note: customerSafeAiError(state.lastRun.note) } } : state;
}

/** Sổ tay cho KHÁCH: bản nháp không mang tiền AI (USD) của lượt học đã sinh ra nó. */
export function customerPlaybookState(state: PlaybookState): PlaybookState {
  return state.draft?.stats ? { ...state, draft: { ...state.draft, stats: { ...state.draft.stats, costUsd: null } } } : state;
}

/** «Rà lỗi AI» cho KHÁCH: dấu hiệu «công cụ lỗi» mang TÊN công cụ bot gọi + câu trả về thô của nó ⇒ MỘT câu thường. */
export const CUSTOMER_TOOL_ERROR_EVIDENCE = "Một bước tra cứu của bot báo lỗi trong lượt này — mở hội thoại để xem bot đã trả lời khách thế nào.";

export function customerQualityItems<I extends { kind: string; evidence: string }>(items: I[]): I[] {
  return items.map((it) => (it.kind === "TOOL_ERROR" ? { ...it, evidence: CUSTOMER_TOOL_ERROR_EVIDENCE } : it));
}

/** Ghi đơn từ hội thoại cho KHÁCH: dòng LỖI (nhánh bắt lỗi — có thể là lỗi gốc của AI) qua bộ lọc; dòng nghiệp vụ giữ nguyên. */
export function customerOrderSyncView<V extends { recent: { outcome: string; result: string }[] }>(view: V): V {
  return { ...view, recent: view.recent.map((r) => (r.outcome === "ERROR" ? { ...r, result: customerSafeAiError(r.result) } : r)) };
}

// ───────────────────────── AI DỰNG CẤU HÌNH (/settings/ai-builder) ─────────────────────────

/** Khoá NỘI BỘ của một bản nháp — bản của KHÁCH KHÔNG CÓ các khoá này (không phải để rỗng / 0: chưa biết không in thành 0). */
const AI_DRAFT_INTERNAL_FIELDS = ["aiSource", "provider", "model", "inputTokens", "outputTokens", "costUsd", "quotaWarning"] as const;
export type CustomerAiDraftView = Omit<AiDraftView, (typeof AI_DRAFT_INTERNAL_FIELDS)[number]>;
export type CustomerAiBuilderView = Omit<AiBuilderView, "ai" | "drafts"> & { ai: { available: boolean; reason: string | null }; drafts: Omit<AiBuilderView["drafts"][number], "costUsd">[] };

/**
 * Bản nháp «AI dựng cấu hình» cho KHÁCH: bỏ hẳn nguồn AI / nhà cung cấp / model / token / USD / cảnh báo hạn mức (USD). Lỗi của
 * LƯỢT gọi AI (`error`, và dòng KHÔNG gắn đường dẫn trong `errors`) qua danh sách cho phép; lỗi của bộ kiểm gói (có đường dẫn)
 * giữ nguyên — đó là việc của người soạn, không phải chữ nội bộ.
 */
export function customerAiDraft(d: AiDraftView): CustomerAiDraftView {
  const out: Record<string, unknown> = {
    ...d,
    error: d.error === null ? null : customerSafeAiError(d.error, CUSTOMER_AI_DRAFT_FAILED),
    errors: d.errors.map((e) => (e.path ? e : { ...e, message: customerSafeAiError(e.message, CUSTOMER_AI_DRAFT_FAILED) })),
  };
  for (const k of AI_DRAFT_INTERNAL_FIELDS) delete out[k];
  return out as CustomerAiDraftView;
}

/**
 * Màn «AI dựng cấu hình» cho KHÁCH: nguồn AI chỉ còn dùng được hay chưa (câu khách); lịch sử nháp liệt kê TƯỜNG MINH từng ô
 * được gửi (không USD) — ô mới thêm vào dòng lịch sử không tự lọt tới khách.
 */
export function customerAiBuilderView(v: AiBuilderView): CustomerAiBuilderView {
  return {
    organization: v.organization,
    ai: { available: v.ai.available, reason: v.ai.available ? null : CUSTOMER_AI_NOT_READY_LABEL },
    usedToday: v.usedToday,
    limits: v.limits,
    drafts: v.drafts.map((d) => ({ id: d.id, mode: d.mode, prompt: d.prompt, status: d.status, name: d.name, valid: d.valid, aiCalls: d.aiCalls, createdAt: d.createdAt, createdByEmail: d.createdByEmail })),
  };
}
