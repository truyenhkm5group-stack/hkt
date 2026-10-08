import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dauNgayVN } from "@/lib/ai/budget";
import { aiCostOfConversationSets } from "@/lib/ai-usage/conversation-cost";
import { can, type SessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { orderFactColumns, orderFactsOf } from "@/lib/sales-chatbot/attribution";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { conversationView } from "@/lib/sales-chatbot/engine";
import { armRaw, armStats, grossProfitLift, profitAfterAiLift, type ArmAiCost, type ArmStats, type DrillFilter, type ProfitLift } from "@/lib/sales-chatbot/experiment-shared";
import { BOT_CONFIRMED, HUMAN_TOUCHED } from "@/lib/sales-chatbot/events-sql";
import { loadLostReasons } from "@/lib/sales-chatbot/lost-reasons";
import { loadModeConfig } from "@/lib/sales-chatbot/operating-mode";
import { loadOrderSyncConfig } from "@/lib/sales-chatbot/order-sync";

/**
 * ═══════════ SO AI vs NGƯỜI THEO NHÁNH + DRILL-DOWN VỀ HỘI THOẠI (DoD #9, #15) — CHỈ MÁY CHỦ ═══════════
 *
 * Luật ở experiment-shared.ts. Mọi câu đọc CSDL của tổ chức NGỮ CẢNH (`getDb()`); kênh THỬ không bao giờ tính.
 *
 * LỢI NHUẬN THEO NHÁNH (Master Mission P0.5 + P1.7, docs/revenue-attribution.md mục 7): từng đơn đọc bằng ĐÚNG đường của bảng
 * quy kết (`orderFactColumns` + `orderFactsOf`: ORDER_OUTCOME · REVENUE_RECOGNIZED_ON_DELIVERY · orderCogsFast), gộp bằng
 * `armRaw` (hàm thuần, luật `orderRow`). TIỀN AI chỉ đọc khi người xem được thấy tiền (`withMoney`), qua
 * lib/ai-usage/conversation-cost.ts — cùng phép hiểu `ref` với khung «Chi phí AI & ROI».
 *
 * MỐC GÁN NHÁNH: `pinArm` (operating-mode.ts) ghi `state.experiment = { key, arm, at }` ở tin khách ĐẦU TIÊN qua cổng chế độ
 * (fanpage / Messenger / Zalo) dưới khoá hiện hành — NGAY TRƯỚC mọi bước tốn tiền AI của lượt đó. Tiền AI của một hội thoại
 * chỉ tính từ NGÀY (giờ VN) của mốc ấy: sổ AI gom theo ngày nên lượt cùng ngày mà trước mốc (lời nhắc follow-up, ghi đơn hộ
 * chạy trước tin khách đầu tiên của thử nghiệm) vẫn bị tính — chi phí có thể CAO hơn thật, không bao giờ thấp hơn.
 *
 * MỐC CUỐI CHƯA CÓ: ERP chưa lưu lúc DỪNG thử nghiệm (`stoppedAt`). Dừng (chế độ rời EXPERIMENT, khoá giữ nguyên) thì cổng thôi
 * chia nhánh nhưng đơn + tiền AI về sau của các hội thoại đã ghim vẫn cộng vào nhánh ⇒ `profitLifts` trống kèm lý do.
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
  /** Người xem được thấy tiền AI — chỉ khi đó máy chủ đọc sổ AI và các ô tiền AI có số. */
  withMoney: boolean;
  /** Tỷ giá quy đổi tiền AI (₫/USD); `null` khi không được xem tiền. */
  rateVndPerUsd: number | null;
  arms: { AI: ArmStats; HUMAN: ArmStats };
  /** Chênh lệch LÃI AI − người — giao diện chỉ hiển thị, không tự tính. Thử nghiệm đã dừng ⇒ `null` + lý do (`STOPPED_LIFT_REASON`). */
  profitLifts: { grossProfitPerConversation: ProfitLift; profitAfterAiPerConversation: ProfitLift };
};

/** Mốc ghim nhánh đọc được ⇒ `Date`; chuỗi hỏng ⇒ `null`. */
const pinnedAt = (v: string | null): Date | null => {
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
};

/**
 * `null` = chưa có hội thoại nào được chia theo khoá thử nghiệm hiện tại. `withMoney` = người xem được thấy tiền AI
 * (`aiPerformanceWithMoney`); mặc định KHÔNG — không có quyền thì các ô tiền AI `null` và sổ AI không bị đọc.
 */
export async function loadExperimentReport(opts: { withMoney: boolean } = { withMoney: false }): Promise<ExperimentReport | null> {
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

  // TỪNG ĐƠN gắn với hội thoại của nhánh — mỗi đơn đúng một dòng (PRIMARY_ATTEMPT), đọc bằng đường chung của bảng quy kết.
  const o = schema.orders;
  const s = schema.shipments;
  const orderRows = await db
    .select({ arm: armOf, ...orderFactColumns() })
    .from(o)
    .innerJoin(c, eq(c.id, o.salesConversationId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(ne(c.channel, "TEST"), keyIs));
  const raw = (arm: string) => armRaw(count(arm), orderRows.filter((r) => r.arm === arm).map((r) => orderFactsOf(r)));
  const sync = await loadOrderSyncConfig();
  // Nhánh người chỉ có đơn qua «AI ghi đơn hộ nhân viên» — chạy trên FANPAGE và chỉ khi bật.
  const humanMeasurable = sync.enabled ? count("HUMAN", "FANPAGE") : 0;
  const humanNote = sync.enabled ? (humanMeasurable < count("HUMAN") ? "Chỉ hội thoại fanpage có đường ghi đơn hộ nhân viên" : null) : "«AI ghi đơn hộ nhân viên» đang TẮT — đơn của nhánh người chưa đo được";
  const firstAt = convs.map((r) => r.first).filter((x): x is string => Boolean(x)).sort()[0] ?? null;

  // TIỀN AI theo nhánh — chỉ khi được xem tiền. Mỗi hội thoại tính từ mốc ghim của CHÍNH nó; mốc hỏng ⇒ mốc sớm nhất của khoá.
  let money: { AI: ArmAiCost; HUMAN: ArmAiCost } | null = null;
  const rate = opts.withMoney ? env.facebook.usdToVnd : null;
  if (rate !== null) {
    const pins = await db
      .select({ id: c.id, arm: armOf, at: sql<string | null>`${c.state}->'experiment'->>'at'` })
      .from(c)
      .where(and(ne(c.channel, "TEST"), keyIs));
    const fallback = pins.map((p) => pinnedAt(p.at)).reduce<Date | null>((a, d) => (d && (!a || d < a) ? d : a), null);
    const sets = { AI: new Map<string, Date>(), HUMAN: new Map<string, Date>() };
    for (const p of pins) {
      const at = pinnedAt(p.at) ?? fallback;
      if (at && (p.arm === "AI" || p.arm === "HUMAN")) sets[p.arm].set(p.id, at);
    }
    const org = await currentOrganization();
    const cost = await aiCostOfConversationSets(org.code, sets, rate);
    money = { AI: cost.AI, HUMAN: cost.HUMAN };
  }
  const running = cfg.mode === "EXPERIMENT";
  const arms = { AI: armStats(raw("AI"), count("AI"), null, money?.AI ?? null), HUMAN: armStats(raw("HUMAN"), humanMeasurable, humanNote, money?.HUMAN ?? null) };
  return {
    key: cfg.experimentKey,
    aiSharePct: cfg.aiSharePct,
    running,
    startedAt: firstAt,
    orderSyncEnabled: sync.enabled,
    withMoney: rate !== null,
    rateVndPerUsd: rate,
    arms,
    // Thử nghiệm đã DỪNG ⇒ hai chênh lệch lãi trống kèm lý do (chưa có mốc dừng); số từng nhánh ở trên giữ nguyên.
    profitLifts: { grossProfitPerConversation: grossProfitLift(arms.AI, arms.HUMAN, running), profitAfterAiPerConversation: profitAfterAiLift(arms.AI, arms.HUMAN, running) },
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
  // Lý do không mua là phân loại LÚC ĐỌC (không có cột) ⇒ lấy đúng tập hội thoại của bảng «Vì sao khách không mua».
  const lostIds = f.lost ? ((await loadLostReasons({ days: f.days, now, pageId: f.page ?? null })).idsByReason[f.lost] ?? []) : null;
  if (lostIds && lostIds.length === 0) return { ok: true, rows: [], truncated: false };
  const rows = await db
    .select({ id: c.id, channel: c.channel, status: c.status, turns: c.turns, stage: sql<string | null>`${c.state}->>'stage'`, handoffReason: c.handoffReason, orderId: c.orderId, updatedAt: c.updatedAt, arm: sql<string | null>`${c.state}->'experiment'->>'arm'` })
    .from(c)
    .where(and(sql`${c.id} in ${ids}`, ...(f.arm ? [sql`${c.state}->'experiment'->>'arm' = ${f.arm}`] : []), ...(lostIds ? [inArray(c.id, lostIds)] : []), ...(f.page ? [eq(c.pageId, f.page)] : [])))
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
