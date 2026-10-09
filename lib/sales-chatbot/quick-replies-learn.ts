/**
 * ═══════════ TỰ NẠP CÂU TRẢ LỜI MẪU — CHỈ MÁY CHỦ (09/10/2026) ═══════════
 *
 * Chủ shop HSLC 09/10/2026: «nạp liên tục dữ liệu vào câu trả lời sẵn để liên tục tối ưu chi phí AI nếu khách hỏi đúng vào
 * những câu đã có câu trả lời sẵn, mà vẫn đạt hiệu quả về tỷ lệ chốt, follow-up và AOV».
 *
 * Mỗi câu khách hỏi mà KHÔNG câu mẫu đang bật nào khớp chữ đã tốn một lượt AI (đọc hiểu, hoặc chatbot đầy đủ). Lượt tự nạp
 * (công tắc `autoLearn`, MẶC ĐỊNH TẮT) chạy trong job `sales-followup` nhưng chỉ thật sự gọi AI mỗi
 * `QUICK_REPLY_AUTO_LEARN.everyMs`: gom các câu đó trong `lookbackDays` ngày (`mineUnansweredQuestions`, hàm thuần), rồi MỘT
 * lời gọi AI của chính shop (chịu trần chi phí của gói, ghi sổ dùng AI) trả về:
 *   · `extend` — câu khách thật ⇒ cách hỏi mới của một câu mẫu ĐÃ CÓ. Áp ngay: lần sau câu đó khớp chữ, 0 token.
 *   · `new` — câu mẫu mới cho chủ đề hỏi nhiều mà chưa có câu nào. TẮT chờ người duyệt (bật hàng loạt ở màn hình quản lý),
 *     trừ khi shop bật `autoActivate`. Giá / tồn / ship chỉ qua `{{giá:SKU}}` · `{{tồn:SKU}}` · `{{ship}}` — số đọc ERP lúc
 *     gửi; giá gõ thẳng ⇒ «[giá lấy từ ERP]» và câu đó KHÔNG BAO GIỜ tự bật; SKU lạ ⇒ bỏ câu.
 * Không ném — lỗi ghi vào lượt chạy (`QUICK_REPLY_AUTO_LEARN_RUN_KEY`), câu mẫu cũ giữ nguyên.
 */
import { and, eq, gte, isNull, notInArray, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { estimateCostUsd, type AiBlock } from "@/lib/ai/provider";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { canUseModule } from "@/lib/platform/capabilities";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { loadSalesChatbotConfig, readJsonSetting, salesChatProvider } from "@/lib/sales-chatbot/engine";
import { MEDIA_ONLY_NOTE, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { homeRuntimeIdleReason } from "@/lib/sales-chatbot/page-runtime";
import { publishedPlaybookText } from "@/lib/sales-chatbot/playbook";
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import { insertLearned, loadQuickReplySettings, NEEDS_EDIT, unknownSkus } from "@/lib/sales-chatbot/quick-replies";
import {
  mergeTriggers,
  mineUnansweredQuestions,
  parseAutoLearnPlan,
  parseAutoLearnRun,
  QUICK_REPLY_AUTO_LEARN,
  QUICK_REPLY_AUTO_LEARN_RUN_KEY,
  QUICK_REPLY_LIMITS,
  validateQuickReply,
  type QuickReplyAutoLearnRun,
  type QuickReplyDraft,
} from "@/lib/sales-chatbot/quick-replies-shared";
import { customerFacing, customerSafeAiError } from "@/lib/saas/visibility";
import { setSettingJson } from "@/lib/settings";

const qr = schema.salesChatQuickReplies;
/** Ngân sách token đầu ra (gồm phần suy luận) của lời gọi soạn câu mẫu. */
const AUTO_LEARN_AI_TOKENS = 8_000;
const BOT_NAME = "Bot tự nạp câu mẫu";

export async function loadAutoLearnRun(): Promise<QuickReplyAutoLearnRun | null> {
  return parseAutoLearnRun(await readJsonSetting(QUICK_REPLY_AUTO_LEARN_RUN_KEY));
}

const AUTO_LEARN_SYSTEM = (shop: string, maxNew: number) =>
  [
    `Bạn giúp shop «${shop}» nạp CÂU TRẢ LỜI MẪU cho chatbot bán hàng: khách hỏi trúng câu mẫu thì bot trả lời ngay, không tốn AI.`,
    "Đầu vào: CÁC CÂU MẪU ĐANG CÓ (mã Q1, Q2… + tên + vài cách hỏi), MẪU MÃ ĐANG BÁN (SKU), và CÂU KHÁCH HỎI GẦN ĐÂY mà chưa câu mẫu nào khớp chữ (kèm số hội thoại đã hỏi).",
    "Việc 1 — `extend`: câu khách nào cùng ý với một câu mẫu ĐÃ CÓ (câu mẫu đó trả lời ĐỦ và ĐÚNG câu khách) ⇒ thêm nguyên văn câu khách làm cách hỏi mới của câu mẫu đó. Không chắc thì bỏ qua.",
    `Việc 2 — \`new\`: chủ đề khách hỏi NHIỀU (ưu tiên ≥ 2 hội thoại) mà CHƯA câu mẫu nào trả lời ⇒ soạn tối đa ${maxNew} câu mẫu mới; mỗi câu 3–8 cách hỏi viết như khách gõ (lấy từ câu khách thật).`,
    "Câu trả lời mẫu phải BÁN HÀNG, không chỉ trả lời cho có: trả lời đúng ý ngắn gọn theo giọng shop, rồi kết bằng MỘT câu hỏi dẫn tới chốt đơn (vd hỏi khách lấy bao nhiêu / gửi địa chỉ để em lên đơn), và khi hợp lý thì gợi ý lấy thêm để được giá tốt / miễn ship — tăng giá trị đơn.",
    "GIÁ / TỒN / PHÍ SHIP: TUYỆT ĐỐI không gõ số tiền hay số lượng. Cần giá thì viết đúng chỗ trống {{giá:SKU}} với SKU lấy NGUYÊN VĂN từ danh sách mẫu mã; cần tồn thì {{tồn:SKU}}; cần phí ship thì {{ship}}. Mẫu mã ghi «chỉ bán kèm» thì không báo giá riêng.",
    "KHÔNG soạn câu mẫu cho: đặt hàng / gửi SĐT / địa chỉ, khiếu nại, hỏi giá SỈ / số lượng lớn, câu chỉ đúng với một khách. Không bịa chính sách (đổi trả, khuyến mãi, thời gian giao) mà sổ tay của shop không nói. Không nhắc tên khách.",
    'Trả về DUY NHẤT một đối tượng JSON: {"extend": [{"code": "Q3", "triggers": ["câu khách"]}], "new": [{"title": "tên ngắn", "triggers": ["..."], "answer": "..."}]}. Không có gì thì trả mảng rỗng.',
  ].join("\n");

const textOf = (content: AiBlock[]) =>
  content
    .filter((b): b is Extract<AiBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/** Câu khách hỏi qua hộp thư fanpage trong `days` ngày — chỉ tin của KHÁCH (dòng bot / page tự gửi / tin chỉ có ảnh bị bỏ). */
async function customerQuestions(since: Date): Promise<{ text: string; thread: string }[]> {
  const db = await getDb();
  const t = schema.salesChatInbound;
  const rows = await db
    .select({ pageId: t.pageId, threadId: t.threadId, text: t.text })
    .from(t)
    .where(and(eq(t.kind, "INBOX"), gte(t.createdAt, since), or(isNull(t.note), notInArray(t.note, ["BOT_SENT", PAGE_REPLY, MEDIA_ONLY_NOTE]))))
    .limit(20_000);
  return rows.map((r) => ({ text: r.text, thread: `${r.pageId}|${r.threadId}` }));
}

/** Mẫu mã đang bán (SKU + tên) — để AI viết `{{giá:SKU}}` đúng mã. */
async function sellingSkus(): Promise<string[]> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = await db
    .select({ sku: pv.sku, name: p.name, detail: pv.detail, size: pv.size, addOnOnly: pv.addOnOnly })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(and(eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false), eq(p.isHidden, false)))
    .limit(QUICK_REPLY_AUTO_LEARN.maxSkus);
  return rows.filter((r) => r.sku).map((r) => `${r.sku} — ${[r.name, r.detail || r.size].filter(Boolean).join(" · ")}${r.addOnOnly ? " (chỉ bán kèm)" : ""}`);
}

export type AutoLearnResult = QuickReplyAutoLearnRun | { status: "NOT_DUE"; note: string };

/**
 * MỘT lượt tự nạp của tổ chức ngữ cảnh. `force` («Nạp ngay» trên màn hình quản lý) bỏ qua nhịp 24 giờ và các điều kiện bot
 * bật / page chạy. Không ném.
 */
export async function autoLearnQuickReplies(opts: { now?: Date; force?: boolean; actor?: { id: string | null; email: string | null } } = {}): Promise<AutoLearnResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? { id: null, email: null };
  const settings = await loadQuickReplySettings();
  if (!settings.autoLearn && !opts.force) return { status: "NOT_DUE", note: "Tự nạp câu mẫu đang tắt" };
  const last = await loadAutoLearnRun();
  const lastAt = last ? Date.parse(last.at) : NaN;
  if (last?.status === "RUNNING" && Number.isFinite(lastAt) && now.getTime() - lastAt < QUICK_REPLY_AUTO_LEARN.staleMs) return { status: "NOT_DUE", note: "Đang có lượt nạp chạy" };
  if (!opts.force && Number.isFinite(lastAt) && now.getTime() - lastAt < QUICK_REPLY_AUTO_LEARN.everyMs) return { status: "NOT_DUE", note: "Chưa tới lượt" };
  if (!opts.force) {
    if (!(await canUseModule("ai_sales"))) return { status: "NOT_DUE", note: "Module AI bán hàng chưa bật" };
    if (!(await loadSalesChatbotConfig()).enabled) return { status: "NOT_DUE", note: "Chatbot đang tắt" };
    const idle = await homeRuntimeIdleReason();
    if (idle) return { status: "NOT_DUE", note: idle };
  }
  const save = async (run: QuickReplyAutoLearnRun) => {
    await setSettingJson(QUICK_REPLY_AUTO_LEARN_RUN_KEY, run);
    return run;
  };
  const org = await currentOrganization();
  let questions = 0;
  try {
    const db = await getDb();
    const all = await db.select({ id: qr.id, title: qr.title, triggers: qr.triggers, answer: qr.answer, active: qr.active }).from(qr);
    const entries = all.map((r) => ({ id: r.id, title: r.title, triggers: r.triggers ?? [], answer: r.answer }));
    // Khớp với MỌI câu mẫu (kể cả câu đang tắt chờ duyệt): câu khách đã có câu mẫu nháp thì không soạn lại lần nữa.
    const mined = mineUnansweredQuestions(await customerQuestions(new Date(now.getTime() - QUICK_REPLY_AUTO_LEARN.lookbackDays * 86_400_000)), entries, QUICK_REPLY_AUTO_LEARN.maxQuestions);
    questions = mined.length;
    if (questions < QUICK_REPLY_AUTO_LEARN.minQuestions) {
      return await save({ at: now.toISOString(), status: "SKIPPED", note: `Mới có ${questions} câu khách hỏi chưa có câu mẫu trong ${QUICK_REPLY_AUTO_LEARN.lookbackDays} ngày — đợi đủ ${QUICK_REPLY_AUTO_LEARN.minQuestions}`, questions, added: 0, extended: 0 });
    }
    await save({ at: now.toISOString(), status: "RUNNING", note: `Đang soạn từ ${questions} câu khách hỏi`, questions, added: 0, extended: 0 });
    const room = Math.max(0, QUICK_REPLY_LIMITS.entries - all.length);
    const maxNew = Math.min(QUICK_REPLY_AUTO_LEARN.maxNew, room);
    const shop = (await findOrganization(org.code))?.name ?? org.code;
    const cfg = await loadSalesChatbotConfig();
    const playbook = (await publishedPlaybookText()).slice(0, 4_000);
    // Câu mẫu đưa vào lời gọi: dùng nhiều trước, câu đang bật trước — mã Q ổn định trong một lượt.
    const listed = [...all].sort((a, b) => Number(b.active) - Number(a.active)).slice(0, QUICK_REPLY_LIMITS.entries);
    const codes = new Map(listed.map((e, i) => [`Q${i + 1}`, e.id]));
    const prompt = [
      `CÁC CÂU MẪU ĐANG CÓ (${listed.length}):`,
      listed.length ? listed.map((e, i) => `Q${i + 1}: ${e.title}${e.active ? "" : " (đang tắt)"} — ${(e.triggers ?? []).slice(0, 4).join(" | ")}`).join("\n") : "(chưa có)",
      "",
      "MẪU MÃ ĐANG BÁN:",
      (await sellingSkus()).join("\n") || "(chưa có)",
      "",
      playbook ? `SỔ TAY BÁN HÀNG CỦA SHOP (giọng văn + chính sách):\n${playbook}\n` : "",
      cfg.extraInstructions.trim() ? `LƯU Ý RIÊNG CỦA SHOP:\n${cfg.extraInstructions.trim().slice(0, 1_500)}\n` : "",
      `CÂU KHÁCH HỎI GẦN ĐÂY CHƯA CÓ CÂU MẪU (${questions}) — dạng «số hội thoại × câu»:`,
      mined.map((q) => `${q.threads} × ${q.samples.join(" / ")}`).join("\n"),
      "",
      maxNew > 0 ? `Trả về JSON như hướng dẫn (tối đa ${maxNew} câu mẫu mới).` : "Shop đã đủ trần câu mẫu — chỉ trả về `extend`, `new` để rỗng.",
    ]
      .filter((x) => x !== "")
      .join("\n");
    const prov = await salesChatProvider();
    if (!prov.ok) throw new Error(prov.error);
    const quota = await checkAiQuota(org.code, prov.source);
    if (!quota.ok) throw new Error(quota.error);
    let out = "";
    try {
      const res = await prov.provider.complete({ system: AUTO_LEARN_SYSTEM(shop, Math.max(maxNew, 0)), messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: AUTO_LEARN_AI_TOKENS, reasoning: "low" });
      out = textOf(res.content);
      await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: res.model || prov.provider.model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(res.model || prov.provider.model, res.usage), status: "OK", actorId: actor.id, ref: "quick-replies" }).catch(() => undefined);
    } catch (e) {
      await recordAiUsage({ orgCode: org.code, feature: "sales_playbook", source: prov.source, provider: prov.provider.name, model: prov.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: actor.id, ref: "quick-replies" }).catch(() => undefined);
      throw e;
    }
    if (!out) throw new Error("AI không trả về nội dung — lượt sau thử lại");
    const plan = parseAutoLearnPlan(out, codes);

    // 1. Thêm cách hỏi vào câu mẫu đã có — đọc lại từng dòng ngay trước khi ghi (người có thể vừa sửa).
    let extended = 0;
    for (const ex of plan.extend) {
      const [row] = await db.select({ triggers: qr.triggers }).from(qr).where(eq(qr.id, ex.id)).limit(1);
      if (!row) continue;
      const current = row.triggers ?? [];
      const next = mergeTriggers(current, ex.triggers, QUICK_REPLY_AUTO_LEARN.maxExtendPerEntry);
      if (next.length === current.length) continue;
      await db.update(qr).set({ triggers: next }).where(eq(qr.id, ex.id));
      extended += next.length - current.length;
    }

    // 2. Câu mẫu mới — làm sạch như câu người nhập; giá gõ thẳng ⇒ «[giá lấy từ ERP]» (không tự bật); SKU lạ ⇒ bỏ.
    const clean: QuickReplyDraft[] = [];
    for (const it of plan.added.slice(0, maxNew)) {
      const stripped = stripPrices(it.answer).text;
      const v = validateQuickReply({ title: it.title, triggers: it.triggers, answer: stripped.replace(/\[giá lấy từ ERP\]/g, "GIA_CHO") });
      if (!v.ok) continue;
      const answer = v.value.answer.replace(/GIA_CHO/g, NEEDS_EDIT);
      if ((await unknownSkus(answer)).length) continue;
      clean.push({ ...v.value, answer });
    }
    const added = clean.length ? await insertLearned(clean, { actorEmail: actor.email ?? BOT_NAME, active: settings.autoActivate }) : 0;
    if (added || extended) {
      await audit({ userId: actor.id, userEmail: actor.email ?? BOT_NAME, action: "SALES_QUICK_REPLY_AUTO_LEARN", entity: "SALES_QUICK_REPLY", after: { questions, added, extended, autoActivate: settings.autoActivate } });
    }
    const note = `Đọc ${questions} câu khách hỏi chưa có câu mẫu: thêm ${extended} cách hỏi vào câu mẫu cũ · ${added} câu mẫu mới${added ? (settings.autoActivate ? " (đã bật — trừ câu còn «[giá lấy từ ERP]»)" : " (đang tắt, chờ duyệt)") : ""}`;
    return await save({ at: now.toISOString(), status: "OK", note, questions, added, extended });
  } catch (e) {
    const raw = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const note = customerFacing(org) ? customerSafeAiError(raw) : raw;
    return await save({ at: now.toISOString(), status: "ERROR", note, questions, added: 0, extended: 0 }).catch(() => ({ at: now.toISOString(), status: "ERROR" as const, note, questions, added: 0, extended: 0 }));
  }
}

/** Số câu mẫu AI soạn đang TẮT chờ người duyệt (màn hình quản lý). */
export async function pendingLearnedCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ id: qr.id }).from(qr).where(and(eq(qr.source, "LEARNED"), eq(qr.active, false)));
  return rows.length;
}
