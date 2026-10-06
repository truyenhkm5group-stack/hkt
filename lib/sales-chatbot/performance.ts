/**
 * ═══════════ HIỆU QUẢ AI BÁN HÀNG — ĐỌC SỐ (docs/productization/MIGRATION_PLAN.md M4) ═══════════
 *
 * Một kỳ = N ngày gần nhất theo giờ Việt Nam. Ba nguồn, mỗi nguồn một sự thật:
 *  · PHỄU, PHẢN HỒI, CHUYỂN NGƯỜI, UPSELL — sổ `sales_conversation_events` của CHÍNH tổ chức (khung thử bị loại).
 *  · KẾT CỤC ĐƠN — `ORDER_OUTCOME` (lib/queries/return-rate.ts), MỘT công thức cho mọi báo cáo (AGENTS §0.2); doanh thu đi qua
 *    `REVENUE_RECOGNIZED_ON_DELIVERY`. Không tự tính «giao thành công» ở đây.
 *  · TIỀN AI — sổ `platform_ai_usage` qua `aiUsageByRef` (luôn lọc `org_code`). Lượt ghi đơn hộ nhân viên mang `ref`
 *    «order-sync:…» ⇒ tách khỏi chi phí bán hàng của bot; khung thử tách riêng.
 *
 * Trước ngày bật sổ sự kiện KHÔNG có số — màn hình in «đo từ ngày …», không in 0 (luật 42, không backfill — luật 35).
 */
import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { aiUsageByRef } from "@/lib/ai-usage/ledger";
import type { SessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { FINISHED_OUTCOMES_SQL, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { HANDOFF_REASON_CODES, HANDOFF_REASON_LABEL, type HandoffReasonCode } from "@/lib/sales-chatbot/events-shared";
import { BOT_CONFIRMED, HUMAN_TOUCHED, onPage } from "@/lib/sales-chatbot/events-sql";
import {
  AI_SALES_PERFORMANCE_SETTING_KEY,
  cohortTable,
  estimatedStaffSaving,
  parsePerformanceSettings,
  rateOrNull,
  salesEconomics,
  AI_SALES_MIN_SAMPLE,
  type AiSalesPerformanceSettings,
  type SalesEconomics,
  type CohortTable,
} from "@/lib/sales-chatbot/performance-shared";
import { setSettingJson } from "@/lib/settings";
import { readJsonSetting } from "@/lib/sales-chatbot/engine";

export type AiSalesPerformance = {
  days: number;
  since: Date;
  /** Mốc sự kiện SỚM NHẤT trong sổ — trước mốc này là CHƯA ĐO. `null` = sổ còn trống. */
  measuredSince: Date | null;
  /** Hội thoại có cập nhật trong kỳ (trừ khung thử) và bao nhiêu trong số đó có dòng trong sổ — độ phủ của chính sổ. */
  coverage: { conversationsActive: number; conversationsWithEvents: number };
  cohorts: CohortTable;
  rates: { aiResolution: number | null; handoff: number | null; leadCapture: number | null };
  response: { medianMs: number | null; p90Ms: number | null; samples: number };
  handoffReasons: { code: HandoffReasonCode; label: string; count: number }[];
  upsell: { offered: number; accepted: number; declined: number; revenueVnd: number; attachRate: number | null };
  orders: { confirmed: number; confirmedValueVnd: number; settled: number; delivered: number; deliveredRevenueVnd: number; returned: number; cancelled: number; pending: number; deliveryRate: number | null };
  orderSync: { orders: number; valueVnd: number };
  /** `null` ở các ô tiền = không người xem nào có quyền thấy tiền (chỉ `ai_sales:manage`). */
  cost: { sellingVnd: number | null; unknownCost: number; turns: number; orderSyncVnd: number | null; testVnd: number | null; perDeliveredOrderVnd: number | null; perConfirmedOrderVnd: number | null; rateVndPerUsd: number } | null;
  human: (AiSalesPerformanceSettings & { estimatedSavingVnd: number | null }) | null;
  /** AOV · doanh thu / hội thoại · chi phí AI / hội thoại · doanh thu ÷ chi phí AI (`salesEconomics`). Ô chi phí `null` khi không có quyền thấy tiền. */
  economics: SalesEconomics;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function loadPerformanceSettings(): Promise<AiSalesPerformanceSettings> {
  return parsePerformanceSettings(await readJsonSetting(AI_SALES_PERFORMANCE_SETTING_KEY));
}

/**
 * Số hiệu quả của tổ chức NGỮ CẢNH. `withMoney` = người xem có quyền thấy tiền (chi phí AI, tiết kiệm ước tính) — tiền là
 * vùng nhạy cảm như ở bảng «Chi phí AI theo ngày».
 */
export async function loadAiSalesPerformance(orgCode: string, opts: { days?: number; now?: Date; withMoney: boolean; /** Một page (chiều lọc); `null` = mọi page. */ pageId?: string | null }): Promise<AiSalesPerformance> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), 180);
  const now = opts.now ?? new Date();
  const since = new Date(dauNgayVN(now).getTime() - (days - 1) * 86_400_000);
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const inPeriod = and(gte(e.occurredAt, since), ne(e.channel, "TEST"), onPage(opts.pageId));

  const [first] = await db.select({ at: sql<Date | null>`min(${e.occurredAt})` }).from(e).where(onPage(opts.pageId));
  const measuredSince = first?.at ? new Date(first.at) : null;

  // ── Phễu theo hội thoại (chỉ hội thoại có tin khách trong kỳ) ──
  const facts = await db
    .select({
      quoted: sql<boolean>`bool_or(${e.type} = 'quote.given')`,
      identified: sql<boolean>`bool_or(${e.type} = 'customer.identified')`,
      drafted: sql<boolean>`bool_or(${e.type} = 'order.drafted' and ${e.actorKind} = 'AI')`,
      // Hai vị ngữ dùng chung (events-sql.ts): đơn NGƯỜI tạo trong khung chat không phải đơn bot chốt, và kéo hội thoại sang
      // nhóm có người.
      confirmed: sql<boolean>`bool_or(${BOT_CONFIRMED})`,
      human: sql<boolean>`bool_or(${HUMAN_TOUCHED})`,
      upsellOffered: sql<boolean>`bool_or(${e.type} = 'upsell.offered')`,
      upsellAccepted: sql<boolean>`bool_or(${e.type} = 'upsell.accepted')`,
    })
    .from(e)
    .where(inPeriod)
    .groupBy(e.conversationId)
    .having(sql`bool_or(${e.type} = 'message.received')`);
  const cohorts = cohortTable(facts.map((f) => ({ quoted: Boolean(f.quoted), identified: Boolean(f.identified), drafted: Boolean(f.drafted), confirmed: Boolean(f.confirmed), human: Boolean(f.human), upsellOffered: Boolean(f.upsellOffered), upsellAccepted: Boolean(f.upsellAccepted) })));
  const total = cohorts.total.conversations;

  // ── Độ phủ của sổ ──
  const c = schema.salesChatConversations;
  const coverageFrom = measuredSince && measuredSince > since ? measuredSince : since;
  const [active] = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(and(ne(c.channel, "TEST"), sql`${c.turns} > 0`, gte(c.updatedAt, coverageFrom), ...(opts.pageId ? [eq(c.pageId, opts.pageId)] : [])));
  const [withEv] = await db.select({ n: sql<number>`count(distinct ${e.conversationId})::int` }).from(e).where(and(ne(e.channel, "TEST"), gte(e.occurredAt, coverageFrom), onPage(opts.pageId)));

  // ── Thời gian trả lời (ngưỡng mẫu áp SAU khi SQL trả về — percentile_cont luôn ra số khi có một dòng, luật 63) ──
  const responseMs = sql`(${e.payload}->>'responseMs')::bigint`;
  const [resp] = await db
    .select({
      n: sql<number>`count(${responseMs})::int`,
      p50: sql<number | null>`percentile_cont(0.5) within group (order by ${responseMs})`,
      p90: sql<number | null>`percentile_cont(0.9) within group (order by ${responseMs})`,
    })
    .from(e)
    .where(and(inPeriod, eq(e.type, "ai.replied"), sql`${e.payload}->>'mode' in ('AI','QUICK_REPLY')`, sql`${e.payload} ? 'responseMs'`));
  const samples = num(resp?.n);
  const enough = samples >= AI_SALES_MIN_SAMPLE;

  // ── Lý do chuyển người ──
  const reasons = await db
    .select({ code: e.reasonCode, n: sql<number>`count(*)::int` })
    .from(e)
    .where(and(inPeriod, inArray(e.type, ["handoff.requested", "human.took_over"])))
    .groupBy(e.reasonCode);
  const handoffReasons = reasons
    .map((r) => {
      const code = (HANDOFF_REASON_CODES as readonly string[]).includes(r.code ?? "") ? (r.code as HandoffReasonCode) : "OTHER";
      return { code, label: HANDOFF_REASON_LABEL[code], count: num(r.n) };
    })
    .sort((a, b) => b.count - a.count);

  // ── Upsell ──
  const [up] = await db
    .select({
      offered: sql<number>`count(*) filter (where ${e.type} = 'upsell.offered')::int`,
      accepted: sql<number>`count(*) filter (where ${e.type} = 'upsell.accepted')::int`,
      declined: sql<number>`count(*) filter (where ${e.type} = 'upsell.declined')::int`,
      revenue: sql<number>`coalesce(sum(${e.amountVnd}) filter (where ${e.type} = 'upsell.accepted'), 0)`,
    })
    .from(e)
    .where(and(inPeriod, inArray(e.type, ["upsell.offered", "upsell.accepted", "upsell.declined"])));

  // ── Đơn bot chốt ⇒ kết cục theo ORDER_OUTCOME ──
  const confirmedIds = (await db.selectDistinct({ id: e.orderId }).from(e).where(and(inPeriod, BOT_CONFIRMED, isNotNull(e.orderId)))).map((r) => r.id!).filter(Boolean);
  let orders: AiSalesPerformance["orders"] = { confirmed: 0, confirmedValueVnd: 0, settled: 0, delivered: 0, deliveredRevenueVnd: 0, returned: 0, cancelled: 0, pending: 0, deliveryRate: null };
  if (confirmedIds.length) {
    const o = schema.orders;
    const s = schema.shipments;
    const per = db
      .select({ outcome: ORDER_OUTCOME.as("p_outcome"), value: sql<number>`${o.totalPriceAfterDiscount}`.as("p_value"), recognized: sql<boolean>`${REVENUE_RECOGNIZED_ON_DELIVERY}`.as("p_recognized") })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(inArray(o.id, confirmedIds))
      .as("p");
    const [agg] = await db
      .select({
        n: sql<number>`count(*)::int`,
        value: sql<number>`coalesce(sum(${per.value}), 0)`,
        delivered: sql<number>`count(*) filter (where ${per.outcome} = 'DELIVERED')::int`,
        deliveredRevenue: sql<number>`coalesce(sum(${per.value}) filter (where ${per.outcome} = 'DELIVERED' and ${per.recognized}), 0)`,
        // Tập «hoàn» và «đã ngã ngũ» SINH RA từ OUTCOME_GROUP (lib/constants/truth.ts) — không gõ lại (contract test chặn).
        returned: sql<number>`count(*) filter (where ${per.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)}))::int`,
        settled: sql<number>`count(*) filter (where ${per.outcome} in (${sql.raw(FINISHED_OUTCOMES_SQL)}))::int`,
        cancelled: sql<number>`count(*) filter (where ${per.outcome} = 'CANCELLED')::int`,
      })
      .from(per);
    const n = num(agg?.n);
    const delivered = num(agg?.delivered);
    const returned = num(agg?.returned);
    const cancelled = num(agg?.cancelled);
    // ĐÃ NGÃ NGŨ = giao thành công + hoàn; HUỶ không vào mẫu số của tỷ lệ giao thành công (ORDER_OUTCOME.md mục 6).
    const settled = num(agg?.settled);
    orders = { confirmed: n, confirmedValueVnd: num(agg?.value), settled, delivered, deliveredRevenueVnd: num(agg?.deliveredRevenue), returned, cancelled, pending: n - settled - cancelled, deliveryRate: rateOrNull(delivered, settled, 1) };
  }

  // ── Đơn AI ghi hộ nhân viên ──
  const [os] = await db
    .select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${e.amountVnd}), 0)` })
    .from(e)
    .where(and(inPeriod, eq(e.type, "order.drafted"), eq(e.actorKind, "HUMAN"), sql`${e.payload}->>'via' = 'ORDER_SYNC'`));

  // ── Tiền AI (chỉ người có quyền thấy tiền) ──
  let cost: AiSalesPerformance["cost"] = null;
  let human: AiSalesPerformance["human"] = null;
  if (opts.withMoney) {
    const rate = env.facebook.usdToVnd;
    const usage = await aiUsageByRef(orgCode, ["sales_chatbot"], since);
    const testIds = new Set((await db.select({ id: c.id }).from(c).where(eq(c.channel, "TEST"))).map((r) => r.id));
    // Một page ⇒ chỉ chi phí AI của hội thoại thuộc page đó (sổ AI ghi `ref` = mã hội thoại).
    const pageConvs = opts.pageId ? new Set((await db.select({ id: c.id }).from(c).where(eq(c.pageId, opts.pageId))).map((r) => r.id)) : null;
    let selling: number | null = null;
    let orderSync: number | null = null;
    let test: number | null = null;
    let unknown = 0;
    let turns = 0;
    const add = (acc: number | null, usd: number | null) => (usd === null ? acc : (acc ?? 0) + usd * rate);
    for (const u of usage) {
      if (pageConvs && !(u.ref && pageConvs.has(u.ref.replace(/^order-sync:/, "")))) continue;
      if (u.ref?.startsWith("order-sync:")) orderSync = add(orderSync, u.costUsd);
      else if (u.ref && testIds.has(u.ref)) test = add(test, u.costUsd);
      else {
        selling = add(selling, u.costUsd);
        unknown += u.unknownCost;
        turns += u.turns;
      }
    }
    const round = (v: number | null) => (v === null ? null : Math.round(v));
    cost = {
      sellingVnd: round(selling),
      unknownCost: unknown,
      turns,
      orderSyncVnd: round(orderSync),
      testVnd: round(test),
      perDeliveredOrderVnd: selling === null || orders.delivered === 0 ? null : Math.round(selling / orders.delivered),
      perConfirmedOrderVnd: selling === null || orders.confirmed === 0 ? null : Math.round(selling / orders.confirmed),
      rateVndPerUsd: rate,
    };
    const settings = await loadPerformanceSettings();
    human = { ...settings, estimatedSavingVnd: estimatedStaffSaving(cohorts.aiOnly.conversations, settings.humanCostPerConversationVnd) };
  }

  return {
    days,
    since,
    measuredSince,
    coverage: { conversationsActive: num(active?.n), conversationsWithEvents: num(withEv?.n) },
    cohorts,
    rates: {
      aiResolution: rateOrNull(cohorts.aiOnly.confirmed, total),
      handoff: rateOrNull(cohorts.aiThenHuman.conversations, total),
      leadCapture: rateOrNull(cohorts.total.identified, total),
    },
    response: { medianMs: enough && resp?.p50 !== null ? Math.round(num(resp?.p50)) : null, p90Ms: enough && resp?.p90 !== null ? Math.round(num(resp?.p90)) : null, samples },
    handoffReasons,
    upsell: { offered: num(up?.offered), accepted: num(up?.accepted), declined: num(up?.declined), revenueVnd: num(up?.revenue), attachRate: rateOrNull(num(up?.accepted), num(up?.offered)) },
    orders,
    orderSync: { orders: num(os?.n), valueVnd: num(os?.value) },
    cost,
    human,
    economics: salesEconomics({ conversations: total, confirmedOrders: orders.confirmed, confirmedValueVnd: orders.confirmedValueVnd, deliveredRevenueVnd: orders.deliveredRevenueVnd, aiCostVnd: cost?.sellingVnd ?? null, unknownCostTurns: cost?.unknownCost ?? 0 }),
  };
}

/**
 * Chủ shop khai «chi phí một hội thoại do người làm» (₫, số nguyên) kèm LÝ DO — đầu vào DUY NHẤT của «tiết kiệm nhân sự (ước
 * tính)». `null` = gỡ khai báo. Người gọi đã kiểm quyền `ai_sales:manage`.
 */
export async function savePerformanceSettings(user: Pick<SessionUser, "email">, input: { humanCostPerConversationVnd: number | null; reason: string }, now: Date = new Date()): Promise<{ ok: true } | { error: string }> {
  const v = input.humanCostPerConversationVnd;
  if (v !== null && (!Number.isInteger(v) || v <= 0 || v > 10_000_000)) return { error: "Chi phí một hội thoại phải là số nguyên đồng, lớn hơn 0 và không quá 10.000.000 ₫." };
  const reason = (input.reason ?? "").trim();
  if (v !== null && reason.length < 5) return { error: "Ghi lý do / cách tính (ít nhất 5 ký tự) — con số này sẽ in cạnh «tiết kiệm ước tính»." };
  await setSettingJson(AI_SALES_PERFORMANCE_SETTING_KEY, { humanCostPerConversationVnd: v, setBy: user.email, reason: v === null ? null : reason.slice(0, 300), at: now.toISOString() } satisfies AiSalesPerformanceSettings);
  return { ok: true };
}
