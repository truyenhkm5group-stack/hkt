/**
 * ═══════════ ĐỒNG HỒ KHÁCH AI (AI_CUSTOMER) — GHI + ĐỌC — CHỈ MÁY CHỦ (docs/saas/PRICING_V1.md §2) ═══════════
 *
 * Một khách AI = MỘT liên hệ DUY NHẤT trong MỘT workspace và MỘT kỳ đã nhận ÍT NHẤT MỘT câu trả lời do AI sinh ra mà bot đã
 * GỬI THÀNH CÔNG. Ghi ở ĐÚNG điểm gửi thành công của runtime bán hàng (`lib/sales-chatbot/fanpage.ts::markWaitingForCustomer`
 * — chỉ được gọi sau khi câu trả lời AI đã tới kênh: fanpage nhắn · fanpage trả lời bình luận · Messenger).
 *
 *  · Sổ: `platform_usage_events` (0224), chỉ số `chotdon.ai_customers`, đường ghi duy nhất `recordUsage`. Khoá idempotent
 *    `aic:<YYYY-MM>:<page>:<băm khách chuẩn>` (L5 · `lib/pricing/ai-customer-identity.ts` — KHÔNG chứa mã hội thoại: cùng khách đổi
 *    đường nhận tin giữa tháng vẫn là một khoá) + chỉ mục duy nhất (tổ chức, khoá) ⇒ cùng khách cùng kỳ = MỘT dòng dù nhiều hội
 *    thoại / tin / lần thử lại / đường; cùng khoá ở tổ chức khác là dòng khác (cô lập). Dòng khoá cũ 0228
 *    (`ai_customer:<kỳ>:<kênh>:<page>:<visitor_key>`) giữ nguyên; khách đã có dòng cũ trong kỳ ⇒ khoá mới ghi SỐ LƯỢNG 0 (bí danh)
 *    ⇒ `sum(quantity)` của kỳ đếm mỗi khách chuẩn đúng một lần.
 *  · Kênh: fanpage (Pancake) · Messenger · Zalo OA · chat web — cùng một điểm «câu do model sinh đã gửi thành công».
 *  · Kỳ = tháng lịch giờ VN — trùng kỳ hạn mức và credit AI (`lib/pricing/meter.ts`). Nền móng chưa có kỳ thu theo ngày gia
 *    hạn của từng thuê bao, nên đồng hồ không đổi theo `paid_through` (docs/saas/PRICING_V1.md §4 ghi lựa chọn này).
 *  · LỖI GHI SỔ KHÔNG BAO GIỜ làm hỏng việc gửi: `noteAiCustomerReply` nuốt mọi lỗi (đếm ở `aiCustomerMeterErrors`).
 *  · Runtime cũ (`chatbot/`, container riêng — bot nhà) KHÔNG đi qua đây ⇒ workspace chỉ chạy runtime cũ đọc ra `null` +
 *    "chưa đo", KHÔNG BAO GIỜ 0.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { canUseFeature, getEnabledModules } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { readAiCustomerMeterLiveAt } from "@/lib/pricing/price-book";
import { aiCustomerKeys } from "@/lib/pricing/ai-customer-identity";
import { chargeAiCustomerUsage } from "@/lib/billing/ai-usage-charge";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { aiCustomerCoverage, meterMonthOf, type MeterCoverage } from "@/lib/pricing/versions";
import { LEGACY_CHATBOT_FEATURE } from "@/lib/saas/catalog";
import { recordUsage } from "@/lib/saas/ledger";

export const AI_CUSTOMER_PRODUCT = "chotdon";
export const AI_CUSTOMER_METRIC = "ai_customers";
/** Kênh của khung THỬ trong ERP — không phải khách thật, không đếm. */
const TEST_CHANNELS = new Set(["TEST"]);

type Holder = { __erpAiCustomerSeen?: Map<string, number>; __erpAiCustomerErrors?: { n: number; last: string | null } };
const holder = globalThis as unknown as Holder;
if (!holder.__erpAiCustomerSeen) holder.__erpAiCustomerSeen = new Map();
if (!holder.__erpAiCustomerErrors) holder.__erpAiCustomerErrors = { n: 0, last: null };
const seen = holder.__erpAiCustomerSeen;
const SEEN_MAX = 20_000;

/** Số lần ghi đồng hồ hỏng trong tiến trình (không chứa nội dung / danh tính khách). */
export function aiCustomerMeterErrors(): { n: number; last: string | null } {
  return { ...holder.__erpAiCustomerErrors! };
}

/** Bài kiểm xoá đệm "đã ghi" để đo lại đường ghi CSDL thật. */
export function resetAiCustomerSeenForTests() {
  seen.clear();
}

/**
 * `customerKey` = `visitor_key` của hội thoại; `threadId` = mã hội thoại / người dùng của kênh (dựng danh tính chuẩn); `threadKind` +
 * `commenterId` = lượt vừa trả lời là BÌNH LUẬN của ai (`AiCustomerHint`).
 */
export type AiCustomerInput = { orgCode: string; channel: string; pageId: string | null; customerKey: string | null; threadId?: string | null; threadKind?: "INBOX" | "COMMENT" | null; commenterId?: string | null; conversationId?: string | null; at: Date };
/** Điểm gửi của đường BÌNH LUẬN báo loại hội thoại + người bình luận — để không suy PSID từ mã hội thoại của cả bài. */
export type AiCustomerHint = { threadKind: "COMMENT"; commenterId: string | null };

type Listener = (orgCode: string) => void;
const listeners = new Set<Listener>();
/** Cổng gói (`ai-gate.ts`) nghe khách AI MỚI để quên đệm của tổ chức ngay — hạn mức dùng thử đọc số tươi. */
export function onAiCustomerRecorded(fn: Listener): void {
  listeners.add(fn);
}

/**
 * Ghi MỘT khách AI cho kỳ của `at`. Trả `{ recorded }` (`false` = khách này đã được đếm trong kỳ — qua khoá mới hoặc khoá cũ — hoặc
 * khoá không dựng được). Ném khi sổ hỏng — chỉ `noteAiCustomerReply` (đường của runtime) nuốt lỗi.
 */
export async function recordAiCustomer(input: AiCustomerInput): Promise<{ recorded: boolean; key: string | null }> {
  if (TEST_CHANNELS.has(input.channel)) return { recorded: false, key: null };
  const keys = aiCustomerKeys(meterMonthOf(input.at), { channel: input.channel, pageId: input.pageId, threadId: input.threadId ?? null, visitorKey: input.customerKey, threadKind: input.threadKind ?? null, commenterId: input.commenterId ?? null });
  if (!keys) return { recorded: false, key: null };
  const { key, aliases, identity } = keys;
  const memoKey = `${input.orgCode}|${key}`;
  if (seen.has(memoKey)) return { recorded: false, key };
  const pdb = await getPlatformDb();
  const e = schema.platformUsageEvents;
  const hits = await pdb
    .select({ key: e.eventKey })
    .from(e)
    .where(and(eq(e.orgCode, input.orgCode), eq(e.productKey, AI_CUSTOMER_PRODUCT), eq(e.metric, AI_CUSTOMER_METRIC), inArray(e.eventKey, [key, ...aliases])));
  const remember = () => {
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.set(memoKey, input.at.getTime());
  };
  if (hits.some((h) => h.key === key)) {
    remember();
    return { recorded: false, key };
  }
  // Khách đã được đếm trong kỳ qua một khoá cũ / khoá theo hội thoại ⇒ khoá mới là BÍ DANH số lượng 0 (không đếm lần hai).
  const aliasOf = hits.find((h) => aliases.includes(h.key))?.key ?? null;
  const r = await recordUsage({
    orgCode: input.orgCode,
    productKey: AI_CUSTOMER_PRODUCT,
    metric: AI_CUSTOMER_METRIC,
    quantity: aliasOf ? 0 : 1,
    occurredAt: input.at,
    eventKey: key,
    correlationId: input.conversationId ?? null,
    source: "sales_chatbot",
    metadata: { channel: input.channel, identity: identity.kind, ...(aliasOf ? { aliasOf } : {}) },
  });
  remember();
  const recorded = r.recorded && !aliasOf;
  if (recorded) for (const fn of listeners) fn(input.orgCode);
  return { recorded, key };
}

/**
 * ĐIỂM GỌI CỦA RUNTIME — sau khi bot đã GỬI THÀNH CÔNG câu trả lời AI của hội thoại `conversationId` (tổ chức ngữ cảnh).
 * Không bao giờ ném, không bao giờ chặn: lỗi đọc / ghi chỉ được đếm.
 */
export async function noteAiCustomerReply(conversationId: string, at: Date, hint?: AiCustomerHint): Promise<void> {
  try {
    const org = await currentOrganization();
    const db = await getDb();
    const c = schema.salesChatConversations;
    const [row] = await db.select({ channel: c.channel, pageId: c.pageId, threadId: c.threadId, visitorKey: c.visitorKey }).from(c).where(eq(c.id, conversationId)).limit(1);
    if (!row) return;
    const r = await recordAiCustomer({ orgCode: org.code, channel: row.channel, pageId: row.pageId, threadId: row.threadId, customerKey: row.visitorKey, threadKind: hint?.threadKind ?? null, commenterId: hint?.commenterId ?? null, conversationId, at });
    // SỐ DƯ AI (docs/saas/AI_BALANCE_V1.md): khách AI MỚI vượt phần gói gồm ⇒ trừ đơn giá vượt vào số dư — ĐÚNG điểm này (câu AI
    // đã tới khách), không ở nơi nào khác. Gọi TƯỜNG MINH (không qua listener): một tiến trình quên đăng ký là mất doanh thu im lặng.
    if (r.recorded && r.key) {
      const period = usagePeriodOf(at);
      const count = (await readAiCustomerCounts([org.code], period.from, period.to)).get(org.code) ?? 0;
      await chargeAiCustomerUsage({ orgCode: org.code, eventKey: r.key, at, periodCount: count });
    }
  } catch (e) {
    const s = holder.__erpAiCustomerErrors!;
    s.n += 1;
    s.last = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
  }
}

/**
 * Khách của hội thoại này ĐÃ là khách AI của kỳ chứa `at` chưa (khoá mới hoặc bất kỳ bí danh nào) — cổng Số dư AI hỏi câu này:
 * khách đã tính phí trong kỳ thì vẫn được AI trả lời dù số dư đã hết. Không dựng được danh tính ⇒ `false` (coi là khách mới).
 */
export async function aiCustomerCountedThisPeriod(
  orgCode: string,
  conv: { channel: string; pageId: string | null; threadId: string | null; visitorKey: string | null; threadKind?: "INBOX" | "COMMENT" | null; commenterId?: string | null },
  at: Date,
): Promise<boolean> {
  // CÙNG khoá với lượt ghi (`noteAiCustomerReply` + gợi ý bình luận): bình luận đếm theo NGƯỜI bình luận — dựng khoá thiếu hai
  // trường này thì người bình luận đã trả tiền trong tháng bị coi là khách mới và bị chặn oan (review 08/10/2026, M2).
  const keys = aiCustomerKeys(meterMonthOf(at), { channel: conv.channel, pageId: conv.pageId, threadId: conv.threadId, visitorKey: conv.visitorKey, threadKind: conv.threadKind ?? null, commenterId: conv.commenterId ?? null });
  if (!keys) return false;
  const pdb = await getPlatformDb();
  const e = schema.platformUsageEvents;
  const [hit] = await pdb
    .select({ key: e.eventKey })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.productKey, AI_CUSTOMER_PRODUCT), eq(e.metric, AI_CUSTOMER_METRIC), inArray(e.eventKey, [keys.key, ...keys.aliases])))
    .limit(1);
  return Boolean(hit);
}

/** Số khách AI ĐÃ GHI của mỗi tổ chức trong `[from, to)` — đọc thô từ sổ, chưa xét độ phủ. */
export async function readAiCustomerCounts(orgCodes: readonly string[], from: Date, to: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!orgCodes.length) return out;
  const pdb = await getPlatformDb();
  const e = schema.platformUsageEvents;
  const rows = await pdb
    .select({ orgCode: e.orgCode, n: sql<number>`coalesce(sum(${e.quantity}), 0)::int` })
    .from(e)
    .where(and(inArray(e.orgCode, [...orgCodes]), eq(e.productKey, AI_CUSTOMER_PRODUCT), eq(e.metric, AI_CUSTOMER_METRIC), gte(e.occurredAt, from), lt(e.occurredAt, to)))
    .groupBy(e.orgCode);
  for (const r of rows) out.set(r.orgCode, Number(r.n));
  return out;
}

export type AiCustomerReading = { value: number | null; coverage: MeterCoverage; note: string | null };

/**
 * Khách AI của một tổ chức trong kỳ, KÈM độ phủ: runtime cũ chưa ghi ⇒ `null`; đồng hồ bật giữa kỳ ⇒ cận dưới (PARTIAL).
 * Lỗi đọc ⇒ `null` + câu lỗi (không bao giờ 0).
 */
export async function readAiCustomerUsage(orgCodes: readonly string[], period: { from: Date; to: Date }, now: Date = new Date()): Promise<Map<string, AiCustomerReading>> {
  const out = new Map<string, AiCustomerReading>();
  if (!orgCodes.length) return out;
  const to = now < period.to ? now : period.to;
  let counts: Map<string, number>;
  let liveAt: Date | null;
  try {
    [counts, liveAt] = await Promise.all([readAiCustomerCounts(orgCodes, period.from, new Date(to.getTime() + 1)), readAiCustomerMeterLiveAt()]);
  } catch (e) {
    for (const code of orgCodes) out.set(code, { value: null, coverage: "NOT_MEASURED", note: `Sổ dùng: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}` });
    return out;
  }
  for (const code of orgCodes) {
    let aiSalesOn = false;
    let legacyChatbotOn = false;
    try {
      const enabled = await getEnabledModules(code);
      aiSalesOn = enabled.has("ai_sales");
      legacyChatbotOn = enabled.has("connector_pancake") ? await canUseFeature(LEGACY_CHATBOT_FEATURE as `${string}.${string}`, code) : false;
    } catch {
      out.set(code, { value: null, coverage: "NOT_MEASURED", note: "Không đọc được module của workspace." });
      continue;
    }
    const cov = aiCustomerCoverage({ aiSalesOn, legacyChatbotOn, meterLiveAt: liveAt, periodFrom: period.from });
    out.set(code, { value: cov.coverage === "NOT_MEASURED" ? null : (counts.get(code) ?? 0), coverage: cov.coverage, note: cov.note });
  }
  return out;
}
