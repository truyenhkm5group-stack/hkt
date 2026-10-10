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
import { paymentSignalInCustomerText } from "@/lib/sales-chatbot/claim-guard";
import { PUBLIC_CHAT_CHANNELS, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import {
  fillPlaceholders,
  isMultiPart,
  looksLikeOrdering,
  looksWholesale,
  matchQuickReplyByKeyword,
  parsePlaceholders,
  parseQuickReplySettings,
  QUICK_REPLY_LIMITS,
  rankQuickReplies,
  QUICK_REPLY_SETTING_KEY,
  repeatsRecent,
  validateQuickReply,
  type QuickReplyDraft,
  type QuickReplyEntry,
  type QuickReplySettings,
} from "@/lib/sales-chatbot/quick-replies-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { foldVi } from "@/lib/sales-chatbot/text";
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

export const NEEDS_EDIT = "[giá lấy từ ERP]";

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

export async function activeEntries(): Promise<QuickReplyEntry[]> {
  const db = await getDb();
  const rows = await db.select({ id: qr.id, title: qr.title, triggers: qr.triggers, answer: qr.answer }).from(qr).where(eq(qr.active, true)).orderBy(desc(qr.uses), asc(qr.title)).limit(QUICK_REPLY_LIMITS.entries);
  return rows.map((r) => ({ id: r.id, title: r.title, triggers: r.triggers ?? [], answer: r.answer }));
}

/**
 * Điền chỗ trống bằng số ĐỌC TỪ ERP ngay lúc gửi — cùng nguồn với công cụ của AI: giá = `retail_price` hiện tại (0 / thiếu ⇒
 * chưa có giá); tồn = KHẢ DỤNG theo sổ kho (chưa có phiếu nhập ⇒ chưa xác nhận; khả dụng ÂM = sổ kho sai ⇒ cũng là thiếu số —
 * bot không gửi «Còn -2 hộp ạ», như `check_inventory` không bán theo tồn âm); ship = phí ship cố định của cấu hình.
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
      values.set(h.raw, s?.stockKnown && s.available !== null && s.available >= 0 ? String(s.available) : null);
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
 * BƯỚC 1 (0 token): đang đặt hàng / khách báo đã chuyển khoản ⇒ `SKIP`; khớp chữ thắng rõ ⇒ `ANSWER`; còn lại ⇒ `NO_MATCH` kèm ứng viên cho bước AI
 * đọc hiểu (hai câu ngang điểm ⇒ chỉ hai câu đó; không khớp ⇒ mọi câu đang bật).
 */
export async function quickReplyByKeyword(text: string, opts: { ordering: boolean; cfg: Pick<SalesChatbotConfig, "shippingFee">; recent?: readonly string[] }): Promise<QuickReplyStep> {
  if (opts.ordering) return { kind: "SKIP", reason: "Khách đang đặt hàng" };
  // KHÁCH BÁO ĐÃ TRẢ TIỀN (P0 10/10/2026 — claim-guard.ts): ảnh chuyển khoản / «ck rồi» ⇒ KHÔNG câu mẫu nào được trả lời —
  // câu mẫu không biết gì về đơn hay tiền, và một câu «khách báo đã CK» học từ nhân viên (đã đối soát) gửi nguyên văn thành
  // «shop đã nhận tiền». Máy chủ chuyển người (engine.ts); bước AI chọn mã cũng không chạy vì đây là SKIP.
  if (paymentSignalInCustomerText(text)) return { kind: "SKIP", reason: "Khách báo đã chuyển khoản — nhân viên đối soát" };
  if (looksLikeOrdering(text)) return { kind: "SKIP", reason: "Câu khách có dấu hiệu chốt đơn" };
  // Nhiều tin liên tiếp ⇒ một câu mẫu chỉ trả lời được một ý — chatbot đầy đủ trả lời ĐỦ từng câu (vẫn dùng câu mẫu được).
  if (isMultiPart(text)) return { kind: "SKIP", reason: "Khách nhắn nhiều câu liên tiếp" };
  const entries = await activeEntries();
  if (entries.length === 0) return { kind: "SKIP", reason: "Chưa có câu mẫu nào đang bật" };
  const m = matchQuickReplyByKeyword(text, entries);
  // Khách hỏi SỈ ⇒ khớp chữ «chả cá thu giá» sẽ trả giá LẺ — nhường AI đọc hiểu (nó biết câu báo giá lẻ không khớp).
  if (m.kind === "MATCH" && !looksWholesale(text)) {
    const pick = await pickOf(m.entry, "KEYWORD", opts.cfg);
    if (pick && repeatsRecent(pick.text, opts.recent ?? [])) return { kind: "SKIP", reason: "Câu mẫu vừa gửi — khách đang trả lời nó" };
    if (pick) return { kind: "ANSWER", pick };
    return { kind: "SKIP", reason: "Câu mẫu khớp nhưng thiếu số từ ERP" };
  }
  if (text.trim().split(/\s+/).length > QUICK_REPLY_LIMITS.maxMessageWords) return { kind: "SKIP", reason: "Tin nhiều ý" };
  // Shop có nhiều hơn `aiCandidates` câu mẫu ⇒ AI đọc hiểu nhận các câu GẦN tin khách nhất, không phải 60 câu dùng nhiều nhất.
  return { kind: "NO_MATCH", candidates: m.kind === "AMBIGUOUS" ? m.entries.slice(0, QUICK_REPLY_LIMITS.aiCandidates) : rankQuickReplies(text, entries, QUICK_REPLY_LIMITS.aiCandidates) };
}

const PICK_SYSTEM = [
  "Bạn đọc tin nhắn của khách gửi một shop bán hàng và chọn MỘT câu trả lời mẫu phù hợp.",
  "Chỉ chọn khi câu mẫu trả lời ĐẦY ĐỦ và ĐÚNG ý chính của tin khách. Tin có nhiều câu hỏi khác nhau, khách đang đặt hàng / gửi thông tin giao hàng, khiếu nại, hoặc không câu mẫu nào khớp ⇒ trả lời NONE.",
  "Khách đang TRẢ LỜI câu shop vừa hỏi (vd shop hỏi «lấy bao nhiêu kg», khách đáp «20-30 kg») ⇒ NONE — không chọn lại câu mẫu cùng ý với câu shop vừa nói.",
  "Khách hỏi giá SỈ / lấy về bán / số lượng lớn ⇒ câu mẫu báo giá LẺ KHÔNG khớp.",
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
  const all = await activeEntries();
  const top = all.slice(0, QUICK_REPLY_LIMITS.aiCandidates);
  // Câu upsell luôn có mặt dù ít được dùng — bước UPSELL của quy trình bán cần đúng câu đó.
  const upsell = settings.upsellReplyId && !top.some((e) => e.id === settings.upsellReplyId) ? all.find((e) => e.id === settings.upsellReplyId) : undefined;
  return (upsell ? [...top.slice(0, -1), upsell] : top).map((e, i) => ({ code: `Q${i + 1}`, id: e.id, title: e.title, upsell: e.id === settings.upsellReplyId }));
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

/** Module AI bán hàng bật + quyền `ai_sales:manage` — mọi bước người của câu mẫu (cả «Nạp ngay») đi qua đây. */
export async function gate(user: SessionUser): Promise<Gate> {
  if (!(await canUseModule("ai_sales"))) return { ok: false, error: "Module AI bán hàng chưa bật." };
  if (!can(user, SALES_CHATBOT_MANAGE)) return { ok: false, error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  return { ok: true };
}

/** SKU trong chỗ trống phải là mẫu mã ĐANG BÁN — gõ sai thì báo ngay, không đợi tới lúc khách hỏi mới lặng lẽ rơi về AI. */
export async function unknownSkus(answer: string): Promise<string[]> {
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

export type BulkQuickReplyOp = "ACTIVATE" | "DEACTIVATE" | "DELETE";

/**
 * THAO TÁC HÀNG LOẠT («Chọn tất cả» trên màn hình quản lý): bật · tắt · xoá nhiều câu mẫu một lần, MỘT dòng nhật ký. Bật bỏ
 * qua câu còn «[giá lấy từ ERP]» (đếm riêng, không bật nửa vời); xoá câu đang là câu upsell thì bỏ chọn câu upsell.
 */
export async function bulkQuickReplies(user: SessionUser, rawIds: readonly string[], op: BulkQuickReplyOp): Promise<{ ok: true; changed: number; skipped: number } | { error: string }> {
  const g = await gate(user);
  if (!g.ok) return { error: g.error };
  const ids = [...new Set(rawIds.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return { error: "Chưa chọn câu mẫu nào." };
  if (ids.length > QUICK_REPLY_LIMITS.bulk) return { error: `Mỗi lần tối đa ${QUICK_REPLY_LIMITS.bulk} câu mẫu.` };
  const db = await getDb();
  const rows = await db.select({ id: qr.id, title: qr.title, answer: qr.answer, active: qr.active }).from(qr).where(inArray(qr.id, ids));
  if (rows.length === 0) return { error: "Không còn câu mẫu nào trong số đã chọn." };
  let changed = 0;
  let skipped = 0;
  if (op === "DELETE") {
    changed = (await db.delete(qr).where(inArray(qr.id, rows.map((r) => r.id))).returning({ id: qr.id })).length;
    const settings = await loadQuickReplySettings();
    if (settings.upsellReplyId && rows.some((r) => r.id === settings.upsellReplyId)) await setSettingJson(QUICK_REPLY_SETTING_KEY, { ...settings, upsellReplyId: null });
  } else {
    const active = op === "ACTIVATE";
    const blocked = active ? rows.filter((r) => r.answer.includes(NEEDS_EDIT)) : [];
    skipped = blocked.length;
    const target = rows.filter((r) => r.active !== active && !blocked.includes(r)).map((r) => r.id);
    if (target.length) changed = (await db.update(qr).set({ active }).where(inArray(qr.id, target)).returning({ id: qr.id })).length;
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: op === "DELETE" ? "SALES_QUICK_REPLY_BULK_DELETE" : op === "ACTIVATE" ? "SALES_QUICK_REPLY_BULK_ACTIVATE" : "SALES_QUICK_REPLY_BULK_DEACTIVATE",
    entity: "SALES_QUICK_REPLY",
    after: { requested: ids.length, found: rows.length, changed, skipped },
  });
  return { ok: true, changed, skipped };
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
    .where(and(inArray(c.channel, [...PUBLIC_CHAT_CHANNELS]), sql`${c.updatedAt} >= ${new Date(now.getTime() - 30 * 86_400_000)}`));
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
  return insertLearned(clean, { actorEmail, active: false });
}

/**
 * Ghi câu mẫu AI soạn (đã làm sạch) — KHÔNG xoá gì, bỏ câu trùng TÊN (bỏ dấu) với câu đang có, giữ trần `entries`. `active`
 * chỉ áp cho câu không còn «[giá lấy từ ERP]». Trả số câu đã ghi.
 */
export async function insertLearned(clean: readonly QuickReplyDraft[], opts: { actorEmail: string | null; active: boolean }): Promise<number> {
  const db = await getDb();
  const existing = new Set((await db.select({ title: qr.title }).from(qr)).map((r) => foldVi(r.title)));
  const fresh = clean.filter((c) => {
    const k = foldVi(c.title);
    if (!k || existing.has(k)) return false;
    existing.add(k);
    return true;
  });
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(qr);
  const room = Math.max(0, QUICK_REPLY_LIMITS.entries - Number(n));
  const rows = fresh.slice(0, room).map((c) => ({ ...c, active: opts.active && !c.answer.includes(NEEDS_EDIT), source: "LEARNED" as const, createdBy: opts.actorEmail }));
  if (rows.length) await db.insert(qr).values(rows);
  return rows.length;
}
