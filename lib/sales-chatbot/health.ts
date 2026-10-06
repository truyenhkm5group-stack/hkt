/**
 * ═══════════ AI BÁN HÀNG SỐNG HAY CHẾT — ẢNH CHỤP TỪ CSDL + KIỂM ĐỊNH KỲ (CHỈ MÁY CHỦ) ═══════════
 *
 * `readSalesHealthSnapshot()` CHỈ ĐỌC: CSDL tổ chức (tin khách, câu bot, hội thoại, đơn, job) + sổ AI của nền tảng
 * (`platform_ai_usage`, lọc đúng mã tổ chức). Luật đánh giá nằm ở `health-shared.ts` (hàm thuần).
 *
 * `runSalesHealthCheck()` — job `sales-health` (5 phút, từng tổ chức có module AI bán hàng, TÁCH khỏi `sales-followup` để
 * một lượt follow-up treo không làm câm luôn bộ giám sát): chụp → đánh giá → lưu trạng thái → báo khi có chuyện MỚI / nhắc
 * khi còn đỏ / báo hồi phục. Không ném: giám sát hỏng không được làm hỏng gì khác.
 *
 * "Tin khách" = dòng `sales_chat_inbound` không phải câu bot (`BOT_SENT`) / câu page (`PAGE_REPLY`) / dấu gửi
 * (`bot-out:` · `staff-out:`), và là tin SỐNG (`imported_at IS NULL` — tin nhập lịch sử không bao giờ là việc của bot).
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { salesAiUsageHealth } from "@/lib/ai-usage/sales-health";
import { AI_SALES_SLO_SETTING_KEY, resolveAiSalesSlo, type AiSalesSlo } from "@/lib/constants/ai-sales-slo";
import { listChannelPages } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { MESSENGER_DIRECT_KEY } from "@/lib/sales-chatbot/channel-ownership";
import { salesBotError } from "@/lib/sales-chatbot/config";
import { AI_DOWN_HANDOFF_REASON, loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { badCheckKeys, decideHealthAlert, evaluateSalesHealth, PENDING_ELIGIBLE_MINUTES, type SalesHealth, type SalesHealthSnapshot, type SalesHealthStatus } from "@/lib/sales-chatbot/health-shared";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { loadOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";
import { PANCAKE_POLL_SETTING_KEY } from "@/lib/sales-chatbot/pancake-poll";
import { notifySalesHealth } from "@/lib/sales-chatbot/alerts";
import { rowsOf } from "@/lib/sql-rows";

export const SALES_HEALTH_STATE_KEY = "ai.salesHealth.state";

/** Mẫu câu lỗi GỬI (Pancake / Meta không nhận tin) mà lượt xử lý ghi vào `note` khi chốt tin. */
export const SEND_ERROR_NOTE_RE = "(không nhận tin|từ chối|không gọi được|lỗi gửi|HTTP [45][0-9]{2}|timeout|timed out)";

const CUSTOMER_ROW = sql.raw(`coalesce(note, '') not in ('BOT_SENT', 'PAGE_REPLY') and message_id not like 'bot-out:%' and message_id not like 'staff-out:%' and imported_at is null`);

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Mốc 00:00 hôm nay theo giờ Việt Nam. */
export function vnDayStart(now: Date): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - 7 * 3_600_000);
}

export async function loadAiSalesSlo(): Promise<AiSalesSlo> {
  return resolveAiSalesSlo(await getSettingJson<unknown>(AI_SALES_SLO_SETTING_KEY, null));
}

export async function readSalesHealthSnapshot(now: Date = new Date(), slo?: AiSalesSlo): Promise<SalesHealthSnapshot> {
  const db = await getDb();
  const s = slo ?? (await loadAiSalesSlo());
  const org = await currentOrganization();
  const [cfg, mode, orderSync, poll, pages] = await Promise.all([
    loadSalesChatbotConfig(),
    loadModeConfig(),
    loadOrderSyncConfig(),
    getSettingJson<{ lastWebhookAt?: number | null; pageId?: string | null } | null>(PANCAKE_POLL_SETTING_KEY, null),
    listChannelPages(MESSENGER_DIRECT_KEY).catch(() => []),
  ]);
  const at = now.toISOString();
  const silentFrom = new Date(now.getTime() - s.silentWindowMinutes * 60_000);
  const dayStart = vnDayStart(now);
  const eligibleFrom = new Date(now.getTime() - PENDING_ELIGIBLE_MINUTES * 60_000);

  const [q] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*) filter (where status = 'PENDING' and created_at >= ${eligibleFrom}) as pending,
        count(*) filter (where status = 'PENDING' and created_at >= ${eligibleFrom} and claim_id is not null) as retrying,
        min(created_at) filter (where status = 'PENDING' and created_at >= ${eligibleFrom}) as oldest,
        count(*) filter (where status = 'PENDING' and created_at < ${eligibleFrom} and created_at >= ${new Date(now.getTime() - 86_400_000)}) as abandoned,
        count(*) filter (where status = 'DONE' and created_at >= ${new Date(now.getTime() - 86_400_000)} and note ~* ${SEND_ERROR_NOTE_RE}) as failed_send,
        max(created_at) as last_customer,
        count(*) filter (where created_at >= ${new Date(now.getTime() - 3_600_000)}) as last_hour,
        count(distinct thread_id) filter (where status = 'DONE' and created_at >= ${silentFrom}) as silent_threads
      from sales_chat_inbound
      where ${CUSTOMER_ROW} and created_at >= ${new Date(now.getTime() - 14 * 86_400_000)}
    `),
  );
  const [bot] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select max(created_at) as last_bot, count(*) filter (where created_at >= ${silentFrom}) as bot_window
      from sales_chat_inbound where note = 'BOT_SENT' and created_at >= ${new Date(now.getTime() - 14 * 86_400_000)}
    `),
  );
  // ĐỘ TRỄ: mỗi tin khách đã chốt trong 24 giờ ↔ câu bot ĐẦU TIÊN của cùng hội thoại sau nó (trong 1 giờ). Không có câu bot
  // trong 10 phút ⇒ "chưa được trả lời" (có thể đúng thiết kế: chuyển người / page đã trả lời — đếm, không xếp vào trễ).
  const [lat] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with khach as (
        select i.page_id, i.thread_id, i.created_at
        from sales_chat_inbound i
        where ${sql.raw(`coalesce(i.note, '') not in ('BOT_SENT', 'PAGE_REPLY') and i.message_id not like 'bot-out:%' and i.message_id not like 'staff-out:%' and i.imported_at is null`)}
          and i.status = 'DONE' and i.kind = 'INBOX' and i.created_at >= ${new Date(now.getTime() - 86_400_000)}
      ), cap as (
        select k.created_at, (
          select min(b.created_at) from sales_chat_inbound b
          where b.page_id = k.page_id and b.thread_id = k.thread_id and b.note = 'BOT_SENT'
            and b.created_at >= k.created_at and b.created_at < k.created_at + interval '1 hour'
        ) as bot_at
        from khach k
      )
      select
        percentile_cont(0.5) within group (order by extract(epoch from (bot_at - created_at))) filter (where bot_at is not null) as p50,
        percentile_cont(0.95) within group (order by extract(epoch from (bot_at - created_at))) filter (where bot_at is not null) as p95,
        count(*) filter (where bot_at is not null) as sample,
        count(*) filter (where bot_at is null or bot_at > created_at + interval '10 minutes') as unanswered
      from cap
    `),
  );
  // NỀN: số tin khách của ĐÚNG khung giờ này (giờ VN) ở 14 ngày trước, trung vị — một ngày bão tin không kéo nền lên (luật 52).
  const [base] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with theo_ngay as (
        select date_trunc('day', created_at at time zone 'Asia/Ho_Chi_Minh') as ngay, count(*)::int as n
        from sales_chat_inbound
        where ${CUSTOMER_ROW}
          and created_at >= ${new Date(now.getTime() - 14 * 86_400_000)} and created_at < date_trunc('hour', ${now}::timestamptz)
          and extract(hour from (created_at at time zone 'Asia/Ho_Chi_Minh')) = extract(hour from (${now}::timestamptz at time zone 'Asia/Ho_Chi_Minh'))
        group by 1
      )
      select percentile_cont(0.5) within group (order by n) as median, count(*)::int as ngay from theo_ngay
    `),
  );
  const [conv] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*) filter (where handoff_reason = ${AI_DOWN_HANDOFF_REASON} and updated_at >= ${new Date(now.getTime() - 86_400_000)}) as ai_down,
        count(*) filter (where last_bot_at >= ${dayStart}) as ai_today
      from sales_chat_conversations
    `),
  );
  const [lastDown] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select last_error from sales_chat_conversations
      where handoff_reason = ${AI_DOWN_HANDOFF_REASON} and last_error is not null
      order by updated_at desc limit 1
    `),
  );
  const [ord] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        max(inserted_at) filter (where origin in ('AI_AGENT', 'AI_ORDER_SYNC')) as last_ai,
        count(*) filter (where origin = 'AI_AGENT' and inserted_at >= ${dayStart}) as ai_today,
        count(*) filter (where origin = 'AI_ORDER_SYNC' and inserted_at >= ${dayStart}) as sync_today,
        coalesce(sum(total_price_after_discount) filter (where origin = 'AI_AGENT' and inserted_at >= ${dayStart}), 0) as ai_value
      from orders
      where origin in ('AI_AGENT', 'AI_ORDER_SYNC') and stage <> 'DELETED' and inserted_at >= ${new Date(now.getTime() - 30 * 86_400_000)}
    `),
  );
  const [job] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select started_at, status, error from sync_runs where job = 'sales-followup' order by started_at desc limit 1`),
  );
  const [jobFails] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select count(*) as n from sync_runs where job = 'sales-followup' and status = 'FAILED' and started_at >= ${new Date(now.getTime() - 86_400_000)}`),
  );

  // SỔ AI CỦA NỀN TẢNG — đúng mã tổ chức (từ ngữ cảnh máy chủ), đúng tính năng bán hàng (gồm lượt ghi đơn `order-sync:`).
  const prov = await salesAiUsageHealth(org.code, now, s.providerWindowMinutes);

  const lastErr = typeof lastDown?.last_error === "string" ? salesBotError(lastDown.last_error) : null;
  const activePages = pages.filter((p) => p.status === "ACTIVE");
  const lastPageEvent = activePages.reduce<Date | null>((m, p) => (p.lastEventAt && (!m || p.lastEventAt > m) ? p.lastEventAt : m), null);
  const errPage = activePages.filter((p) => p.lastErrorAt).sort((a, b) => (b.lastErrorAt?.getTime() ?? 0) - (a.lastErrorAt?.getTime() ?? 0))[0];
  const conversationsAi = num(conv?.ai_today);
  const ordersAi = num(ord?.ai_today);
  const failedSend = num(q?.failed_send);
  const aiDown = num(conv?.ai_down);
  const provErr24 = prov.errors24h;
  return {
    at,
    botEnabled: cfg.enabled,
    mode: mode.mode,
    orderSyncEnabled: orderSync.enabled,
    channels: {
      pancake: { configured: Boolean(poll?.pageId), lastWebhookAt: typeof poll?.lastWebhookAt === "number" ? new Date(poll.lastWebhookAt).toISOString() : null },
      messenger: { pages: activePages.length, lastEventAt: iso(lastPageEvent), lastErrorAt: iso(errPage?.lastErrorAt ?? null), lastError: errPage?.lastError ?? null },
    },
    lastCustomerMessageAt: iso(q?.last_customer),
    lastAiReplyAt: iso(bot?.last_bot),
    lastAiOrderAt: iso(ord?.last_ai),
    queue: { pending: num(q?.pending), retrying: num(q?.retrying), oldestPendingAt: iso(q?.oldest), failedAiDown24h: aiDown, failedSend24h: failedSend, abandoned24h: num(q?.abandoned), deadLetter: null },
    silent: { customerHandled: num(q?.silent_threads), botSent: num(bot?.bot_window), windowMinutes: s.silentWindowMinutes },
    latency: { p50Seconds: numOrNull(lat?.p50), p95Seconds: numOrNull(lat?.p95), sample: num(lat?.sample), unanswered: num(lat?.unanswered) },
    provider: {
      okInWindow: prov.okInWindow,
      errorsInWindow: prov.errorsInWindow,
      blockedInWindow: prov.blockedInWindow,
      lastOkAt: iso(prov.lastOkAt),
      lastErrorAt: iso(prov.lastErrorAt),
      lastErrorKind: lastErr?.kind ?? null,
      lastErrorLabel: lastErr?.label ?? null,
    },
    traffic: { lastHour: num(q?.last_hour), baselineSameHour: numOrNull(base?.median) === null ? null : Math.round(Number(base?.median)), baselineDays: num(base?.ngay) },
    followup: { lastRunAt: iso(job?.started_at), lastStatus: typeof job?.status === "string" ? job.status : null, lastError: typeof job?.error === "string" ? job.error : null },
    orderSyncErrors24h: prov.orderSyncErrors24h,
    orderSync: { errorsInWindow: prov.orderSyncErrorsInWindow, lastOkAt: iso(prov.orderSyncLastOkAt), lastErrorAt: iso(prov.orderSyncLastErrorAt) },
    today: { conversationsAi, ordersAi, ordersSync: num(ord?.sync_today), orderValueAi: num(ord?.ai_value), conversionPct: conversationsAi > 0 ? Math.round((ordersAi / conversationsAi) * 1000) / 10 : null },
    errors24h: failedSend + aiDown + provErr24 + num(jobFails?.n),
  };
}

/** Một dòng để người trực bấm vào: tin đang chờ / tin chốt kèm lỗi, kèm hội thoại ERP nếu có. */
export type HealthDrillRow = { kind: "PENDING" | "SEND_FAILED" | "AI_DOWN"; at: string; pageId: string; threadId: string; customerName: string | null; text: string; note: string | null; conversationId: string | null };

export async function salesHealthDrilldown(now: Date = new Date(), limit = 30): Promise<HealthDrillRow[]> {
  const db = await getDb();
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select i.status, i.created_at, i.page_id, i.thread_id, i.customer_name, left(i.text, 160) as text, left(i.note, 200) as note, c.id as conversation_id, c.handoff_reason
      from sales_chat_inbound i
      left join sales_chat_conversations c on c.page_id = i.page_id and c.thread_id = i.thread_id
      where ${sql.raw(`coalesce(i.note, '') not in ('BOT_SENT', 'PAGE_REPLY') and i.message_id not like 'bot-out:%' and i.message_id not like 'staff-out:%' and i.imported_at is null`)}
        and i.created_at >= ${new Date(now.getTime() - 86_400_000)}
        and (i.status = 'PENDING' or (i.status = 'DONE' and i.note ~* ${SEND_ERROR_NOTE_RE}) or (c.handoff_reason = ${AI_DOWN_HANDOFF_REASON} and i.status = 'DONE'))
      order by i.created_at desc
      limit ${limit}
    `),
  );
  return rows.map((r) => ({
    kind: r.status === "PENDING" ? "PENDING" : r.handoff_reason === AI_DOWN_HANDOFF_REASON ? "AI_DOWN" : "SEND_FAILED",
    at: iso(r.created_at) ?? "",
    pageId: String(r.page_id ?? ""),
    threadId: String(r.thread_id ?? ""),
    customerName: typeof r.customer_name === "string" ? r.customer_name : null,
    text: String(r.text ?? ""),
    note: typeof r.note === "string" ? r.note : null,
    conversationId: typeof r.conversation_id === "string" ? r.conversation_id : null,
  }));
}

type StoredState = { status: SalesHealthStatus; bad: string[]; since: string; checkedAt: string; headline: string };

export async function readSalesHealthState(): Promise<StoredState | null> {
  const v = await getSettingJson<StoredState | null>(SALES_HEALTH_STATE_KEY, null);
  return v && typeof v.status === "string" && Array.isArray(v.bad) ? v : null;
}

export type SalesHealthRun = { status: SalesHealthStatus; alerted: string; health: SalesHealth };

/** Job `sales-health`: chụp → đánh giá → báo (nếu cần) → lưu trạng thái. KHÔNG ném. */
export async function runSalesHealthCheck(now: Date = new Date()): Promise<SalesHealthRun> {
  const slo = await loadAiSalesSlo();
  const snap = await readSalesHealthSnapshot(now, slo);
  const health = evaluateSalesHealth(snap, slo);
  const prev = await readSalesHealthState();
  const decision = decideHealthAlert(prev, health, now, slo.remindEveryMinutes);
  let alerted = "không";
  if (decision.kind !== "NONE") {
    try {
      await notifySalesHealth({ decision, health, snapshot: snap, now });
      alerted = decision.kind === "RECOVERED" ? "báo hồi phục" : decision.reason === "NEW_PROBLEM" ? "báo sự cố mới" : "nhắc sự cố";
    } catch (e) {
      alerted = `báo hỏng: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
    }
  }
  const bad = badCheckKeys(health);
  const since = prev && prev.status === health.status ? prev.since : now.toISOString();
  await setSettingJson(SALES_HEALTH_STATE_KEY, { status: health.status, bad, since, checkedAt: now.toISOString(), headline: health.headline } satisfies StoredState);
  return { status: health.status, alerted, health };
}
