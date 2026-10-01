/**
 * ═══════════ CÂU TRẢ LỜI MẪU (Q&A) — CHỈ MÁY CHỦ (0183) ═══════════
 *
 * Phần thuần (khớp chữ, chỗ trống, kiểm đầu vào): `quick-replies-shared.ts`. Tệp này: đọc / ghi câu mẫu + ảnh trong CSDL của
 * tổ chức NGỮ CẢNH, điền chỗ trống bằng số ĐỌC TỪ ERP lúc gửi (`catalog.ts` — cùng nguồn với công cụ của AI), bước AI ĐỌC
 * HIỂU (một lời gọi nhỏ chỉ chọn mã câu mẫu), và các bước người (thêm · sửa · bật / tắt · xoá · ảnh). Không import
 * `engine.ts` (engine import tệp này) — provider AI do engine đưa vào.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { sha256Hex, sniffImageType } from "@/lib/creative/images";
import { formatVND } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { stockFor } from "@/lib/sales-chatbot/catalog";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import {
  fillPlaceholders,
  looksLikeOrdering,
  matchQuickReplyByKeyword,
  parsePlaceholders,
  parseQuickReplySettings,
  QUICK_REPLY_LIMITS,
  QUICK_REPLY_SETTING_KEY,
  validateQuickReply,
  type QuickReplyDraft,
  type QuickReplyEntry,
  type QuickReplySettings,
} from "@/lib/sales-chatbot/quick-replies-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { setSettingJson } from "@/lib/settings";

const qr = schema.salesChatQuickReplies;
const qi = schema.salesChatQuickReplyImages;

export async function loadQuickReplySettings(): Promise<QuickReplySettings> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, QUICK_REPLY_SETTING_KEY)).limit(1);
  try {
    return parseQuickReplySettings(row?.value ? (JSON.parse(row.value) as unknown) : null);
  } catch {
    return parseQuickReplySettings(null);
  }
}

export type QuickReplyImageMeta = { id: string; contentType: string; bytes: number };
export type QuickReplyRow = {
  id: string;
  title: string;
  triggers: string[];
  answer: string;
  active: boolean;
  source: "MANUAL" | "LEARNED";
  uses: number;
  lastUsedAt: Date | null;
  updatedAt: Date;
  images: QuickReplyImageMeta[];
  /** Câu mẫu còn «[giá lấy từ ERP]» (gợi ý AI chưa sửa) — không bật được tới khi người thay bằng chỗ trống. */
  needsEdit: boolean;
};

const NEEDS_EDIT = "[giá lấy từ ERP]";

/** Mọi câu mẫu (màn hình quản lý) — đang bật trước, dùng nhiều trước. */
export async function listQuickReplies(): Promise<QuickReplyRow[]> {
  const db = await getDb();
  const rows = await db.select().from(qr).orderBy(desc(qr.active), desc(qr.uses), asc(qr.title));
  const imgs = rows.length
    ? await db.select({ id: qi.id, quickReplyId: qi.quickReplyId, contentType: qi.contentType, bytes: qi.bytes }).from(qi).where(inArray(qi.quickReplyId, rows.map((r) => r.id))).orderBy(asc(qi.position), asc(qi.createdAt))
    : [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    triggers: r.triggers ?? [],
    answer: r.answer,
    active: r.active,
    source: r.source === "LEARNED" ? "LEARNED" : "MANUAL",
    uses: r.uses,
    lastUsedAt: r.lastUsedAt,
    updatedAt: r.updatedAt,
    images: imgs.filter((i) => i.quickReplyId === r.id).map((i) => ({ id: i.id, contentType: i.contentType, bytes: i.bytes })),
    needsEdit: r.answer.includes(NEEDS_EDIT),
  }));
}

async function activeEntries(): Promise<QuickReplyEntry[]> {
  const db = await getDb();
  const rows = await db.select({ id: qr.id, title: qr.title, triggers: qr.triggers, answer: qr.answer }).from(qr).where(eq(qr.active, true)).orderBy(desc(qr.uses), asc(qr.title)).limit(QUICK_REPLY_LIMITS.entries);
  return rows.map((r) => ({ id: r.id, title: r.title, triggers: r.triggers ?? [], answer: r.answer }));
}

/**
 * Điền chỗ trống bằng số ĐỌC TỪ ERP ngay lúc gửi — cùng nguồn với công cụ của AI: giá = `retail_price` hiện tại (0 / thiếu ⇒
 * chưa có giá); tồn = KHẢ DỤNG theo sổ kho (chưa có phiếu nhập ⇒ chưa xác nhận); ship = phí ship cố định của cấu hình.
 * Thiếu bất kỳ số nào ⇒ `null`: KHÔNG gửi câu mẫu, để chatbot AI trả lời theo luật của nó (không bao giờ báo «0 ₫»).
 */
export async function renderQuickAnswer(answer: string, cfg: Pick<SalesChatbotConfig, "shippingFee">): Promise<string | null> {
  const holes = parsePlaceholders(answer);
  if (holes.length === 0) return answer;
  const skus = [...new Set(holes.filter((h) => h.kind !== "ship").map((h) => h.sku))];
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = skus.length
    ? await db
        .select({ id: pv.id, sku: pv.sku, price: pv.retailPrice })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .where(and(inArray(pv.sku, skus), eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false)))
    : [];
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const stock = await stockFor(rows.map((r) => r.id));
  const values = new Map<string, string | null>();
  for (const h of holes) {
    if (h.kind === "ship") {
      values.set(h.raw, cfg.shippingFee === null ? null : cfg.shippingFee === 0 ? "miễn phí" : formatVND(cfg.shippingFee));
      continue;
    }
    const v = bySku.get(h.sku);
    if (!v) {
      values.set(h.raw, null);
      continue;
    }
    if (h.kind === "price") values.set(h.raw, v.price > 0 ? formatVND(v.price) : null);
    else {
      const s = stock.get(v.id);
      values.set(h.raw, s?.stockKnown && s.available !== null ? String(s.available) : null);
    }
  }
  return fillPlaceholders(answer, values);
}

export type QuickReplyPick = { entry: QuickReplyEntry; text: string; imageIds: string[]; method: "KEYWORD" | "AI" };
export type QuickReplyStep = { kind: "ANSWER"; pick: QuickReplyPick } | { kind: "SKIP"; reason: string } | { kind: "NO_MATCH"; candidates: QuickReplyEntry[] };

async function imageIdsOf(quickReplyId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select({ id: qi.id }).from(qi).where(eq(qi.quickReplyId, quickReplyId)).orderBy(asc(qi.position), asc(qi.createdAt)).limit(QUICK_REPLY_LIMITS.images);
  return rows.map((r) => r.id);
}

async function pickOf(entry: QuickReplyEntry, method: QuickReplyPick["method"], cfg: Pick<SalesChatbotConfig, "shippingFee">): Promise<QuickReplyPick | null> {
  const text = await renderQuickAnswer(entry.answer, cfg);
  if (text === null) return null;
  return { entry, text, imageIds: await imageIdsOf(entry.id), method };
}

/**
 * BƯỚC 1 (0 token): đang đặt hàng ⇒ `SKIP`; khớp chữ thắng rõ ⇒ `ANSWER`; còn lại ⇒ `NO_MATCH` kèm ứng viên cho bước AI
 * đọc hiểu (hai câu ngang điểm ⇒ chỉ hai câu đó; không khớp ⇒ mọi câu đang bật).
 */
export async function quickReplyByKeyword(text: string, opts: { ordering: boolean; cfg: Pick<SalesChatbotConfig, "shippingFee"> }): Promise<QuickReplyStep> {
  if (opts.ordering) return { kind: "SKIP", reason: "Khách đang đặt hàng" };
  if (looksLikeOrdering(text)) return { kind: "SKIP", reason: "Câu khách có dấu hiệu chốt đơn" };
  const entries = await activeEntries();
  if (entries.length === 0) return { kind: "SKIP", reason: "Chưa có câu mẫu nào đang bật" };
  const m = matchQuickReplyByKeyword(text, entries);
  if (m.kind === "MATCH") {
    const pick = await pickOf(m.entry, "KEYWORD", opts.cfg);
    if (pick) return { kind: "ANSWER", pick };
    return { kind: "SKIP", reason: "Câu mẫu khớp nhưng thiếu số từ ERP" };
  }
  if (text.trim().split(/\s+/).length > QUICK_REPLY_LIMITS.maxMessageWords) return { kind: "SKIP", reason: "Tin nhiều ý" };
  return { kind: "NO_MATCH", candidates: (m.kind === "AMBIGUOUS" ? m.entries : entries).slice(0, QUICK_REPLY_LIMITS.aiCandidates) };
}

const PICK_SYSTEM = [
  "Bạn đọc tin nhắn của khách gửi một shop bán hàng và chọn MỘT câu trả lời mẫu phù hợp.",
  "Chỉ chọn khi câu mẫu trả lời ĐẦY ĐỦ và ĐÚNG ý chính của tin khách. Tin có nhiều câu hỏi khác nhau, khách đang đặt hàng / gửi thông tin giao hàng, khiếu nại, hoặc không câu mẫu nào khớp ⇒ trả lời NONE.",
  "Chỉ trả lời đúng MỘT mã dạng Q1, Q2… hoặc NONE. Không giải thích.",
].join("\n");

/**
 * BƯỚC 2 — AI ĐỌC HIỂU: một lời gọi NHỎ (danh sách tên + câu hỏi mẫu, KHÔNG có câu trả lời, không có công cụ, không có danh
 * mục) chỉ để chọn mã câu mẫu. Rẻ hơn một lượt chatbot đầy đủ nhiều lần. Trả `pick` (có thể `null`) + phản hồi để engine
 * ghi sổ dùng AI.
 */
export async function quickReplyByAi(
  provider: AiProvider,
  text: string,
  context: string,
  candidates: readonly QuickReplyEntry[],
  cfg: Pick<SalesChatbotConfig, "shippingFee">,
): Promise<{ pick: QuickReplyPick | null; res: AiResponse }> {
  const list = candidates.map((c, i) => `Q${i + 1}: ${c.title} — khách hay hỏi: ${c.triggers.slice(0, 6).join(" | ")}`).join("\n");
  const user = [context ? `Câu shop vừa nói trước đó: «${context.slice(0, 300)}»` : "", `CÁC CÂU MẪU:\n${list}`, `TIN KHÁCH: «${text}»`].filter(Boolean).join("\n\n");
  const res = await provider.complete({ system: PICK_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: user }] }], tools: [], maxTokens: 1200, reasoning: "low" });
  const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
  const m = /\bQ(\d{1,3})\b/i.exec(out);
  const idx = m && !/\bNONE\b/i.test(out.replace(m[0], "")) ? Number(m[1]) - 1 : -1;
  const entry = idx >= 0 ? candidates[idx] : undefined;
  return { pick: entry ? await pickOf(entry, "AI", cfg) : null, res };
}

/**
 * Câu mẫu ĐANG BẬT cho AI dùng TRONG luồng bán (công cụ `send_quick_reply`): mã ngắn Q1, Q2… (ổn định trong một lượt) +
 * tên + có phải câu upsell không. Không đưa câu trả lời vào lời nhắc — AI chỉ chọn, máy chủ điền số ERP rồi gửi nguyên văn.
 */
export async function quickReplyCatalog(): Promise<{ code: string; id: string; title: string; upsell: boolean }[]> {
  const settings = await loadQuickReplySettings();
  if (!settings.enabled) return [];
  return (await activeEntries()).slice(0, QUICK_REPLY_LIMITS.aiCandidates).map((e, i) => ({ code: `Q${i + 1}`, id: e.id, title: e.title, upsell: e.id === settings.upsellReplyId }));
}

/** Một câu mẫu ĐANG BẬT, đã điền số ERP, kèm ảnh — để gửi nguyên văn. `null` = không còn / thiếu số. */
export async function renderQuickReplyForSend(id: string, cfg: Pick<SalesChatbotConfig, "shippingFee">): Promise<QuickReplyPick | null> {
  const entry = (await activeEntries()).find((e) => e.id === id);
  return entry ? pickOf(entry, "AI", cfg) : null;
}

/** Ghi một lần dùng (đếm cho màn hình quản lý). */
export async function markQuickReplyUsed(id: string, now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db.update(qr).set({ uses: sql`${qr.uses} + 1`, lastUsedAt: now }).where(eq(qr.id, id));
}

/** Nội dung một ảnh câu mẫu (route xem ảnh của màn hình quản lý; gửi Pancake). */
export async function readQuickReplyImage(id: string): Promise<{ contentType: string; data: Buffer; pancakePageId: string | null; pancakeContentId: string | null; pancakeUploadedAt: Date | null } | null> {
  const db = await getDb();
  const [row] = await db.select({ contentType: qi.contentType, data: qi.data, pancakePageId: qi.pancakePageId, pancakeContentId: qi.pancakeContentId, pancakeUploadedAt: qi.pancakeUploadedAt }).from(qi).where(eq(qi.id, id)).limit(1);
  return row ?? null;
}

/** Nhớ mã nội dung Pancake của một ảnh cho một page (dùng lại 12 giờ). */
export async function rememberPancakeContent(imageId: string, pageId: string, contentId: string, now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db.update(qi).set({ pancakePageId: pageId, pancakeContentId: contentId, pancakeUploadedAt: now }).where(eq(qi.id, imageId));
}

// ───────────────────────── Các bước người (server action gọi) ─────────────────────────

type Gate = { ok: true } | { ok: false; error: string };

async function gate(user: SessionUser): Promise<Gate> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  return { ok: true };
}

/** SKU trong chỗ trống phải là mẫu mã ĐANG BÁN — gõ sai thì báo ngay, không đợi tới lúc khách hỏi mới lặng lẽ rơi về AI. */
async function unknownSkus(answer: string): Promise<string[]> {
  const skus = [...new Set(parsePlaceholders(answer).filter((h) => h.kind !== "ship").map((h) => h.sku))];
  if (skus.length === 0) return [];
  const db = await getDb();
  const pv = schema.productVariants;
  const rows = await db.select({ sku: pv.sku }).from(pv).where(and(inArray(pv.sku, skus), eq(pv.isRemoved, false)));
  const known = new Set(rows.map((r) => r.sku));
  return skus.filter((s) => !known.has(s));
}

export async function saveQuickReply(user: SessionUser, input: { id?: string | null; title: unknown; triggers: unknown; answer: unknown; active?: boolean }): Promise<{ ok: true; id: string } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const v = validateQuickReply(input);
  if (!v.ok) return { error: v.error };
  const missing = await unknownSkus(v.value.answer);
  if (missing.length) return { error: `Không có mẫu mã SKU: ${missing.join(", ")} — kiểm lại mã trong chỗ trống.` };
  const db = await getDb();
  const active = Boolean(input.active) && !v.value.answer.includes(NEEDS_EDIT);
  if (input.id) {
    const [row] = await db.update(qr).set({ ...v.value, active }).where(eq(qr.id, input.id)).returning({ id: qr.id });
    if (!row) return { error: "Không còn câu mẫu này." };
    await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_UPDATE", entity: "SALES_QUICK_REPLY", entityId: row.id, after: { title: v.value.title, active } });
    return { ok: true, id: row.id };
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(qr);
  if (Number(n) >= QUICK_REPLY_LIMITS.entries) return { error: `Tối đa ${QUICK_REPLY_LIMITS.entries} câu mẫu.` };
  const [row] = await db.insert(qr).values({ ...v.value, active, source: "MANUAL", createdBy: user.email }).returning({ id: qr.id });
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_CREATE", entity: "SALES_QUICK_REPLY", entityId: row.id, after: { title: v.value.title, active } });
  return { ok: true, id: row.id };
}

export async function setQuickReplyActive(user: SessionUser, id: string, active: boolean): Promise<{ ok: true } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select({ answer: qr.answer }).from(qr).where(eq(qr.id, id)).limit(1);
  if (!row) return { error: "Không còn câu mẫu này." };
  if (active && row.answer.includes(NEEDS_EDIT)) return { error: "Câu trả lời còn «[giá lấy từ ERP]» — sửa thành {{giá:SKU}} (hoặc bỏ giá) rồi mới bật." };
  await db.update(qr).set({ active }).where(eq(qr.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: active ? "SALES_QUICK_REPLY_ACTIVATE" : "SALES_QUICK_REPLY_DEACTIVATE", entity: "SALES_QUICK_REPLY", entityId: id });
  return { ok: true };
}

export async function deleteQuickReply(user: SessionUser, id: string): Promise<{ ok: true } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const [row] = await db.delete(qr).where(eq(qr.id, id)).returning({ id: qr.id, title: qr.title });
  if (!row) return { error: "Không còn câu mẫu này." };
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_DELETE", entity: "SALES_QUICK_REPLY", entityId: id, before: { title: row.title } });
  return { ok: true };
}

export async function addQuickReplyImages(user: SessionUser, id: string, files: readonly Uint8Array[]): Promise<{ ok: true; added: number } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.id, id)).limit(1);
  if (!row) return { error: "Không còn câu mẫu này." };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(qi).where(eq(qi.quickReplyId, id));
  if (Number(n) + files.length > QUICK_REPLY_LIMITS.images) return { error: `Tối đa ${QUICK_REPLY_LIMITS.images} ảnh mỗi câu mẫu.` };
  const values: (typeof qi.$inferInsert)[] = [];
  for (const [i, bytes] of files.entries()) {
    if (bytes.length === 0) return { error: `Ảnh ${i + 1} rỗng.` };
    if (bytes.length > QUICK_REPLY_LIMITS.imageBytes) return { error: `Ảnh ${i + 1} quá lớn (${Math.round(bytes.length / 1024)} KB) — tối đa ${QUICK_REPLY_LIMITS.imageBytes / 1024 / 1024} MB.` };
    const type = sniffImageType(bytes);
    if (!type) return { error: `Tệp ${i + 1} không phải ảnh JPEG / PNG / WEBP.` };
    values.push({ quickReplyId: id, position: Number(n) + i, contentType: type, bytes: bytes.length, sha256: sha256Hex(bytes), data: Buffer.from(bytes) });
  }
  if (values.length) await db.insert(qi).values(values);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_IMAGES_ADD", entity: "SALES_QUICK_REPLY", entityId: id, after: { added: values.length } });
  return { ok: true, added: values.length };
}

export async function removeQuickReplyImage(user: SessionUser, imageId: string): Promise<{ ok: true } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const db = await getDb();
  const [row] = await db.delete(qi).where(eq(qi.id, imageId)).returning({ quickReplyId: qi.quickReplyId });
  if (!row) return { error: "Không còn ảnh này." };
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_IMAGE_REMOVE", entity: "SALES_QUICK_REPLY", entityId: row.quickReplyId });
  return { ok: true };
}

/** Lưu MỘT PHẦN cài đặt — gộp với bản đang lưu (bật / tắt một công tắc không xoá câu upsell đã chọn). */
export async function saveQuickReplySettings(user: SessionUser, input: Partial<QuickReplySettings>): Promise<{ ok: true } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const value = parseQuickReplySettings({ ...(await loadQuickReplySettings()), ...input });
  if (value.upsellReplyId) {
    const db = await getDb();
    const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.id, value.upsellReplyId)).limit(1);
    if (!row) return { error: "Câu mẫu upsell không còn." };
  }
  await setSettingJson(QUICK_REPLY_SETTING_KEY, value);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_QUICK_REPLY_SETTINGS", entity: "SETTINGS", entityId: QUICK_REPLY_SETTING_KEY, after: value });
  return { ok: true };
}

/** Số lượt hội thoại trả lời bằng câu mẫu vs bằng AI trong 30 ngày (màn hình quản lý). */
export async function quickReplyStats(now: Date = new Date()): Promise<{ quickTurns: number; totalTurns: number }> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [r] = await db
    .select({ quick: sql<number>`coalesce(sum(${c.quickReplies}), 0)::int`, total: sql<number>`coalesce(sum(${c.turns}), 0)::int` })
    .from(c)
    .where(and(inArray(c.channel, ["WEB", "FANPAGE"]), sql`${c.updatedAt} >= ${new Date(now.getTime() - 30 * 86_400_000)}`));
  return { quickTurns: Number(r?.quick ?? 0), totalTurns: Number(r?.total ?? 0) };
}

/**
 * Gợi ý câu mẫu do AI rút từ hội thoại cũ («Học từ hội thoại cũ»): luôn ở trạng thái TẮT, giá trong câu trả lời bị thay bằng
 * «[giá lấy từ ERP]» (không bật được tới khi người sửa). Lượt học mới thay các gợi ý CŨ chưa ai bật / chưa dùng lần nào —
 * không động tới câu mẫu người tự soạn hay gợi ý đã được dùng.
 */
export async function saveLearnedQuickReplies(items: readonly QuickReplyDraft[], actorEmail: string | null): Promise<number> {
  const db = await getDb();
  const clean: QuickReplyDraft[] = [];
  for (const it of items.slice(0, QUICK_REPLY_LIMITS.learnedMax)) {
    const answer = stripPrices(String(it.answer ?? "")).text;
    const v = validateQuickReply({ title: it.title, triggers: it.triggers, answer: answer.replace(/\[giá lấy từ ERP\]/g, "GIA_CHO") });
    if (!v.ok) continue;
    clean.push({ ...v.value, answer: v.value.answer.replace(/GIA_CHO/g, NEEDS_EDIT) });
  }
  await db.delete(qr).where(and(eq(qr.source, "LEARNED"), eq(qr.active, false), eq(qr.uses, 0)));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(qr);
  const room = Math.max(0, QUICK_REPLY_LIMITS.entries - Number(n));
  const rows = clean.slice(0, room).map((c) => ({ ...c, active: false, source: "LEARNED" as const, createdBy: actorEmail }));
  if (rows.length) await db.insert(qr).values(rows);
  return rows.length;
}
