/**
 * ═══════════ FOLLOW-UP TỰ ĐỘNG — CHỈ MÁY CHỦ (0185) ═══════════
 *
 * Job `sales-followup` (mỗi 5 phút, từng tổ chức có module AI bán hàng): hội thoại fanpage `WAITING` tới mốc follow-up ⇒
 * GIÀNH dòng (một lượt duy nhất) ⇒ kiểm điều kiện dừng (chốt đơn · từ chối rõ · cần người · ngoài khung 24 giờ của
 * Facebook) ⇒ AI của CHÍNH shop viết MỘT câu nhắc theo bước khách đang dừng (giọng sổ tay, KHÔNG nêu giá) ⇒ gửi qua
 * Pancake ⇒ ghi vào hội thoại ⇒ đặt mốc kế tiếp. Lỗi một hội thoại không chặn hội thoại khác.
 */
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { estimateCostUsd } from "@/lib/ai/provider";
import { aiKillSwitchDenial } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { SALES_TONE_LABEL, type SalesChatbotConfig, salesBotBillingSource } from "@/lib/sales-chatbot/config";
import { appendBotMessage, conversationView, loadSalesChatbotConfig, salesChatProvider } from "@/lib/sales-chatbot/engine";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { PAGE_REPLY, type FanpageDeps } from "@/lib/sales-chatbot/fanpage";
import { sendBotText } from "@/lib/sales-chatbot/messenger";
import { nextFollowupAt, withinMessagingWindow } from "@/lib/sales-chatbot/followup-shared";
import { loadFollowupSettings } from "@/lib/sales-chatbot/followup-settings";
import { publishedPlaybookText } from "@/lib/sales-chatbot/playbook";
import { findReturningCustomer, returningCustomerPrompt } from "@/lib/sales-chatbot/returning";
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import { SALES_STAGE_LABEL } from "@/lib/sales-chatbot/stages";
import type { ChatState } from "@/lib/sales-chatbot/tools";

const BATCH = 20;
/** AI tạm không dùng được (công tắc / hạn mức / khoá) ⇒ thử lại sau chừng này, không bỏ lượt. */
const RETRY_LATER_MS = 15 * 60_000;

/**
 * Lỗi gửi mà gửi lại cũng không bao giờ được: Pancake không còn hội thoại («conversation_id not found»), khách không nhận tin
 * từ page nữa («Người này hiện không có mặt» — chặn page / khoá tài khoản), Meta từ chối vĩnh viễn (mã 551 / 10 / 200). HÀM THUẦN.
 */
export function followupSendPermanent(error: string): boolean {
  return /conversation_id not found|không có mặt|not available right now|\(#?551\)|\(#?10\)|\(#?200\)|blocked|đã chặn/i.test(error);
}

export type FollowupRunResult = { due: number; sent: number; stopped: number; deferred: number; errors: number; detail: string[] };

export function followupSystemPrompt(cfg: Pick<SalesChatbotConfig, "botName" | "tone">, shop: string, stage: string, attempt: number, total: number, hasDraft: boolean, playbook: string, returning: string = ""): string {
  const step =
    attempt >= total
      ? "Đây là lần nhắc CUỐI: hỏi lịch sự khách có muốn tiếp tục không / cần tư vấn thêm gì; không nài, không gây áp lực."
      : attempt === 1
        ? "Lần nhắc đầu: nhắc nhẹ, hỏi khách còn băn khoăn gì để shop hỗ trợ."
        : "Nhắc lần giữa: nhấn MỘT lợi ích của sản phẩm khách đang quan tâm, hoặc gỡ băn khoăn khách đã nêu trong hội thoại.";
  return [
    `Bạn là «${cfg.botName}», nhân viên bán hàng của shop «${shop}». Giọng: ${SALES_TONE_LABEL[cfg.tone]}.`,
    "Khách đã IM LẶNG sau tin nhắn gần nhất của shop. Viết ĐÚNG MỘT tin nhắn follow-up ngắn (1–2 câu), tiếng Việt, dựa trên hội thoại bên dưới.",
    `Khách đang dừng ở bước: ${stage}.${hasDraft ? " Khách ĐÃ CÓ đơn nháp chưa xác nhận — nhắc khách xác nhận đơn." : ""}`,
    `Lần nhắc ${attempt}/${total}. ${step}`,
    "TUYỆT ĐỐI không nêu giá, số tiền, khuyến mãi, thời gian giao; không bịa thông tin; không nhắc rằng mình là AI hay tin tự động.",
    // Khách cũ (03/10/2026): nhắc ĐẶT LẠI cụ thể như lần trước thay vì «còn băn khoăn gì không».
    returning ? `${returning}\nTin nhắc cho KHÁCH CŨ: đề xuất ĐẶT LẠI cụ thể như lần trước (món, giao về địa chỉ cũ), MỘT câu hỏi có / không; vẫn KHÔNG nêu giá.` : "",
    playbook ? `Sổ tay giọng điệu của shop:\n${playbook.slice(0, 1500)}` : "",
    "Chỉ trả về nội dung tin nhắn.",
  ]
    .filter(Boolean)
    .join("\n");
}

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
    .select()
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), eq(c.status, "WAITING"), lte(c.nextFollowupAt, now)))
    .orderBy(asc(c.nextFollowupAt))
    .limit(BATCH);
  out.due = due.length;
  if (!due.length) return out;
  const org = await currentOrganization();
  const shop = (await findOrganization(org.code))?.name ?? org.code;
  const playbook = await publishedPlaybookText();
  for (const row of due) {
    // GIÀNH: chỉ lượt nào xoá được đúng mốc này mới gửi — hai lượt job chồng nhau không nhắn hai lần.
    const [mine] = await db
      .update(c)
      .set({ nextFollowupAt: null })
      .where(and(eq(c.id, row.id), eq(c.status, "WAITING"), eq(c.nextFollowupAt, row.nextFollowupAt!)))
      .returning({ id: c.id });
    if (!mine) continue;
    const st = (row.state ?? {}) as ChatState;
    const stop = (why: string) => {
      out.stopped += 1;
      out.detail.push(`${row.id.slice(0, 8)}: dừng — ${why}`);
    };
    if (st.confirmed || st.declined || st.handoff) {
      stop(st.confirmed ? "đã chốt đơn" : st.declined ? "khách từ chối rõ" : "cần người xử lý");
      continue;
    }
    if (!row.pageId || !row.threadId) {
      stop("thiếu địa chỉ fanpage");
      continue;
    }
    // Nhân viên / tự động của page đã nhắn SAU tin cuối của bot (vd nhân viên vào chốt đơn trên Pancake) ⇒ khách không còn
    // «im lặng với bot» — bot nhắc chen vào là làm phiền khách đã mua. Phủ cả hội thoại đã xếp lịch trước khi có chặn lúc nhận.
    const since = row.lastBotAt ?? row.waitingSince;
    if (since) {
      const t = schema.salesChatInbound;
      const [other] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.pageId, row.pageId), eq(t.threadId, row.threadId), eq(t.note, PAGE_REPLY), gt(t.createdAt, since)))
        .limit(1);
      if (other) {
        stop("nhân viên / page đã nhắn sau bot");
        continue;
      }
    }
    if (!withinMessagingWindow(row.lastCustomerAt, now)) {
      stop("ngoài khung 24 giờ của Facebook");
      continue;
    }
    const putBack = async (why: string) => {
      await db.update(c).set({ nextFollowupAt: new Date(now.getTime() + RETRY_LATER_MS) }).where(eq(c.id, row.id));
      out.deferred += 1;
      out.detail.push(`${row.id.slice(0, 8)}: hoãn — ${why}`);
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
    const attempt = row.followupsSent + 1;
    const scheduleNext = async (sentNow: boolean) => {
      const next = row.waitingSince ? nextFollowupAt(row.waitingSince, attempt, fs.stepsMinutes) : null;
      await db
        .update(c)
        .set({ followupsSent: attempt, nextFollowupAt: next && withinMessagingWindow(row.lastCustomerAt, next) ? next : null, ...(sentNow ? { lastBotAt: now, turns: row.turns + 1 } : {}) })
        .where(eq(c.id, row.id));
    };
    try {
      const view = await conversationView(row.id);
      const transcript = (view?.messages ?? [])
        .slice(-12)
        .map((m) => `${m.role === "user" ? "KHÁCH" : "SHOP"}: ${m.text.slice(0, 400)}`)
        .join("\n");
      const stage = st.stage && st.stage in SALES_STAGE_LABEL ? SALES_STAGE_LABEL[st.stage] : "Đang tư vấn";
      const res = await prov.provider.complete({
        system: followupSystemPrompt(cfg, shop, stage, attempt, fs.stepsMinutes.length, Boolean(st.draft), playbook, returningCustomerPrompt(await findReturningCustomer(st).catch(() => null), st.returning)),
        messages: [{ role: "user", content: [{ type: "text", text: `HỘI THOẠI:\n${transcript}` }] }],
        tools: [],
        maxTokens: 1500,
        reasoning: "low",
      });
      const inTok = res.usage.inputTokens + res.usage.cacheReadTokens + res.usage.cacheWriteTokens;
      await recordAiUsage({ orgCode: org.code, feature: "sales_chatbot", source: prov.source, provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: inTok, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model || prov.provider.model, res.usage), status: "OK", actorId: null, ref: row.id }).catch(() => undefined);
      await db.update(c).set({ aiCalls: row.aiCalls + 1, inputTokens: row.inputTokens + inTok, outputTokens: row.outputTokens + res.usage.outputTokens }).where(eq(c.id, row.id));
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim().slice(0, 1000);
      // Câu rỗng, hay lỡ nêu giá (giá chỉ được đọc từ ERP lúc chat) ⇒ BỎ lần nhắc này, sang mốc sau — không gửi câu sai.
      if (!text || stripPrices(text).removed > 0) {
        await scheduleNext(false);
        out.detail.push(`${row.id.slice(0, 8)}: bỏ lần ${attempt} — ${text ? "AI nêu giá" : "AI không viết được"}`);
        continue;
      }
      // Đúng đường của page: Pancake, hoặc Messenger trực tiếp (0207).
      const sent = await sendBotText(row.pageId, row.threadId, text, deps);
      if (!sent.ok) {
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
      await appendBotMessage(row.id, text);
      await recordConversationEvent(row.id, { type: "followup.sent", actorKind: "AI", occurredAt: now, payload: { attempt }, key: `followup:${row.waitingSince?.toISOString() ?? "?"}:${attempt}` });
      await scheduleNext(true);
      out.sent += 1;
    } catch (e) {
      out.errors += 1;
      out.detail.push(`${row.id.slice(0, 8)}: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`);
    }
  }
  return out;
}
