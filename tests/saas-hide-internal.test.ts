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
 *  (e) người vận hành sửa được cấu hình AI của workspace khách (khối «AI của workspace»), khách thì không.
 * Không ghim ngày (luật 50 · 65); khoá bí mật là khoá KIỂM THỬ, trả lại nguyên trạng trong finally.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { loadConnectionsView } from "@/lib/connectors/service";
import type { ConnectionsView } from "@/lib/connectors/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY, type ChatView, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig, openConversation } from "@/lib/sales-chatbot/engine";
import type { SalesHealth } from "@/lib/sales-chatbot/health-shared";
import type { MessageTrace } from "@/lib/sales-chatbot/ai-status-shared";
import { loadInboxThread } from "@/lib/sales-chatbot/inbox";
import type { InboxThread } from "@/lib/sales-chatbot/inbox-shared";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { loadOperatorOrgAiConfig, operateOrgAiConnection, saveOrgChatbotEngine } from "@/lib/saas/operator-ai";
import {
  CHATBOT_ENGINE_FIELDS,
  CUSTOMER_AI_INCIDENT_LABEL,
  customerAiBlocks,
  customerAiState,
  customerChatbotConfig,
  customerChatView,
  customerConnectionsView,
  customerFacing,
  customerInboxThread,
  customerMessageTrace,
  customerPlaybookRun,
  customerReadinessChecks,
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

/** Chữ khách không được đọc trong payload hộp thư: mã nhà cung cấp, tên nhà cung cấp / model, «token / provider / model», khoá AI. */
const INBOX_FORBIDDEN = /PROVIDER|AI_MODEL|AI_CONTEXT|KILL_SWITCH|NOT_CONFIGURED|\b(token|provider|model)\b|gemini|openai|anthropic|claude|khoá AI|nguồn AI|RESOURCE_EXHAUSTED|429/i;

export function testHideInternalInbox() {
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
  } as unknown as InboxThread;
  const ct = customerInboxThread(thread);
  assert.deepEqual(stringHits(ct, INBOX_FORBIDDEN), [], "payload hộp thư của khách sạch");
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

  // Câu lỗi lượt AI.
  assert.equal(customerSafeAiError("Chưa dùng được khoá AI «gemini-byok»: Kết nối chưa bật"), CUSTOMER_AI_INCIDENT_LABEL);
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
] as const;

const FORBIDDEN_WORD = /\b(token|tokens|USD|Gemini|OpenAI|Anthropic|model|provider|prompt)\b|nhà cung cấp AI/i;

/** Miễn trừ: [tệp, đoạn chữ hiển thị chứa từ cấm, lý do nó chỉ tới nhà / người vận hành]. Danh sách ĐÓNG. */
const EXEMPT: [string, string, string][] = [
  ["app/(dashboard)/settings/plan/page.tsx", "Lượt · token · tiền ƯỚC TÍNH theo bảng giá model", "Khung «Dùng AI» chỉ dựng khi `ai` khác null — `customerFacing(user.organization) ? null : loadOrgAiUsage(...)`."],
  ["app/(dashboard)/settings/plan/page.tsx", "không gọi model", "Câu gợi ý của cùng khung «Dùng AI» (chỉ nhà)."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "Anthropic / OpenAI) — tổ chức trả tiền token", "Câu gợi ý nhánh `customer ? … : (nhà)`."],
  ["app/(dashboard)/ai/sales-chatbot/performance/page.tsx", "token thật × bảng giá model", "Khối «Chi phí AI & ROI» chỉ dựng khi `r.cost` khác null — khách: `withMoney = aiPerformanceWithMoney(...) = false` ⇒ `cost = null`."],
  ["app/(dashboard)/ai/sales-chatbot/performance/experiment-block.tsx", "token thật × bảng giá model", "Đoạn giải thích tiền AI của khối AI vs Người chỉ dựng khi `report.withMoney` — `loadExperimentReport({ withMoney: aiPerformanceWithMoney(user, manage) })`, khách ⇒ false ⇒ không đọc sổ AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "nhập Page ID và page access token", "Hướng dẫn nối fanpage qua Pancake — token của KÊNH do chính shop dán (chẩn đoán / cấu hình kết nối thật), không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "lấy refresh token ở API Explorer", "Hướng dẫn nối Zalo OA của chính shop — token của KÊNH, không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "Máy tự làm mới token và lưu cặp mới", "Cùng hướng dẫn Zalo OA — token của KÊNH."],
  ["app/(dashboard)/ai/sales-chatbot/history-panel.tsx", "page access token của shop", "Chẩn đoán kết nối fanpage của chính shop — token của KÊNH, không phải token AI."],
  ["app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx", "page access token của shop", "Cùng chẩn đoán kết nối fanpage — token của KÊNH."],
  ["app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx", "Lượt gần nhất xong", "Phần « · ~x USD» chỉ hiện khi `run.stats.costUsd !== null` — máy chủ đặt null cho khách (`customerPlaybookRun`)."],
  ["app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx", "Nhà cung cấp AI", "Dòng «Nhà cung cấp AI» trong nhánh `customer ? null : (…)` VÀ sau cổng `detail` (ai_sales:manage)."],
  ["app/(dashboard)/ai/sales-chatbot/cockpit/page.tsx", "Thành công cuối", "Ô số lượt OK / lỗi của cùng dòng «Nhà cung cấp AI» (chỉ nhà, sau cổng `detail`)."],
];

function visibleTexts(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|import\b|export \* from)/.test(l))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
  const out: string[] = [];
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) out.push(m[0].slice(1, -1));
  // Chữ JSX giữa hai thẻ; biểu thức `{…}` xen giữa bị bỏ (tên biến không phải chữ hiển thị); đoạn trông như mã thì bỏ qua.
  for (const m of code.matchAll(/>([^<>]+)</g)) if (!/=>|&&|\|\||;\s*$/.test(m[1])) out.push(m[1].replace(/\{[^{}]*\}/g, " "));
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
  assert.ok(read("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx").includes('const thread = loaded && "thread" in loaded && customerFacing(user.organization) ? { ...loaded, thread: customerInboxThread(loaded.thread) } : loaded;'), "hộp thư: hội thoại của khách lọc ở máy chủ trước khi vào props");
  assert.equal((actions.match(/testView\(user,/g) ?? []).length, 3, "cả hai action khung thử trả view qua bộ lọc của khách");

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
    // Khoá đã bật ⇒ trang của khách nói «AI đang hoạt động» khi bot bật — vẫn không một khoá nội bộ.
    await withOrganization(ORG, async () => {
      const on = await saveSalesChatbotConfig(admin, { ...customerChatbotConfig(await loadSalesChatbotConfig()), enabled: true });
      assert.ok(on.ok, JSON.stringify(on));
      const v2 = await loadChatbotAiView(admin, await loadSalesChatbotConfig(), { manage: true });
      assert.ok(v2.audience === "CUSTOMER" && v2.aiState === "ACTIVE" && internalKeyPaths(v2).length === 0, JSON.stringify(v2));
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
}

export async function testSaasHideInternal() {
  testHideInternalPure();
  testHideInternalStatic();
  testHideInternalInbox();
  await testHideInternalLive();
  console.log("✓ Che dữ liệu AI nội bộ khỏi khách: DTO máy chủ (chatbot · gói · kết nối · hiệu quả · cockpit · khung thử), lưu cấu hình giữ động cơ AI, quét mã nguồn, khối vận hành");
}
