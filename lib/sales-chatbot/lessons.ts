/**
 * ═══════════ BOT TỰ HỌC TỪ HỘI THOẠI THẬT — CHỈ MÁY CHỦ ═══════════
 *
 * Phần thuần (kiểu, làm sạch, lời nhắc): `lib/sales-chatbot/lessons-shared.ts`. Tệp này: chọn hội thoại fanpage MỚI từ
 * `sales_chat_inbound` (ba giọng KHÁCH · BOT · SHOP, kèm kết cục của hội thoại), cho AI của CHÍNH shop (khoá BYOK, chịu trần
 * chi phí của gói) cập nhật danh sách bài học, áp dụng NGAY (bot đọc ở lượt kế tiếp) và giữ bản trước để quay lại.
 *
 * Chạy theo job `sales-followup` (5 phút / lần, mỗi tổ chức) nhưng chỉ thật sự học mỗi `LESSON_LIMITS.everyMs` và khi có đủ
 * hội thoại mới; «Học ngay» trên trang Chatbot bán hàng bỏ qua hai điều kiện đó. Không ném — lỗi ghi vào `lastRun`, bài học
 * cũ giữ nguyên.
 */
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { estimateCostUsd, type AiBlock } from "@/lib/ai/provider";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { loadSalesChatbotConfig, readJsonSetting, salesChatProvider } from "@/lib/sales-chatbot/engine";
import { fanpageVisitorKey, PAGE_REPLY, PANCAKE_AUTO_NOTE_RE } from "@/lib/sales-chatbot/fanpage";
import { homeRuntimeIdleReason } from "@/lib/sales-chatbot/page-runtime";
import {
  LESSON_LIMITS,
  LESSONS_SETTING_KEY,
  LESSONS_SYSTEM,
  lessonTranscript,
  normalizeLessons,
  parseLessonsFromAi,
  parseLessonsState,
  screenAiLessons,
  type LessonsRun,
  type LessonsState,
  type TranscriptLine,
} from "@/lib/sales-chatbot/lessons-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { setSettingJson } from "@/lib/settings";
import type { ChatState } from "@/lib/sales-chatbot/tools";

/** Ngân sách token đầu ra của lượt học (gồm phần suy luận). */
export const LESSONS_AI_TOKENS = 8_000;
/** Hội thoại còn nhận tin trong chừng này thì chưa học (đang dở, chưa có kết cục). */
const SETTLE_MS = 30 * 60_000;
/** Lượt học đầu tiên nhìn lại chừng này. */
const FIRST_LOOKBACK_MS = 7 * 86_400_000;
/** Lượt RUNNING cũ hơn chừng này coi như đã chết (máy chủ khởi động lại giữa chừng). */
const RUN_STALE_MS = 15 * 60_000;
const BOT_NAME = "Bot tự học";

export async function loadLessons(): Promise<LessonsState> {
  return parseLessonsState(await readJsonSetting(LESSONS_SETTING_KEY));
}

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/** Kết cục của hội thoại — AI cần biết bot đã làm TỐT hay HỎNG ở hội thoại nào. */
function outcomeTag(conv: { status: string; handoffReason: string | null; state: unknown } | undefined, customerPhone: boolean): { tag: string; weight: number } {
  const st = (conv?.state ?? {}) as ChatState;
  if (st.confirmed || st.pastOrders?.length) return { tag: "[KẾT QUẢ: bot chốt được đơn]", weight: 1 };
  if (conv?.status === "HANDOFF") return { tag: `[KẾT QUẢ: chuyển nhân viên — ${(conv.handoffReason ?? "").slice(0, 120)}]`, weight: 3 };
  if (customerPhone || st.customer?.phone) return { tag: "[KẾT QUẢ: khách để lại SĐT, chưa chốt]", weight: 1 };
  if (!conv) return { tag: "[KẾT QUẢ: nhân viên tự trả lời, bot không tham gia]", weight: 2 };
  return { tag: "[KẾT QUẢ: chưa chốt được — khách dừng]", weight: 2 };
}

const PHONE_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}/;

/** Chọn + chép hội thoại mới có tin trong (since, until]. Hội thoại nhiều «dấu hỏng» (nhân viên vào thay, khách bỏ đi) lên trước. */
export async function collectLessonTranscripts(since: Date, until: Date): Promise<string[]> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const recent = await db
    .select({ pageId: t.pageId, threadId: t.threadId, last: sql<string>`max(${t.createdAt})` })
    .from(t)
    .where(and(eq(t.kind, "INBOX"), ne(t.threadId, "__private_reply__"), gt(t.createdAt, since), lte(t.createdAt, until)))
    .groupBy(t.pageId, t.threadId)
    .orderBy(desc(sql`max(${t.createdAt})`))
    .limit(LESSON_LIMITS.maxThreads * 2);
  // Còn tin SAU `until` ⇒ hội thoại đang dở — để lượt sau.
  const threadKeys = recent.map((r) => `${r.pageId}|${r.threadId}`);
  if (!threadKeys.length) return [];
  const live = new Set(
    (
      await db
        .select({ pageId: t.pageId, threadId: t.threadId })
        .from(t)
        .where(and(inArray(t.threadId, recent.map((r) => r.threadId)), gt(t.createdAt, until)))
    ).map((r) => `${r.pageId}|${r.threadId}`),
  );
  const picked = recent.filter((r) => !live.has(`${r.pageId}|${r.threadId}`)).slice(0, LESSON_LIMITS.maxThreads);
  if (!picked.length) return [];
  const rows = await db
    .select({ pageId: t.pageId, threadId: t.threadId, messageId: t.messageId, text: t.text, note: t.note, customerName: t.customerName })
    .from(t)
    .where(and(eq(t.kind, "INBOX"), inArray(t.threadId, picked.map((r) => r.threadId)), lte(t.createdAt, until)))
    .orderBy(asc(t.createdAt));
  const c = schema.salesChatConversations;
  const convs = await db
    .select({ visitorKey: c.visitorKey, status: c.status, handoffReason: c.handoffReason, state: c.state })
    .from(c)
    .where(and(eq(c.channel, "FANPAGE"), inArray(c.visitorKey, picked.map((r) => fanpageVisitorKey(r.pageId, r.threadId)))));
  const convOf = new Map(convs.map((x) => [x.visitorKey, x]));
  const out: { text: string; weight: number }[] = [];
  for (const p of picked) {
    const mine = rows.filter((r) => r.pageId === p.pageId && r.threadId === p.threadId);
    const lines: TranscriptLine[] = [];
    const names = new Set<string>();
    for (const r of mine) {
      if (r.customerName) names.add(r.customerName);
      if (r.note === "BOT_SENT") {
        // Mỗi đoạn bot gửi có MỘT dòng `bot-out:` ghi trước khi gửi; dòng mang mã tin Pancake là bản trùng.
        if (r.messageId.startsWith("bot-out:") && r.text.trim()) lines.push({ who: "BOT", text: r.text });
      } else if (r.note === PAGE_REPLY) {
        if (!PANCAKE_AUTO_NOTE_RE.test(r.text)) lines.push({ who: "SHOP", text: r.text });
      } else lines.push({ who: "KHÁCH", text: r.text });
    }
    const conv = convOf.get(fanpageVisitorKey(p.pageId, p.threadId));
    const st = (conv?.state ?? {}) as ChatState;
    if (st.customer?.name) names.add(st.customer.name);
    const o = outcomeTag(conv, lines.some((l) => l.who === "KHÁCH" && PHONE_RE.test(l.text)));
    // Nhân viên phải vào SAU khi bot đã nói ⇒ chỗ bot hỏng rõ nhất.
    const firstBot = lines.findIndex((l) => l.who === "BOT");
    const staffAfterBot = firstBot >= 0 && lines.slice(firstBot).some((l) => l.who === "SHOP");
    const text = lessonTranscript(lines, staffAfterBot ? `${o.tag} [NHÂN VIÊN PHẢI VÀO SAU BOT]` : o.tag, [...names]);
    if (text) out.push({ text, weight: o.weight + (staffAfterBot ? 2 : 0) });
  }
  out.sort((a, b) => b.weight - a.weight);
  const kept: string[] = [];
  let size = 0;
  for (const x of out) {
    if (size + x.text.length > LESSON_LIMITS.transcriptChars) continue;
    kept.push(x.text);
    size += x.text.length + 10;
  }
  return kept;
}

export type LearnResult = { status: LessonsRun["status"] | "NOT_DUE"; note: string; threads: number; lessons: number };

async function saveRun(state: LessonsState, run: LessonsRun, extra: Partial<LessonsState> = {}) {
  await setSettingJson(LESSONS_SETTING_KEY, { ...state, ...extra, lastRun: run } satisfies LessonsState);
}

/**
 * MỘT lượt tự học của tổ chức ngữ cảnh. `force` (bấm «Học ngay») bỏ qua nhịp `everyMs` và ngưỡng `minThreads`.
 * Không ném: mọi lỗi thành `status: "ERROR"`, bài học cũ giữ nguyên.
 */
export async function learnLessons(opts: { now?: Date; force?: boolean; actor?: { id: string | null; name: string } } = {}): Promise<LearnResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? { id: null, name: BOT_NAME };
  let state = await loadLessons();
  const none = (status: LearnResult["status"], note: string): LearnResult => ({ status, note, threads: 0, lessons: state.lessons.length });
  if (!state.enabled) return none("NOT_DUE", "Tự học đang tắt");
  const last = state.lastRun ? Date.parse(state.lastRun.at) : NaN;
  if (state.lastRun?.status === "RUNNING" && Number.isFinite(last) && now.getTime() - last < RUN_STALE_MS) return none("NOT_DUE", "Đang có lượt học chạy");
  if (!opts.force && Number.isFinite(last) && now.getTime() - last < LESSON_LIMITS.everyMs) return none("NOT_DUE", "Chưa tới lượt");
  if (!opts.force) {
    if (!(await canUseModule("ai_sales"))) return none("NOT_DUE", "Module AI bán hàng chưa bật");
    if (!(await loadSalesChatbotConfig()).enabled) return none("NOT_DUE", "Chatbot đang tắt");
    // Workspace nhà chưa page nào LIVE ⇒ chưa có hội thoại nào của bot mới để học, không tốn tiền AI (page-runtime.ts).
    const idle = await homeRuntimeIdleReason();
    if (idle) return none("NOT_DUE", idle);
  }
  const until = new Date(now.getTime() - SETTLE_MS);
  const sinceAt = state.learnedUntil ? Date.parse(state.learnedUntil) : NaN;
  const since = Number.isFinite(sinceAt) ? new Date(Math.max(sinceAt, now.getTime() - FIRST_LOOKBACK_MS)) : new Date(now.getTime() - FIRST_LOOKBACK_MS);
  let threads = 0;
  try {
    const transcripts = await collectLessonTranscripts(since, until);
    threads = transcripts.length;
    if (!threads || (!opts.force && threads < LESSON_LIMITS.minThreads)) {
      const note = threads ? `Mới có ${threads} hội thoại xong kể từ lượt trước — đợi đủ ${LESSON_LIMITS.minThreads}` : "Chưa có hội thoại mới đã xong";
      await saveRun(state, { at: now.toISOString(), status: "SKIPPED", threads, note });
      return { status: "SKIPPED", note, threads, lessons: state.lessons.length };
    }
    const startedVersion = state.version;
    await saveRun(state, { at: now.toISOString(), status: "RUNNING", threads, note: `Đang học từ ${threads} hội thoại` });
    const org = await currentOrganization();
    const prov = await salesChatProvider();
    if (!prov.ok) throw new Error(prov.error);
    const quota = await checkAiQuota(org.code, prov.source);
    if (!quota.ok) throw new Error(quota.error);
    const prompt = [
      `BÀI HỌC ĐANG DÙNG (${state.lessons.length}):`,
      state.lessons.length ? state.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(chưa có)",
      "",
      `HỘI THOẠI MỚI (${threads}) — SĐT / tên / link đã che:`,
      transcripts.join("\n\n---\n\n"),
      "",
      "Trả về DANH SÁCH BÀI HỌC ĐẦY ĐỦ sau khi cập nhật (mảng JSON).",
    ].join("\n");
    let out = "";
    let status: "OK" | "ERROR" = "OK";
    try {
      const res = await prov.provider.complete({ system: LESSONS_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: LESSONS_AI_TOKENS, reasoning: "low" });
      out = textOf(res.content);
      await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model || prov.provider.model, res.usage), status, actorId: actor.id, ref: "lessons" }).catch(() => undefined);
    } catch (e) {
      status = "ERROR";
      await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: prov.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status, actorId: actor.id, ref: "lessons" }).catch(() => undefined);
      throw e;
    }
    const parsed = parseLessonsFromAi(out);
    if (!parsed) throw new Error("AI không trả về danh sách bài học đọc được");
    const screened = screenAiLessons(parsed, state.lessons);
    const lessons = screened.kept;
    if (!lessons.length && state.lessons.length) throw new Error("AI trả về danh sách rỗng — giữ bài học cũ");
    // Chủ shop sửa bài học trong lúc AI đang đọc ⇒ kết quả dựa trên bản cũ — bỏ, không đè lên tay người.
    state = await loadLessons();
    if (state.version !== startedVersion) {
      const note = "Chủ shop vừa sửa bài học trong lúc học — bỏ kết quả lượt này";
      await saveRun(state, { at: now.toISOString(), status: "SKIPPED", threads, note });
      return { status: "SKIPPED", note, threads, lessons: state.lessons.length };
    }
    const before = new Set(state.lessons);
    const added = lessons.filter((l) => !before.has(l)).length;
    const dropped = state.lessons.filter((l) => !lessons.includes(l)).length;
    const note = `Học từ ${threads} hội thoại: ${lessons.length} bài (mới / sửa ${added} · bỏ ${dropped})${screened.dropped ? ` · không áp ${screened.dropped} bài nhắc tới tiền / tài khoản / liên kết (chủ shop tự thêm nếu thật sự cần)` : ""}`;
    await saveRun(
      state,
      { at: now.toISOString(), status: "OK", threads, note },
      {
        lessons,
        version: state.version + 1,
        updatedAt: now.toISOString(),
        updatedBy: actor.name,
        history: state.lessons.length ? [...state.history, { version: state.version, lessons: state.lessons, at: state.updatedAt ?? now.toISOString(), by: state.updatedBy ?? "" }].slice(-LESSON_LIMITS.history) : state.history,
        learnedUntil: until.toISOString(),
      },
    );
    return { status: "OK", note, threads, lessons: lessons.length };
  } catch (e) {
    const note = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    state = await loadLessons();
    await saveRun(state, { at: now.toISOString(), status: "ERROR", threads, note }).catch(() => undefined);
    return { status: "ERROR", note, threads, lessons: state.lessons.length };
  }
}

// ─── Thao tác của chủ shop ───

type Result = { ok: true; message: string } | { error: string };

async function gate(user: SessionUser): Promise<string | null> {
  if (!(await canUseModule("ai_sales"))) return "Module AI bán hàng chưa bật.";
  if (!can(user, SALES_CHATBOT_MANAGE)) return "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage).";
  return null;
}

export async function setLessonsEnabled(user: SessionUser, enabled: boolean): Promise<Result> {
  const err = await gate(user);
  if (err) return { error: err };
  const state = await loadLessons();
  await setSettingJson(LESSONS_SETTING_KEY, { ...state, enabled } satisfies LessonsState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_LESSONS_TOGGLE", entity: "SETTINGS", entityId: LESSONS_SETTING_KEY, before: { enabled: state.enabled }, after: { enabled }, reason: enabled ? "Bật bot tự học" : "Tắt bot tự học" });
  return { ok: true, message: enabled ? "Đã bật tự học — bot dùng bài học từ lượt trả lời kế tiếp." : "Đã tắt tự học — bot không dùng bài học nữa (danh sách vẫn giữ)." };
}

/** Chủ shop sửa / xoá bài học (mỗi dòng một bài). Bản đang dùng lùi vào lịch sử. */
export async function saveLessons(user: SessionUser, raw: unknown): Promise<Result> {
  const err = await gate(user);
  if (err) return { error: err };
  const lines = Array.isArray(raw) ? raw.map((x) => String(x ?? "")) : String(raw ?? "").split(/\r?\n/);
  const lessons = normalizeLessons(lines);
  const state = await loadLessons();
  const now = new Date().toISOString();
  await setSettingJson(LESSONS_SETTING_KEY, {
    ...state,
    lessons,
    version: state.version + 1,
    updatedAt: now,
    updatedBy: user.email,
    history: state.lessons.length ? [...state.history, { version: state.version, lessons: state.lessons, at: state.updatedAt ?? now, by: state.updatedBy ?? "" }].slice(-LESSON_LIMITS.history) : state.history,
  } satisfies LessonsState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_LESSONS_EDIT", entity: "SETTINGS", entityId: LESSONS_SETTING_KEY, before: { version: state.version, count: state.lessons.length }, after: { version: state.version + 1, count: lessons.length }, reason: "Chủ shop sửa bài học của bot" });
  return { ok: true, message: `Đã lưu ${lessons.length} bài học.` };
}

/** Quay lại bản ngay trước (lấy khỏi lịch sử). */
export async function rollbackLessons(user: SessionUser): Promise<Result> {
  const err = await gate(user);
  if (err) return { error: err };
  const state = await loadLessons();
  const prev = state.history[state.history.length - 1];
  if (!prev) return { error: "Không còn bản trước." };
  await setSettingJson(LESSONS_SETTING_KEY, { ...state, lessons: prev.lessons, version: state.version + 1, updatedAt: new Date().toISOString(), updatedBy: user.email, history: state.history.slice(0, -1) } satisfies LessonsState);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_LESSONS_ROLLBACK", entity: "SETTINGS", entityId: LESSONS_SETTING_KEY, before: { version: state.version, count: state.lessons.length }, after: { restored: prev.version, count: prev.lessons.length }, reason: "Quay lại bài học bản trước" });
  return { ok: true, message: `Bot dùng lại ${prev.lessons.length} bài học của bản trước.` };
}

/** «Học ngay» — kiểm quyền; việc nặng do server action chạy SAU phản hồi (`learnLessons({ force: true })`). */
export async function checkLearnNow(user: SessionUser): Promise<Result> {
  const err = await gate(user);
  if (err) return { error: err };
  const state = await loadLessons();
  if (!state.enabled) return { error: "Tự học đang tắt — bật trước rồi học." };
  const last = state.lastRun ? Date.parse(state.lastRun.at) : NaN;
  if (state.lastRun?.status === "RUNNING" && Number.isFinite(last) && Date.now() - last < RUN_STALE_MS) return { error: "Đang có lượt học chạy — đợi vài phút." };
  return { ok: true, message: "Đang học từ các hội thoại mới — khoảng một phút; bấm «Làm mới» để xem." };
}
