import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AiBlock } from "@/lib/ai/provider";
import { can, type SessionUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { canUseModule } from "@/lib/platform/capabilities";
import { readJsonSetting } from "@/lib/sales-chatbot/engine";
import {
  COPILOT_NO_REPLY_HOURS,
  copilotVerdict,
  DEFAULT_MODE_CONFIG,
  OPERATING_MODE_SETTING_KEY,
  OPERATING_MODES,
  parseModeConfig,
  similarity,
  type CopilotVerdict,
  type ModeConfig,
  type OperatingMode,
  type ReplyGate,
} from "@/lib/sales-chatbot/operating-mode-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { shadowTurn } from "@/lib/sales-chatbot/shadow";
import { setSettingJson } from "@/lib/settings";

/**
 * ═══════════ CHẾ ĐỘ VẬN HÀNH — LÕI MÁY CHỦ (luật ở operating-mode-shared.ts) ═══════════
 *
 * Lối vào kênh (fanpage.ts; messenger / zalo khi nối) gọi `loadModeConfig` + `replyGate` ngay TRƯỚC lượt AI, rồi:
 *  · `pinArm` khi cổng nói `pinNow` (thử nghiệm) — ghi nhánh vào `state.experiment` của hội thoại;
 *  · OBSERVE ⇒ không gọi AI; COPILOT ⇒ `draftCopilotSuggestion` (hội thoại bóng, không gửi); AUTOPILOT ⇒ như cũ.
 */

export async function loadModeConfig(): Promise<ModeConfig> {
  return parseModeConfig(await readJsonSetting(OPERATING_MODE_SETTING_KEY));
}

export async function saveModeConfig(user: SessionUser, raw: { mode?: unknown; aiSharePct?: unknown; restartExperiment?: unknown }, now: Date = new Date()): Promise<{ ok: true; message: string } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền đổi chế độ chatbot (ai_sales:manage)." };
  if (!(OPERATING_MODES as readonly string[]).includes(String(raw.mode))) return { error: "Chế độ không hợp lệ." };
  const mode = raw.mode as OperatingMode;
  const share = Number(raw.aiSharePct ?? DEFAULT_MODE_CONFIG.aiSharePct);
  if (!Number.isInteger(share) || share < 0 || share > 100) return { error: "Tỷ lệ AI phải là số nguyên 0–100." };
  const before = await loadModeConfig();
  // Bắt đầu thử nghiệm MỚI (lần đầu, hoặc người bấm «chia lại») ⇒ khoá mới: hội thoại được chia lại từ đầu.
  const restart = raw.restartExperiment === true || (mode === "EXPERIMENT" && before.mode !== "EXPERIMENT");
  const experimentKey = restart ? `e${now.getTime().toString(36)}` : before.experimentKey;
  const next: ModeConfig = { mode, aiSharePct: share, experimentKey, updatedAt: now.toISOString(), updatedByEmail: user.email };
  await setSettingJson(OPERATING_MODE_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_BOT_MODE_SET", entity: "SETTING", entityId: OPERATING_MODE_SETTING_KEY, before, after: next });
  return { ok: true, message: mode === "EXPERIMENT" ? `Đang thử nghiệm: ${share}% hội thoại mới cho AI, còn lại người trả lời.` : "Đã đổi chế độ — áp từ tin khách kế tiếp." };
}

/** Ghi nhánh thử nghiệm vào hội thoại (một lần cho mỗi khoá thử nghiệm). */
export async function pinArm(conversationId: string, gate: ReplyGate, now: Date = new Date()): Promise<void> {
  if (!gate.pinNow || !gate.arm || !gate.experimentKey) return;
  const c = schema.salesChatConversations;
  const db = await getDb();
  await db
    .update(c)
    .set({ state: sql`${c.state} || ${JSON.stringify({ experiment: { key: gate.experimentKey, arm: gate.arm, at: now.toISOString() } })}::jsonb` })
    .where(eq(c.id, conversationId));
}

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

export const COPILOT_TAG = (conversationId: string) => `copilot:${conversationId}`;

/**
 * COPILOT: bot soạn câu cho lượt tin khách này ở hội thoại BÓNG (≤ 20 tin lịch sử của hội thoại thật), KHÔNG gửi, lưu
 * làm gợi ý. Trước khi lưu, chấm các gợi ý cũ của cùng hội thoại (câu thật của page có thể đã tới).
 */
export async function draftCopilotSuggestion(input: { conversationId: string; pageId: string; threadId: string; text: string; context?: string; now?: Date }): Promise<{ id: string; ok: boolean }> {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const rows = await db.select({ seq: m.seq, role: m.role, content: m.content }).from(m).where(eq(m.conversationId, input.conversationId)).orderBy(desc(m.seq)).limit(20);
  const history = rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", text: textOf(r.content as AiBlock[]) }))
    .filter((r) => r.text);
  await scoreCopilotSuggestions(input.now ?? new Date(), { pageId: input.pageId, threadId: input.threadId });
  const shadow = await shadowTurn({ tag: COPILOT_TAG(input.conversationId), history, text: input.text, ...(input.context ? { context: input.context } : {}) });
  const s = schema.salesCopilotSuggestions;
  const [row] = await db
    .insert(s)
    .values({
      conversationId: input.conversationId,
      pageId: input.pageId,
      threadId: input.threadId,
      customerText: input.text.slice(0, 2_000),
      suggestion: shadow.ok ? shadow.reply.slice(0, 4_000) : null,
      aiStatus: shadow.status,
      tools: shadow.tools.slice(0, 20),
      error: shadow.error,
      ...(input.now ? { createdAt: input.now } : {}),
    })
    .returning({ id: s.id });
  return { id: row.id, ok: shadow.ok };
}

/**
 * Chấm gợi ý chưa chấm: câu thật = tin page (`PAGE_REPLY`) ĐẦU TIÊN của cùng hội thoại tới SAU gợi ý. Không có sau
 * `COPILOT_NO_REPLY_HOURS` ⇒ NO_REPLY. Gợi ý hỏng (không có câu) ⇒ không chấm độ giống, chỉ ghi câu thật.
 */
export async function scoreCopilotSuggestions(now: Date = new Date(), only?: { pageId: string; threadId: string }): Promise<number> {
  const db = await getDb();
  const s = schema.salesCopilotSuggestions;
  const t = schema.salesChatInbound;
  const pending = await db
    .select()
    .from(s)
    .where(and(isNull(s.scoredAt), ...(only ? [eq(s.pageId, only.pageId), eq(s.threadId, only.threadId)] : [])))
    .orderBy(asc(s.createdAt))
    .limit(200);
  let scored = 0;
  for (const p of pending) {
    const [reply] = await db
      .select({ text: t.text, at: t.createdAt })
      .from(t)
      .where(and(eq(t.pageId, p.pageId), eq(t.threadId, p.threadId), eq(t.note, "PAGE_REPLY"), gt(t.createdAt, p.createdAt)))
      .orderBy(asc(t.createdAt))
      .limit(1);
    if (!reply) {
      if (now.getTime() - p.createdAt.getTime() < COPILOT_NO_REPLY_HOURS * 3_600_000) continue;
      await db.update(s).set({ verdict: "NO_REPLY", scoredAt: now }).where(and(eq(s.id, p.id), isNull(s.scoredAt)));
      scored += 1;
      continue;
    }
    const sim = p.suggestion ? similarity(p.suggestion, reply.text) : null;
    const verdict: CopilotVerdict | null = p.suggestion ? copilotVerdict(sim) : null;
    await db.update(s).set({ humanReply: reply.text.slice(0, 4_000), humanReplyAt: reply.at, similarity: sim, verdict, scoredAt: now }).where(and(eq(s.id, p.id), isNull(s.scoredAt)));
    scored += 1;
  }
  return scored;
}

// ─────────────────────────── Đọc cho màn hình ───────────────────────────

export type CopilotRow = { id: string; createdAt: string; customerText: string; suggestion: string | null; error: string | null; humanReply: string | null; similarity: number | null; verdict: CopilotVerdict | null };
export type CopilotStats = { suggestions: number; scored: number; byVerdict: Record<CopilotVerdict, number>; medianSimilarity: number | null; failed: number };
export type ExperimentArms = { key: string; ai: number; human: number } | null;

const MIN_SAMPLE = 5;

export async function loadCopilotView(user: SessionUser, now: Date = new Date()): Promise<{ ok: true; config: ModeConfig; stats: CopilotStats; rows: CopilotRow[]; arms: ExperimentArms } | { error: string }> {
  if (!(await canUseModule("ai_sales"))) return { error: "Module AI bán hàng chưa bật." };
  if (!can(user, "ai_sales:view")) return { error: "Bạn không có quyền xem AI bán hàng." };
  await scoreCopilotSuggestions(now);
  const db = await getDb();
  const s = schema.salesCopilotSuggestions;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db.select().from(s).where(gt(s.createdAt, since)).orderBy(desc(s.createdAt)).limit(500);
  const byVerdict: Record<CopilotVerdict, number> = { SAME: 0, EDITED: 0, DIFFERENT: 0, NO_REPLY: 0 };
  const sims: number[] = [];
  for (const r of rows) {
    if (r.verdict && r.verdict in byVerdict) byVerdict[r.verdict as CopilotVerdict] += 1;
    if (r.similarity !== null) sims.push(r.similarity);
  }
  sims.sort((a, b) => a - b);
  const median = sims.length >= MIN_SAMPLE ? (sims.length % 2 ? sims[(sims.length - 1) / 2] : (sims[sims.length / 2 - 1] + sims[sims.length / 2]) / 2) : null;
  const config = await loadModeConfig();
  let arms: ExperimentArms = null;
  if (config.mode === "EXPERIMENT" || config.experimentKey !== DEFAULT_MODE_CONFIG.experimentKey) {
    const c = schema.salesChatConversations;
    const [a] = await db
      .select({
        ai: sql<number>`count(*) filter (where ${c.state}->'experiment'->>'arm' = 'AI')::int`,
        human: sql<number>`count(*) filter (where ${c.state}->'experiment'->>'arm' = 'HUMAN')::int`,
      })
      .from(c)
      .where(sql`${c.state}->'experiment'->>'key' = ${config.experimentKey}`);
    arms = { key: config.experimentKey, ai: Number(a?.ai ?? 0), human: Number(a?.human ?? 0) };
  }
  return {
    ok: true,
    config,
    stats: { suggestions: rows.length, scored: rows.filter((r) => r.scoredAt).length, byVerdict, medianSimilarity: median, failed: rows.filter((r) => !r.suggestion).length },
    rows: rows.slice(0, 50).map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), customerText: r.customerText, suggestion: r.suggestion, error: r.error, humanReply: r.humanReply, similarity: r.similarity, verdict: (r.verdict as CopilotVerdict | null) ?? null })),
    arms,
  };
}
