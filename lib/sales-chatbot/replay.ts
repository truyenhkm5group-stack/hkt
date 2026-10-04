import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { can, type SessionUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { loadSalesChatbotConfig, salesChatProvider } from "@/lib/sales-chatbot/engine";
import { shadowTurn } from "@/lib/sales-chatbot/shadow";
import {
  extractMoneyAmounts,
  judgePoint,
  pickReplayPoints,
  REPLAY_LIMITS,
  summarizeReplay,
  type ReplayFlag,
  type ReplaySummary,
  type SourceConversation,
  type SourceMessage,
} from "@/lib/sales-chatbot/replay-shared";

/**
 * ═══════════ PHÁT LẠI HỘI THOẠI CŨ — LÕI MÁY CHỦ (docs/productization/22_HISTORICAL_REPLAY.md) ═══════════
 *
 * Nguồn: hội thoại THẬT của chính tổ chức đã lưu trong ERP (kênh FANPAGE / WEB — bảng `sales_chat_*`). Mỗi điểm: dựng một hội
 * thoại kênh THỬ mang đúng lịch sử tới trước tin khách đó, cho AI trả lời bằng ĐÚNG đường bán hàng thật (`shadowTurn` —
 * lib/sales-chatbot/shadow.ts), rồi chấm bằng luật tất định (`judgePoint`). Kênh THỬ: công cụ ghi chỉ mô phỏng — KHÔNG tạo
 * khách, đơn, giữ hàng hay tin nhắn nào tới khách / nhóm. Hội thoại tạm bị xoá sau khi chụp kết quả.
 *
 * Chi phí: mỗi điểm là một lượt AI thật trên khoá của tổ chức, đi qua hạn mức AI như mọi lượt khác (`checkAiQuota` trong
 * `chatTurn`). Một lượt mỗi lúc; người bấm phải có `ai_sales:manage`.
 */

export const REPLAY_CREATED_BY = (runId: string) => `replay:${runId}`;

type Gate = { ok: true } | { ok: false; error: string };

async function gate(user: SessionUser, perm: "ai_sales:view" | typeof SALES_CHATBOT_MANAGE): Promise<Gate> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!can(user, perm)) return { ok: false, error: perm === SALES_CHATBOT_MANAGE ? "Bạn không có quyền chạy phát lại (ai_sales:manage)." : "Bạn không có quyền xem AI bán hàng." };
  return { ok: true };
}

export type ReplayRunRow = { id: string; status: string; targetPoints: number; days: number; summary: ReplaySummary | null; error: string | null; createdByEmail: string | null; startedAt: string; finishedAt: string | null };
export type ReplayPointRow = {
  id: string;
  sourceConversationId: string;
  sourceChannel: string;
  sourceSeq: number;
  customerText: string;
  historyMessages: number;
  historicalReply: string | null;
  historicalSpeaker: string;
  aiReply: string | null;
  aiStatus: string | null;
  tools: { name: string; ok: boolean; summary: string }[];
  flags: ReplayFlag[];
  ungroundedAmounts: number[];
  error: string | null;
};

function runRow(r: typeof schema.salesReplayRuns.$inferSelect): ReplayRunRow {
  return { id: r.id, status: r.status, targetPoints: r.targetPoints, days: r.days, summary: (r.summary as ReplaySummary | null) ?? null, error: r.error, createdByEmail: r.createdByEmail, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
}

/** Kiểm mọi điều kiện rồi ghi lượt RUNNING. Việc nặng (`runReplay`) chạy SAU phản hồi trong đúng ngữ cảnh tổ chức. */
export async function startReplay(user: SessionUser, raw: { points?: unknown; days?: unknown }, now: Date = new Date()): Promise<{ ok: true; runId: string } | { error: string }> {
  const g = await gate(user, SALES_CHATBOT_MANAGE);
  if (!g.ok) return { error: g.error };
  const points = Number(raw.points);
  const days = Number(raw.days);
  if (!(REPLAY_LIMITS.pointChoices as readonly number[]).includes(points)) return { error: "Số điểm không hợp lệ." };
  if (!(REPLAY_LIMITS.dayChoices as readonly number[]).includes(days)) return { error: "Khoảng ngày không hợp lệ." };
  const prov = await salesChatProvider();
  if (!prov.ok) return { error: prov.error };
  const org = await currentOrganization();
  const quota = await checkAiQuota(org.code, prov.source);
  if (!quota.ok) return { error: quota.error };
  const db = await getDb();
  const r = schema.salesReplayRuns;
  const [running] = await db.select({ id: r.id, startedAt: r.startedAt }).from(r).where(eq(r.status, "RUNNING")).orderBy(desc(r.startedAt)).limit(1);
  if (running && now.getTime() - running.startedAt.getTime() < REPLAY_LIMITS.runStaleMinutes * 60_000) return { error: "Đang có một lượt phát lại chạy — đợi xong rồi chạy lại." };
  if (running) await db.update(r).set({ status: "FAILED", error: "Treo quá lâu — bị thay bằng lượt mới.", finishedAt: now }).where(eq(r.id, running.id));
  const [row] = await db.insert(r).values({ targetPoints: points, days, createdByUserId: user.id, createdByEmail: user.email, startedAt: now }).returning({ id: r.id });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_REPLAY_START", entity: "SALES_REPLAY_RUN", entityId: row.id, after: { points, days } });
  return { ok: true, runId: row.id };
}

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/** Hội thoại nguồn: kênh khách thật (không THỬ, không hội thoại tạm của lượt phát lại), trong `days` ngày, có tin khách. */
async function loadSources(days: number, now: Date, limit: number): Promise<SourceConversation[]> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  const since = new Date(now.getTime() - days * 86_400_000);
  const convs = await db
    .select({ id: c.id, channel: c.channel, createdAt: c.createdAt })
    .from(c)
    .where(and(ne(c.channel, "TEST"), gte(c.createdAt, since), sql`${c.turns} > 0`))
    .orderBy(desc(c.createdAt))
    .limit(limit);
  if (!convs.length) return [];
  const rows = await db.select({ conversationId: m.conversationId, seq: m.seq, role: m.role, content: m.content }).from(m).where(inArray(m.conversationId, convs.map((x) => x.id)));
  const byConv = new Map<string, SourceMessage[]>();
  for (const r of rows) {
    const text = textOf(r.content as AiBlock[]);
    if (!text) continue;
    if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []);
    byConv.get(r.conversationId)!.push({ seq: r.seq, role: r.role as "user" | "assistant", text });
  }
  return convs.map((x) => ({ id: x.id, channel: x.channel, createdAt: x.createdAt, messages: byConv.get(x.id) ?? [] }));
}

/** Tập căn cứ của giá: giá bảng mọi mẫu mã còn bán + phí ship đã khai. Số do công cụ trả trong lượt cộng thêm ở `judgePoint`. */
async function groundedPrices(): Promise<Set<number>> {
  const db = await getDb();
  const v = schema.productVariants;
  const rows = await db.select({ p: v.retailPrice, d: v.retailPriceAfterDiscount }).from(v).where(eq(v.isRemoved, false));
  const out = new Set<number>();
  for (const r of rows) {
    if (r.p > 0) out.add(r.p);
    if (r.d > 0) out.add(r.d);
  }
  const cfg = await loadSalesChatbotConfig();
  if (cfg.shippingFee) out.add(cfg.shippingFee);
  return out;
}

export type ReplayDeps = { now?: () => Date };

/** Lượt chạy NẶNG. Không ném: lỗi cả lượt ⇒ FAILED kèm câu; lỗi một điểm ⇒ điểm mang cờ ERROR, lượt chạy tiếp. */
export async function runReplay(runId: string, actor: { id: string | null }, deps: ReplayDeps = {}): Promise<ReplayRunRow | null> {
  const now = deps.now ?? (() => new Date());
  const db = await getDb();
  const r = schema.salesReplayRuns;
  const p = schema.salesReplayPoints;
  const [run] = await db.select().from(r).where(eq(r.id, runId)).limit(1);
  if (!run || run.status !== "RUNNING") return run ? runRow(run) : null;
  try {
    const sources = await loadSources(run.days, now(), run.targetPoints * 4);
    const points = pickReplayPoints(sources, run.targetPoints);
    const grounded = await groundedPrices();
    const judged: { conversationId: string; flags: ReplayFlag[]; aiReply: string | null }[] = [];
    for (const pt of points) {
      // Số shop đã nói trước đó trong chính hội thoại cũng là căn cứ (AI nhắc lại giá shop vừa báo không phải bịa).
      const historyAmounts = pt.history.filter((m) => m.role === "assistant").flatMap((m) => extractMoneyAmounts(m.text));
      const pointGrounded = new Set<number>([...grounded, ...historyAmounts]);
      const shadow = await shadowTurn({ tag: REPLAY_CREATED_BY(runId), history: pt.history, text: pt.customerText, actorId: actor.id });
      const ok = shadow.ok;
      const aiReply: string | null = shadow.ok ? shadow.reply : null;
      const aiStatus = shadow.status;
      const tools = shadow.tools;
      const error = shadow.error;
      const { flags, ungrounded } = judgePoint(pt, { ok, aiReply: aiReply ?? "", aiStatus, tools }, pointGrounded);
      await db.insert(p).values({
        runId,
        sourceConversationId: pt.conversationId,
        sourceChannel: pt.channel,
        sourceSeq: pt.seq,
        customerText: pt.customerText.slice(0, 2_000),
        historyMessages: pt.history.length,
        historicalReply: pt.historicalReply?.slice(0, 2_000) ?? null,
        historicalSpeaker: pt.historicalSpeaker,
        aiReply: aiReply?.slice(0, 4_000) ?? null,
        aiStatus,
        tools: tools.slice(0, 20),
        flags,
        ungroundedAmounts: ungrounded.slice(0, 20),
        error,
      });
      judged.push({ conversationId: pt.conversationId, flags, aiReply });
    }
    const summary = summarizeReplay(judged);
    const [done] = await db
      .update(r)
      .set({ status: "DONE", summary: summary as unknown as Record<string, unknown>, finishedAt: now(), error: points.length ? null : "Không có hội thoại khách thật nào trong khoảng ngày đã chọn." })
      .where(eq(r.id, runId))
      .returning();
    return runRow(done);
  } catch (e) {
    const [failed] = await db
      .update(r)
      .set({ status: "FAILED", error: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500), finishedAt: now() })
      .where(eq(r.id, runId))
      .returning();
    return failed ? runRow(failed) : null;
  }
}

// ─────────────────────────── Đọc cho màn hình ───────────────────────────

export async function listReplayRuns(user: SessionUser, limit = 20): Promise<{ ok: true; runs: ReplayRunRow[] } | { error: string }> {
  const g = await gate(user, "ai_sales:view");
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const rows = await db.select().from(schema.salesReplayRuns).orderBy(desc(schema.salesReplayRuns.startedAt)).limit(limit);
  return { ok: true, runs: rows.map(runRow) };
}

export async function loadReplayRun(user: SessionUser, runId: string): Promise<{ ok: true; run: ReplayRunRow; points: ReplayPointRow[] } | { error: string }> {
  const g = await gate(user, "ai_sales:view");
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const [run] = await db.select().from(schema.salesReplayRuns).where(eq(schema.salesReplayRuns.id, String(runId ?? ""))).limit(1);
  if (!run) return { error: "Không có lượt phát lại này." };
  const rows = await db.select().from(schema.salesReplayPoints).where(eq(schema.salesReplayPoints.runId, run.id)).orderBy(schema.salesReplayPoints.createdAt);
  return {
    ok: true,
    run: runRow(run),
    points: rows.map((x) => ({
      id: x.id,
      sourceConversationId: x.sourceConversationId,
      sourceChannel: x.sourceChannel,
      sourceSeq: x.sourceSeq,
      customerText: x.customerText,
      historyMessages: x.historyMessages,
      historicalReply: x.historicalReply,
      historicalSpeaker: x.historicalSpeaker,
      aiReply: x.aiReply,
      aiStatus: x.aiStatus,
      tools: x.tools,
      flags: x.flags as ReplayFlag[],
      ungroundedAmounts: x.ungroundedAmounts,
      error: x.error,
    })),
  };
}
