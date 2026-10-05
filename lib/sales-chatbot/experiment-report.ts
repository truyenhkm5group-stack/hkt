import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { can, type SessionUser } from "@/lib/auth/session";
import { FINISHED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { canUseModule } from "@/lib/platform/capabilities";
import { REVENUE_RECOGNIZED_ON_DELIVERY } from "@/lib/queries/manual-order-sql";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { conversationView } from "@/lib/sales-chatbot/engine";
import { armStats, type ArmRaw, type ArmStats, type DrillFilter } from "@/lib/sales-chatbot/experiment-shared";
import { BOT_CONFIRMED, HUMAN_TOUCHED } from "@/lib/sales-chatbot/events-sql";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { loadOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";

/**
 * ═══════════ SO AI vs NGƯỜI THEO NHÁNH + DRILL-DOWN VỀ HỘI THOẠI (DoD #9, #15) — CHỈ MÁY CHỦ ═══════════
 *
 * Luật ở experiment-shared.ts. Mọi câu đọc CSDL của tổ chức NGỮ CẢNH (`getDb()`); kênh THỬ không bao giờ tính.
 */

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export type ExperimentReport = {
  key: string;
  aiSharePct: number;
  running: boolean;
  startedAt: string | null;
  orderSyncEnabled: boolean;
  arms: { AI: ArmStats; HUMAN: ArmStats };
};

/** `null` = chưa có hội thoại nào được chia theo khoá thử nghiệm hiện tại. */
export async function loadExperimentReport(): Promise<ExperimentReport | null> {
  const cfg = await loadModeConfig();
  const db = await getDb();
  const c = schema.salesChatConversations;
  const keyIs = sql`${c.state}->'experiment'->>'key' = ${cfg.experimentKey}`;
  const armOf = sql<string>`${c.state}->'experiment'->>'arm'`;
  const convs = await db
    .select({ arm: armOf, channel: c.channel, n: sql<number>`count(*)::int`, first: sql<string | null>`min(${c.state}->'experiment'->>'at')` })
    .from(c)
    .where(and(ne(c.channel, "TEST"), keyIs))
    .groupBy(armOf, c.channel);
  if (!convs.length) return null;
  const count = (arm: string, channel?: string) => convs.filter((r) => r.arm === arm && (!channel || r.channel === channel)).reduce((s, r) => s + num(r.n), 0);

  const o = schema.orders;
  const s = schema.shipments;
  const per = db
    .select({ arm: armOf.as("p_arm"), outcome: ORDER_OUTCOME.as("p_outcome"), value: sql<number>`${o.totalPriceAfterDiscount}`.as("p_value"), recognized: sql<boolean>`${REVENUE_RECOGNIZED_ON_DELIVERY}`.as("p_recognized") })
    .from(o)
    .innerJoin(c, eq(c.id, o.salesConversationId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(ne(c.channel, "TEST"), keyIs))
    .as("p");
  const agg = await db
    .select({
      arm: per.arm,
      orders: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${per.value}), 0)`,
      settled: sql<number>`count(*) filter (where ${per.outcome} in (${sql.raw(FINISHED_OUTCOMES_SQL)}))::int`,
      delivered: sql<number>`count(*) filter (where ${per.outcome} = 'DELIVERED')::int`,
      deliveredRevenue: sql<number>`coalesce(sum(${per.value}) filter (where ${per.outcome} = 'DELIVERED' and ${per.recognized}), 0)`,
    })
    .from(per)
    .groupBy(per.arm);
  const raw = (arm: string): ArmRaw => {
    const a = agg.find((x) => x.arm === arm);
    return { conversations: count(arm), orders: num(a?.orders), ordersValueVnd: num(a?.value), settled: num(a?.settled), delivered: num(a?.delivered), deliveredRevenueVnd: num(a?.deliveredRevenue) };
  };
  const sync = await loadOrderSyncConfig();
  // Nhánh người chỉ có đơn qua «AI ghi đơn hộ nhân viên» — chạy trên FANPAGE và chỉ khi bật.
  const humanMeasurable = sync.enabled ? count("HUMAN", "FANPAGE") : 0;
  const humanNote = sync.enabled ? (humanMeasurable < count("HUMAN") ? "Chỉ hội thoại fanpage có đường ghi đơn hộ nhân viên" : null) : "«AI ghi đơn hộ nhân viên» đang TẮT — đơn của nhánh người chưa đo được";
  const firstAt = convs.map((r) => r.first).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  return {
    key: cfg.experimentKey,
    aiSharePct: cfg.aiSharePct,
    running: cfg.mode === "EXPERIMENT",
    startedAt: firstAt,
    orderSyncEnabled: sync.enabled,
    arms: { AI: armStats(raw("AI"), count("AI")), HUMAN: armStats(raw("HUMAN"), humanMeasurable, humanNote) },
  };
}

// ─────────────────────────── Drill-down ───────────────────────────

export type DrillRow = { id: string; channel: string; status: string; turns: number; stage: string | null; handoffReason: string | null; orderId: string | null; updatedAt: string; arm: string | null };

/** Danh sách hội thoại khớp bộ lọc (cùng định nghĩa với phễu của màn «Hiệu quả»: hội thoại có tin khách trong kỳ). */
export async function listDrillConversations(user: SessionUser, f: DrillFilter, now: Date = new Date()): Promise<{ ok: true; rows: DrillRow[]; truncated: boolean } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, "ai_sales:view")) return { error: "Bạn không có quyền xem AI bán hàng." };
  const db = await getDb();
  const e = schema.salesConversationEvents;
  const c = schema.salesChatConversations;
  const since = new Date(dauNgayVN(now).getTime() - (f.days - 1) * 86_400_000);
  const human = sql`bool_or(${HUMAN_TOUCHED})`;
  const conds = [sql`bool_or(${e.type} = 'message.received')`];
  if (f.cohort === "AI_ONLY") conds.push(sql`not ${human}`);
  if (f.cohort === "AI_THEN_HUMAN") conds.push(human);
  if (f.confirmed) conds.push(sql`bool_or(${BOT_CONFIRMED})`);
  if (f.reason) conds.push(sql`bool_or(${e.type} in ('handoff.requested','human.took_over') and coalesce(${e.reasonCode}, 'OTHER') = ${f.reason})`);
  const ids = db
    .select({ id: e.conversationId })
    .from(e)
    .where(and(gte(e.occurredAt, since), ne(e.channel, "TEST")))
    .groupBy(e.conversationId)
    .having(and(...conds));
  const LIMIT = 200;
  const rows = await db
    .select({ id: c.id, channel: c.channel, status: c.status, turns: c.turns, stage: sql<string | null>`${c.state}->>'stage'`, handoffReason: c.handoffReason, orderId: c.orderId, updatedAt: c.updatedAt, arm: sql<string | null>`${c.state}->'experiment'->>'arm'` })
    .from(c)
    .where(and(sql`${c.id} in ${ids}`, ...(f.arm ? [sql`${c.state}->'experiment'->>'arm' = ${f.arm}`] : [])))
    .orderBy(desc(c.updatedAt))
    .limit(LIMIT + 1);
  return { ok: true, truncated: rows.length > LIMIT, rows: rows.slice(0, LIMIT).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
}

export type ConversationReview = { view: ChatView; channel: string; arm: string | null; handoffReason: string | null; createdAt: string; events: { type: string; at: string; actor: string; reason: string | null }[] };

/** Xem lại MỘT hội thoại (chữ + công cụ + dòng sổ sự kiện). Kênh THỬ không mở ở đây. */
export async function loadConversationReview(user: SessionUser, id: string): Promise<{ ok: true; value: ConversationReview } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, "ai_sales:view")) return { error: "Bạn không có quyền xem AI bán hàng." };
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select().from(c).where(eq(c.id, String(id ?? ""))).limit(1);
  if (!conv || conv.channel === "TEST") return { error: "Không có hội thoại này." };
  const view = await conversationView(conv.id);
  if (!view) return { error: "Không có hội thoại này." };
  const e = schema.salesConversationEvents;
  const ev = await db.select({ type: e.type, at: e.occurredAt, actor: e.actorKind, reason: e.reasonCode }).from(e).where(eq(e.conversationId, conv.id)).orderBy(e.occurredAt).limit(300);
  const state = (conv.state ?? {}) as Record<string, unknown>;
  const exp = state.experiment && typeof state.experiment === "object" ? (state.experiment as Record<string, unknown>) : null;
  return {
    ok: true,
    value: { view, channel: conv.channel, arm: typeof exp?.arm === "string" ? exp.arm : null, handoffReason: conv.handoffReason, createdAt: conv.createdAt.toISOString(), events: ev.map((x) => ({ type: x.type, at: x.at.toISOString(), actor: x.actor, reason: x.reason })) },
  };
}
