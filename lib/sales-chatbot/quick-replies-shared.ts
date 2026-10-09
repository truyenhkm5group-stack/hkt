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
  /** 09/10/2026: 80 ⇒ 300 — chủ shop HSLC muốn nạp liên tục câu mẫu để khách hỏi trúng câu có sẵn thì không tốn token. */
  entries: 300,
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
  learnedMax: 30,
  /** Một thao tác hàng loạt («Chọn tất cả») tối đa chừng này câu — bằng trần câu mẫu. */
  bulk: 300,
} as const;

/**
 * TỰ NẠP CÂU MẪU (09/10/2026): mỗi `everyMs`, gom câu khách hỏi trong `lookbackDays` ngày mà KHÔNG câu mẫu đang bật nào
 * khớp chữ (tức là mỗi câu đó đã tốn một lượt AI), rồi MỘT lời gọi AI soạn câu mẫu mới (TẮT, chờ người duyệt — trừ khi shop
 * bật «tự bật») và thêm cách hỏi mới vào câu mẫu đã có. Dưới `minQuestions` câu thì không gọi AI.
 */
export const QUICK_REPLY_AUTO_LEARN = {
  everyMs: 24 * 3_600_000,
  lookbackDays: 14,
  minQuestions: 5,
  /** Câu khách tối đa đưa vào lời gọi AI (đã gộp câu trùng). */
  maxQuestions: 150,
  /** Câu mẫu mới tối đa mỗi lượt. */
  maxNew: 12,
  /** Cách hỏi mới tối đa thêm vào MỘT câu mẫu đã có mỗi lượt. */
  maxExtendPerEntry: 5,
  /** Mẫu mã đưa vào lời gọi để AI viết `{{giá:SKU}}` đúng mã. */
  maxSkus: 80,
  /** Lượt RUNNING cũ hơn chừng này coi như đã chết (máy chủ khởi động lại giữa chừng). */
  staleMs: 15 * 60_000,
} as const;
export const QUICK_REPLY_AUTO_LEARN_RUN_KEY = "ai.salesChatbot.quickReplies.autoLearnRun";

/**
 * `upsellReplyId` = câu mẫu (kèm ảnh menu) bot gửi ở bước UPSELL / CROSS-SELL của quy trình bán — `null` khi chưa chọn.
 * `autoLearn` = tự nạp câu mẫu mỗi ngày (dùng AI, MẶC ĐỊNH TẮT). `autoActivate` = câu mẫu tự nạp được BẬT NGAY (mặc định
 * tắt: nằm chờ người duyệt); câu còn «[giá lấy từ ERP]» không bao giờ tự bật.
 */
export type QuickReplySettings = { enabled: boolean; aiMatch: boolean; upsellReplyId: string | null; autoLearn: boolean; autoActivate: boolean };
export const DEFAULT_QUICK_REPLY_SETTINGS: QuickReplySettings = { enabled: true, aiMatch: true, upsellReplyId: null, autoLearn: false, autoActivate: false };

export function parseQuickReplySettings(v: unknown): QuickReplySettings {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof QuickReplySettings, unknown>>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_QUICK_REPLY_SETTINGS.enabled,
    aiMatch: typeof o.aiMatch === "boolean" ? o.aiMatch : DEFAULT_QUICK_REPLY_SETTINGS.aiMatch,
    upsellReplyId: typeof o.upsellReplyId === "string" && o.upsellReplyId.trim() ? o.upsellReplyId.trim() : null,
    autoLearn: typeof o.autoLearn === "boolean" ? o.autoLearn : DEFAULT_QUICK_REPLY_SETTINGS.autoLearn,
    autoActivate: typeof o.autoActivate === "boolean" ? o.autoActivate : DEFAULT_QUICK_REPLY_SETTINGS.autoActivate,
  };
}

/** Kết quả lượt tự nạp gần nhất (màn hình quản lý in ra). */
export type QuickReplyAutoLearnRun = { at: string; status: "RUNNING" | "OK" | "SKIPPED" | "ERROR"; note: string; questions: number; added: number; extended: number };

export function parseAutoLearnRun(v: unknown): QuickReplyAutoLearnRun | null {
  const o = (v && typeof v === "object" ? v : null) as Partial<Record<keyof QuickReplyAutoLearnRun, unknown>> | null;
  if (!o || typeof o.at !== "string" || !["RUNNING", "OK", "SKIPPED", "ERROR"].includes(String(o.status))) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { at: o.at, status: o.status as QuickReplyAutoLearnRun["status"], note: typeof o.note === "string" ? o.note : "", questions: n(o.questions), added: n(o.added), extended: n(o.extended) };
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

/**
 * Xếp câu mẫu theo độ GẦN với tin khách (số từ chung với tên + cách hỏi, bỏ dấu) — để bước AI đọc hiểu nhận đúng các câu mẫu
 * đáng xét khi shop có nhiều hơn `limit` câu. Bằng điểm ⇒ giữ thứ tự vào (dùng nhiều trước). HÀM THUẦN.
 */
export function rankQuickReplies(text: string, entries: readonly QuickReplyEntry[], limit: number): QuickReplyEntry[] {
  if (entries.length <= limit) return [...entries];
  const words = new Set(foldVi(text).split(" ").filter((w) => w.length > 1));
  const scored = entries.map((e, i) => {
    const bag = new Set(foldVi([e.title, ...e.triggers].join(" ")).split(" "));
    let score = 0;
    for (const w of words) if (bag.has(w)) score += 1;
    return { e, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}

/** Từ đệm khách hay gõ — bỏ khi gộp câu trùng («giá chả cá ạ» = «giá chả cá shop ơi»). */
const FILLER = new Set(["a", "ad", "ak", "ah", "shop", "sop", "oi", "nhe", "nha", "vay", "the", "ha", "z", "e", "em", "chi", "anh", "ban", "minh", "ac", "nhi"]);

export type FrequentQuestion = { key: string; samples: string[]; threads: number };

/**
 * Câu khách hỏi mà KHÔNG câu mẫu nào khớp chữ — ứng viên cho câu mẫu mới. Bỏ câu đặt hàng (SĐT, «chốt»…), câu nhiều dòng,
 * câu có liên kết, câu một từ, câu quá dài; gộp câu trùng sau khi bỏ dấu + từ đệm; đếm số HỘI THOẠI khác nhau (một khách hỏi
 * năm lần vẫn là một). Xếp hỏi nhiều trước. HÀM THUẦN.
 */
export function mineUnansweredQuestions(rows: readonly { text: string; thread: string }[], entries: readonly QuickReplyEntry[], max: number): FrequentQuestion[] {
  const groups = new Map<string, { samples: string[]; threads: Set<string> }>();
  for (const r of rows) {
    const text = r.text.trim();
    if (!text || isMultiPart(text) || looksLikeOrdering(text) || /https?:\/\//i.test(text)) continue;
    const words = foldVi(text).split(" ").filter(Boolean);
    if (words.length < 2 || words.length > QUICK_REPLY_LIMITS.maxMessageWords) continue;
    if (matchQuickReplyByKeyword(text, entries).kind === "MATCH") continue;
    const key = words.filter((w) => !FILLER.has(w)).join(" ");
    if (!key.includes(" ")) continue;
    const g = groups.get(key) ?? { samples: [], threads: new Set<string>() };
    const sample = text.slice(0, QUICK_REPLY_LIMITS.triggerChars);
    if (g.samples.length < 3 && !g.samples.includes(sample)) g.samples.push(sample);
    g.threads.add(r.thread);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, samples: g.samples, threads: g.threads.size }))
    .sort((a, b) => b.threads - a.threads || a.key.localeCompare(b.key))
    .slice(0, max);
}

export type AutoLearnPlan = { added: QuickReplyDraft[]; extend: { id: string; triggers: string[] }[] };

/**
 * Đọc kết quả AI của lượt tự nạp: `{"new": [{title, triggers, answer}], "extend": [{"code": "Q3", "triggers": [...]}]}`.
 * `code` ⇒ mã câu mẫu thật qua `codes` (mã lạ bị bỏ). Hỏng ⇒ kế hoạch rỗng. HÀM THUẦN.
 */
export function parseAutoLearnPlan(text: string, codes: ReadonlyMap<string, string>): AutoLearnPlan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { added: [], extend: [] };
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const added = Array.isArray(o.new) ? parseLearnedQuickReplies(JSON.stringify(o.new)) : [];
    const extend: AutoLearnPlan["extend"] = [];
    for (const x of Array.isArray(o.extend) ? o.extend : []) {
      if (!x || typeof x !== "object") continue;
      const r = x as Record<string, unknown>;
      const id = codes.get(String(r.code ?? "").trim().toUpperCase());
      const triggers = Array.isArray(r.triggers) ? r.triggers.filter((t): t is string => typeof t === "string" && Boolean(t.trim())) : [];
      if (id && triggers.length) extend.push({ id, triggers });
    }
    return { added, extend };
  } catch {
    return { added: [], extend: [] };
  }
}

/**
 * Cách hỏi mới cho một câu mẫu ĐÃ CÓ: bỏ trùng (bỏ dấu), bỏ câu đặt hàng và câu hỏi SỈ (câu mẫu báo giá lẻ không được trả
 * lời câu sỉ), giữ trần `triggers` của câu mẫu và `maxNew` mỗi lượt. HÀM THUẦN.
 */
export function mergeTriggers(current: readonly string[], proposed: readonly string[], maxNew: number): string[] {
  const seen = new Set(current.map((t) => foldVi(t)));
  const out = [...current];
  let added = 0;
  for (const raw of proposed) {
    const t = raw.trim().slice(0, QUICK_REPLY_LIMITS.triggerChars);
    const k = foldVi(t);
    if (!k || seen.has(k) || looksLikeOrdering(t) || looksWholesale(t)) continue;
    if (out.length >= QUICK_REPLY_LIMITS.triggers || added >= maxNew) break;
    seen.add(k);
    out.push(t);
    added += 1;
  }
  return out;
}

/** Câu khách cho thấy đang ĐẶT HÀNG (SĐT, «chốt», «địa chỉ», «đồng ý»…) ⇒ câu mẫu đứng ngoài, AI chốt đơn bằng công cụ. */
export function looksLikeOrdering(text: string): boolean {
  if (/(?:\+?84|0)(?:[\s.-]?\d){8,10}/.test(text)) return true;
  const m = ` ${foldVi(text)} `;
  return [" chot ", " dat hang ", " len don ", " dia chi ", " sdt ", " so dien thoai ", " dong y ", " xac nhan ", " gui ve ", " giao ve ", " lay cho ", " lay em ", " lay 1 ", " lay 2 ", " lay 3 "].some((k) => m.includes(k));
}

/**
 * Khách nhắn NHIỀU tin liên tiếp (fanpage gom các tin của một lượt, mỗi tin một dòng) ⇒ một câu mẫu chỉ trả lời được một ý.
 * Đo 02/10/2026 (Hải Sản Làng Chài): «Chả cá thu giá sĩ bao nhiêu ạ» + «Mình ở đâu ạ» ⇒ câu mẫu báo giá LẺ, bỏ cả «sỉ» lẫn
 * câu hỏi địa chỉ. HÀM THUẦN.
 */
export function isMultiPart(text: string): boolean {
  return text.split(/\r?\n/).filter((l) => foldVi(l)).length >= 2;
}

/**
 * Khách hỏi SỈ / lấy về bán / đại lý / số lượng từ 10 kg trở lên — ERP chỉ có giá LẺ nên câu mẫu báo giá lẻ KHÔNG trả lời
 * được câu này (bước khớp chữ nhường cho AI đọc hiểu / chatbot đầy đủ). HÀM THUẦN.
 */
export function looksWholesale(text: string): boolean {
  const m = ` ${foldVi(text)} `;
  if (m.includes(" si ") && !m.includes(" bac si ")) return true;
  if ([" ban buon ", " gia buon ", " dai ly ", " ctv ", " cong tac vien ", " ve ban ", " ban lai ", " lam hang "].some((k) => m.includes(k))) return true;
  // «20-30 kg» bỏ dấu thành «20 30 kg»; «20kg» giữ liền.
  const q = /(?:^| )(\d+)(?: \d+)? ?(?:kg|ky|ki|can)(?= |$)/.exec(foldVi(text));
  return Boolean(q) && Number(q![1]) >= 10;
}

/** Chữ để so «câu này bot / shop vừa nói rồi»: bỏ tiền tố tin của page, bỏ dấu, gộp khoảng trắng. */
function sayKey(s: string): string {
  return foldVi(s.replace(/^\[Shop đã nhắn\]\s*/, ""));
}

/**
 * Câu sắp gửi TRÙNG một câu bot / page vừa nói ⇒ khách đang TRẢ LỜI câu đó, gửi lại là không đọc tin khách. Đo 02/10/2026:
 * «Anh/chị lấy bao nhiêu kg nhắn em báo giá tốt…» gửi HAI lần liền, lần hai ngay sau khi khách đáp «Em lấy lần 20-30 kg».
 * HÀM THUẦN.
 */
export function repeatsRecent(text: string, recent: readonly string[]): boolean {
  const k = sayKey(text);
  return Boolean(k) && recent.some((r) => sayKey(r) === k);
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
