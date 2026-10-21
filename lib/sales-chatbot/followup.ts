/**
 * ═══════════ FOLLOW-UP TỰ ĐỘNG — CHỈ MÁY CHỦ (0185 · cổng vòng đời P0 11/10/2026) ═══════════
 *
 * Job `sales-followup` (mỗi 5 phút, từng tổ chức có module AI bán hàng): hội thoại fanpage `WAITING` tới mốc follow-up ⇒
 * GIÀNH dòng (một lượt duy nhất) ⇒ CỔNG lần 1 (trước AI) ⇒ AI của CHÍNH shop viết MỘT câu nhắc theo bước khách đang dừng
 * (giọng sổ tay, KHÔNG nêu giá) ⇒ CỔNG lần 2 trên dữ liệu đọc LẠI ⇒ hàng rào khẳng định (claim-guard) ⇒ GIÀNH khoá gửi ⇒ gửi
 * qua Pancake / Messenger ⇒ ghi vào hội thoại ⇒ đặt mốc kế tiếp. Lỗi một hội thoại không chặn hội thoại khác.
 *
 * ─── VÌ SAO CỔNG ĐỌC VÒNG ĐỜI, KHÔNG ĐỌC SỔ BOT (ca KimThu Le, hội thoại a8c10daf…, 11/10/2026) ───
 * Bot lên đơn #71B31FE3; tổ chức bật «đơn đủ thông tin = đã xác nhận» nên lõi đơn ghi thẳng «Đã xác nhận» ngay ở
 * `create_draft_order`. `state.confirmed` chỉ do `confirm_order` ghi ⇒ vẫn trống ⇒ `markWaitingForCustomer` xếp lịch 1 · 6 · 22
 * giờ, và cổng cũ (`st.confirmed || st.declined || st.handoff`) cho qua; lời nhắc còn dặn «Khách ĐÃ CÓ đơn nháp chưa xác nhận —
 * nhắc khách xác nhận đơn» ⇒ 11:54 «đơn … đã lên xong, em xác nhận để gửi đi luôn nhé ạ?», 16:54, 08:54 «… có muốn tiếp tục chốt
 * đơn». Cổng nay đọc `lifecycle.ts` (đơn THẬT nối với hội thoại · chứng từ thu · ORDER_OUTCOME · lời từ chối nhận tin · người
 * tiếp quản) và các dấu vết của hội thoại (`decideFollowup`, hàm thuần — thứ tự kiểm là luật).
 *
 * ─── CHỐNG TRÙNG ───
 * (1) giành mốc: `UPDATE … WHERE next_followup_at = <mốc>` — hai lượt job chồng nhau thì một lượt thắng; (2) khoá gửi: dòng
 * `followup.decided` quyết định GỬI được chèn TRƯỚC khi gọi Pancake với `dedupe_key` duy nhất (hội thoại · đợt im lặng · lần nhắc)
 * — chèn thua ⇒ không gửi; lượt chết giữa chừng ⇒ khoá còn đó ⇒ không ai gửi lại (thà thiếu còn hơn trùng); (3) cùng kịch bản
 * đã gửi trong `FOLLOWUP_SAME_SCRIPT_WINDOW_MS` ⇒ không gửi; (4) nguồn gửi khác của ERP (lượt AI trả lời, xác nhận đặt lại của máy
 * ghi đơn…) đã nhắn sau tin cuối của bot ⇒ không gửi.
 *
 * ─── VẾT ───
 * Mỗi lượt để lại ĐÚNG MỘT `followup.decided` (gửi / chặn · mã lý do · ảnh chụp vòng đời · kết quả kiểm · mã đơn · model ·
 * phiên bản + dấu băm lời nhắc), không chép chữ khách / SĐT / chữ câu nhắc vào vết.
 */
import { and, asc, eq, gt, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { compatTableColumns } from "@/lib/db/serve-compat-columns";
import { estimateCostUsd } from "@/lib/ai/provider";
import { aiKillSwitchDenial } from "@/lib/ai-usage/control";
import { aiCallKey, recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { runningVersion } from "@/lib/version";
import { claimFactsLoader, guardOutgoing, type ClaimKind } from "@/lib/sales-chatbot/claim-guard";
import { SALES_TONE_LABEL, type SalesChatbotConfig, salesBotBillingSource } from "@/lib/sales-chatbot/config";
import { appendBotMessage, conversationView, loadSalesChatbotConfig, salesChatProvider } from "@/lib/sales-chatbot/engine";
import { claimConversationEvent, patchConversationEventPayload, recordConversationEvent } from "@/lib/sales-chatbot/events";
import { settleConfirmedConversation } from "@/lib/sales-chatbot/confirmed-settle";
import { PAGE_REPLY, type FanpageDeps } from "@/lib/sales-chatbot/fanpage";
import { sendBotText } from "@/lib/sales-chatbot/messenger";
import { pageRuntimeMode } from "@/lib/sales-chatbot/page-runtime";
import {
  BOT_ECHO_GRACE_MS,
  decideFollowup,
  pendingPriorOrderReason,
  FOLLOWUP_PROMPT_VERSION,
  FOLLOWUP_REASON_LABEL,
  FOLLOWUP_SAME_SCRIPT_WINDOW_MS,
  FOLLOWUP_TRACE_VERSION,
  followupScriptOf,
  followupSendPermanent,
  followupSlotKey,
  nextFollowupAt,
  withinMessagingWindow,
  type FollowupConvSnap,
  type FollowupGateDecision,
  type FollowupReason,
  type FollowupScript,
} from "@/lib/sales-chatbot/followup-shared";
import { loadFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { CONFIRMED_ORDER_WATCH_DAYS, DWELL_SLA } from "@/lib/constants/shipment-status-age";
import { linkedOrdersFor, loadLifecycle, UNKNOWN_LIFECYCLE, type LifecycleConvRow, type LifecycleSnapshot } from "@/lib/sales-chatbot/lifecycle";
import { publishedPlaybookText } from "@/lib/sales-chatbot/playbook";
import { promptStampOf } from "@/lib/sales-chatbot/prompt-stamp";
import { findReturningCustomer, isRepeatBuyer, returningCustomerPrompt } from "@/lib/sales-chatbot/returning";
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import { SALES_STAGE_LABEL } from "@/lib/sales-chatbot/stages";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export { followupSendPermanent } from "@/lib/sales-chatbot/followup-shared";

const BATCH = 20;
/** AI tạm không dùng được (công tắc / hạn mức / khoá) ⇒ thử lại sau chừng này, không bỏ lượt. */
const RETRY_LATER_MS = 15 * 60_000;
/** Tên quy trình trong vết — job đăng ký ở lib/sync/jobs.ts (lịch không đổi). */
const WORKFLOW = "sales-followup";

export type FollowupRunResult = { due: number; sent: number; stopped: number; deferred: number; errors: number; detail: string[] };

export function followupSystemPrompt(cfg: Pick<SalesChatbotConfig, "botName" | "tone">, shop: string, stage: string, attempt: number, total: number, hasDraft: boolean, playbook: string, returning: string = "", repeatBuyer: boolean = false, infoCollected: boolean = false): string {
  const step =
    attempt >= total
      ? "Đây là lần nhắc CUỐI: hỏi lịch sự khách có muốn tiếp tục không / cần tư vấn thêm gì; không nài, không gây áp lực."
      : attempt === 1
        ? "Lần nhắc đầu: nhắc nhẹ, hỏi khách còn băn khoăn gì để shop hỗ trợ."
        : "Nhắc lần giữa: nhấn MỘT lợi ích của sản phẩm khách đang quan tâm, hoặc gỡ băn khoăn khách đã nêu trong hội thoại.";
  return [
    `Bạn là «${cfg.botName}», nhân viên bán hàng của shop «${shop}». Giọng: ${SALES_TONE_LABEL[cfg.tone]}.`,
    "Khách đã IM LẶNG sau tin nhắn gần nhất của shop. Viết ĐÚNG MỘT tin nhắn follow-up ngắn (1–2 câu), tiếng Việt, dựa trên hội thoại bên dưới.",
    // Đơn nháp CHƯA xác nhận (11/10/2026 — KimThu Le: «đơn … đã lên xong, em xác nhận để gửi đi luôn nhé ạ?»): không được nói đơn
    // đã lên / đã chốt — claim-guard chặn câu ấy, và nhắc xác nhận chỉ hợp lệ khi đơn CHƯA xác nhận (máy chủ đã kiểm).
    `Khách đang dừng ở bước: ${stage}.${hasDraft ? " Shop đã soạn đơn nháp mà khách CHƯA xác nhận — nhắc khách xem lại và xác nhận; KHÔNG nói đơn đã lên / đã chốt / đã xác nhận." : ""}`,
    infoCollected ? "Khách ĐÃ gửi SĐT và địa chỉ — KHÔNG hỏi lại thông tin đó." : "",
    `Lần nhắc ${attempt}/${total}. ${step}`,
    "TUYỆT ĐỐI không nêu giá, số tiền, khuyến mãi, thời gian giao; không bịa thông tin; không nhắc rằng mình là AI hay tin tự động.",
    // Khách cũ (03/10/2026): nhắc ĐẶT LẠI cụ thể như lần trước thay vì «còn băn khoăn gì không». CHỈ khách ĐÃ TỪNG MUA (10/10/2026,
    // «Trần Thanh Hà»: khách mới từ quảng cáo nhận «lần này em gửi chị 1kg về địa chỉ cũ nhé?» — lời chào quảng cáo của page đã
    // đủ dựng khối thông tin khách và câu này được thêm vô điều kiện).
    returning && repeatBuyer ? `${returning}\nTin nhắc cho KHÁCH CŨ: đề xuất ĐẶT LẠI cụ thể như lần trước (món, giao về địa chỉ cũ), MỘT câu hỏi có / không; vẫn KHÔNG nêu giá.` : returning,
    repeatBuyer ? "" : "Khách CHƯA từng mua hàng của shop: KHÔNG nói «lần trước», «địa chỉ cũ», «như cũ», «đặt lại».",
    playbook ? `Sổ tay giọng điệu của shop:\n${playbook.slice(0, 1500)}` : "",
    "Chỉ trả về nội dung tin nhắn.",
  ]
    .filter(Boolean)
    .join("\n");
}

type DueRow = typeof schema.salesChatConversations.$inferSelect;

const snapOf = (r: Pick<DueRow | LifecycleConvRow, "status" | "lastBotAt" | "lastCustomerAt" | "lastStaffAt" | "waitingSince" | "humanCooldownUntil">): FollowupConvSnap => ({
  status: r.status,
  lastBotAt: r.lastBotAt,
  lastCustomerAt: r.lastCustomerAt,
  lastStaffAt: r.lastStaffAt,
  waitingSince: r.waitingSince,
  humanCooldownUntil: r.humanCooldownUntil,
});

type GateSignals = { pageReplyAfter: boolean; customerInboundAfter: boolean; otherBotSendAfter: boolean; sameScriptRecently: boolean };
type GateChecks = GateSignals & { status: string; withinWindow: boolean; staffCooldown: boolean };
type GateResult = { decision: FollowupGateDecision; lifecycle: LifecycleSnapshot; script: FollowupScript; checks: GateChecks | null; conv: LifecycleConvRow | null };

/** Dấu vết của hội thoại sau tin cuối của bot — tin phía page · tin khách · tiếng vọng bot muộn · kịch bản vừa gửi. Ném khi CSDL lỗi. */
async function gateSignals(conversationId: string, pageId: string | null, threadId: string | null, since: Date | null, lastCustomerAt: Date | null, script: FollowupScript, now: Date): Promise<GateSignals> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const e = schema.salesConversationEvents;
  const exists = async (where: ReturnType<typeof and>) => (await db.select({ id: t.id }).from(t).where(where).limit(1)).length > 0;
  const thread = pageId && threadId && since ? and(eq(t.pageId, pageId), eq(t.threadId, threadId)) : null;
  const [sameScript] = await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.conversationId, conversationId), eq(e.type, "followup.decided"), sql`${e.payload}->>'decision' = 'SEND'`, sql`${e.payload}->>'script' = ${script}`, gt(e.occurredAt, new Date(Math.max(now.getTime() - FOLLOWUP_SAME_SCRIPT_WINDOW_MS, lastCustomerAt?.getTime() ?? 0)))))
    .limit(1);
  if (!thread || !since) return { pageReplyAfter: false, customerInboundAfter: false, otherBotSendAfter: false, sameScriptRecently: Boolean(sameScript) };
  return {
    pageReplyAfter: await exists(and(thread, eq(t.note, PAGE_REPLY), gt(t.createdAt, since))),
    // Tin KHÁCH: mọi dòng không phải phía page / tiếng vọng bot; dòng nhập lịch sử (`imported_at`) là tin CŨ chép lại — không tính.
    customerInboundAfter: await exists(and(thread, or(isNull(t.note), notInArray(t.note, [PAGE_REPLY, "BOT_SENT"])), isNull(t.importedAt), gt(t.createdAt, since))),
    otherBotSendAfter: await exists(and(thread, eq(t.note, "BOT_SENT"), gt(t.createdAt, new Date(since.getTime() + BOT_ECHO_GRACE_MS)))),
    sameScriptRecently: Boolean(sameScript),
  };
}

/**
 * Một lượt CỔNG: đọc LẠI hội thoại + vòng đời + dấu vết rồi `decideFollowup`. Không bao giờ dùng ảnh chụp cũ: gọi lại ngay trước
 * khi gửi. Đọc lỗi ⇒ LIFECYCLE_UNKNOWN (không gửi — phía hẹp).
 */
async function followupGate(row: DueRow, claimed: FollowupConvSnap, now: Date): Promise<GateResult> {
  const loaded = await loadLifecycle(row.id, now).catch(() => null);
  if (!loaded) return { decision: { send: false, reason: "LIFECYCLE_UNKNOWN" }, lifecycle: UNKNOWN_LIFECYCLE, script: "SALES_NUDGE", checks: null, conv: null };
  const lifecycle = loaded.snapshot;
  const script = followupScriptOf(lifecycle);
  const fresh = snapOf(loaded.conv);
  const pageId = loaded.conv.pageId ?? row.pageId;
  const threadId = loaded.conv.threadId ?? row.threadId;
  const signals = await gateSignals(row.id, pageId, threadId, claimed.lastBotAt ?? claimed.waitingSince, fresh.lastCustomerAt, script, now).catch(() => null);
  if (!signals) return { decision: { send: false, reason: "LIFECYCLE_UNKNOWN" }, lifecycle, script, checks: null, conv: loaded.conv };
  // Đơn đã chốt chưa kết cục của CẢ lượt mua trước (lượt mua đã cắt ⇒ `lifecycle` không thấy) — cùng bộ đọc với luồng hậu mãi. Đọc lỗi ⇒
  // không nhắc (phía hẹp).
  const prior = await linkedOrdersFor(loaded.conv, now, { includePast: true }).catch(() => null);
  if (!prior) return { decision: { send: false, reason: "LIFECYCLE_UNKNOWN" }, lifecycle, script, checks: null, conv: loaded.conv };
  const pendingOrder = pendingPriorOrderReason(prior, now, CONFIRMED_ORDER_WATCH_DAYS, DWELL_SLA.PENDING?.exception ?? null);
  const decision = decideFollowup({ now, hasAddress: Boolean(pageId && threadId), claimed, fresh, lifecycle, ...signals, pendingOrder });
  const checks: GateChecks = { status: fresh.status, ...signals, withinWindow: withinMessagingWindow(fresh.lastCustomerAt, now), staffCooldown: Boolean(fresh.humanCooldownUntil && fresh.humanCooldownUntil.getTime() > now.getTime()) };
  return { decision, lifecycle, script, checks, conv: loaded.conv };
}

const lifecycleView = (lc: LifecycleSnapshot | null) => (lc ? { version: lc.version, salesStage: lc.salesStage, quote: lc.quote, order: lc.order, payment: lc.payment, fulfillment: lc.fulfillment, contact: lc.contact, orderId: lc.orderId, sources: lc.sources } : null);

/** Một lượt job cho tổ chức NGỮ CẢNH. Không ném. */
export async function runSalesFollowups(deps: FanpageDeps = {}): Promise<FollowupRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const out: FollowupRunResult = { due: 0, sent: 0, stopped: 0, deferred: 0, errors: 0, detail: [] };
  if (!(await canUseModule("ai_sales"))) return { ...out, detail: ["module AI bán hàng chưa bật"] };
  const fs = await loadFollowupSettings();
  if (!fs.enabled) return { ...out, detail: ["follow-up đang tắt"] };
  const cfg = await loadSalesChatbotConfig();
  if (!cfg.enabled) return { ...out, detail: ["bot đang tắt"] };
  const db = await getDb();
  const c = schema.salesChatConversations;
  const due = await db
    .select(compatTableColumns(c))
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), eq(c.status, "WAITING"), lte(c.nextFollowupAt, now)))
    .orderBy(asc(c.nextFollowupAt))
    .limit(BATCH);
  out.due = due.length;
  if (!due.length) return out;
  const org = await currentOrganization();
  const shop = (await findOrganization(org.code))?.name ?? org.code;
  const playbook = await publishedPlaybookText();
  const codeVersion = runningVersion().commit;
  for (const row of due) {
    // GIÀNH: chỉ lượt nào xoá được đúng mốc này mới gửi — hai lượt job chồng nhau không nhắn hai lần.
    const [mine] = await db
      .update(c)
      .set({ nextFollowupAt: null })
      .where(and(eq(c.id, row.id), eq(c.status, "WAITING"), eq(c.nextFollowupAt, row.nextFollowupAt!)))
      .returning({ id: c.id });
    if (!mine) continue;
    const st = (row.state ?? {}) as ChatState;
    const claimed = snapOf(row);
    const attempt = row.followupsSent + 1;
    const slotKey = followupSlotKey(row.waitingSince, attempt);
    const base = { v: FOLLOWUP_TRACE_VERSION, trigger: "SCHEDULE", workflow: WORKFLOW, attempt, totalSteps: fs.stepsMinutes.length, scheduledAt: row.nextFollowupAt?.toISOString() ?? null, waitingSince: row.waitingSince?.toISOString() ?? null, promptVersion: FOLLOWUP_PROMPT_VERSION, codeVersion };
    type TraceExtra = { lc?: LifecycleSnapshot | null; script?: FollowupScript | null; checks?: GateChecks | null; model?: string | null; promptHash?: string | null; claim?: ClaimKind };
    /** Vết của lượt — MỘT dòng mỗi lượt nhắc (khoá = lượt nhắc); hoãn ghi khoá riêng để lượt chạy lại sau vẫn quyết được. */
    const trace = (phase: "PRE_AI" | "PRE_SEND", decision: "SUPPRESS" | "DEFER", reason: FollowupReason, x: TraceExtra = {}) =>
      recordConversationEvent(row.id, {
        type: "followup.decided",
        actorKind: "SYSTEM",
        occurredAt: now,
        orderId: x.lc?.orderId ?? null,
        reasonCode: reason,
        payload: { ...base, phase, decision, reason, script: x.script ?? null, lifecycle: lifecycleView(x.lc ?? null), checks: x.checks ?? null, model: x.model ?? null, promptHash: x.promptHash ?? null, ...(x.claim ? { claim: x.claim } : {}) },
        key: decision === "DEFER" ? `${slotKey}:defer` : slotKey,
      });
    const stop = async (reason: FollowupReason, phase: "PRE_AI" | "PRE_SEND", x: TraceExtra = {}) => {
      out.stopped += 1;
      out.detail.push(`${row.id.slice(0, 8)}: dừng — ${FOLLOWUP_REASON_LABEL[reason]}`);
      await trace(phase, "SUPPRESS", reason, x);
    };
    if (!row.pageId || !row.threadId) {
      await stop("NO_ADDRESS", "PRE_AI");
      continue;
    }
    // Cổng page của nhà (page-runtime.ts): page chưa LIVE ⇒ thôi nhắc (đã giành mốc ⇒ không còn lịch), KHÔNG gọi AI, không gửi.
    if ((await pageRuntimeMode(row.pageId)) !== "LIVE") {
      await stop("PAGE_NOT_LIVE", "PRE_AI");
      continue;
    }
    // CỔNG lần 1 — trước khi tốn token.
    const pre = await followupGate(row, claimed, now);
    if (!pre.decision.send) {
      await stop(pre.decision.reason, "PRE_AI", { lc: pre.lifecycle, script: pre.script, checks: pre.checks });
      // Đơn ĐÃ XÁC NHẬN (P0-B 11/10/2026): ngoài chặn gửi, dọn luôn sổ hội thoại — huỷ lịch còn lại, WAITING ⇒ OPEN, bước DONE.
      if (pre.conv) await settleConfirmedConversation(pre.conv, pre.lifecycle, now, "FOLLOWUP_JOB").catch(() => undefined);
      continue;
    }
    const putBack = async (why: string) => {
      await db.update(c).set({ nextFollowupAt: new Date(now.getTime() + RETRY_LATER_MS) }).where(eq(c.id, row.id));
      out.deferred += 1;
      out.detail.push(`${row.id.slice(0, 8)}: hoãn — ${why}`);
      await trace("PRE_AI", "DEFER", "AI_UNAVAILABLE", { lc: pre.lifecycle, script: pre.script, checks: pre.checks });
    };
    if (await aiKillSwitchDenial(org.code)) {
      await putBack("AI đang bị tạm tắt");
      continue;
    }
    if (!(await checkAiQuota(org.code, salesBotBillingSource(cfg.connectorKey, { home: org.isHome }))).ok) {
      await putBack("hết hạn mức AI");
      continue;
    }
    const prov = await salesChatProvider();
    if (!prov.ok) {
      await putBack(prov.error);
      continue;
    }
    const scheduleNext = async (sentNow: boolean) => {
      const next = row.waitingSince ? nextFollowupAt(row.waitingSince, attempt, fs.stepsMinutes) : null;
      await db
        .update(c)
        .set({ followupsSent: attempt, nextFollowupAt: next && withinMessagingWindow(row.lastCustomerAt, next) ? next : null, ...(sentNow ? { lastBotAt: now, turns: row.turns + 1 } : {}) })
        .where(eq(c.id, row.id));
    };
    try {
      const known = await findReturningCustomer(st).catch(() => null);
      const view = await conversationView(row.id);
      const transcript = (view?.messages ?? [])
        .slice(-12)
        .map((m) => `${m.role === "user" ? "KHÁCH" : "SHOP"}: ${m.text.slice(0, 400)}`)
        .join("\n");
      const stage = st.stage && st.stage in SALES_STAGE_LABEL ? SALES_STAGE_LABEL[st.stage] : "Đang tư vấn";
      const infoCollected = pre.lifecycle.salesStage === "CUSTOMER_INFO_COLLECTED" || pre.lifecycle.salesStage === "AWAITING_CONFIRMATION";
      const system = followupSystemPrompt(cfg, shop, stage, attempt, fs.stepsMinutes.length, pre.script === "CONFIRM_REMINDER", playbook, returningCustomerPrompt(known, st.returning), isRepeatBuyer(known), infoCollected);
      const res = await prov.provider.complete({
        system,
        messages: [{ role: "user", content: [{ type: "text", text: `HỘI THOẠI:\n${transcript}` }] }],
        tools: [],
        maxTokens: 1500,
        reasoning: "low",
      });
      const model = res.model || prov.provider.model;
      const promptHash = promptStampOf({ system, tools: [], config: { steps: fs.stepsMinutes, version: FOLLOWUP_PROMPT_VERSION }, model, codeVersion }).promptHash;
      const inTok = res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
      await recordAiUsage({ orgCode: org.code, feature: "sales_chatbot", source: prov.source, provider: prov.provider.name, model, requests: 1, inputTokens: inTok, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(model, res.usage), status: "OK", actorId: null, ref: row.id, conversationId: row.id, workload: "followup", eventKey: aiCallKey({ workload: "followup", scope: row.id, turn: attempt, round: row.aiCalls }) }).catch(() => undefined);
      await db.update(c).set({ aiCalls: row.aiCalls + 1, inputTokens: row.inputTokens + inTok, outputTokens: row.outputTokens + res.usage.outputTokens }).where(eq(c.id, row.id));
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim().slice(0, 1000);
      // Câu rỗng, hay lỡ nêu giá (giá chỉ được đọc từ ERP lúc chat) ⇒ BỎ lần nhắc này, sang mốc sau — không gửi câu sai.
      if (!text || stripPrices(text).removed > 0) {
        await scheduleNext(false);
        out.detail.push(`${row.id.slice(0, 8)}: bỏ lần ${attempt} — ${text ? "AI nêu giá" : "AI không viết được"}`);
        await trace("PRE_SEND", "SUPPRESS", "AI_TEXT_REJECTED", { lc: pre.lifecycle, script: pre.script, checks: pre.checks, model, promptHash });
        continue;
      }
      // CỔNG lần 2 — đọc LẠI mọi thứ: khách / người / nguồn gửi khác có thể đã lên tiếng, đơn có thể vừa được tạo, trong lúc AI soạn.
      const fin = await followupGate(row, claimed, now);
      if (!fin.decision.send || !fin.conv) {
        await stop(fin.decision.send ? "LIFECYCLE_UNKNOWN" : fin.decision.reason, "PRE_SEND", { lc: fin.lifecycle, script: fin.script, checks: fin.checks, model, promptHash });
        // Đơn vừa được xác nhận trong lúc AI soạn ⇒ dọn sổ ngay (P0-B).
        if (fin.conv) await settleConfirmedConversation(fin.conv, fin.lifecycle, now, "FOLLOWUP_JOB").catch(() => undefined);
        continue;
      }
      // Hàng rào khẳng định (#789): câu nhắc nói «đã lên đơn / đã chốt / đã nhận tiền» mà ERP chưa có căn cứ ⇒ KHÔNG gửi, bỏ lần này.
      const freshConv = fin.conv;
      const verdict = await guardOutgoing(text, () => claimFactsLoader({ id: row.id, orderId: freshConv.orderId, pageId: freshConv.pageId ?? row.pageId, threadId: freshConv.threadId ?? row.threadId })(freshConv.state));
      if (!verdict.ok) {
        await scheduleNext(false);
        out.stopped += 1;
        out.detail.push(`${row.id.slice(0, 8)}: bỏ lần ${attempt} — ${FOLLOWUP_REASON_LABEL.CLAIM_BLOCKED} (${verdict.claim})`);
        await trace("PRE_SEND", "SUPPRESS", "CLAIM_BLOCKED", { lc: fin.lifecycle, script: fin.script, checks: fin.checks, model, promptHash, claim: verdict.claim });
        continue;
      }
      // GIÀNH KHOÁ GỬI: dòng vết GỬI chèn TRƯỚC khi gọi Pancake; chèn thua (lượt khác đã quyết lượt nhắc này) ⇒ không gửi.
      let locked: boolean;
      try {
        locked = await claimConversationEvent(row.id, row.channel, freshConv.state, {
          type: "followup.decided",
          actorKind: "SYSTEM",
          occurredAt: now,
          orderId: fin.lifecycle.orderId,
          reasonCode: "OK",
          payload: { ...base, phase: "SEND", decision: "SEND", reason: "OK", script: fin.script, lifecycle: lifecycleView(fin.lifecycle), checks: fin.checks, model, promptHash, delivery: "PENDING" },
          key: slotKey,
        });
      } catch (e) {
        out.errors += 1;
        out.detail.push(`${row.id.slice(0, 8)}: không giành được khoá gửi — không gửi (${e instanceof Error ? e.message.slice(0, 120) : "lỗi"})`);
        continue;
      }
      if (!locked) {
        out.stopped += 1;
        out.detail.push(`${row.id.slice(0, 8)}: dừng — ${FOLLOWUP_REASON_LABEL.DUPLICATE}`);
        continue;
      }
      // Đúng đường của page: Pancake, hoặc Messenger trực tiếp (0207).
      const sent = await sendBotText(row.pageId, row.threadId, text, deps);
      if (!sent.ok) {
        await patchConversationEventPayload(row.id, slotKey, { delivery: "FAILED", deliveryReason: "SEND_FAILED", error: sent.error.slice(0, 120) });
        // Gửi hỏng từng KHÔNG dời mốc ⇒ 5 phút sau AI soạn lại và gửi hỏng lại (đo HSLC 05/10/2026: cùng hội thoại hỏng 3 lần,
        // mỗi lần một lời gọi AI). Lỗi VĨNH VIỄN (hội thoại không còn / khách chặn page) ⇒ thôi nhắc; lỗi tạm ⇒ bỏ lần này,
        // sang mốc sau như khi AI không viết được.
        const permanent = followupSendPermanent(sent.error);
        if (permanent) await db.update(c).set({ lastError: sent.error.slice(0, 300), nextFollowupAt: null }).where(eq(c.id, row.id));
        else {
          await db.update(c).set({ lastError: sent.error.slice(0, 300) }).where(eq(c.id, row.id));
          await scheduleNext(false);
        }
        out.errors += 1;
        out.detail.push(`${row.id.slice(0, 8)}: lỗi gửi${permanent ? " (thôi nhắc)" : ""} — ${sent.error.slice(0, 120)}`);
        continue;
      }
      await patchConversationEventPayload(row.id, slotKey, { delivery: "SENT" });
      await appendBotMessage(row.id, text);
      await recordConversationEvent(row.id, { type: "followup.sent", actorKind: "AI", occurredAt: now, payload: { attempt, script: fin.script }, key: `followup:${row.waitingSince?.toISOString() ?? "?"}:${attempt}` });
      await scheduleNext(true);
      out.sent += 1;
    } catch (e) {
      out.errors += 1;
      out.detail.push(`${row.id.slice(0, 8)}: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
    }
  }
  return out;
}
