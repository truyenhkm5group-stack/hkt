/**
 * ═══════════ AI CÓ THẬT SỰ TRẢ LỜI KHÁCH NÀY KHÔNG + DẤU VẾT TỪNG TIN KHÁCH — LÕI MÁY CHỦ (sứ mệnh sales-human-takeover) ═══════════
 *
 * Luật hiển thị ở `ai-status-shared.ts`. Tệp này có hai việc, cả hai CHỈ ĐỌC (không bật page, không đổi cổng, không gọi model,
 * không trả lời ngược tin cũ):
 *
 *  1. `conversationAiBlocks` — lý do AI KHÔNG trả lời hội thoại này, hỏi ĐÚNG các hàm mà đường xử lý tin hỏi:
 *     `pageRuntimeMode` (cổng page của nhà — `inboundPageGate`) · `loadModeConfig` + `replyGate` (chế độ vận hành) ·
 *     `messengerPageAiOn` (AI theo page Messenger) · `canUseModule("ai_sales")` + `cfg.enabled` (đầu `chatTurnCore`) ·
 *     `salesAiReadiness` (công tắc người vận hành → hạn mức → chọn khoá, KHÔNG gọi model). Khoá sai (401) chỉ lộ ra khi gọi ⇒
 *     đọc CHỨNG CỨ: lượt gọi AI gần nhất của bot trong sổ AI là lỗi, chưa có lượt nào thành công sau đó.
 *  2. `buildMessageTrace` — dấu vết của MỘT tin khách: Đã nhận → Đủ điều kiện AI → Xếp hàng → Đang soạn → Đã soạn → Đang gửi →
 *     Đã gửi, hoặc dừng ở đâu với mã gì. Dựng từ dữ liệu ĐÃ CÓ: `sales_chat_inbound` (status · note · attempts · last_error ·
 *     claim · processed_at · next_attempt_at), sổ AI `platform_ai_usage` theo hội thoại, dòng `BOT_SENT` của chính thread.
 *     Ghi chú → mã là một bảng TƯỜNG MINH (`classifyInboundNote`) trên đúng các hằng mà đường ghi dùng; ghi chú lạ ⇒
 *     «UNKNOWN: <ghi chú>», không đoán. Bước không có mốc đã lưu ⇒ `at = null` («chưa đo»), không bịa.
 */
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { lastSalesAiCall, salesAiCallsForConversation } from "@/lib/ai-usage/conversation-evidence";
import { forgetMemo, memo } from "@/lib/cache";
import { loadAiEntitlement } from "@/lib/pricing/ai-gate";
import { AI_STOP_MESSAGE, AI_STOP_NOTE } from "@/lib/pricing/ai-entitlement";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { AI_DOWN_HANDOFF_REASON, FANPAGE_STAFF_REASON, ZALO_STAFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { aiBlock, type AiBlock, type MessageTrace, type TraceStage, type TraceStep, TRACE_STAGES } from "@/lib/sales-chatbot/ai-status-shared";
import { DUPLICATE_SOURCE_REASON, loadTransportFacts, NON_CANONICAL_NOTE, ROUTE_SWITCH_NOTE, transportOwnerOf } from "@/lib/sales-chatbot/channel-ownership";
import { BOT_YIELDED_NOTE, CONTROL_COPILOT_NOTE, CONTROL_HUMAN_NOTE, NEEDS_HUMAN_NOTE, TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { loadSalesChatbotConfig, salesAiReadiness, TURN_BOT_OFF_ERROR, TURN_BUSY_ERROR, TURN_EMPTY_ERROR, TURN_MODULE_OFF_ERROR, TURN_NO_CONVERSATION_ERROR } from "@/lib/sales-chatbot/engine";
import { COPILOT_NOTE, MEDIA_ONLY_NOTE, OBSERVE_HUMAN_ARM_NOTE, OBSERVE_NOTE, PAGE_REPLIED_REASON } from "@/lib/sales-chatbot/fanpage";
import { HISTORY_NOTE } from "@/lib/sales-chatbot/history-shared";
import { ALREADY_REPLIED_NOTE, CONV_OPEN_FAILED_NOTE, DEAD_AI_DOWN_NOTE, DEAD_SEND_NOTE_PREFIX, EMPTY_REPLY_NOTE, HANDOFF_SILENT_NOTE } from "@/lib/sales-chatbot/inbound-retry";
import { messengerOwnedPageIds, messengerPageAiOn, PAGE_AI_OFF_NOTE } from "@/lib/sales-chatbot/messenger";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { readPinnedArm, replyGate, type ModeConfig } from "@/lib/sales-chatbot/operating-mode-shared";
import { loadPageRuntime } from "@/lib/sales-chatbot/page-runtime";
import { PAGE_NOT_LIVE_SEND_ERROR, PAGE_OFF_NOTE, PAGE_SHADOW_BOT_OFF_NOTE, PAGE_SHADOW_NOTE, pageRuntimeModeOf, type PageRuntimeMap } from "@/lib/sales-chatbot/page-runtime-shared";
import { ZALO_OUTSIDE_WINDOW } from "@/lib/sales-chatbot/zalo";

// ─────────────────────────── 1. Lý do AI không trả lời ───────────────────────────

export type BlockConv = { id: string; channel: string; pageId: string | null; visitorKey: string | null; state: unknown };

/** Kênh có người trả lời song song (cổng page + chế độ vận hành áp ở đây) — chat web / khung thử không qua hai cổng này. */
function isPageChannel(channel: string): boolean {
  return channel === "FANPAGE" || channel === "ZALO";
}

/**
 * Mọi lý do AI KHÔNG trả lời hội thoại này, theo thứ tự đường xử lý. Rỗng ⇒ AI trả lời (trừ khi người đang cầm — việc của
 * `aiHoldOf`). Mỗi bước đọc lỗi ⇒ ghi lý do «không đọc được», không bao giờ im lặng thành «AI đang trả lời».
 */
export async function conversationAiBlocks(conv: BlockConv): Promise<AiBlock[]> {
  const org = await orgAiFacts();
  const out: AiBlock[] = [];
  const pageId = (conv.pageId ?? "").trim();
  if (isPageChannel(conv.channel)) {
    // ĐÚNG hàm thuần của cổng page (`pageRuntimeModeOf`, cổng `inboundPageGate` gọi qua `pageRuntimeMode`) trên danh sách page đã
    // đọc một lần cho cả tổ chức. Đọc lỗi ⇒ OFF (hẹp) như cổng.
    const mode = org.pageRuntime ? pageRuntimeModeOf({ isHome: org.pageRuntime.isHome }, org.pageRuntime.map, pageId) : "OFF";
    if (mode === "OFF") out.push(aiBlock("PAGE_OFF", "Page chưa bật cho bot Chốt Đơn (workspace nhà) — mọi tin khách bị bỏ qua"));
    if (mode === "SHADOW") out.push(aiBlock("PAGE_SHADOW", "Page đang chạy BÓNG — bot chỉ soạn để so, không gửi khách"));
    if (!org.modeConfig) out.push(aiBlock("ORG_OBSERVE", "Không đọc được chế độ vận hành của tổ chức"));
    else {
      const gate = replyGate(org.modeConfig, conv.visitorKey ?? conv.id, readPinnedArm(conv.state));
      if (gate.mode === "OBSERVE") out.push(aiBlock("ORG_OBSERVE", gate.arm ? "Thử nghiệm AI vs người: hội thoại thuộc nhánh NGƯỜI" : "Tổ chức đang ở chế độ Quan sát — người của shop trả lời"));
      if (gate.mode === "COPILOT") out.push(aiBlock("ORG_COPILOT", "Tổ chức đang ở chế độ Copilot — AI chỉ soạn gợi ý, không gửi"));
    }
    if (conv.channel === "FANPAGE" && pageId) {
      if (org.messengerAiOff === null) out.push(aiBlock("PAGE_AI_OFF", "Không đọc được trạng thái AI của page Messenger"));
      else if (org.messengerAiOff.includes(pageId)) out.push(aiBlock("PAGE_AI_OFF", "AI đang tắt cho page Messenger này"));
    }
  }
  out.push(...org.orgBlocks);
  return out;
}

/** Sự thật CẤP TỔ CHỨC của trạng thái AI — giống nhau ở mọi hội thoại, nên đọc MỘT lần (memo 60 giây theo tổ chức). */
type OrgAiFacts = {
  pageRuntime: { isHome: boolean; map: PageRuntimeMap } | null;
  modeConfig: ModeConfig | null;
  /** Page Messenger (đi đường Messenger) đang TẮT AI; `null` = đọc lỗi. */
  messengerAiOff: string[] | null;
  /** Module · công tắc bot · nguồn AI · chứng cứ lượt gọi gần nhất — theo thứ tự đường xử lý. */
  orgBlocks: AiBlock[];
};

export const AI_STATUS_MEMO_KEY = "sales-chatbot:ai-status-org";
export const AI_STATUS_MEMO_MS = 60_000;

/** Chỉ bài kiểm: số lần thật sự tính lại phần cấp tổ chức (không tính lượt trúng đệm). */
let orgFactComputes = 0;
export function aiStatusOrgComputesForTests(): number {
  return orgFactComputes;
}

/**
 * Hộp thư tự làm mới vài giây một lần — phần cấp tổ chức (đọc gói, cộng sổ AI cả tháng, khoá AI…) KHÔNG được chạy lại mỗi lượt.
 * Đổi cấu hình thì màn hình đúng lại tối đa sau `AI_STATUS_MEMO_MS`; `forgetAiStatus()` để nơi vừa đổi quên ngay.
 */
async function orgAiFacts(): Promise<OrgAiFacts> {
  return memo(AI_STATUS_MEMO_KEY, AI_STATUS_MEMO_MS, async () => {
    orgFactComputes += 1;
    const pageRuntime = await loadPageRuntime().catch(() => null);
    const modeConfig = await loadModeConfig().catch(() => null);
    let messengerAiOff: string[] | null = [];
    try {
      const owned = await messengerOwnedPageIds();
      if (owned.length) {
        const facts = await loadTransportFacts();
        const off: string[] = [];
        for (const id of owned) if (transportOwnerOf(facts, id) === "MESSENGER" && !(await messengerPageAiOn(id))) off.push(id);
        messengerAiOff = off;
      }
    } catch {
      messengerAiOff = null;
    }
    const orgBlocks: AiBlock[] = [];
    // Cổng gói (L5 · lib/pricing/ai-gate.ts) — ĐÚNG hàm đường xử lý tin hỏi (`salesAiPlanGate`), không luật thứ hai. Đọc lỗi ⇒ cổng
    // tự cho (nới), nên ở đây cũng không thêm lý do.
    const plan = await loadAiEntitlement((await currentOrganization()).code).catch(() => null);
    for (const r of plan?.reasons ?? []) orgBlocks.push(aiBlock(r, AI_STOP_MESSAGE[r]));
    if (!(await canUseModule("ai_sales"))) orgBlocks.push(aiBlock("MODULE_OFF", "Module AI bán hàng chưa bật cho tổ chức"));
    const cfg = await loadSalesChatbotConfig().catch(() => null);
    if (!cfg?.enabled) orgBlocks.push(aiBlock("BOT_DISABLED", cfg ? "Bot bán hàng đang TẮT (Cấu hình → Bật bot)" : "Không đọc được cấu hình bot"));
    const ready = await salesAiReadiness().catch((e: unknown) => ({ ok: false as const, code: "NO_AI_SOURCE" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (!ready.ok) {
      orgBlocks.push(aiBlock(ready.code, ready.code === "KILL_SWITCH" ? `AI bị người vận hành nền tảng tạm tắt: ${ready.reason}` : ready.code === "QUOTA" ? `Hết hạn mức AI: ${ready.reason}` : `Không có nguồn AI chạy được: ${ready.reason}`));
    } else {
      const failing = await lastAiCallFailed().catch(() => null);
      if (failing) orgBlocks.push(aiBlock("AI_PROVIDER_ERROR", failing));
    }
    return { pageRuntime, modeConfig, messengerAiOff, orgBlocks };
  });
}

/** Quên phần cấp tổ chức của tổ chức NGỮ CẢNH (vừa đổi cấu hình bot / page / nguồn AI). */
export async function forgetAiStatus(): Promise<void> {
  await forgetMemo(AI_STATUS_MEMO_KEY);
}

/** Chứng cứ «khoá có nhưng gọi hỏng»: lượt gọi AI gần nhất (24 giờ) của bot là lỗi. Kèm câu lỗi đã lưu nếu có. Không đoán. */
async function lastAiCallFailed(now: Date = new Date()): Promise<string | null> {
  const org = await currentOrganization();
  const last = await lastSalesAiCall(org.code, new Date(now.getTime() - 86_400_000));
  if (!last || last.status !== "ERROR") return null;
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [err] = await db
    .select({ error: c.lastError })
    .from(c)
    .where(and(eq(c.handoffReason, AI_DOWN_HANDOFF_REASON), isNotNull(c.lastError), gte(c.updatedAt, new Date(now.getTime() - 86_400_000))))
    .orderBy(desc(c.updatedAt))
    .limit(1);
  return `Lượt gọi AI gần nhất của bot (${last.at.toISOString()}) hỏng${err?.error ? `: ${err.error.slice(0, 160)}` : ""}`;
}

// ─────────────────────────── 2. Dấu vết từng tin khách ───────────────────────────

export type TraceTransport = "MESSENGER" | "PANCAKE" | "ZALO" | "WEB";

/** Dừng ở bước nào, mã gì, và tin có đi tới đích theo đúng thiết kế không (`kind`). */
export type NoteVerdict = { code: string; stop: TraceStage; kind: "SKIP" | "FAIL" | "WARN" };

/** Ghi chú khớp NGUYÊN VĂN ⇒ mã. Mọi chữ ở đây là hằng của đường ghi — không gõ lại chữ nào. */
const EXACT: ReadonlyArray<[string, NoteVerdict]> = [
  [PAGE_OFF_NOTE, { code: "AI_SKIPPED_PAGE_OFF", stop: "ELIGIBLE", kind: "SKIP" }],
  [PAGE_SHADOW_NOTE, { code: "AI_SKIPPED_PAGE_SHADOW", stop: "ELIGIBLE", kind: "SKIP" }],
  [PAGE_SHADOW_BOT_OFF_NOTE, { code: "AI_SKIPPED_DISABLED", stop: "ELIGIBLE", kind: "SKIP" }],
  [PAGE_REPLIED_REASON, { code: "AI_SKIPPED_PAGE_ANSWERED", stop: "ELIGIBLE", kind: "SKIP" }],
  [ALREADY_REPLIED_NOTE, { code: "AI_SKIPPED_ALREADY_REPLIED", stop: "ELIGIBLE", kind: "SKIP" }],
  [FANPAGE_STAFF_REASON, { code: "AI_SKIPPED_HUMAN_COOLDOWN", stop: "ELIGIBLE", kind: "SKIP" }],
  [ZALO_STAFF_REASON, { code: "AI_SKIPPED_HUMAN_COOLDOWN", stop: "ELIGIBLE", kind: "SKIP" }],
  [TAKEOVER_REASON, { code: "AI_SKIPPED_HUMAN_TAKEOVER", stop: "ELIGIBLE", kind: "SKIP" }],
  [CONTROL_HUMAN_NOTE, { code: "AI_SKIPPED_HUMAN_TAKEOVER", stop: "ELIGIBLE", kind: "SKIP" }],
  [AI_DOWN_HANDOFF_REASON, { code: "AI_SKIPPED_AI_DOWN_COOLDOWN", stop: "ELIGIBLE", kind: "SKIP" }],
  [CONTROL_COPILOT_NOTE, { code: "AI_SKIPPED_COPILOT", stop: "ELIGIBLE", kind: "SKIP" }],
  [COPILOT_NOTE, { code: "AI_SKIPPED_COPILOT", stop: "ELIGIBLE", kind: "SKIP" }],
  [OBSERVE_NOTE, { code: "AI_SKIPPED_ORG_OBSERVE", stop: "ELIGIBLE", kind: "SKIP" }],
  [OBSERVE_HUMAN_ARM_NOTE, { code: "AI_SKIPPED_EXPERIMENT_HUMAN_ARM", stop: "ELIGIBLE", kind: "SKIP" }],
  [PAGE_AI_OFF_NOTE, { code: "AI_SKIPPED_PAGE_AI_OFF", stop: "ELIGIBLE", kind: "SKIP" }],
  [ZALO_OUTSIDE_WINDOW, { code: "AI_SKIPPED_OUTSIDE_WINDOW", stop: "ELIGIBLE", kind: "SKIP" }],
  [MEDIA_ONLY_NOTE, { code: "AI_SKIPPED_MEDIA_ONLY", stop: "ELIGIBLE", kind: "SKIP" }],
  [HISTORY_NOTE, { code: "HISTORY_IMPORTED", stop: "ELIGIBLE", kind: "SKIP" }],
  [TURN_BOT_OFF_ERROR, { code: "AI_SKIPPED_DISABLED", stop: "ELIGIBLE", kind: "SKIP" }],
  [TURN_MODULE_OFF_ERROR, { code: "AI_SKIPPED_MODULE_OFF", stop: "ELIGIBLE", kind: "SKIP" }],
  [TURN_NO_CONVERSATION_ERROR, { code: "AI_CONTEXT_ERROR", stop: "COMPOSING", kind: "FAIL" }],
  [TURN_EMPTY_ERROR, { code: "AI_CONTEXT_ERROR", stop: "COMPOSING", kind: "FAIL" }],
  [TURN_BUSY_ERROR, { code: "AI_QUEUE_BUSY", stop: "QUEUED", kind: "SKIP" }],
  [CONV_OPEN_FAILED_NOTE, { code: "AI_CONTEXT_ERROR", stop: "COMPOSING", kind: "FAIL" }],
  [HANDOFF_SILENT_NOTE, { code: "AI_HANDED_OFF", stop: "COMPOSED", kind: "SKIP" }],
  [EMPTY_REPLY_NOTE, { code: "AI_EMPTY_RESPONSE", stop: "COMPOSED", kind: "FAIL" }],
  [BOT_YIELDED_NOTE, { code: "AI_YIELDED_TO_HUMAN", stop: "SENDING", kind: "SKIP" }],
  [PAGE_NOT_LIVE_SEND_ERROR, { code: "AI_SEND_BLOCKED_PAGE_NOT_LIVE", stop: "SENDING", kind: "SKIP" }],
  // 0233: đường nhận tin KHÔNG canonical ghi tin khách (đường chính của page đã lưu mà không chạy) — lưu cho người, không kích AI.
  [NON_CANONICAL_NOTE, { code: "AI_SKIPPED_NON_CANONICAL_ROUTE", stop: "ELIGIBLE", kind: "SKIP" }],
  // 0233: bản sao của một tin khách đã tới qua đường kia (đường chính vừa đổi) — bản của đường chính được AI trả lời.
  [DUPLICATE_SOURCE_REASON, { code: "AI_SKIPPED_DUPLICATE_SOURCE", stop: "ELIGIBLE", kind: "SKIP" }],
  [ROUTE_SWITCH_NOTE, { code: "AI_SKIPPED_ROUTE_SWITCHED", stop: "ELIGIBLE", kind: "SKIP" }],
  [AI_STOP_NOTE.TRIAL_EXPIRED, { code: "AI_SKIPPED_TRIAL_EXPIRED", stop: "ELIGIBLE", kind: "SKIP" }],
  [AI_STOP_NOTE.TRIAL_QUOTA_EXHAUSTED, { code: "AI_SKIPPED_TRIAL_QUOTA_EXHAUSTED", stop: "ELIGIBLE", kind: "SKIP" }],
  [AI_STOP_NOTE.WORKSPACE_SUSPENDED, { code: "AI_SKIPPED_WORKSPACE_SUSPENDED", stop: "ELIGIBLE", kind: "SKIP" }],
];

/** Mọi ghi chú đường xử lý tin ghi vào `sales_chat_inbound.note` mà bảng này biết — bài kiểm duyệt từng dòng. */
export const KNOWN_INBOUND_NOTES: readonly string[] = [...EXACT.map(([n]) => n), NEEDS_HUMAN_NOTE, `${NEEDS_HUMAN_NOTE}: Khách sỉ`, DEAD_AI_DOWN_NOTE, `${DEAD_SEND_NOTE_PREFIX}lỗi mạng`];

/**
 * Lỗi nhà cung cấp AI (câu đã lưu ở `last_error` khi bot chuyển người vì AI hỏng) ⇒ mã. Chỉ nhận những dấu hiệu nói rõ; còn lại
 * là lỗi model chung, câu gốc vẫn hiện ở `detail`. HÀM THUẦN.
 */
export function classifyProviderError(error: string | null): string {
  const e = (error ?? "").toLowerCase();
  if (/ai đang tắt/.test(e)) return "AI_SKIPPED_KILL_SWITCH";
  if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid[ _-]?(x-)?api[ _-]?key|api key not valid|permission[ _-]denied/.test(e)) return "AI_PROVIDER_AUTH_ERROR";
  if (/\b429\b|quota|hạn mức|credit|insufficient|billing|rate[ _-]?limit|resource[ _-]exhausted/.test(e)) return "AI_PROVIDER_QUOTA";
  if (/chưa cấu hình ai|chưa dùng được khoá ai|thiếu khoá|không có ai|chưa có ai dùng chung|chưa bật ai dùng chung/.test(e)) return "AI_PROVIDER_NOT_CONFIGURED";
  if (/context|too long|maximum.*tokens|prompt is too long|quá dài/.test(e)) return "AI_CONTEXT_ERROR";
  return "AI_MODEL_ERROR";
}

/** Ghi chú của MỘT dòng tin khách ⇒ mã + bước dừng. `null` = không ghi chú (đường bình thường). Ghi chú lạ ⇒ UNKNOWN. HÀM THUẦN. */
export function classifyInboundNote(note: string | null, ctx: { status: string; lastError: string | null; transport: TraceTransport }): NoteVerdict | { code: string; stop: null; kind: "UNKNOWN" } | null {
  if (note === null || note === "") return null;
  if (note === DEAD_AI_DOWN_NOTE) return { code: classifyProviderError(ctx.lastError), stop: "COMPOSING", kind: "FAIL" };
  if (note.startsWith(DEAD_SEND_NOTE_PREFIX)) return { code: ctx.transport === "MESSENGER" ? "MESSENGER_SEND_FAILED" : ctx.transport === "ZALO" ? "ZALO_SEND_FAILED" : "PANCAKE_SEND_FAILED", stop: "SENDING", kind: "FAIL" };
  if (note === NEEDS_HUMAN_NOTE || note.startsWith(`${NEEDS_HUMAN_NOTE}: `)) return { code: "AI_SKIPPED_NEEDS_HUMAN", stop: "ELIGIBLE", kind: "SKIP" };
  const hit = EXACT.find(([n]) => n === note);
  if (hit) {
    if (hit[0] === CONV_OPEN_FAILED_NOTE && ctx.status === "DEAD") return { code: "AI_QUEUE_FAILED", stop: "QUEUED", kind: "FAIL" };
    return hit[1];
  }
  return { code: `UNKNOWN: ${note}`, stop: null, kind: "UNKNOWN" };
}

export type TraceRow = {
  status: string;
  note: string | null;
  attempts: number;
  lastError: string | null;
  claimId: string | null;
  claimedAt: Date | null;
  processedAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
};

export type TraceEvidence = {
  transport: TraceTransport;
  /** Sổ AI của hội thoại (`platform_ai_usage.conversation_id` / `ref`). */
  aiUsage: readonly { at: Date; status: string }[];
  /** Mốc các dòng `BOT_SENT` của thread. */
  botSentAt: readonly Date[];
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Dấu vết của MỘT tin khách. HÀM THUẦN (nhận `now`). */
export function buildMessageTrace(row: TraceRow, ev: TraceEvidence, now: Date): MessageTrace {
  const step = (stage: TraceStage, state: TraceStep["state"], at: Date | null, source: string): TraceStep => ({ stage, state, at: iso(at), source });
  const received = step("RECEIVED", "DONE", row.createdAt, "sales_chat_inbound.created_at");
  const verdict = classifyInboundNote(row.note, { status: row.status, lastError: row.lastError, transport: ev.transport });
  const inWindow = (at: Date) => (row.claimedAt ? at.getTime() >= row.claimedAt.getTime() - 1_000 : at.getTime() >= row.createdAt.getTime()) && (row.processedAt ? at.getTime() <= row.processedAt.getTime() + 120_000 : true);
  const aiOk = ev.aiUsage.filter((u) => u.status === "OK" && inWindow(u.at)).sort((a, b) => a.at.getTime() - b.at.getTime())[0]?.at ?? null;
  const aiQuota = ev.aiUsage.some((u) => u.status === "BLOCKED_QUOTA" && inWindow(u.at));
  const sentAt = [...ev.botSentAt].filter(inWindow).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  // Mốc đã lưu của từng bước — bước nào không có cột riêng thì `null` («chưa đo»).
  const atOf: Record<TraceStage, { at: Date | null; source: string }> = {
    RECEIVED: { at: row.createdAt, source: "sales_chat_inbound.created_at" },
    ELIGIBLE: { at: null, source: "sales_chat_inbound.note (cổng của đường xử lý — không lưu mốc riêng)" },
    QUEUED: { at: null, source: "sales_chat_inbound.status / next_attempt_at" },
    COMPOSING: { at: row.claimedAt, source: "sales_chat_inbound.claimed_at (mốc giành tin)" },
    COMPOSED: { at: aiOk, source: "platform_ai_usage (lượt AI thành công của hội thoại; câu mẫu không gọi AI ⇒ chưa đo)" },
    SENDING: { at: null, source: "sales_chat_inbound (dòng BOT_SENT ghi trước khi gửi)" },
    SENT: { at: sentAt ?? row.processedAt, source: sentAt ? "sales_chat_inbound BOT_SENT.created_at" : "sales_chat_inbound.processed_at" },
  };
  const upTo = (stop: TraceStage, stopState: TraceStep["state"], stopAt: Date | null, stopSource: string): TraceStep[] => {
    const idx = TRACE_STAGES.indexOf(stop);
    return TRACE_STAGES.map((s, i) => (i === 0 ? received : i < idx ? step(s, "DONE", atOf[s].at, atOf[s].source) : i === idx ? step(s, stopState, stopAt, stopSource) : step(s, "NOT_REACHED", null, atOf[s].source)));
  };

  if (row.status === "PENDING") {
    if (verdict && verdict.kind !== "UNKNOWN" && verdict.code === "AI_QUEUE_BUSY") return { steps: upTo("QUEUED", "CURRENT", null, atOf.QUEUED.source), code: "AI_QUEUE_BUSY", detail: row.note, outcome: "IN_PROGRESS" };
    if (row.claimId) {
      const steps = upTo("COMPOSING", "CURRENT", row.claimedAt, atOf.COMPOSING.source);
      steps[1] = step("ELIGIBLE", "NOT_MEASURED", null, atOf.ELIGIBLE.source);
      return { steps, code: null, detail: null, outcome: "IN_PROGRESS" };
    }
    const retry = row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime();
    const steps = upTo("QUEUED", "CURRENT", retry ? row.nextAttemptAt : null, atOf.QUEUED.source);
    steps[1] = step("ELIGIBLE", "NOT_MEASURED", null, atOf.ELIGIBLE.source);
    return { steps, code: retry || row.attempts > 0 ? "AI_QUEUE_RETRY" : null, detail: row.lastError ?? row.note, outcome: "IN_PROGRESS" };
  }

  if (verdict && verdict.kind === "UNKNOWN") {
    return { steps: TRACE_STAGES.map((s, i) => (i === 0 ? received : step(s, "NOT_MEASURED", null, atOf[s].source))), code: verdict.code, detail: row.note, outcome: "UNKNOWN" };
  }
  if (verdict) {
    const code = verdict.code === "AI_MODEL_ERROR" && aiQuota ? "AI_PROVIDER_QUOTA" : verdict.code;
    return { steps: upTo(verdict.stop, "FAILED", row.processedAt, atOf[verdict.stop].source), code, detail: row.status === "DEAD" ? (row.lastError ?? row.note) : row.note, outcome: "STOPPED" };
  }
  if (row.status === "DEAD") return { steps: upTo("QUEUED", "FAILED", row.processedAt, atOf.QUEUED.source), code: "AI_QUEUE_FAILED", detail: row.lastError, outcome: "STOPPED" };
  // DONE không ghi chú = đi trọn đường.
  return { steps: TRACE_STAGES.map((s, i) => (i === 0 ? received : step(s, "DONE", atOf[s].at, atOf[s].source))), code: null, detail: null, outcome: "SENT" };
}

/** Dấu vết cho các tin khách của MỘT hội thoại nhắn tin (đọc sổ AI một lần). Lỗi đọc sổ AI ⇒ bước «Đã soạn» chưa đo, không chặn. */
export async function loadAiUsageForConversation(conversationId: string, since: Date): Promise<{ at: Date; status: string }[]> {
  try {
    const org = await currentOrganization();
    return await salesAiCallsForConversation(org.code, conversationId, since);
  } catch {
    return [];
  }
}

export async function transportOfConversation(conv: { channel: string; pageId: string | null }): Promise<TraceTransport> {
  if (conv.channel === "ZALO") return "ZALO";
  if (conv.channel !== "FANPAGE") return "WEB";
  const owner = conv.pageId ? transportOwnerOf(await loadTransportFacts().catch(() => ({ pancake: { active: false, pageId: null }, messenger: { active: false, pageIds: [] } })), conv.pageId) : null;
  return owner === "MESSENGER" ? "MESSENGER" : "PANCAKE";
}
