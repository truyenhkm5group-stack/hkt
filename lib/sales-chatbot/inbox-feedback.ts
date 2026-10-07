/**
 * ═══════════ GÓP Ý CỦA NHÂN VIÊN CHO AI — MỘT HỘI THOẠI ⇒ BÀI HỌC NGAY ═══════════
 *
 * Chủ shop 06/10/2026 (mọi tổ chức SaaS): «Tại mỗi cuộc hội thoại, thêm phần feedback kèm nút gửi cho AI sales agent để chat bot
 * học và rút kinh nghiệm để lần sau không lặp lại và chat tốt hơn». Bot đã TỰ HỌC mỗi 6 giờ (`lessons.ts`); góp ý là đường
 * NHANH và CÓ CHỦ ĐÍCH: nhân viên chỉ ra bot sai ở đâu ⇒ AI của shop đọc góp ý + đoạn chép hội thoại (đã che SĐT / tên / số) ⇒
 * 1–3 bài học «Khi … ⇒ …» ⇒ nhập vào ĐẦU bộ bài học đang dùng (bản trước lùi vào lịch sử, quay lại được ở trang Chatbot).
 * Góp ý luôn được LƯU (kể cả khi AI lỗi — `FAILED`, gửi lại được); bài học không bao giờ mang giá (`normalizeLessons`), và bài
 * AI rút ra mà nhắc tới tiền / tài khoản / liên kết KHÔNG tự vào bot (`screenAiLessons` — cùng bộ lọc với tự học).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { estimateCostUsd, type AiBlock } from "@/lib/ai/provider";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { publish } from "@/lib/realtime/bus";
import { salesChatProvider } from "@/lib/sales-chatbot/engine";
import { PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { lessonTranscript, LESSON_LIMITS, normalizeLessons, parseLessonsFromAi, screenAiLessons, type LessonsState, type TranscriptLine } from "@/lib/sales-chatbot/lessons-shared";
import { loadLessons } from "@/lib/sales-chatbot/lessons";
import { setSettingJson } from "@/lib/settings";
import { LESSONS_SETTING_KEY } from "@/lib/sales-chatbot/lessons-shared";

export const FEEDBACK_MAX = 1_000;
const FEEDBACK_AI_TOKENS = 1_500;

export const FEEDBACK_SYSTEM = [
  "Bạn là trưởng nhóm bán hàng online. Nhân viên vừa GÓP Ý cho chatbot AI của shop về MỘT hội thoại (đoạn chép đã che SĐT / tên / số).",
  "Biến góp ý thành 1–3 BÀI HỌC cho bot, mỗi bài MỘT dòng dạng «Khi <tình huống cụ thể> ⇒ <làm gì / nói câu gì>», tối đa 200 ký tự, áp dụng được cho khách sau.",
  "Bám đúng ý nhân viên; dùng hội thoại để hiểu tình huống. KHÔNG ghi giá, số tiền, SĐT, tên khách, địa chỉ. Không lặp lại bài học đang có.",
  'Chỉ trả về MỘT mảng JSON các chuỗi, vd ["Khi … ⇒ …"]. Không giải thích.',
].join("\n");

export type FeedbackRow = { id: string; userName: string; text: string; lessons: string[]; status: "APPLIED" | "FAILED"; error: string | null; createdAt: string };
type Result = { ok: true; message: string; lessons: string[] } | { ok: false; error: string };

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

function canGiveFeedback(user: SessionUser): boolean {
  return can(user, "ai_sales:reply") || can(user, "outreach:send") || can(user, "ai_sales:manage");
}

/** Đoạn chép của hội thoại (≤ `linesPerThread` dòng cuối, đã che). */
async function transcriptOf(convId: string): Promise<string | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ pageId: c.pageId, threadId: c.threadId, state: c.state }).from(c).where(eq(c.id, convId)).limit(1);
  if (!conv) return null;
  const lines: TranscriptLine[] = [];
  const names: string[] = [];
  const st = (conv.state ?? {}) as { customer?: { name?: string } };
  if (st.customer?.name) names.push(st.customer.name);
  if (conv.pageId && conv.threadId) {
    const t = schema.salesChatInbound;
    const rows = await db
      .select({ text: t.text, note: t.note, messageId: t.messageId, name: t.customerName })
      .from(t)
      .where(and(eq(t.pageId, conv.pageId), eq(t.threadId, conv.threadId), eq(t.kind, "INBOX")))
      .orderBy(desc(t.createdAt))
      .limit(LESSON_LIMITS.linesPerThread * 2);
    for (const r of rows.reverse()) {
      if (r.name) names.push(r.name);
      if (r.note === "BOT_SENT") {
        if (r.messageId.startsWith("bot-out:")) lines.push({ who: "BOT", text: r.text });
      } else if (r.note === PAGE_REPLY) lines.push({ who: "SHOP", text: r.text });
      else lines.push({ who: "KHÁCH", text: r.text });
    }
  } else {
    const m = schema.salesChatMessages;
    const rows = await db.select({ role: m.role, content: m.content }).from(m).where(eq(m.conversationId, convId)).orderBy(asc(m.seq));
    for (const r of rows.slice(-LESSON_LIMITS.linesPerThread)) {
      const text = textOf((r.content ?? []) as AiBlock[]);
      if (text) lines.push({ who: r.role === "user" ? "KHÁCH" : "BOT", text });
    }
  }
  return lessonTranscript(lines, "[HỘI THOẠI NHÂN VIÊN GÓP Ý]", names) ?? lines.map((l) => `${l.who}: ${l.text}`).join("\n").slice(-4000);
}

/** Góp ý của nhân viên ⇒ bài học ngay. Góp ý luôn được lưu; AI lỗi ⇒ `FAILED` (gửi lại được). */
export async function submitConversationFeedbackCore(user: SessionUser, conversationId: unknown, rawText: unknown, now: Date = new Date()): Promise<Result> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!canGiveFeedback(user)) return { ok: false, error: "Bạn không có quyền góp ý cho bot (cần quyền trả lời khách)." };
  const id = String(conversationId ?? "").trim();
  const text = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, FEEDBACK_MAX);
  if (text.length < 5) return { ok: false, error: "Góp ý quá ngắn — viết rõ bot sai ở đâu, nên làm gì." };
  const transcript = await transcriptOf(id);
  if (transcript === null) return { ok: false, error: "Không thấy hội thoại." };
  const db = await getDb();
  const f = schema.salesChatFeedback;
  const fail = async (error: string): Promise<Result> => {
    await db.insert(f).values({ conversationId: id, userId: user.id, userName: user.name ?? user.email, text, lessons: [], status: "FAILED", error: error.slice(0, 300), createdAt: now });
    return { ok: false, error: `Đã lưu góp ý nhưng chưa rút được bài học: ${error}` };
  };
  const org = await currentOrganization();
  const prov = await salesChatProvider();
  if (!prov.ok) return fail(prov.error);
  const quota = await checkAiQuota(org.code, prov.source);
  if (!quota.ok) return fail(quota.error);
  let state: LessonsState = await loadLessons();
  const prompt = [`BÀI HỌC ĐANG CÓ (${state.lessons.length}):`, state.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n") || "(chưa có)", "", "GÓP Ý CỦA NHÂN VIÊN:", text, "", "HỘI THOẠI:", transcript].join("\n");
  let out = "";
  try {
    const res = await prov.provider.complete({ system: FEEDBACK_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: FEEDBACK_AI_TOKENS, reasoning: "low" });
    out = textOf(res.content);
    await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model || prov.provider.model, res.usage), status: "OK", actorId: user.id, ref: `feedback:${id}` }).catch(() => undefined);
  } catch (e) {
    await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: prov.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: user.id, ref: `feedback:${id}` }).catch(() => undefined);
    return fail(e instanceof Error ? e.message : String(e));
  }
  const parsed = parseLessonsFromAi(out);
  if (!parsed?.length) return fail("AI không trả về bài học đọc được");
  // Đọc lại ngay trước khi ghi — tự học / chủ shop có thể vừa sửa; bài học MỚI đứng đầu, bản cũ lùi vào lịch sử.
  state = await loadLessons();
  // Đoạn chép là chữ KHÁCH gõ — một hội thoại dựng sẵn có thể cài «xin khách chuyển khoản trước» qua AI vào bài học (review bảo mật
  // #651). Bài như thế không tự áp; cần thật thì chủ shop tự viết ở trang Chatbot (sửa tay không qua bộ lọc này).
  const screened = screenAiLessons(parsed, state.lessons);
  const fresh = screened.kept;
  if (!fresh.length) return fail("AI chỉ rút ra bài nhắc tới tiền / tài khoản / liên kết — không tự áp; cần thật thì chủ shop tự viết ở trang Chatbot");
  const lessons = normalizeLessons([...fresh, ...state.lessons]);
  await setSettingJson(LESSONS_SETTING_KEY, {
    ...state,
    lessons,
    version: state.version + 1,
    updatedAt: now.toISOString(),
    updatedBy: `Góp ý của ${user.name ?? user.email}`,
    history: state.lessons.length ? [...state.history, { version: state.version, lessons: state.lessons, at: state.updatedAt ?? now.toISOString(), by: state.updatedBy ?? "" }].slice(-LESSON_LIMITS.history) : state.history,
  } satisfies LessonsState);
  const applied = fresh.filter((l) => lessons.includes(l));
  await db.insert(f).values({ conversationId: id, userId: user.id, userName: user.name ?? user.email, text, lessons: applied, status: "APPLIED", createdAt: now });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHAT_FEEDBACK", entity: "SALES_CHAT", entityId: id, after: { lessons: applied }, reason: text.slice(0, 200) });
  publish({ type: "chat", conversationId: id });
  const skipped = screened.dropped ? ` Không áp ${screened.dropped} bài nhắc tới tiền / tài khoản / liên kết — cần thật thì chủ shop tự viết ở trang Chatbot.` : "";
  return { ok: true, message: (state.enabled ? `Bot đã học ${applied.length} bài — dùng từ lượt trả lời kế tiếp.` : `Đã lưu ${applied.length} bài học — bật «Tự học» ở trang Chatbot để bot dùng.`) + skipped, lessons: applied };
}

/** Góp ý đã gửi cho một hội thoại (mới nhất trước). */
export async function feedbackFor(conversationId: string): Promise<FeedbackRow[]> {
  const db = await getDb();
  const f = schema.salesChatFeedback;
  const rows = await db.select().from(f).where(eq(f.conversationId, conversationId)).orderBy(desc(f.createdAt)).limit(20);
  return rows.map((r) => ({ id: r.id, userName: r.userName, text: r.text, lessons: (r.lessons ?? []) as string[], status: r.status === "APPLIED" ? "APPLIED" : "FAILED", error: r.error, createdAt: r.createdAt.toISOString() }));
}
