/**
 * ═══════════ CHE DỮ LIỆU AI NỘI BỘ KHỎI KHÁCH (chủ shop 07/10/2026 · lib/saas/visibility.ts) ═══════════
 *
 * Khách (workspace KHÔNG phải nhà) không thấy model / nhà cung cấp AI, token, chi phí AI, khoá AI, sức khoẻ khoá, mô tả nội
 * bộ của sổ connector — và KHÔNG CHỈ ẨN GIAO DIỆN: máy chủ không trả các trường đó. Bài kiểm:
 *  (a) chạy loader / đường đọc THẬT với tổ chức khách (PGlite, mã `hi-shop`) ⇒ đối tượng trả về không có khoá nội bộ nào
 *      (duyệt đệ quy); tổ chức nhà ⇒ có;
 *  (b) khách lưu cấu hình bot ⇒ nguồn AI / model / dự phòng / mức suy nghĩ GIỮ NGUYÊN giá trị đang lưu (kể cả khi khách gửi
 *      giá trị khác, kể cả khi khách không gửi các ô đó);
 *  (c) quét mã nguồn: tệp trang khách không in chữ «token / USD / Gemini / OpenAI / Anthropic / model / provider / prompt»
 *      ngoài nhánh nhà — miễn trừ là danh sách ĐÓNG có lý do, miễn trừ mồ côi cũng đỏ;
 *  (d) cockpit: phần chẩn đoán đòi `ai_sales:manage`, phần nhà cung cấp không bao giờ tới khách;
 *  (e) người vận hành sửa được cấu hình AI của workspace khách (khối «AI của workspace»), khách thì không — kể cả gọi thẳng
 *      lõi Lưu / Kiểm tra / Bật / Tắt của sổ kết nối: từ chối bằng câu kinh doanh, khoá đang chạy đứng nguyên;
 *  (f) review #639: câu lỗi tới khách theo DANH SÁCH CHO PHÉP (câu hạn mức THẬT có USD ⇒ câu của trang gói), phát lại · tự
 *      học · sổ tay · góp ý cho AI · Copilot · rà lỗi AI · AI dựng cấu hình · vào việc ngay không lộ model / USD / token / tên công cụ;
 *  (g) thông báo «vượt ngưỡng cảnh báo» của AI DÙNG CHUNG tới shop khách: câu kinh doanh, không số USD (khoá riêng giữ nguyên).
 * Không ghim ngày (luật 50 · 65); khoá bí mật là khoá KIỂM THỬ, trả lại nguyên trạng trong finally.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { FakeProvider } from "@/lib/ai/provider";
import { createDraft, loadAiBuilderView } from "@/lib/ai-builder/service";
import { setBuilderAiForTests } from "@/lib/ai-builder/provider";
import { AI_BUILDER_LIMITS, type AiBuilderView, type AiDraftView } from "@/lib/ai-builder/types";
import { setOrgAiControl } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota, softWarningKey } from "@/lib/ai-usage/quota";
import { AI_DISABLED_BY_OPERATOR, evaluateAiQuota, type AiLimits, type AiSourceUsage } from "@/lib/ai-usage/types";
import type { SessionUser } from "@/lib/auth/session";
import { findConnector } from "@/lib/connectors/registry";
import { aiConnectionsForOperator, loadConnectionsView, openActiveConnection, OPERATOR_AI_CONNECTORS, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { ConnectionsView, ConnectorView } from "@/lib/connectors/types";
import { overLimitMessage } from "@/lib/entitlements/kinds";
import { loadGoLive, quickConnectFanpage } from "@/lib/onboarding/go-live";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { AI_STOP_MESSAGE } from "@/lib/pricing/ai-entitlement";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY, type ChatView, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig, openConversation, TURN_BUSY_ERROR, TURN_EMPTY_ERROR, TURN_MODULE_OFF_ERROR, TURN_NO_CONVERSATION_ERROR } from "@/lib/sales-chatbot/engine";
import type { SalesHealth } from "@/lib/sales-chatbot/health-shared";
import type { MessageTrace } from "@/lib/sales-chatbot/ai-status-shared";
import { loadInboxThread } from "@/lib/sales-chatbot/inbox";
import { submitConversationFeedbackCore } from "@/lib/sales-chatbot/inbox-feedback";
import type { InboxThread } from "@/lib/sales-chatbot/inbox-shared";
import { EMPTY_LESSONS } from "@/lib/sales-chatbot/lessons-shared";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { startPlaybookLearning } from "@/lib/sales-chatbot/playbook";
import { EMPTY_PLAYBOOK } from "@/lib/sales-chatbot/playbook-shared";
import { startReplay } from "@/lib/sales-chatbot/replay";
import { REPLAY_LIMITS } from "@/lib/sales-chatbot/replay-shared";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { loadOperatorOrgAiConfig, operateOrgAiConnection, saveOrgChatbotEngine } from "@/lib/saas/operator-ai";
import {
  CHATBOT_ENGINE_FIELDS,
  CUSTOMER_AI_CONFIG_MANAGED,
  CUSTOMER_AI_DRAFT_FAILED,
  CUSTOMER_AI_INCIDENT_LABEL,
  CUSTOMER_AI_NOT_READY_LABEL,
  CUSTOMER_AI_SOFT_LIMIT_NOTICE,
  CUSTOMER_AI_STATE_HINT,
  CUSTOMER_PANCAKE_READ_FAILED,
  CUSTOMER_TOOL_ERROR_EVIDENCE,
  customerAiBlocks,
  customerAiBuilderView,
  customerAiDraft,
  customerAiState,
  customerChatbotConfig,
  customerChatView,
  customerConnectionsView,
  customerFacing,
  customerInboxThread,
  customerLessons,
  customerMessageTrace,
  customerOrderSyncView,
  customerPlaybookRun,
  customerPlaybookState,
  customerQualityItems,
  customerQuotaError,
  customerReadinessChecks,
  customerReplayDetail,
  customerSafeAiError,
  customerSalesHealth,
  keepStoredEngineFields,
} from "@/lib/saas/visibility";
import { aiPerformanceWithMoney, loadChatbotAiView } from "@/lib/saas/visibility-loaders";
import { setSettingJson } from "@/lib/settings";

const ORG = "hi-shop";
const GEMINI_KEY = "AIzaKiemThuCheDuLieuNoiBo0123456789abcd";

/** Khoá NỘI BỘ không được xuất hiện ở BẤT KỲ độ sâu nào trong DTO của khách. */
const INTERNAL_KEY = /^(model|fallbackModel|provider|vendor|connectorKey|fallbackConnectorKey|failoverEnabled|failoverOpenMinutes|thinking|engine|health|costReport|cost|costUsd|costVnd|usd|rateVndPerUsd|inputTokens|outputTokens|tokens|apiKey|keyIdShort|lastErrorClass|openUntil)$/i;

/** Mọi đường dẫn khoá khớp `re` trong `v` (đệ quy qua đối tượng và mảng). Khoá mang giá trị `null` / `undefined` vẫn tính. */
export function internalKeyPaths(v: unknown, re: RegExp = INTERNAL_KEY, at = "$", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => internalKeyPaths(x, re, `${at}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (re.test(k)) out.push(`${at}.${k}`);
      internalKeyPaths(x, re, `${at}.${k}`, out);
    }
  }
  return out;
}

/** Mọi CHUỖI (giá trị, không phải khoá) ở bất kỳ độ sâu nào khớp `re` — câu lỗi gốc, tên nhà cung cấp, mã kỹ thuật. */
export function stringHits(v: unknown, re: RegExp, at = "$", out: string[] = []): string[] {
  if (typeof v === "string") {
    if (re.test(v)) out.push(`${at} = «${v.slice(0, 120)}»`);
  } else if (Array.isArray(v)) v.forEach((x, i) => stringHits(x, re, `${at}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) stringHits(x, re, `${at}.${k}`, out);
  return out;
}

/** Chữ khách không được đọc trong payload hộp thư: mã nhà cung cấp, tên nhà cung cấp / model, «token / provider / model», khoá AI.
 *  `429` đứng riêng (mã HTTP) — KHÔNG phải chuỗi con: một UUID ngẫu nhiên kiểu «faba2977-5d98-429e-…» từng làm bài đỏ chập chờn
 *  trên CI (08/10/2026, PR #707 chỉ đổi tài liệu). */
const INBOX_FORBIDDEN = /PROVIDER|AI_MODEL|AI_CONTEXT|KILL_SWITCH|NOT_CONFIGURED|\b(token|provider|model)\b|gemini|openai|anthropic|claude|khoá AI|nguồn AI|RESOURCE_EXHAUSTED|\b429\b/i;

export function testHideInternalInbox() {
  assert.ok(INBOX_FORBIDDEN.test("Pancake bận (HTTP 429)") && INBOX_FORBIDDEN.test("429 RESOURCE_EXHAUSTED"), "mã 429 đứng riêng vẫn bị bắt");
  assert.ok(!INBOX_FORBIDDEN.test("faba2977-5d98-429e-b031-0e509f4af9f8"), "UUID ngẫu nhiên chứa «429» không phải rò nội bộ");
  const blocks = customerAiBlocks([
    { code: "BOT_DISABLED", reason: "Bot bán hàng đang TẮT (Cấu hình → Bật bot)", fixHref: "/ai/sales-chatbot#bot-config", fixLabel: "Bật bot trong Cấu hình" },
    { code: "NO_AI_SOURCE", reason: "Không có nguồn AI chạy được: Kết nối «Google Gemini — khoá AI của tổ chức» chưa bật", fixHref: "/ai/sales-chatbot#bot-config", fixLabel: "Cấu hình nguồn AI" },
    { code: "AI_PROVIDER_ERROR", reason: "Lỗi model / nhà cung cấp AI: 429 RESOURCE_EXHAUSTED gemini-3.5-flash", fixHref: "/ai/sales-chatbot#bot-config", fixLabel: "Kiểm tra khoá AI" },
    { code: "QUOTA", reason: "Hết hạn mức AI: PLATFORM_CREDIT_USED", fixHref: "/ai/sales-chatbot#bot-config", fixLabel: "Khoá AI / gói dịch vụ" },
  ]);
  assert.deepEqual(stringHits(blocks, INBOX_FORBIDDEN), [], "lý do chặn cho khách: không mã / câu lỗi / tên nhà cung cấp");
  assert.deepEqual(blocks.map((b) => b.code), ["BOT_DISABLED", "NO_AI_SOURCE", "QUOTA"], "lỗi nguồn AI gộp MỘT dòng; lý do khác giữ nguyên thứ tự");
  assert.ok(blocks[0].fixHref === "/ai/sales-chatbot#bot-config" && blocks[2].fixHref === "/settings/plan", "lý do khách sửa được có nút tới đúng chỗ");
  assert.ok(blocks[1].reason === "AI chưa sẵn sàng — đội ngũ đang xử lý" && blocks[1].fixHref === null, "NO_AI_SOURCE với khách: đội ngũ xử lý, không nút cấu hình AI");
  const kill = customerAiBlocks([{ code: "AI_PROVIDER_ERROR", reason: "x", fixHref: null, fixLabel: null }]);
  assert.equal(kill[0].reason, CUSTOMER_AI_INCIDENT_LABEL);

  const trace = (code: string | null, detail: string | null): MessageTrace => ({ steps: [{ stage: "RECEIVED", state: "DONE", at: "2026-10-07T01:00:00.000Z", source: "sales_chat_inbound.created_at" }, { stage: "COMPOSING", state: "FAILED", at: null, source: "platform_ai_usage.status" }], code, detail, outcome: "STOPPED" });
  for (const [code, want] of [["AI_MODEL_ERROR", "AI gặp sự cố"], ["AI_PROVIDER_AUTH_ERROR", "AI gặp sự cố"], ["AI_PROVIDER_QUOTA", "AI gặp sự cố"], ["AI_CONTEXT_ERROR", "AI gặp sự cố"], ["AI_PROVIDER_NOT_CONFIGURED", "Chờ cấu hình AI"], ["AI_SKIPPED_DISABLED", "Bot đang tắt"], ["UNKNOWN: ghi chú lạ", "Chưa xác định"]] as const) {
    const t = customerMessageTrace(trace(code, "429 RESOURCE_EXHAUSTED: gemini-3.5-flash quota"));
    assert.equal(t.code, want, `${code} ⇒ «${want}»`);
    assert.ok(t.detail === null && t.steps.every((s) => s.source === ""), "không lỗi gốc, không tên bảng / cột");
    assert.deepEqual(stringHits(t, INBOX_FORBIDDEN), [], `${code}: dấu vết của khách sạch`);
  }
  assert.equal(customerMessageTrace(trace(null, null)).code, null, "đi trọn ⇒ không mã");

  // Cả hội thoại: duyệt đệ quy payload sau bộ lọc.
  const thread = {
    id: "c1",
    channel: "FANPAGE",
    channelLabel: "Facebook / Instagram",
    status: "OPEN",
    handoffReason: null,
    botYields: false,
    aiBlocks: [{ code: "AI_PROVIDER_ERROR" as const, reason: "Lỗi model / nhà cung cấp AI: invalid x-goog-api-key", fixHref: "/ai/sales-chatbot#bot-config", fixLabel: "Kiểm tra khoá AI" }],
    items: [
      { key: "i:1", at: "2026-10-07T01:00:00.000Z", side: "CUSTOMER" as const, text: "Còn hàng không shop", images: [], author: null, trace: trace("AI_PROVIDER_AUTH_ERROR", "401 API key not valid (gemini)") },
      { key: "i:2", at: "2026-10-07T01:01:00.000Z", side: "BOT" as const, text: "Dạ còn ạ", images: [], author: null },
    ],
    // Góp ý «Gửi cho AI học» chưa học được: dòng lưu câu lỗi GỐC (nguồn AI / hạn mức USD) — khách đọc câu đã lọc.
    feedback: [
      { id: "f1", userName: "NV", text: "Bot báo sai phí ship", lessons: [], status: "FAILED" as const, error: "Chưa dùng được khoá AI «gemini-byok»: Kết nối chưa bật", createdAt: "2026-10-07T01:02:00.000Z" },
      { id: "f2", userName: "NV", text: "Bot trả lời chậm", lessons: [], status: "FAILED" as const, error: "Chi phí AI tháng này đã tới trần 5.00 USD (5.12 USD) — AI tạm dừng tới tháng sau hoặc tới khi người vận hành nâng trần.", createdAt: "2026-10-07T01:03:00.000Z" },
      { id: "f3", userName: "NV", text: "Hỏi lại SĐT", lessons: ["Khi khách đã để SĐT ⇒ không hỏi lại"], status: "APPLIED" as const, error: null, createdAt: "2026-10-07T01:04:00.000Z" },
    ],
  } as unknown as InboxThread;
  const ct = customerInboxThread(thread);
  assert.deepEqual(stringHits(ct, INBOX_FORBIDDEN), [], "payload hộp thư của khách sạch");
  assert.deepEqual(stringHits(ct.feedback, /USD|\$/), [], "góp ý chưa học được: không USD");
  assert.deepEqual(
    ct.feedback.map((f) => f.error),
    [CUSTOMER_AI_NOT_READY_LABEL, CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, null],
    "lỗi nguồn AI ⇒ «chưa sẵn sàng», hạn mức ⇒ câu trang gói, góp ý đã học giữ nguyên",
  );
  assert.equal(ct.customerView, true, "màn hình biết không in mã máy");
  assert.ok(stringHits(thread, INBOX_FORBIDDEN).length > 0, "đối chứng: bản nhà còn mã / lỗi gốc");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, ORG));
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  invalidateOrganizations();
  invalidateCapabilities();
}

// ─────────────────────────── THUẦN ───────────────────────────

export function testHideInternalPure() {
  assert.equal(customerFacing({ isHome: true }), false, "nhà ⇒ không phải khách");
  assert.equal(customerFacing({ isHome: false }), true);
  assert.equal(customerFacing(undefined), true, "không biết workspace ⇒ coi là khách (hỏng về phía hẹp)");
  assert.equal(customerFacing(null), true);

  const stored: SalesChatbotConfig = { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "platform", fallbackModel: "mot-model", failoverEnabled: false, failoverOpenMinutes: 45, thinking: "FAST" };
  const cust = customerChatbotConfig(stored);
  assert.deepEqual(internalKeyPaths(cust), [], "cấu hình cho khách KHÔNG có khoá động cơ AI");
  for (const k of CHATBOT_ENGINE_FIELDS) assert.ok(!(k in cust), `${k} không tồn tại trong đối tượng (không phải để rỗng)`);
  const merged = keepStoredEngineFields(stored, { ...DEFAULT_SALES_CHATBOT_CONFIG, greeting: "Chào mới", connectorKey: "openai-byok", model: "gpt-x", thinking: "SMART" }) as SalesChatbotConfig;
  for (const k of CHATBOT_ENGINE_FIELDS) assert.deepEqual(merged[k], stored[k], `${k}: giữ giá trị đang lưu`);
  assert.equal(merged.greeting, "Chào mới", "ô của chủ shop vẫn lưu theo khách");
  const noEngine = keepStoredEngineFields(stored, cust) as SalesChatbotConfig;
  for (const k of CHATBOT_ENGINE_FIELDS) assert.deepEqual(noEngine[k], stored[k], `${k}: khách không gửi ô ⇒ vẫn giá trị đang lưu, KHÔNG về mặc định`);
  assert.equal(keepStoredEngineFields(stored, "x"), "x", "đầu vào không phải đối tượng ⇒ để lược đồ báo lỗi");

  // Khung thử: không tên / tóm tắt công cụ.
  const view: ChatView = { conversationId: "c1", status: "OPEN", messages: [{ role: "assistant", text: "Dạ", tools: [{ name: "search_products", ok: true, summary: "3 kết quả" }] }], order: null };
  const cv = customerChatView(view);
  assert.ok(!JSON.stringify(cv).includes("search_products") && !("tools" in cv.messages[0]), "khung thử của khách không mang tools");
  assert.ok(JSON.stringify(view).includes("search_products"), "đối chứng: bản gốc có tools (nhà vẫn thấy)");

  // Lượt «Học từ hội thoại cũ»: không tiền AI, không câu lỗi nhà cung cấp.
  const done = customerPlaybookRun({ state: "DONE", startedAt: "a", finishedAt: "b", stats: { conversations: 3, messages: 9, aiCalls: 4, costUsd: 0.123, pricesRemoved: 0 } });
  assert.ok(done.state === "DONE" && done.stats.costUsd === null && done.stats.aiCalls === 4, "khách: lượt học không mang USD");
  const failed = customerPlaybookRun({ state: "FAILED", startedAt: "a", finishedAt: "b", error: "Gemini 429 RESOURCE_EXHAUSTED" });
  assert.ok(failed.state === "FAILED" && failed.error === CUSTOMER_AI_INCIDENT_LABEL, "khách: lỗi lượt học là câu chung");

  // Câu lỗi lượt AI (chi tiết ở `testHideInternalErrors`).
  assert.equal(customerSafeAiError("Chưa dùng được khoá AI «gemini-byok»: Kết nối chưa bật"), CUSTOMER_AI_NOT_READY_LABEL, "nguồn AI chưa mở được ⇒ «chưa sẵn sàng»");
  assert.equal(customerSafeAiError("429 RESOURCE_EXHAUSTED credit"), CUSTOMER_AI_INCIDENT_LABEL);
  assert.equal(customerSafeAiError("Tin nhắn trống."), "Tin nhắn trống.", "lỗi nghiệp vụ giữ nguyên");

  // Bốn trạng thái.
  assert.equal(customerAiState({ enabled: true, aiReady: true, quotaExhausted: false }), "ACTIVE");
  assert.equal(customerAiState({ enabled: false, aiReady: true, quotaExhausted: false }), "PAUSED");
  assert.equal(customerAiState({ enabled: true, aiReady: false, quotaExhausted: false }), "NEEDS_SETUP");
  assert.equal(customerAiState({ enabled: true, aiReady: false, quotaExhausted: true }), "OUT_OF_QUOTA");
  const rd = customerReadinessChecks([{ key: "AI_READY", label: "Khoá AI chưa dùng được", status: "FAIL", detail: "Kết nối «Google Gemini — khoá AI của tổ chức» chưa bật", href: "/integrations" }], "NEEDS_SETUP");
  assert.ok(!/khoá|gemini|kết nối/i.test(`${rd[0].label} ${rd[0].detail}`) && rd[0].href === null, `bảng kiểm của khách không nhắc khoá / nhà cung cấp: ${JSON.stringify(rd)}`);

  // Cockpit: phần nhà cung cấp gộp thành MỘT câu, không số lượt, không lớp lỗi.
  const raw: SalesHealth = {
    status: "RED",
    headline: "Nhà cung cấp AI: 7 lượt lỗi trong 15 phút, chưa lượt nào thành công sau lỗi cuối. Tài khoản AI của shop đã hết tiền",
    checks: [
      { key: "BACKLOG", level: "CRITICAL", title: "Hàng chờ", detail: "3 tin khách đang chờ", fix: "Mở «Tin lỗi / đang chờ» bên dưới; nếu provider lỗi thì sửa provider trước." },
      { key: "DEAD_LETTER", level: "WARNING", title: "Tin bot không trả lời được", detail: "2 tin ở hàng dead-letter", fix: "Tin AI hỏng còn trong 30 phút được máy thử lại khi provider hồi phục." },
      { key: "PROVIDER", level: "CRITICAL", title: "Nhà cung cấp AI", detail: "7 lượt lỗi trong 15 phút. Tài khoản AI của shop đã hết tiền", fix: "Tài khoản AI của shop đã hết tiền — nạp thêm ở trang của nhà cung cấp AI" },
      { key: "ORDER_SYNC", level: "CRITICAL", title: "AI ghi đơn từ hội thoại", detail: "Provider AI hỏng (CREDIT)" },
      { key: "SAFETY_NET", level: "OK", title: "Job quét lại & ghi đơn", detail: "Lượt cuối cách đây 2 phút." },
      { key: "WEBHOOK", level: "OK", title: "Tin khách tới (webhook)", detail: "Giờ qua 12 tin." },
    ],
  };
  const ch = customerSalesHealth(raw);
  // Chữ HIỂN THỊ (tiêu đề · chi tiết · cách sửa · dòng đầu) — khoá máy (`PROVIDER`, `WEBHOOK`) không in ra màn hình.
  const chText = [ch.headline, ...ch.checks.flatMap((c) => [c.title, c.detail, c.fix ?? ""])].join(" | ");
  assert.equal(ch.status, "RED", "trạng thái tổng giữ nguyên — không làm đẹp số");
  assert.ok(!/provider|nhà cung cấp|hết tiền|lượt lỗi|dead-letter|webhook|CREDIT|job/i.test(chText), `cockpit của khách không lộ phần nhà cung cấp / vận hành: ${chText}`);
  assert.ok(ch.checks.some((c) => c.key === "PROVIDER" && c.detail === CUSTOMER_AI_INCIDENT_LABEL), "MỘT câu «AI đang gặp sự cố — đội ngũ đã được báo»");
  assert.ok(!ch.checks.some((c) => c.key === "SAFETY_NET" || c.key === "DEAD_LETTER" || c.key === "ORDER_SYNC"), "kiểm nội bộ không tới khách");
  assert.ok(JSON.stringify(raw).includes("hết tiền"), "đối chứng: bản gốc (nhà) còn nguyên lớp lỗi");
  const okHealth = customerSalesHealth({ status: "GREEN", headline: "AI bán hàng đang chạy bình thường.", checks: [{ key: "PROVIDER", level: "OK", title: "Nhà cung cấp AI", detail: "12 lượt thành công trong 15 phút." }] });
  assert.ok(okHealth.checks[0].detail === "AI đang hoạt động" && !/lượt/.test(JSON.stringify(okHealth)), JSON.stringify(okHealth));

  // Danh mục kết nối dựng tay: connector chỉ-nhà / AI bị bỏ, dòng còn lại không mô tả nội bộ.
  const row = (key: string, kind: "AI" | "MESSAGING", tenancy: "PER_ORG" | "HOME_ONLY") => ({ key, label: key, vendor: "V", kind, tenancy, auth: "API_KEY" as const, capabilities: [], moduleKey: "core", moduleLabel: "Lõi", moduleEnabled: true, why: "lý do nội bộ", configStore: "ORG_CONNECTIONS" as const, configWhere: "/settings/connections — AES", hasHealthCheck: true, consumers: ["lib/x.ts::y"], webhook: { path: "/api/webhooks/x", tenantResolution: "token" }, mode: "CONFIGURABLE" as const, homeReadiness: null, fields: [], connection: null });
  const fake: ConnectionsView = { organization: { code: "x", name: "X", isHome: false }, secretsReady: { ok: true, reason: null, keyIdShort: "abcd1234…" }, groups: [{ kind: "AI", label: "AI", rows: [row("gemini-byok", "AI", "PER_ORG")] }, { kind: "MESSAGING", label: "Nhắn tin", rows: [row("lark-webhook", "MESSAGING", "PER_ORG"), row("pancake-pos", "MESSAGING", "HOME_ONLY")] }] };
  const cvw = customerConnectionsView(fake);
  assert.deepEqual(cvw.groups.flatMap((g) => g.rows.map((r) => r.key)), ["lark-webhook"], "chỉ còn connector theo tổ chức, không AI");
  assert.deepEqual(internalKeyPaths(cvw, /^(why|consumers|webhook|tenancy|configStore|configWhere|keyIdShort)$/), ["$.secretsReady.keyIdShort"], "chỉ còn khoá keyIdShort mang null");
  assert.equal(cvw.secretsReady.keyIdShort, null);
  // Module CHƯA MUA / đang tắt (kiểm kê 08/10): connector chưa khai ⇒ không hiện; đã khai ⇒ vẫn hiện — không giấu kết nối đang có.
  const off = (key: string, configured: boolean): ConnectorView => ({
    ...row(key, "MESSAGING", "PER_ORG"),
    moduleKey: "logistics",
    moduleLabel: "Giao vận",
    moduleEnabled: false,
    connection: configured ? { status: "ACTIVE", settings: {}, secretHints: {}, lastTestAt: null, lastTestOk: true, lastTestMessage: null, activatedAt: null, updatedAt: "2026-10-08T00:00:00.000Z", updatedBy: "qt" } : null,
  });
  const mv = customerConnectionsView({ ...fake, groups: [{ kind: "SHIPPING", label: "Vận chuyển", rows: [off("ghn-carrier", false), off("ghtk-carrier", true)] }] });
  assert.deepEqual(mv.groups.flatMap((g) => g.rows.map((r) => r.key)), ["ghtk-carrier"], "module chưa mua: chưa khai ⇒ ẩn; đã khai ⇒ vẫn hiện");
  // Lõi chặn ghi theo LOẠI connector: mọi khoá người vận hành quản đều là loại AI — không khoá nào lọt qua `guard()`.
  for (const k of OPERATOR_AI_CONNECTORS) assert.equal(findConnector(k)?.kind, "AI", `${k}: connector loại AI (lõi chặn khách ghi theo loại)`);
}

// ─────────────────────────── REVIEW #639: CÂU LỖI CHO KHÁCH — DANH SÁCH CHO PHÉP ───────────────────────────

/** Khoá nội bộ của màn «AI dựng cấu hình» — DTO của khách KHÔNG có (không phải để rỗng / 0). */
const BUILDER_INTERNAL = /^(aiSource|provider|model|inputTokens|outputTokens|costUsd|quotaWarning|source)$/;

/** Chữ nội bộ không được tới khách ở BẤT KỲ câu nào sau bộ lọc. */
const ERROR_FORBIDDEN = /\$|USD|\btokens?\b|\bmodels?\b|provider|nhà cung cấp AI|gemini|openai|anthropic|claude|PLATFORM_|khoá AI|settings\/connections|RESOURCE_EXHAUSTED|TypeError|fetch failed|Pancake (từ chối|bận)/i;

export function testHideInternalErrors() {
  // (1) Câu hạn mức THẬT (`evaluateAiQuota`) cho từng lý do ⇒ đúng câu khách của `customerQuotaError`. Đổi chữ ở nguồn mà quên bộ
  //     đổi câu ⇒ đỏ ở đây (không lặng lẽ thành câu chung, càng không lọt USD).
  const lim = (o: Partial<AiLimits>): AiLimits => ({ requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 10, ...o });
  const usage = (o: Partial<AiSourceUsage>): AiSourceUsage => ({ requestsToday: 0, requestsMonth: 0, costUsdMonth: 0, unknownCostMonth: 0, ...o });
  const verdicts = [
    evaluateAiQuota("PLATFORM", lim({ requestsPerDay: 1200 }), usage({ requestsToday: 1200 })),
    evaluateAiQuota("BYOK", lim({ requestsPerMonth: 30 }), usage({ requestsMonth: 30 })),
    evaluateAiQuota("PLATFORM", lim({ platformCreditUsdPerMonth: 5 }), usage({ costUsdMonth: 5.12 })),
    evaluateAiQuota("BYOK", lim({ costUsdPerMonth: { soft: null, hard: 4 } }), usage({ costUsdMonth: 4.5 })),
    evaluateAiQuota("PLATFORM", lim({ platformCreditUsdPerMonth: 0 }), usage({})),
  ];
  assert.deepEqual(verdicts.map((v) => (v.ok ? "OK" : v.reason)), ["REQUESTS_DAY", "REQUESTS_MONTH", "PLATFORM_CREDIT_USED", "COST_HARD", "NO_PLATFORM_CREDIT"], "tiền đề: đủ năm lý do chặn của hàm thật");
  for (const v of verdicts) if (!v.ok) assert.equal(customerSafeAiError(v.error), customerQuotaError(v.reason), `«${v.error}» ⇒ ${customerQuotaError(v.reason)}`);
  assert.equal(customerQuotaError("REQUESTS_DAY"), CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA, "hết lượt / hết credit của gói ⇒ khách tự xử ở trang gói");
  assert.equal(customerQuotaError("COST_HARD"), CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA);
  assert.equal(customerQuotaError("NO_PLATFORM_CREDIT"), CUSTOMER_AI_NOT_READY_LABEL, "gói không có AI dùng chung ⇒ việc của hỗ trợ");
  assert.equal(customerQuotaError("PLAN_UNREADABLE"), CUSTOMER_AI_NOT_READY_LABEL);
  for (const raw of ["Không đọc được gói dịch vụ của tổ chức — người vận hành nền tảng cần kiểm bảng gói.", "AI của tổ chức nhà chỉ dành cho tổ chức nhà."]) assert.equal(customerSafeAiError(raw), CUSTOMER_AI_NOT_READY_LABEL, raw);

  // (2) Công tắc của người vận hành · nguồn AI chưa mở được ⇒ «chưa sẵn sàng»; Pancake ⇒ câu kênh, KHÔNG chữ Pancake trả về.
  for (const raw of [
    `${AI_DISABLED_BY_OPERATOR} (toàn nền tảng).`,
    `AI đang tắt: ${AI_DISABLED_BY_OPERATOR} (riêng tổ chức này).`,
    "Chưa dùng được khoá AI «gemini-byok»: Kết nối «Google Gemini — khoá AI của tổ chức» chưa bật (cần Kiểm tra đạt rồi Bật).",
    "Kết nối AI thiếu khoá.",
    "Nền tảng chưa bật AI dùng chung — chọn khoá AI riêng của shop, hoặc báo người vận hành.",
    "Gói hiện tại chưa có AI dùng chung — nâng gói, hoặc chọn khoá AI riêng của shop.",
    "Tổ chức chưa có kết nối AI đang bật — khai khoá Anthropic hoặc OpenAI của tổ chức ở Kết nối theo tổ chức (/settings/connections), kiểm tra rồi bật.",
  ])
    assert.equal(customerSafeAiError(raw), CUSTOMER_AI_NOT_READY_LABEL, raw);
  for (const raw of ["Pancake từ chối: access_token hết hạn", "Pancake bận (HTTP 429)", "Không gọi được Pancake sau 3 lần thử: Pancake bận (HTTP 503)", "Không gọi được Pancake: Máy chủ ERP không tới được pages.fm"])
    assert.equal(customerSafeAiError(raw), CUSTOMER_PANCAKE_READ_FAILED, raw);
  // Vỏ Chốt Đơn không có menu «Cài đặt → Kết nối» (mục của nó là «Kênh kết nối») ⇒ câu chỉ «trang Kết nối», không đường menu ERP.
  assert.ok(/trang Kết nối/.test(CUSTOMER_PANCAKE_READ_FAILED) && !/Cài đặt →/.test(CUSTOMER_PANCAKE_READ_FAILED), CUSTOMER_PANCAKE_READ_FAILED);

  // (3) DANH SÁCH CHO PHÉP: câu lạ / câu mang chữ nội bộ ⇒ câu chung của nơi gọi; câu nghiệp vụ đã duyệt ⇒ nguyên văn.
  const internal = [
    "fetch failed",
    "TypeError: Cannot read properties of undefined (reading 'model')",
    "Lỗi lạ chưa ai duyệt",
    "Mô tả quá ngắn nhưng model gemini lỗi",
    "Không gọi được AI: Máy chủ ERP không tới được nhà cung cấp AI (hết thời gian chờ)",
    "AI không trả về nội dung (dừng: max_tokens) — chạy lại, hoặc chọn model khác ở khung Cấu hình.",
    "Bạn không có quyền nhưng hết $3.20",
    "Gọi AI hỏng: 401 API key not valid",
    "AI hết trần token trước khi nộp gói — rút gọn mô tả hoặc chia làm nhiều lượt sửa.",
  ];
  for (const raw of internal) assert.equal(customerSafeAiError(raw), CUSTOMER_AI_INCIDENT_LABEL, `«${raw}» ⇒ câu chung`);
  assert.equal(customerSafeAiError("fetch failed", CUSTOMER_AI_DRAFT_FAILED), CUSTOMER_AI_DRAFT_FAILED, "câu chung theo nơi gọi");
  const business = [
    TURN_EMPTY_ERROR,
    TURN_MODULE_OFF_ERROR,
    TURN_NO_CONVERSATION_ERROR,
    TURN_BUSY_ERROR,
    ...Object.values(AI_STOP_MESSAGE),
    "Số điểm không hợp lệ.",
    "Đang có một lượt phát lại chạy — đợi xong rồi chạy lại.",
    "Treo quá lâu — bị thay bằng lượt mới.",
    "Không có hội thoại khách thật nào trong khoảng ngày đã chọn.",
    "Chỉ có 2 hội thoại có cả khách lẫn shop trả lời trong 90 ngày — chưa đủ để học (cần ≥ 3).",
    "AI không trả về danh sách bài học đọc được",
    "AI trả lời sai định dạng — chưa ghi đơn (lượt sau đọc lại khi có tin mới)",
    "Mô tả quá ngắn — viết ít nhất một câu về doanh nghiệp hoặc thay đổi cần làm.",
    overLimitMessage("aiDraftsPerDay", "Khởi đầu", 20, 20),
    "Gói còn 3 lỗi sau 2 lượt sửa — xem lỗi, bỏ chọn mục hỏng hoặc gửi yêu cầu rõ hơn.",
    "Bạn không có quyền chạy phát lại (ai_sales:manage).",
    CUSTOMER_AI_NOT_READY_LABEL,
    CUSTOMER_AI_CONFIG_MANAGED,
  ];
  for (const ok of business) assert.equal(customerSafeAiError(ok), ok, `«${ok}» giữ nguyên`);
  // (4) Bất biến: KHÔNG câu nào ra khỏi bộ lọc mang chữ nội bộ.
  const all = [...verdicts.flatMap((v) => (v.ok ? [] : [v.error])), ...internal, ...business, `${AI_DISABLED_BY_OPERATOR} (toàn nền tảng).`, "Pancake từ chối: Token hết hạn"];
  for (const raw of all) assert.ok(!ERROR_FORBIDDEN.test(customerSafeAiError(raw)), `«${raw}» ⇒ «${customerSafeAiError(raw)}» còn chữ nội bộ`);
  assert.ok(all.some((raw) => ERROR_FORBIDDEN.test(raw)), "đối chứng: đầu vào có chữ nội bộ thật");
}

// ─────────────────────────── REVIEW #639: PHÁT LẠI · TỰ HỌC · SỔ TAY · GHI ĐƠN · AI DỰNG CẤU HÌNH (DTO) ───────────────────────────

export function testHideInternalReview() {
  // Phát lại: không tên công cụ; câu lỗi lượt / điểm qua bộ lọc; câu nghiệp vụ giữ nguyên.
  const replay = customerReplayDetail({
    ok: true,
    run: { id: "r", error: "Chưa dùng được khoá AI «gemini-byok»: hết credit 5.00 USD" },
    points: [
      { id: "p", error: "TypeError: Cannot read properties of undefined (reading 'model')", tools: [{ name: "search_products", ok: true, summary: "3 kết quả" }] },
      { id: "q", error: TURN_BUSY_ERROR, tools: [{ name: "draft_order", ok: false, summary: "thiếu SĐT" }] },
      { id: "s", error: null, tools: [] },
    ],
  });
  assert.deepEqual(stringHits(replay, ERROR_FORBIDDEN), [], "phát lại của khách: không lỗi gốc");
  assert.ok(replay.points.every((p) => p.tools.length === 0) && !/search_products|draft_order/.test(JSON.stringify(replay)), "phát lại của khách: không tên công cụ");
  assert.deepEqual([replay.run.error, ...replay.points.map((p) => p.error)], [CUSTOMER_AI_NOT_READY_LABEL, CUSTOMER_AI_INCIDENT_LABEL, TURN_BUSY_ERROR, null]);

  // Rà lỗi AI: dấu hiệu «công cụ lỗi» không mang tên công cụ / câu trả về thô; dấu hiệu khác (câu của bot) giữ nguyên.
  const qi = customerQualityItems([
    { kind: "TOOL_ERROR", evidence: 'search_products: {"error":"TypeError: fetch failed"}', seq: 3 },
    { kind: "PRICE_UNGROUNDED", evidence: "Dạ áo này 250k ạ", seq: 4 },
  ]);
  assert.deepEqual(qi.map((x) => x.evidence), [CUSTOMER_TOOL_ERROR_EVIDENCE, "Dạ áo này 250k ạ"]);
  assert.ok(qi[0].seq === 3 && !/search_products/.test(JSON.stringify(qi)), "rà lỗi AI của khách: không tên công cụ");

  // Bot tự học: ghi chú lượt LỖI qua bộ lọc; lượt đạt / bỏ qua là câu nghiệp vụ.
  const run = (status: "OK" | "ERROR" | "SKIPPED", note: string) => ({ ...EMPTY_LESSONS, lastRun: { at: "2026-10-08T01:00:00.000Z", status, threads: 3, note } });
  assert.equal(customerLessons(run("ERROR", "429 RESOURCE_EXHAUSTED gemini-3.5-flash quota")).lastRun?.note, CUSTOMER_AI_INCIDENT_LABEL);
  assert.equal(customerLessons(run("ERROR", "Đã dùng hết credit AI của nền tảng tháng này (3.00 USD / 3.00 USD) — khai khoá AI của tổ chức ở /settings/connections để dùng tiếp.")).lastRun?.note, CUSTOMER_AI_STATE_HINT.OUT_OF_QUOTA);
  assert.equal(customerLessons(run("OK", "Học từ 3 hội thoại: 2 bài (mới / sửa 1 · bỏ 0)")).lastRun?.note, "Học từ 3 hội thoại: 2 bài (mới / sửa 1 · bỏ 0)", "lượt đạt giữ ghi chú nghiệp vụ");
  assert.equal(customerLessons(run("SKIPPED", "Chưa có hội thoại mới đã xong")).lastRun?.note, "Chưa có hội thoại mới đã xong");

  // Sổ tay: bản nháp không USD của lượt học.
  const pb = customerPlaybookState({ ...EMPTY_PLAYBOOK, draft: { text: "Sổ tay", createdAt: "a", createdBy: null, stats: { conversations: 1, messages: 2, aiCalls: 1, costUsd: 0.04, pricesRemoved: 0 } } });
  assert.ok(pb.draft?.stats?.costUsd === null && pb.draft.stats.aiCalls === 1 && pb.draft.text === "Sổ tay", "sổ tay của khách: bản nháp không USD");

  // Ghi đơn từ hội thoại: dòng LỖI qua bộ lọc; dòng nghiệp vụ giữ nguyên.
  const os = customerOrderSyncView({ config: null, recent: [{ outcome: "ERROR", result: "503 gemini overloaded" }, { outcome: "ERROR", result: "AI trả lời sai định dạng — chưa ghi đơn (lượt sau đọc lại khi có tin mới)" }, { outcome: "SKIPPED", result: "Không lưu được khách: thiếu SĐT" }] });
  assert.deepEqual(os.recent.map((r) => r.result), [CUSTOMER_AI_INCIDENT_LABEL, "AI trả lời sai định dạng — chưa ghi đơn (lượt sau đọc lại khi có tin mới)", "Không lưu được khách: thiếu SĐT"]);
  assert.equal(os.config, null, "phần còn lại của DTO giữ nguyên");

  // AI dựng cấu hình: KHÔNG khoá nguồn AI / nhà cung cấp / model / token / USD / cảnh báo hạn mức (không phải để rỗng); lỗi lượt gọi
  // AI (dòng không đường dẫn) ⇒ câu khách; lỗi bộ kiểm gói (có đường dẫn) giữ nguyên.
  const draft: AiDraftView = {
    id: "d",
    mode: "new",
    prompt: "Shop hải sản",
    status: "DRAFT",
    name: null,
    valid: false,
    error: "Gọi AI hỏng: 401 API key not valid (gemini-3.5-flash)",
    errors: [
      { path: "", message: "Gọi AI hỏng: 401 API key not valid (gemini-3.5-flash)" },
      { path: "fields[0].key", message: "Khoá field trùng «trang_thai»." },
    ],
    warnings: [],
    groups: [],
    excludedKeys: [],
    installId: null,
    aiSource: "ORG_CONNECTION",
    provider: "gemini-byok",
    model: "gemini-3.5-flash",
    aiCalls: 1,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.01,
    createdAt: "2026-10-08T01:00:00.000Z",
    createdByEmail: "qt@shop",
    appliedAt: null,
    discardedAt: null,
    quotaWarning: "Chi phí AI tháng này (khoá ai của tổ chức) đã vượt ngưỡng cảnh báo 4.00 USD: 4.10 USD.",
  };
  const cd = customerAiDraft(draft);
  assert.deepEqual(internalKeyPaths(cd, BUILDER_INTERNAL), [], `bản nháp của khách không mang khoá nội bộ: ${internalKeyPaths(cd, BUILDER_INTERNAL).join(", ")}`);
  assert.deepEqual(stringHits(cd, ERROR_FORBIDDEN), [], "bản nháp của khách: không chữ nội bộ");
  assert.equal(cd.error, CUSTOMER_AI_DRAFT_FAILED);
  assert.deepEqual(cd.errors, [{ path: "", message: CUSTOMER_AI_DRAFT_FAILED }, { path: "fields[0].key", message: "Khoá field trùng «trang_thai»." }], "lỗi bộ kiểm gói giữ nguyên");
  assert.ok(internalKeyPaths(draft, BUILDER_INTERNAL).length >= 7, "đối chứng: bản nhà có đủ khoá nội bộ");
  const view: AiBuilderView = {
    organization: { code: "x", name: "X", isHome: false },
    ai: { available: false, source: null, provider: "anthropic-byok", model: "claude-x", reason: "Tổ chức chưa có kết nối AI đang bật — khai khoá Anthropic hoặc OpenAI của tổ chức ở Kết nối theo tổ chức (/settings/connections), kiểm tra rồi bật." },
    usedToday: 1,
    limits: AI_BUILDER_LIMITS,
    drafts: [{ id: "d", mode: "new", prompt: "p", status: "DRAFT", name: null, valid: false, aiCalls: 1, costUsd: 0.2, createdAt: "a", createdByEmail: null }],
  };
  const cv = customerAiBuilderView(view);
  assert.deepEqual(internalKeyPaths(cv, BUILDER_INTERNAL), [], `màn AI dựng cấu hình của khách không mang khoá nội bộ: ${internalKeyPaths(cv, BUILDER_INTERNAL).join(", ")}`);
  assert.ok(cv.ai.reason === CUSTOMER_AI_NOT_READY_LABEL && !cv.ai.available && cv.drafts[0].aiCalls === 1 && cv.usedToday === 1, JSON.stringify(cv));
  assert.equal(customerAiBuilderView({ ...view, ai: { available: true, source: "PLATFORM", provider: "gemini-platform", model: "gemini-3.5-flash", reason: null } }).ai.reason, null, "dùng được ⇒ không lý do");
}

// ─────────────────────────── QUÉT MÃ NGUỒN ───────────────────────────

/** Tệp màn hình KHÁCH chạm tới. Thành phần chỉ dựng cho nhà / người vận hành (ai-engine-fields, org-ai-config) không ở đây. */
const CUSTOMER_FILES = [
  "app/(dashboard)/settings/plan/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/config-form.tsx",
  "app/(dashboard)/ai/sales-chatbot/followup-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/history-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/lessons-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/level-scripts-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/messenger-history-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/mode-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/order-sync-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/resume-button.tsx",
  "app/(dashboard)/ai/sales-chatbot/inbox/control-bar.tsx",
  "app/(dashboard)/ai/sales-chatbot/inbox/message-trace.tsx",
  "app/(dashboard)/ai/sales-chatbot/inbox/thread-view.tsx",
  "app/(dashboard)/ai/sales-chatbot/performance/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/performance/experiment-block.tsx",
  "app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx",
  "app/(dashboard)/settings/connections/page.tsx",
  "components/connectors/connector-group-table.tsx",
  // Review #639 · kiểm kê 08/10: phát lại · xem lại hội thoại · Copilot · AI dựng cấu hình · vào việc ngay.
  "app/(dashboard)/ai/sales-chatbot/replay/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/conversations/[id]/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/copilot/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/quality/page.tsx",
  "app/(dashboard)/settings/ai-builder/page.tsx",
  "components/ai-builder/ai-builder-panel.tsx",
  "components/onboarding/go-live-card.tsx",
] as const;

const FORBIDDEN_WORD = /\b(token|tokens|USD|Gemini|OpenAI|Anthropic|model|provider|prompt)\b|nhà cung cấp AI/i;

/** Miễn trừ: [tệp, đoạn chữ hiển thị chứa từ cấm, lý do nó chỉ tới nhà / người vận hành]. Danh sách ĐÓNG. */
const EXEMPT: [string, string, string][] = [
  ["app/(dashboard)/settings/plan/page.tsx", "Lượt · token · tiền ƯỚC TÍNH theo bảng giá model", "Khung «Dùng AI» chỉ dựng khi `ai` khác null — `customerFacing(user.organization) ? null : loadOrgAiUsage(...)`."],
  ["app/(dashboard)/settings/plan/page.tsx", "không gọi model", "Câu gợi ý của cùng khung «Dùng AI» (chỉ nhà)."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "Anthropic / OpenAI) — tổ chức trả tiền token", "Câu gợi ý nhánh `customer ? … : (nhà)`."],
  ["app/(dashboard)/ai/sales-chatbot/performance/experiment-block.tsx", "token thật × bảng giá model", "Đoạn giải thích tiền AI của khối AI vs Người chỉ dựng khi `report.withMoney` — `loadExperimentReport({ withMoney: aiPerformanceWithMoney(user, manage) })`, khách ⇒ false ⇒ không đọc sổ AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "nhập Page ID và page access token", "Hướng dẫn nối fanpage qua Pancake — token của KÊNH do chính shop dán (chẩn đoán / cấu hình kết nối thật), không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "lấy refresh token ở API Explorer", "Hướng dẫn nối Zalo OA của chính shop — token của KÊNH, không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "Máy tự làm mới token và lưu cặp mới", "Cùng hướng dẫn Zalo OA — token của KÊNH."],
  ["app/(dashboard)/ai/sales-chatbot/history-panel.tsx", "page access token của shop", "Chẩn đoán kết nối fanpage của chính shop — token của KÊNH, không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx", "page access token của shop", "Cùng chẩn đoán kết nối fanpage — token của KÊNH."],
  ["app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx", "Lượt gần nhất xong", "Phần « · ~x USD» chỉ hiện khi `run.stats.costUsd !== null` — máy chủ đặt null cho khách (`customerPlaybookRun`)."],
  ["app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx", "Nhà cung cấp AI", "Dòng «Nhà cung cấp AI» trong nhánh `customer ? null : (…)` VÀ sau cổng `detail` (ai_sales:manage)."],
  ["app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx", "Thành công cuối", "Ô số lượt OK / lỗi của cùng dòng «Nhà cung cấp AI» (chỉ nhà, sau cổng `detail`)."],
  ["components/ai-builder/ai-builder-panel.tsx", "${engine.model", "Mô tả nguồn AI · model chỉ dựng khi `engine` khác null — `engine` = `view.ai` CÓ khoá `source`, mà DTO của khách (`customerAiBuilderView`) không có khoá đó."],
  ["components/ai-builder/ai-builder-panel.tsx", "để khai khoá Anthropic hoặc OpenAI của tổ chức — tổ chức trả tiền token", "Hướng dẫn khai khoá AI trong nhánh `engine ? (…)` — chỉ nhà; khách thấy câu «Bộ phận hỗ trợ đang hoàn tất cấu hình AI»."],
  ["components/onboarding/go-live-card.tsx", "gl-token", "Mã ô nhập page access token của KÊNH (Pancake) do chính shop dán — không phải token AI."],
  ["components/onboarding/go-live-card.tsx", "Page access token", "Nhãn / hướng dẫn ô nhập token của KÊNH (Pancake) — không phải token AI."],
  ["components/onboarding/go-live-card.tsx", "kiểm lại Page ID / token", "Câu kiểm tra kết nối KÊNH (Pancake) — token của page, không phải token AI."],
];

export function visibleTexts(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|import\b|export \* from)/.test(l))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
  const out: string[] = [];
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) out.push(m[0].slice(1, -1));
  // Chữ JSX giữa hai thẻ; biểu thức `{…}` xen giữa bị bỏ (tên biến không phải chữ hiển thị); đoạn trông như mã thì bỏ qua — kể cả
  // đoạn nằm giữa hai tham số kiểu (`useState<A>(…); const … useState<B>`), có khai báo `const` mà chữ JSX không bao giờ có.
  for (const m of code.matchAll(/>([^<>]+)</g)) if (!/=>|&&|\|\||;\s*$|\bconst\s/.test(m[1])) out.push(m[1].replace(/\{[^{}]*\}/g, " "));
  // Hằng mã máy (`"PROVIDER"`, `"AI_DOWN"`) là khoá so sánh trong mã, không phải chữ hiển thị.
  return out.filter((t) => /[a-zA-ZÀ-ỹ]/.test(t) && !/^[A-Z][A-Z0-9_]*$/.test(t));
}

export function testHideInternalStatic() {
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  const hits: string[] = [];
  const used = new Set<number>();
  for (const f of CUSTOMER_FILES) {
    for (const t of visibleTexts(read(f))) {
      if (!FORBIDDEN_WORD.test(t)) continue;
      const i = EXEMPT.findIndex(([ef, snippet]) => ef === f && t.includes(snippet));
      if (i >= 0) used.add(i);
      else hits.push(`${f}: «${t.trim().slice(0, 140)}»`);
    }
  }
  assert.deepEqual(hits, [], "màn hình khách in chữ kỹ thuật (token / USD / tên nhà cung cấp / model / provider / prompt) ngoài nhánh nhà — đưa vào nhánh nhà hoặc khai miễn trừ có lý do");
  const orphan = EXEMPT.filter((_, i) => !used.has(i)).map(([f, s]) => `${f}: «${s}»`);
  assert.deepEqual(orphan, [], "miễn trừ không còn khớp chữ nào — xoá khỏi danh sách");
  // Tự kiểm bộ quét: không tin được nó thì luật trên mù.
  assert.ok(visibleTexts(`<p>Chi phí token</p>\nconst x = "Gemini";`).some((t) => FORBIDDEN_WORD.test(t)), "bộ quét thấy chữ JSX và chuỗi");
  assert.ok(!visibleTexts(`// model\nconst model = c.model;`).some((t) => FORBIDDEN_WORD.test(t)), "bộ quét bỏ chú thích và tên biến");
  assert.ok(!visibleTexts(`const [a, setA] = useState<A>(x);\n  const [prompt, setPrompt] = useState<B | null>(null);`).some((t) => FORBIDDEN_WORD.test(t)), "bộ quét bỏ đoạn mã giữa hai tham số kiểu");
  assert.ok(visibleTexts(`<span>Chọn model khác</span>`).some((t) => FORBIDDEN_WORD.test(t)), "chữ JSX thường vẫn bị bắt");

  // Nhánh nhà được dựng ĐÚNG bằng hàm chung — không tự hỏi `.isHome` ở từng trang.
  const page = read("app/(dashboard)/ai/sales-chatbot/page.tsx");
  assert.ok(/loadChatbotAiView\(user, cfg/.test(page) && !/loadProviderHealth\(|loadChatCostReport\(|platformChatAi\(/.test(page), "trang chatbot đọc phần AI qua loader đã lọc, không tự gọi sức khoẻ khoá / chi phí / AI nền tảng");
  assert.ok(/customerFacing\(user\.organization\) \? null : await loadOrgAiUsage\(usage\.orgCode\)/.test(read("app/(dashboard)/settings/plan/page.tsx")), "trang gói: khách không đọc sổ AI");
  assert.ok(/withMoney: aiPerformanceWithMoney\(user, manage\)/.test(read("app/(dashboard)/ai/sales-chatbot/performance/page.tsx")), "trang hiệu quả: khách không tính tiền AI");
  assert.ok(/loadExperimentReport\(\{ withMoney: aiPerformanceWithMoney\(user, manage\) \}\)/.test(read("app/(dashboard)/ai/sales-chatbot/performance/page.tsx")), "khối AI vs người: tiền AI cùng cổng với khung «Chi phí AI & ROI»");
  const experimentBlock = read("app/(dashboard)/ai/sales-chatbot/performance/experiment-block.tsx");
  assert.ok(/\{report\.withMoney \? \(/.test(experimentBlock), "khối AI vs người: đoạn tiền AI chỉ dựng khi được xem tiền");
  assert.ok(/\.\.\.\(report\.withMoney\s*\?\s*\[/.test(experimentBlock), "khối AI vs người: dòng tiền AI của bảng chỉ dựng khi được xem tiền");
  assert.ok(page.includes("run={customer ? customerPlaybookRun(playbookRun) : playbookRun}"), "lượt học của khách đi qua bộ lọc (không USD)");
  const form = read("app/(dashboard)/ai/sales-chatbot/config-form.tsx");
  assert.ok(!/cb-model|cb-conn|cb-thinking|fallbackModel|connectorKey/.test(form), "form của khách không còn ô nguồn AI / model / mức suy nghĩ (chúng ở ai-engine-fields, chỉ dựng khi có `engine`)");
  assert.ok(/customerConnectionsView\(full\)/.test(read("lib/connectors/service.ts")), "danh mục kết nối lọc DTO ở máy chủ");
  assert.ok(/keepStoredEngineFields\(before, raw\)/.test(read("lib/sales-chatbot/settings.ts")), "đường lưu cấu hình bot giữ động cơ AI của khách");
  const actions = read("lib/actions/sales-chatbot.ts");
  // Hộp thư (10/10/2026): hai lối mở hội thoại — trang (đường dẫn / tự làm mới) và route chuyển hội thoại — đi CHUNG một lõi lọc.
  assert.ok(read("lib/sales-chatbot/inbox-thread-payload.ts").includes("const thread = customerFacing(user.organization) ? customerInboxThread(loaded.thread) : loaded.thread;"), "hộp thư: hội thoại của khách lọc ở máy chủ trước khi vào props");
  assert.ok(read("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx").includes("await inboxThreadPayload(user, selected)") && !read("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx").includes("loadInboxThread("), "trang mở hội thoại qua lõi lọc, không gọi thẳng loadInboxThread");
  assert.ok(read("app/api/ai-sales/inbox-thread/route.ts").includes("await inboxThreadPayload(user, id)") && !read("app/api/ai-sales/inbox-thread/route.ts").includes("loadInboxThread("), "route chuyển hội thoại cũng qua lõi lọc");
  assert.equal((actions.match(/testView\(user,/g) ?? []).length, 3, "cả hai action khung thử trả view qua bộ lọc của khách");

  // Review #639 · kiểm kê 08/10: phát lại · xem lại hội thoại · Copilot · tự học · sổ tay · ghi đơn · AI dựng cấu hình · vào việc ngay.
  assert.ok(read("app/(dashboard)/ai/sales-chatbot/replay/page.tsx").includes("customer ? customerReplayDetail(selected) : selected"), "phát lại: lượt của khách qua bộ lọc (không tên công cụ, câu lỗi đã lọc)");
  assert.ok(read("app/(dashboard)/ai/sales-chatbot/conversations/[id]/page.tsx").includes("view: customerChatView(r.value.view)"), "xem lại hội thoại: không tên công cụ cho khách");
  assert.ok(read("app/(dashboard)/ai/sales-chatbot/copilot/page.tsx").includes("customer ? customerSafeAiError(e) : e"), "Copilot: câu lỗi của gợi ý hỏng qua bộ lọc");
  const quality = read("app/(dashboard)/ai/sales-chatbot/quality/page.tsx");
  assert.ok(quality.includes("customerQualityItems(r.value.items)") && !quality.includes("r.value.items.map("), "rà lỗi AI: dấu hiệu «công cụ lỗi» của khách qua bộ lọc (không tên công cụ)");
  for (const [needle, why] of [
    ["state={customer ? customerLessons(lessons) : lessons}", "tự học"],
    ["state={customer ? customerPlaybookState(playbook) : playbook}", "sổ tay"],
    ["view={customer ? customerOrderSyncView(orderSync) : orderSync}", "ghi đơn từ hội thoại"],
  ] as const)
    assert.ok(page.includes(needle), `trang chatbot: ${why} của khách qua bộ lọc`);
  const builderPage = read("app/(dashboard)/settings/ai-builder/page.tsx");
  assert.ok(builderPage.includes("customerAiBuilderView(raw.value)") && builderPage.includes("customerAiDraft(rawOpened.value)"), "AI dựng cấu hình: DTO của khách lọc trước props");
  const builderActions = read("lib/actions/ai-builder.ts");
  assert.equal((builderActions.match(/return forViewer\(user, r, /g) ?? []).length, 2, "tạo + bỏ nháp: kết quả qua bộ lọc của khách");
  assert.ok(builderActions.includes("customerSafeAiError(r.error, CUSTOMER_AI_DRAFT_FAILED)"), "xem trước: câu lỗi qua bộ lọc của khách");
  const goLive = read("lib/onboarding/go-live.ts");
  assert.ok(/loadChatbotAiView\(user, cfg/.test(goLive) && !/platformChatAi\(|usesPlatformAi/.test(goLive), "vào việc ngay: trạng thái AI qua loader đã lọc — không câu gốc của nền tảng, không nguồn AI");
  for (const f of ["lib/sales-chatbot/replay.ts", "lib/sales-chatbot/playbook.ts"]) assert.ok(read(f).includes("customer ? customerQuotaError(quota.reason) : quota.error"), `${f}: câu hạn mức của khách không USD`);
  // Lõi kết nối: khách không ghi khoá AI — kiểm ĐỨNG TRƯỚC mọi kiểm khác của `guard()` (câu trả lời luôn là câu kinh doanh).
  const svc = read("lib/connectors/service.ts");
  const guardSrc = svc.slice(svc.indexOf("function guard("), svc.indexOf("export type ConnectionStatusRow"));
  const aiCheck = guardSrc.indexOf('if (spec.kind === "AI" && customerFacing(user.organization)) return { error: CUSTOMER_AI_CONFIG_MANAGED };');
  assert.ok(aiCheck > 0 && aiCheck < guardSrc.indexOf("if (!isOrgConfigurable(spec))") && aiCheck < guardSrc.indexOf("if (!moduleEnabled(user, spec))"), "guard(): chặn khoá AI của khách trước kiểm cấu hình / module");

  // (d) Cockpit: chi tiết đòi ai_sales:manage; phần nhà cung cấp không tới khách.
  const cockpit = read("app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx");
  assert.ok(/const detail = can\(user, SALES_CHATBOT_MANAGE\)/.test(cockpit), "cockpit: cổng chi tiết = ai_sales:manage");
  assert.equal((cockpit.match(/\{detail \? \(/g) ?? []).length, 2, "cả «Từng kiểm» lẫn «Kênh» nằm sau cổng `detail`");
  assert.ok(/customer \? customerSalesHealth\(rawHealth\) : rawHealth/.test(cockpit), "cockpit của khách dùng sức khoẻ đã lọc");
  assert.ok(/\{customer \? null : \(\s*<tr>\s*<td className="py-2 font-medium">Nhà cung cấp AI/.test(cockpit), "dòng «Nhà cung cấp AI» không bao giờ dựng cho khách");
  assert.ok(/r\.kind === "AI_DOWN" && \(customer \|\| !detail\) \? null : r\.note/.test(cockpit), "ghi chú tin AI hỏng (có thể là câu lỗi gốc) không tới khách / người không cấu hình bot");
}

// ─────────────────────────── TỔ CHỨC THẬT ───────────────────────────

export async function testHideInternalLive() {
  await cleanup();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-che-du-lieu-noi-bo-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await provisionOrganization({ code: ORG, name: "Che nội bộ", plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "CheNoiBo@12345" }, source: "TEST", actor: null });
    const home = await getHomeOrganization();
    const operator: SessionUser = { id: "hi-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    // Cấu hình ĐANG CHẠY của khách — như HSLC: khoá Gemini riêng + dự phòng AI dùng chung + mức suy nghĩ nhanh.
    const running = { connectorKey: "gemini-byok", model: "gemini-3.5-flash-lite", fallbackConnectorKey: "platform", fallbackModel: "", failoverEnabled: true, failoverOpenMinutes: 45, thinking: "FAST" } as const;
    let admin!: SessionUser;
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Che nội bộ", isHome: false }, modules: [...(await getEnabledModules(ORG))] };
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, ...running, greeting: "Chào cũ" });

      // (b) Khách lưu — gửi nguồn / model KHÁC ⇒ giữ nguyên; không gửi các ô đó (form của khách) ⇒ vẫn giữ nguyên.
      const s1 = await saveSalesChatbotConfig(admin, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "openai-byok", model: "gpt-bia", thinking: "SMART", failoverOpenMinutes: 5, greeting: "Chào mới 1" });
      assert.ok(s1.ok, JSON.stringify(s1));
      let now = await loadSalesChatbotConfig();
      for (const [k, v] of Object.entries(running)) assert.deepEqual(now[k as keyof typeof running], v, `khách gửi ${k} khác ⇒ giữ ${String(v)}`);
      assert.equal(now.greeting, "Chào mới 1", "ô của chủ shop vẫn lưu");
      const s2 = await saveSalesChatbotConfig(admin, { ...customerChatbotConfig(now), greeting: "Chào mới 2" });
      assert.ok(s2.ok, JSON.stringify(s2));
      now = await loadSalesChatbotConfig();
      for (const [k, v] of Object.entries(running)) assert.deepEqual(now[k as keyof typeof running], v, `khách không gửi ${k} ⇒ vẫn ${String(v)}, không về mặc định`);
      // Khách bật bot khi khoá chưa sẵn sàng ⇒ từ chối bằng câu của khách, không tên khoá / nhà cung cấp.
      const s3 = await saveSalesChatbotConfig(admin, { ...customerChatbotConfig(now), enabled: true });
      assert.ok(!s3.ok && /Chưa bật được bot/.test(s3.error) && !/gemini|google|khoá AI|kết nối/i.test(s3.error), JSON.stringify(s3));

      // (a) Loader trang chatbot của khách.
      const v = await loadChatbotAiView(admin, now, { manage: true });
      assert.equal(v.audience, "CUSTOMER");
      assert.deepEqual(internalKeyPaths(v), [], `DTO trang chatbot của khách không có khoá nội bộ: ${internalKeyPaths(v).join(", ")}`);
      assert.ok(!/gemini|openai|anthropic|flash/i.test(JSON.stringify(v)), "không tên nhà cung cấp / model ở bất kỳ giá trị nào");
      assert.ok(v.audience === "CUSTOMER" && v.aiState === "NEEDS_SETUP", "khoá chưa bật ⇒ «Cần cấu hình»");
      // Danh mục kết nối của khách.
      const cv = (await loadConnectionsView(admin)) as ConnectionsView;
      const rows = cv.groups.flatMap((g) => g.rows);
      assert.ok(rows.length > 0 && !rows.some((r) => r.kind === "AI" || r.tenancy === "HOME_ONLY"), "không connector AI / chỉ-nhà");
      assert.deepEqual(internalKeyPaths(cv, /^(why|consumers|webhook|tenancy|configStore|keyIdShort|apiKey)$/).filter((p) => p !== "$.secretsReady.keyIdShort"), [], "dòng kết nối không mô tả nội bộ");
      assert.equal(cv.secretsReady.keyIdShort, null);
      // Module CHƯA MUA (gói của shop này không có Giao vận · Marketing · Săn khách sỉ…): connector chưa khai không hiện (kiểm kê 08/10).
      assert.deepEqual(rows.filter((r) => !r.moduleEnabled && r.connection === null).map((r) => r.key), [], "màn Kết nối của khách: không connector của module chưa mua");
      assert.ok(!rows.some((r) => r.key === "ghn-carrier" || r.key === "meta-ads-org"), "Giao vận / Marketing chưa mua ⇒ không dòng GHN / Meta Ads");
      // Hiệu quả AI: tiền AI không tính.
      const perf = await loadAiSalesPerformance(ORG, { days: 30, withMoney: aiPerformanceWithMoney(admin, true) });
      assert.ok(perf.cost === null && perf.human === null && perf.economics.aiCostPerConversationVnd === null && perf.economics.revenuePerAiCost === null, "khách: không chi phí AI / ROI theo tiền AI");

      // Hộp thư: hội thoại THẬT của tổ chức khách qua đúng loader + bộ lọc của trang (bot tắt, khoá chưa bật ⇒ có lý do chặn).
      const conv = await openConversation("WEB", { visitorKey: "hi-visitor-0123456789abcdef" });
      const loaded = await loadInboxThread(admin, conv.id);
      assert.ok(loaded.ok && "thread" in loaded, JSON.stringify(loaded).slice(0, 300));
      const raw = loaded.thread;
      assert.ok(raw.aiBlocks.length > 0, "tiền đề: có lý do chặn");
      const shown = customerInboxThread(raw);
      assert.deepEqual(stringHits(shown, INBOX_FORBIDDEN), [], `payload hộp thư thật của khách sạch: ${stringHits(shown, INBOX_FORBIDDEN).join(" | ")}`);
      assert.deepEqual(internalKeyPaths(shown), [], "không khoá nội bộ trong payload hộp thư");

      // (f) Review #639 — phát lại · vào việc ngay · góp ý cho AI · học từ hội thoại cũ: nguồn AI chưa dùng được (khoá «gemini-byok»
      //     chưa bật, AI dùng chung chưa bật) ⇒ lõi trả câu của KHÁCH, không «Chưa dùng được khoá AI «gemini-byok»…», không USD.
      const rp = await startReplay(admin, { points: REPLAY_LIMITS.pointChoices[0], days: REPLAY_LIMITS.dayChoices[0] });
      assert.ok("error" in rp && rp.error === CUSTOMER_AI_NOT_READY_LABEL, `phát lại: ${JSON.stringify(rp)}`);
      const gl = await loadGoLive(admin);
      assert.ok(gl.show && !gl.bot.aiReady && gl.bot.aiReason === CUSTOMER_AI_STATE_HINT.NEEDS_SETUP, `vào việc ngay: khoá riêng chưa bật ⇒ «cần cấu hình» (trước đây khoá riêng luôn coi là sẵn sàng): ${JSON.stringify(gl.bot)}`);
      assert.deepEqual(stringHits(gl.bot, ERROR_FORBIDDEN), [], "vào việc ngay của khách: không chữ nội bộ");
      const fb = await submitConversationFeedbackCore(admin, conv.id, "Bot báo sai phí ship, phải báo 30k");
      assert.ok(!fb.ok && fb.error.endsWith(CUSTOMER_AI_NOT_READY_LABEL) && !ERROR_FORBIDDEN.test(fb.error), `góp ý cho AI: ${JSON.stringify(fb)}`);
      const withFeedback = await loadInboxThread(admin, conv.id);
      assert.ok(withFeedback.ok && "thread" in withFeedback, JSON.stringify(withFeedback).slice(0, 300));
      assert.ok(/gemini-byok/.test(withFeedback.thread.feedback[0]?.error ?? ""), "tiền đề: dòng góp ý giữ câu lỗi GỐC (chẩn đoán)");
      assert.equal(customerInboxThread(withFeedback.thread).feedback[0]?.error, CUSTOMER_AI_NOT_READY_LABEL, "hộp thư của khách: câu lỗi góp ý đã lọc");
      // Học từ hội thoại cũ: lõi đòi fanpage đang bật TRƯỚC nguồn AI ⇒ nối fanpage (Pancake giả) rồi chạy.
      const fakePancake = (async () => new Response(JSON.stringify({ success: true, conversations: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
      const fp = await quickConnectFanpage(admin, { pageId: "556677889900", pageAccessToken: "pancake_page_token_hi_0123456789" }, { tester: { fetch: fakePancake } });
      assert.ok("ok" in fp, JSON.stringify(fp));
      const pl = await startPlaybookLearning(admin, { conversations: 50, days: 90 });
      assert.ok("error" in pl && pl.error === CUSTOMER_AI_NOT_READY_LABEL, `học từ hội thoại cũ: ${JSON.stringify(pl)}`);

      // (g) AI dựng cấu hình: loader THẬT + bộ lọc của trang ⇒ không nguồn AI / model; bản nháp THẬT (provider giả, AI không nộp gói)
      //     ⇒ không khoá nội bộ, lỗi lượt là câu khách.
      const builder: SessionUser = { ...admin, permissions: [...admin.permissions, "metadata:manage"] };
      const bv = await loadAiBuilderView(builder);
      assert.ok(bv.ok && !bv.value.ai.available && /settings\/connections/.test(bv.value.ai.reason ?? ""), `tiền đề: câu gốc của lõi nhắc đường cấu hình khoá AI — ${JSON.stringify(bv).slice(0, 300)}`);
      const cbv = customerAiBuilderView(bv.value);
      assert.ok(cbv.ai.reason === CUSTOMER_AI_NOT_READY_LABEL && internalKeyPaths(cbv, BUILDER_INTERNAL).length === 0, JSON.stringify(cbv).slice(0, 300));
      setBuilderAiForTests({ provider: new FakeProvider([() => ({ content: [{ type: "text", text: "Tôi đề xuất CRM và đơn hàng." }], stopReason: "end_turn" })]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      try {
        const d = await createDraft(builder, { mode: "new", prompt: "Shop hải sản cần CRM, đơn hàng và kho." });
        assert.ok(d.ok && d.value.error !== null && d.value.provider === "fake" && d.value.inputTokens > 0, `tiền đề: bản nháp thật mang lỗi lượt + nhà cung cấp + token — ${JSON.stringify(d).slice(0, 300)}`);
        const cd = customerAiDraft(d.value);
        assert.deepEqual(internalKeyPaths(cd, BUILDER_INTERNAL), [], `bản nháp thật của khách không khoá nội bộ: ${internalKeyPaths(cd, BUILDER_INTERNAL).join(", ")}`);
        assert.ok(cd.error === CUSTOMER_AI_DRAFT_FAILED && cd.errors.every((e) => e.path !== "" || e.message === CUSTOMER_AI_DRAFT_FAILED), JSON.stringify(cd).slice(0, 300));
      } finally {
        setBuilderAiForTests(undefined);
      }

      // (e) Khách KHÔNG gọi được lõi của người vận hành.
      assert.ok("error" in (await saveOrgChatbotEngine(admin, { orgCode: ORG, reason: "khách tự sửa", engine: { model: "gpt-bia" } })), "khách không ghi được động cơ AI qua cửa vận hành");
      assert.ok(!(await loadOperatorOrgAiConfig(admin, ORG)).ok, "khách không đọc được khối vận hành");
    });

    // Nhà: loader trả đủ (đối chứng — cùng hàm, khác người xem).
    const homeCfg = await loadSalesChatbotConfig();
    const hv = await loadChatbotAiView(operator, homeCfg, { manage: true });
    assert.equal(hv.audience, "INTERNAL");
    assert.ok(hv.audience === "INTERNAL" && "connectorKey" in hv.engine.config && Array.isArray(hv.engine.connections) && internalKeyPaths(hv).length > 0, "nhà nhận động cơ AI + sức khoẻ khoá");
    assert.equal(aiPerformanceWithMoney(operator, true), true, "nhà + người cấu hình ⇒ có tiền AI");
    assert.equal(aiPerformanceWithMoney(operator, false), false);

    // (e) Người vận hành sửa cấu hình AI của workspace khách — đúng hàm cấu hình, mọi ô của chủ shop giữ nguyên.
    assert.ok("error" in (await saveOrgChatbotEngine(operator, { orgCode: ORG, reason: "", engine: { model: "gemini-3.5-flash" } })), "thiếu lý do ⇒ từ chối");
    assert.ok("error" in (await saveOrgChatbotEngine(operator, { orgCode: ORG, reason: "đổi model theo yêu cầu", engine: { greeting: "chen ngang" } })), "ô không phải động cơ AI ⇒ từ chối");
    const op1 = await saveOrgChatbotEngine(operator, { orgCode: ORG, reason: "Đổi model theo yêu cầu chủ shop", engine: { model: "gemini-3.5-flash", thinking: "SMART" } });
    assert.ok("ok" in op1, JSON.stringify(op1));
    await withOrganization(ORG, async () => {
      const after = await loadSalesChatbotConfig();
      assert.ok(after.model === "gemini-3.5-flash" && after.thinking === "SMART" && after.connectorKey === "gemini-byok" && after.greeting === "Chào mới 2", JSON.stringify(after));
      const log = await (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_CHATBOT_CONFIG"));
      assert.ok(log.some((r) => r.userId === null && r.userEmail.includes("vận hành nền tảng")), "nhật ký của tổ chức ghi người vận hành (userId null + nhãn)");
    });
    // Khoá AI của workspace: chỉ nhập, không hiện lại.
    const fakeGemini = (async () => new Response(JSON.stringify({ models: [{ name: "models/gemini-3.5-flash-lite" }], data: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    assert.ok("ok" in (await operateOrgAiConnection(operator, { orgCode: ORG, reason: "Nhập khoá Gemini của shop", connectorKey: "gemini-byok", op: "save", secrets: { apiKey: GEMINI_KEY } })));
    assert.ok("ok" in (await operateOrgAiConnection(operator, { orgCode: ORG, reason: "Kiểm tra khoá", connectorKey: "gemini-byok", op: "test" }, { tester: { fetch: fakeGemini } })));
    assert.ok("ok" in (await operateOrgAiConnection(operator, { orgCode: ORG, reason: "Bật khoá", connectorKey: "gemini-byok", op: "activate" })));
    assert.ok("error" in (await operateOrgAiConnection(operator, { orgCode: ORG, reason: "Thử cửa sau", connectorKey: "lark-webhook", op: "save", secrets: { webhookUrl: "https://open.larksuite.com/x" } })), "chỉ khoá AI — không cửa sau cho kết nối khác");
    const opView = await loadOperatorOrgAiConfig(operator, ORG);
    assert.ok(opView.ok, JSON.stringify(opView));
    const gem = opView.ok ? opView.value.keys.find((k) => k.connectorKey === "gemini-byok") : undefined;
    assert.ok(gem && gem.status === "ACTIVE" && gem.hasSecret, JSON.stringify(gem));
    assert.ok(!JSON.stringify(opView).includes(GEMINI_KEY) && !JSON.stringify(opView).includes(GEMINI_KEY.slice(-4)), "khối vận hành không hiện lại khoá (kể cả 4 ký tự cuối)");
    const plog = await (await getPlatformDb()).select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
    assert.ok(plog.filter((r) => r.action === "AI_ORG_CONTROL_SET").length >= 4 && !JSON.stringify(plog).includes(GEMINI_KEY), "nhật ký nền tảng có mọi lượt, không mang khoá");
    // DoD (1): workspace KHÁCH không Lưu / Kiểm tra / Bật / Tắt được khoá AI ở LÕI (action gọi thẳng, bỏ qua màn hình) — kể cả khoá
    // đang chạy của chính shop (như HSLC: «gemini-byok» cho Thư viện Media). Câu kinh doanh; khoá đang có ĐỨNG NGUYÊN.
    await withOrganization(ORG, async () => {
      const keyRow = async () => (await aiConnectionsForOperator()).find((k) => k.connectorKey === "gemini-byok");
      const before = await keyRow();
      assert.ok(before?.status === "ACTIVE" && before.lastTestOk === true && before.hasSecret, `tiền đề: khoá đang bật — ${JSON.stringify(before)}`);
      let probes = 0;
      const countingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        probes += 1;
        return fakeGemini(input, init);
      }) as typeof fetch;
      const tries = [
        await saveConnection(admin, { connectorKey: "gemini-byok", settings: { model: "gemini-2.5-pro" }, secrets: {} }),
        await saveConnection(admin, { connectorKey: "gemini-byok", secrets: { apiKey: "AIzaKhachTuDanKhoaMoi0123456789abcdefgh" } }),
        await testOrgConnection(admin, "gemini-byok", { tester: { fetch: countingFetch } }),
        await setConnectionStatus(admin, "gemini-byok", "DISABLED"),
        await saveConnection(admin, { connectorKey: "openai-byok", secrets: { apiKey: "sk-khach-tu-dan-0123456789abcdefghij" } }),
        await setConnectionStatus(admin, "anthropic-byok", "ACTIVE"),
      ];
      for (const r of tries) assert.ok("error" in r && r.error === CUSTOMER_AI_CONFIG_MANAGED, `khách ghi khoá AI ⇒ từ chối bằng câu kinh doanh: ${JSON.stringify(r)}`);
      assert.equal(probes, 0, "khách «kiểm tra» khoá AI ⇒ không một request nào tới nhà cung cấp");
      assert.deepEqual(await keyRow(), before, "khoá đang chạy đứng nguyên: trạng thái, kết quả kiểm tra, ô model, đã có khoá");
      assert.equal((await aiConnectionsForOperator()).find((k) => k.connectorKey === "openai-byok")?.status, null, "khách không tạo được khoá mới");
      const opened = await openActiveConnection("gemini-byok");
      assert.ok(opened.ok && opened.secrets.apiKey === GEMINI_KEY, "luồng chạy (bot · Thư viện Media) vẫn đọc được khoá");
      const audits = await (await getDb()).select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "org_connection"));
      assert.ok(!audits.some((a) => a.userId === admin.id && (OPERATOR_AI_CONNECTORS as readonly string[]).includes(a.entityId ?? "")), "lượt bị từ chối không ghi gì: không dòng nhật ký khoá AI nào của quản trị khách");
    });
    // Đối chứng: workspace NHÀ không bị cổng này chặn — lượt của người nhà dừng ở bước SAU cổng (đầu vào sai), không ghi gì.
    const homeSave = await saveConnection(operator, { connectorKey: "anthropic-byok", secrets: { lạ: "x" } });
    assert.ok("error" in homeSave && homeSave.error !== CUSTOMER_AI_CONFIG_MANAGED && /không phải ô bí mật/.test(homeSave.error), `nhà qua cổng: ${JSON.stringify(homeSave)}`);
    const homeStatus = await setConnectionStatus(operator, "gemini-byok", "BẬT");
    assert.ok("error" in homeStatus && /chỉ nhận Bật hoặc Tắt/.test(homeStatus.error), `nhà qua cổng: ${JSON.stringify(homeStatus)}`);
    // Khoá đã bật ⇒ trang của khách nói «AI đang hoạt động» khi bot bật — vẫn không một khoá nội bộ.
    await withOrganization(ORG, async () => {
      const on = await saveSalesChatbotConfig(admin, { ...customerChatbotConfig(await loadSalesChatbotConfig()), enabled: true });
      assert.ok(on.ok, JSON.stringify(on));
      const v2 = await loadChatbotAiView(admin, await loadSalesChatbotConfig(), { manage: true });
      assert.ok(v2.audience === "CUSTOMER" && v2.aiState === "ACTIVE" && internalKeyPaths(v2).length === 0, JSON.stringify(v2));
      const gl2 = await loadGoLive(admin);
      assert.ok(gl2.bot.enabled && gl2.bot.aiReady && gl2.bot.aiReason === null, `vào việc ngay: khoá riêng đã bật ⇒ sẵn sàng — ${JSON.stringify(gl2.bot)}`);
    });
    // Ngưỡng cảnh báo của AI DÙNG CHUNG (tiền của NỀN TẢNG — phát hiện 08/10 khi kiểm HSLC): thông báo tới shop khách bằng câu
    // kinh doanh, không số USD, không tên nguồn nội bộ. Khoá riêng của shop (BYOK — tiền của chính shop) giữ câu có số tiền.
    const ctl = await setOrgAiControl(operator, { orgCode: ORG, limits: { costUsdSoft: 0.5, costUsdHard: 100, platformCreditUsdPerMonth: 50 }, reason: "Kiểm thử ngưỡng cảnh báo AI" });
    assert.ok("ok" in ctl, JSON.stringify(ctl));
    const at = new Date();
    for (const source of ["PLATFORM", "BYOK"] as const) {
      await recordAiUsage({ orgCode: ORG, feature: "copilot", source, provider: source === "PLATFORM" ? "gemini-platform" : "gemini-byok", model: "gemini-3.5-flash", requests: 1, inputTokens: 10, outputTokens: 10, costUsd: 1.25, status: "OK", actorId: null, eventKey: `hi-soft-${source}-${at.getTime()}` });
      const q = await checkAiQuota(ORG, source, { now: at });
      assert.ok(q.ok && q.softExceeded && q.warning !== null, `${source}: vượt ngưỡng cảnh báo, vẫn cho chạy — ${JSON.stringify(q).slice(0, 200)}`);
    }
    await withOrganization(ORG, async () => {
      const notice = async (source: "PLATFORM" | "BYOK") => (await (await getDb()).select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, softWarningKey(source, at))))[0];
      const plat = await notice("PLATFORM");
      assert.ok(plat?.title === CUSTOMER_AI_SOFT_LIMIT_NOTICE.title && plat.body === CUSTOMER_AI_SOFT_LIMIT_NOTICE.body, `AI dùng chung: thông báo của khách là câu kinh doanh — ${JSON.stringify(plat)}`);
      assert.deepEqual(stringHits([plat.title, plat.body], /USD|\$|\d[.,]\d{2}|dùng chung|nền tảng|credit|PLATFORM/i), [], "thông báo của khách: không số USD, không tên nguồn nội bộ");
      const byok = await notice("BYOK");
      assert.ok(byok && /USD/.test(byok.body ?? ""), `đối chứng: khoá riêng của shop giữ câu có số tiền — ${JSON.stringify(byok)}`);
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
}

export async function testSaasHideInternal() {
  testHideInternalPure();
  testHideInternalErrors();
  testHideInternalReview();
  testHideInternalStatic();
  testHideInternalInbox();
  await testHideInternalLive();
  console.log(
    "✓ Che dữ liệu AI nội bộ khỏi khách: DTO máy chủ (chatbot · gói · kết nối · hiệu quả · cockpit · khung thử · phát lại · tự học · sổ tay · góp ý · Copilot · rà lỗi AI · AI dựng cấu hình · vào việc ngay), câu lỗi theo danh sách cho phép, thông báo ngưỡng AI dùng chung không USD, khách không ghi được khoá AI ở lõi (khoá đang chạy đứng nguyên), lưu cấu hình giữ động cơ AI, quét mã nguồn, khối vận hành",
  );
}
