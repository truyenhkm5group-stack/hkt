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
import type { ConnectionsView, ConnectorView } from "@/lib/connectors/types";
import type { AiFailureClass } from "@/lib/constants/ai-incidents";
import type { ChatView, SalesBotConnector, SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import type { HealthCheck, SalesHealth } from "@/lib/sales-chatbot/health-shared";
import type { PlaybookRun } from "@/lib/sales-chatbot/playbook-shared";
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

/** Câu lỗi của lượt AI cho KHÁCH: lỗi nhắc khoá / nhà cung cấp / model / hạn mức nội bộ ⇒ MỘT câu chung; lỗi nghiệp vụ giữ nguyên. */
const INTERNAL_AI_ERROR = /khoá AI|kết nối AI|model|provider|token|credit|gemini|openai|anthropic|claude|nhà cung cấp|nền tảng|tổ chức nhà|api/i;
export function customerSafeAiError(message: string): string {
  return INTERNAL_AI_ERROR.test(message) ? CUSTOMER_AI_INCIDENT_LABEL : message;
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
 * Danh mục kết nối cho KHÁCH: bỏ connector chỉ-nhà (dùng thông tin của nhà ở biến môi trường) và MỌI connector AI (cấu hình
 * AI của workspace khách thuộc người vận hành). Dòng còn lại bỏ phần mô tả nội bộ — vì sao khai thế nào, luồng mã nào đọc,
 * đường nhận tin, cách phân giải tổ chức, kho lưu — và mã khoá mã hoá của máy chủ. Còn lại: nhãn, nhà cung cấp, trạng thái,
 * ô cấu hình — đủ để khách tự nối kết nối của mình.
 */
export function customerConnectionsView(view: ConnectionsView): ConnectionsView {
  return {
    organization: view.organization,
    secretsReady: { ok: view.secretsReady.ok, reason: view.secretsReady.ok ? null : "Máy chủ chưa sẵn sàng lưu thông tin kết nối — liên hệ bộ phận hỗ trợ.", keyIdShort: null },
    groups: view.groups
      .map((g) => ({ kind: g.kind, label: g.label, rows: g.rows.filter((r) => r.tenancy !== "HOME_ONLY" && r.kind !== "AI").map(customerConnectorRow) }))
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

/** Câu «AI chưa sẵn sàng» cho khách — khách không tự cấu hình AI nữa, đội ngũ vận hành xử lý. */
export const CUSTOMER_AI_NOT_READY_LABEL = "AI chưa sẵn sàng — đội ngũ đang xử lý";

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

/** Hội thoại hộp thư cho KHÁCH — lọc ở máy chủ trước khi vào props của client component. */
export function customerInboxThread(thread: InboxThread): InboxThread {
  return {
    ...thread,
    customerView: true,
    aiBlocks: customerAiBlocks(thread.aiBlocks),
    items: thread.items.map((it) => (it.trace ? { ...it, trace: customerMessageTrace(it.trace) } : it)),
  };
}
