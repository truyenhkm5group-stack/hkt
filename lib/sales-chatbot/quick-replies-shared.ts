/**
 * ═══════════ CÂU TRẢ LỜI MẪU (Q&A) CỦA CHATBOT BÁN HÀNG — PHẦN THUẦN (0183) ═══════════
 *
 * Chủ shop 01/10/2026: câu hỏi phổ biến (giá, ship, bảo quản, cách dùng…) trả lời bằng câu SOẠN SẴN kèm ảnh, không tốn token
 * AI; AI chỉ dùng cho ca câu mẫu không trả lời được, hoặc để ĐỌC HIỂU câu khó rồi chọn câu mẫu. Thứ tự một lượt fanpage /
 * web / thử (`lib/sales-chatbot/engine.ts`):
 *   1. Khách đang đặt hàng (có đơn nháp, gửi SĐT, nói «chốt», «địa chỉ»…) ⇒ BỎ QUA câu mẫu — chốt đơn cần công cụ của AI.
 *   2. Khớp CHỮ (bỏ dấu, theo cụm từ khách hay gõ) — 0 token. Một câu mẫu thắng rõ ⇒ trả lời ngay.
 *   3. Không khớp / hai câu ngang nhau ⇒ (nếu bật) AI ĐỌC HIỂU: một lời gọi nhỏ chỉ chọn MÃ câu mẫu hoặc «không có».
 *   4. Vẫn không có ⇒ chatbot AI đầy đủ như cũ.
 *
 * GIÁ / TỒN / PHÍ SHIP không bao giờ gõ thẳng vào câu mẫu (luật cứng của bot: số chỉ đọc từ ERP lúc trả lời): câu mẫu dùng
 * chỗ trống `{{giá:SKU}}` · `{{tồn:SKU}}` · `{{ship}}`; thiếu số (chưa có giá, chưa xác nhận tồn) ⇒ KHÔNG gửi câu mẫu, để
 * AI trả lời theo luật của nó. Tệp này không đọc CSDL — client import được.
 */
import { stripPrices } from "@/lib/sales-chatbot/playbook-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

export const QUICK_REPLY_SETTING_KEY = "ai.salesChatbot.quickReplies";

export const QUICK_REPLY_LIMITS = {
  entries: 80,
  titleChars: 80,
  triggers: 20,
  triggerChars: 120,
  answerChars: 1500,
  images: 6,
  imageBytes: 3 * 1024 * 1024,
  /** Tin dài hơn chừng này từ là nhiều ý — không khớp chữ (AI đọc hiểu / chatbot đầy đủ lo). */
  maxMessageWords: 30,
  /** Số câu mẫu tối đa đưa vào lời gọi AI đọc hiểu. */
  aiCandidates: 60,
  /** Gợi ý AI rút ra từ hội thoại cũ mỗi lượt học. */
  learnedMax: 15,
} as const;

/** `upsellReplyId` = câu mẫu (kèm ảnh menu) bot gửi ở bước UPSELL / CROSS-SELL của quy trình bán — `null` khi chưa chọn. */
export type QuickReplySettings = { enabled: boolean; aiMatch: boolean; upsellReplyId: string | null };
export const DEFAULT_QUICK_REPLY_SETTINGS: QuickReplySettings = { enabled: true, aiMatch: true, upsellReplyId: null };

export function parseQuickReplySettings(v: unknown): QuickReplySettings {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof QuickReplySettings, unknown>>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_QUICK_REPLY_SETTINGS.enabled,
    aiMatch: typeof o.aiMatch === "boolean" ? o.aiMatch : DEFAULT_QUICK_REPLY_SETTINGS.aiMatch,
    upsellReplyId: typeof o.upsellReplyId === "string" && o.upsellReplyId.trim() ? o.upsellReplyId.trim() : null,
  };
}

export type QuickReplyEntry = { id: string; title: string; triggers: readonly string[]; answer: string };

export type KeywordMatch = { kind: "MATCH"; entry: QuickReplyEntry; trigger: string } | { kind: "AMBIGUOUS"; entries: QuickReplyEntry[] } | { kind: "NONE" };

/** Điểm một cụm từ trên câu khách (đã bỏ dấu, có khoảng trắng hai đầu): liền mạch = 2 × số từ; đủ từ rời rạc = số từ. */
function phraseScore(msgPadded: string, msgWords: ReadonlySet<string>, trigger: string): number {
  const t = foldVi(trigger);
  if (!t) return 0;
  const words = t.split(" ");
  if (msgPadded.includes(` ${t} `)) return words.length * 2;
  return words.every((w) => msgWords.has(w)) ? words.length : 0;
}

/**
 * Khớp CHỮ — HÀM THUẦN. Mỗi câu mẫu lấy điểm cao nhất trong các cụm từ của nó; cần ≥ 2 điểm (một từ đứng liền, hoặc hai từ
 * trở lên). Hai câu mẫu cùng điểm cao nhất ⇒ `AMBIGUOUS` (không đoán — AI đọc hiểu hoặc chatbot đầy đủ quyết). Tin dài
 * quá `maxMessageWords` từ ⇒ `NONE`: câu nhiều ý không được trả lời bằng một câu mẫu.
 */
export function matchQuickReplyByKeyword(text: string, entries: readonly QuickReplyEntry[]): KeywordMatch {
  const msg = foldVi(text);
  if (!msg) return { kind: "NONE" };
  const words = msg.split(" ");
  if (words.length > QUICK_REPLY_LIMITS.maxMessageWords) return { kind: "NONE" };
  const padded = ` ${msg} `;
  const set = new Set(words);
  let best = 0;
  let top: { entry: QuickReplyEntry; trigger: string }[] = [];
  for (const entry of entries) {
    let score = 0;
    let trigger = "";
    for (const tr of entry.triggers) {
      const s = phraseScore(padded, set, tr);
      if (s > score) {
        score = s;
        trigger = tr;
      }
    }
    if (score < 2) continue;
    if (score > best) {
      best = score;
      top = [{ entry, trigger }];
    } else if (score === best) top.push({ entry, trigger });
  }
  if (top.length === 1) return { kind: "MATCH", entry: top[0].entry, trigger: top[0].trigger };
  if (top.length > 1) return { kind: "AMBIGUOUS", entries: top.map((x) => x.entry) };
  return { kind: "NONE" };
}

/** Câu khách cho thấy đang ĐẶT HÀNG (SĐT, «chốt», «địa chỉ», «đồng ý»…) ⇒ câu mẫu đứng ngoài, AI chốt đơn bằng công cụ. */
export function looksLikeOrdering(text: string): boolean {
  if (/(?:\+?84|0)(?:[\s.-]?\d){8,10}/.test(text)) return true;
  const m = ` ${foldVi(text)} `;
  return [" chot ", " dat hang ", " len don ", " dia chi ", " sdt ", " so dien thoai ", " dong y ", " xac nhan ", " gui ve ", " giao ve ", " lay cho ", " lay em ", " lay 1 ", " lay 2 ", " lay 3 "].some((k) => m.includes(k));
}

export type Placeholder = { raw: string; kind: "price" | "stock" | "ship"; sku: string };

const PLACEHOLDER_RE = /\{\{\s*(giá|gia|tồn|ton|ship|phí ship|phi ship)\s*(?::\s*([^}]+?))?\s*\}\}/gi;

/** Chỗ trống trong câu mẫu. `{{giá:SKU}}` / `{{tồn:SKU}}` bắt buộc có SKU; `{{ship}}` thì không. */
export function parsePlaceholders(answer: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of answer.matchAll(PLACEHOLDER_RE)) {
    const k = foldVi(m[1]);
    const kind: Placeholder["kind"] = k === "gia" ? "price" : k === "ton" ? "stock" : "ship";
    out.push({ raw: m[0], kind, sku: (m[2] ?? "").trim() });
  }
  return out;
}

/** Thay chỗ trống bằng giá trị ĐÃ ĐỌC từ ERP. Thiếu một giá trị ⇒ `null` (không gửi câu mẫu nửa vời). HÀM THUẦN. */
export function fillPlaceholders(answer: string, values: ReadonlyMap<string, string | null>): string | null {
  let out = answer;
  for (const p of parsePlaceholders(answer)) {
    const v = values.get(p.raw);
    if (v === null || v === undefined) return null;
    out = out.split(p.raw).join(v);
  }
  return out;
}

export type QuickReplyDraft = { title: string; triggers: string[]; answer: string };

/**
 * Đọc gợi ý câu mẫu AI trả về (mảng JSON `[{title, triggers, answer}]`, có thể bọc trong ```json``` hay chữ thừa). Hỏng ⇒ `[]`
 * (lượt học vẫn xong — sổ tay không phụ thuộc phần này). HÀM THUẦN.
 */
export function parseLearnedQuickReplies(text: string): QuickReplyDraft[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
      .map((x) => ({
        title: typeof x.title === "string" ? x.title : "",
        triggers: Array.isArray(x.triggers) ? x.triggers.filter((t): t is string => typeof t === "string") : [],
        answer: typeof x.answer === "string" ? x.answer : "",
      }))
      .filter((x) => x.title && x.triggers.length && x.answer);
  } catch {
    return [];
  }
}

/** Làm sạch + kiểm một câu mẫu do người nhập. Lỗi ⇒ câu tiếng Việt nói rõ sửa gì. */
export function validateQuickReply(input: { title: unknown; triggers: unknown; answer: unknown }): { ok: true; value: QuickReplyDraft } | { ok: false; error: string } {
  const title = String(input.title ?? "").trim().slice(0, QUICK_REPLY_LIMITS.titleChars);
  const rawTriggers = Array.isArray(input.triggers) ? input.triggers : String(input.triggers ?? "").split(/\r?\n/);
  const seen = new Set<string>();
  const triggers: string[] = [];
  for (const t of rawTriggers) {
    const v = String(t ?? "").trim().slice(0, QUICK_REPLY_LIMITS.triggerChars);
    const k = foldVi(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    triggers.push(v);
  }
  const answer = String(input.answer ?? "").trim();
  if (!title) return { ok: false, error: "Thiếu tên câu hỏi." };
  if (triggers.length === 0) return { ok: false, error: "Thêm ít nhất một câu khách hay hỏi (mỗi dòng một câu)." };
  if (triggers.length > QUICK_REPLY_LIMITS.triggers) return { ok: false, error: `Tối đa ${QUICK_REPLY_LIMITS.triggers} câu khách hay hỏi.` };
  if (!answer) return { ok: false, error: "Thiếu câu trả lời." };
  if (answer.length > QUICK_REPLY_LIMITS.answerChars) return { ok: false, error: `Câu trả lời tối đa ${QUICK_REPLY_LIMITS.answerChars} ký tự.` };
  for (const p of parsePlaceholders(answer)) if (p.kind !== "ship" && !p.sku) return { ok: false, error: `Chỗ trống ${p.raw} thiếu mã SKU — viết dạng {{giá:SKU}}.` };
  // Giá gõ thẳng sẽ sai ngay khi shop đổi giá — bắt buộc đi qua chỗ trống (đọc ERP lúc gửi).
  const bare = answer.replace(PLACEHOLDER_RE, " ");
  if (stripPrices(bare).removed > 0) return { ok: false, error: "Không gõ giá / phí ship trực tiếp — dùng {{giá:SKU}} hoặc {{ship}} để bot đọc số từ ERP lúc gửi." };
  return { ok: true, value: { title, triggers, answer } };
}
