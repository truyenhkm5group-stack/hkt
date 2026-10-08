/**
 * ═══════════ «HỌC TỪ HỘI THOẠI CŨ» — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Chủ nền tảng duyệt 01/10/2026: chatbot bán hàng học CÁCH CHAT của shop từ lịch sử tin nhắn fanpage (qua Pancake). Không
 * huấn luyện lại mô hình, không nạp nguyên văn: lịch sử được LÀM SẠCH (mọi chữ số ⇒ «[số]» — giá cũ, SĐT, số nhà, mã đơn
 * đều mất; tên khách ⇒ «[khách]»; link / email bị che) rồi AI chắt thành MỘT «Sổ tay bán hàng» nháp. Chủ shop đọc, sửa,
 * xuất bản; bot dùng bản ĐÃ XUẤT BẢN trong lời nhắc — luật «giá / tồn chỉ từ công cụ ERP» vẫn đứng trên sổ tay. Tin nhắn
 * gốc KHÔNG được lưu; chỉ sổ tay (nháp + các bản đã xuất bản) nằm trong `settings` của tổ chức.
 */

export const PLAYBOOK_SETTING_KEY = "ai.salesChatbot.playbook";
export const PLAYBOOK_RUN_SETTING_KEY = "ai.salesChatbot.playbookRun";

/** Trần kỹ thuật (không phải ngưỡng nghiệp vụ): chặn một lượt đọc quá lâu / quá tốn và một sổ tay quá dài cho lời nhắc. */
export const PLAYBOOK_LIMITS = {
  conversationChoices: [50, 100, 200, 500] as const,
  dayChoices: [30, 90, 180] as const,
  messageChars: 400,
  conversationChars: 3000,
  batchChars: 24_000,
  playbookChars: 6000,
  keepVersions: 5,
  runStaleMinutes: 30,
} as const;

export type PlaybookVersion = { version: number; text: string; publishedAt: string; publishedBy: string | null };
/** `quickReplies` = số câu trả lời mẫu AI gợi ý ở lượt này (0183; lượt cũ không có trường này). */
/** `closed` = hội thoại khách đã để lại SĐT; `skipped` = hội thoại Pancake không trả được sau khi thử lại (02/10/2026; lượt cũ không có). */
export type PlaybookStats = { conversations: number; messages: number; aiCalls: number; costUsd: number | null; pricesRemoved: number; quickReplies?: number; closed?: number; skipped?: number };
export type PlaybookState = {
  draft: { text: string; createdAt: string; createdBy: string | null; stats: PlaybookStats | null } | null;
  published: PlaybookVersion | null;
  history: PlaybookVersion[];
};
export const EMPTY_PLAYBOOK: PlaybookState = { draft: null, published: null, history: [] };

export type PlaybookRun =
  | { state: "IDLE" }
  | { state: "RUNNING"; startedAt: string; startedBy: string | null; target: number; days: number; fetched: number; note: string }
  | { state: "DONE"; startedAt: string; finishedAt: string; stats: PlaybookStats }
  | { state: "FAILED"; startedAt: string; finishedAt: string; error: string };

export function parsePlaybookState(raw: unknown): PlaybookState {
  if (!raw || typeof raw !== "object") return EMPTY_PLAYBOOK;
  const r = raw as Partial<PlaybookState>;
  return { draft: r.draft ?? null, published: r.published ?? null, history: Array.isArray(r.history) ? r.history.slice(0, PLAYBOOK_LIMITS.keepVersions) : [] };
}

export function parsePlaybookRun(raw: unknown): PlaybookRun {
  if (!raw || typeof raw !== "object" || typeof (raw as { state?: unknown }).state !== "string") return { state: "IDLE" };
  return raw as PlaybookRun;
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Đuôi tên miền mà dấu chấm viết RỜI vẫn bị gộp lại («xyz . com», «xyz .com») hay viết thành chữ («xyz dot com», «xyz chấm com»).
 * Chỉ các đuôi này: dạng rời mà nhận mọi đuôi thì «ok . em» thành tên miền (review bảo mật #656). Tên miền viết DÍNH thì đuôi là
 * dạng CHUNG (`DOMAIN_RE`). Dấu cách chỉ đứng SAU dấu chấm («xyz. com») KHÔNG gộp — đó đúng là hình một chỗ ngắt câu («vâng. Shop»).
 */
export const SPACED_DOT_TLDS = "com|vn|net|org|info|xyz|click|shop|site|online|store|me|io|cc|co|live|link|top|app|asia|biz|pro|club|vip|tk|ly|gg|ws";

/**
 * Chữ «ĐÃ GỠ CHE» để dò liên kết: NFKC («＠» ⇒ «@», «．» ⇒ «.»), dấu chấm Đông Á / chấm giữa («。» «｡» «·» «・» «‧» «∙» «⋅» «•») ⇒
 * «.», «[.]» / «(.)» ⇒ «.», dấu cách TRƯỚC dấu chấm của một đuôi quen ⇒ gộp, và XOÁ ký tự định dạng (zero-width · bidi) chen giữa
 * từ — «chuy‹ký tự vô hình›ển» thành «chuyển» (review bảo mật #654 · #656). Xoá thì hai từ có thể dính nhau («chuyển‹vô hình›khoản» ⇒
 * «chuyểnkhoản») — bộ lọc bài học vì thế nhận cả cụm viết DÍNH (`RISKY_FOLDED`). HÀM THUẦN.
 */
export function unmaskLinkText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[。｡·・‧∙⋅•]/g, ".")
    .replace(/\s*[[(]\s*\.\s*[\])]\s*/g, ".")
    .replace(new RegExp(`([\\p{L}\\p{N}])\\s+\\.\\s*(${SPACED_DOT_TLDS})(?![\\p{L}\\p{N}])`, "giu"), "$1.$2");
}

/** Nhãn hành chính viết tắt trước dấu chấm («TP.HCM», «TX.Sơn Tây», «TT.Đông Anh») — KHÔNG phải tên miền. */
const ADMIN_LABELS = new Set(["tp", "tx", "tt"]);

/**
 * Tên miền dạng CHUNG — đuôi 2–24 chữ cái — không dựa vào danh sách đuôi: đuôi mới / rẻ (.click · .live · .cc …) lọt mọi danh
 * sách (review bảo mật #654, MEDIUM). Nhãn nhận CHỮ CÓ DẤU: tên miền tiếng Việt đăng ký được («thanhtoán.vn» — review #656). Nhãn
 * hành chính («TP.HCM») không tính; nhãn 1 ký tự chỉ tính khi có đường dẫn theo sau («t.me/abc», kể cả «t.co /abc») hoặc là một
 * trang rút gọn quen (`ONE_CHAR_HOSTS`) — không thì là viết tắt địa chỉ («P.Cổ Nhuế», «H.Mê Linh», «Q.1»).
 * Nhóm 1 là ký tự đứng TRƯỚC (hoặc đầu chuỗi) thay cho nhìn-ngược: tệp này tới cả trình duyệt (khung Bài học nạp `riskyLesson`), và
 * Safari < 16.4 không dịch được nhìn-ngược — cả khối mã của trang sẽ hỏng.
 */
const DOMAIN_RE = /(^|[^\p{L}\p{N}_-])([\p{L}\p{N}-]+)((?:\.[\p{L}\p{N}-]{2,})*)\.([a-z]{2,24})(?![\p{L}\p{N}_-])/giu;
/** Trang rút gọn / nhắn tin mang nhãn MỘT ký tự — là tên miền dù không có đường dẫn theo sau. */
const ONE_CHAR_HOSTS = new Set(["t.co", "x.co", "g.co", "t.me", "m.me", "s.id", "j.mp", "t.ly", "v.gd", "u.to"]);

/** `after` = phần chữ ngay sau đuôi (đường dẫn, nếu có, bắt đầu bằng «/» — có thể cách một dấu cách). */
function isDomainMatch(first: string, middle: string, tld: string, after: string): boolean {
  if (middle) return true;
  const label = first.toLowerCase();
  if (ADMIN_LABELS.has(label)) return false;
  return label.length >= 2 || /^\s*\//.test(after) || ONE_CHAR_HOSTS.has(`${label}.${tld.toLowerCase()}`);
}

/** Các tên miền trần trong một chữ (đã gỡ che). HÀM THUẦN. */
export function findBareDomains(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DOMAIN_RE)) if (isDomainMatch(m[2], m[3], m[4], text.slice((m.index ?? 0) + m[0].length))) out.push(m[0].slice(m[1].length));
  return out;
}

/**
 * Handle «@tên» ở BẤT CỨ đâu — kể cả sau dấu câu và dính sau chữ («zalo@shop», «IG@shop» — review bảo mật #654 · #656). Email đã
 * che trước bước này (tin khách) hay đã là tên miền (bài học), nên «@» còn lại chỉ có thể là một tài khoản.
 */
export const HANDLE_RE = /@[\p{L}\p{N}_.]{3,}/u;

/**
 * Làm sạch MỘT tin trước khi đưa cho AI. Mọi CHỮ SỐ ⇒ «[số]» (chặn giá cũ, SĐT, số nhà, mã đơn, số tài khoản — kể cả
 * cách viết «299k», «1tr5»); tên khách đã biết ⇒ «[khách]»; link / email ⇒ «[link]» / «[email]». HÀM THUẦN.
 */
export function redactForLearning(text: string, names: readonly string[] = []): string {
  let t = unmaskLinkText(stripHtml(String(text ?? "")));
  t = t.replace(/https?:\/\/\S+|www\.\S+/gi, "[link]");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
  // Tên miền TRẦN (thanhtoan-xyz.com/pay · t.me/abc) và handle @… cũng là liên kết — AI học không được thấy (review bảo mật #652).
  t = t.replace(new RegExp(`${DOMAIN_RE.source}(?:\\s*/[^\\s,;)»"']*)?`, "giu"), (m: string, pre: string, first: string, middle: string, tld: string) => (isDomainMatch(first, middle, tld, m.slice(pre.length + first.length + middle.length + 1 + tld.length)) ? `${pre}[link]` : m));
  t = t.replace(new RegExp(HANDLE_RE.source, "gu"), "[link]");
  for (const n of names) {
    const name = n.trim();
    if (name.length >= 2) t = t.split(name).join("[khách]");
  }
  // Mọi hệ chữ số (`\p{Nd}`): NFKC không đổi chữ số Ả Rập / Thái / Devanagari… về 0–9 (review bảo mật #656).
  t = t.replace(/\p{Nd}(?:[\p{Nd}\s.,:/-]*\p{Nd})?/gu, "[số]");
  return t.replace(/\s+/g, " ").trim().slice(0, PLAYBOOK_LIMITS.messageChars);
}

/** SĐT Việt Nam trong tin GỐC (trước khi che số) — dấu hiệu khách đã chịu để lại thông tin, tức hội thoại đi tới chốt. */
const PHONE_IN_TEXT = /(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)/;

/**
 * Khách đã để lại SĐT trong hội thoại chưa (đọc trên tin GỐC, chỉ tin của KHÁCH). HÀM THUẦN. Đây là nhãn KẾT QUẢ để AI so
 * sánh cách shop nói ở hội thoại chốt được với hội thoại khách bỏ đi (02/10/2026: chủ shop muốn bot học «khôn hơn»).
 */
export function customerLeftPhone(messages: readonly { fromShop: boolean; text: string }[]): boolean {
  return messages.some((m) => !m.fromShop && PHONE_IN_TEXT.test(stripHtml(String(m.text ?? ""))));
}

export const CLOSED_TAG = "[KẾT QUẢ: khách ĐÃ để lại SĐT — chốt được]";
export const OPEN_TAG = "[KẾT QUẢ: khách CHƯA để lại SĐT]";

/**
 * Một hội thoại ⇒ bản chép «Khách: … / Shop: …» đã làm sạch, hoặc `null` khi không đáng học (thiếu một trong hai bên).
 * `closed` có giá trị ⇒ dòng đầu là nhãn kết quả (khách ĐÃ / CHƯA để lại SĐT).
 */
export function transcriptFor(messages: readonly { fromShop: boolean; text: string }[], names: readonly string[], opts: { closed?: boolean } = {}): string | null {
  const lines: string[] = [];
  let shop = 0;
  let customer = 0;
  for (const m of messages) {
    const t = redactForLearning(m.text, names);
    if (!t || t === "[số]") continue;
    if (m.fromShop) shop += 1;
    else customer += 1;
    lines.push(`${m.fromShop ? "Shop" : "Khách"}: ${t}`);
  }
  if (!shop || !customer || lines.length < 3) return null;
  if (opts.closed !== undefined) lines.unshift(opts.closed ? CLOSED_TAG : OPEN_TAG);
  return lines.join("\n").slice(0, PLAYBOOK_LIMITS.conversationChars);
}

/** Gom bản chép thành từng lô ≤ `batchChars` để mỗi lượt AI đọc một lô. HÀM THUẦN. */
export function batchTranscripts(transcripts: readonly string[], maxChars: number = PLAYBOOK_LIMITS.batchChars): string[] {
  const out: string[] = [];
  let cur = "";
  for (const t of transcripts) {
    const block = `--- HỘI THOẠI ---\n${t}`;
    if (cur && cur.length + block.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Lưới cuối trên CHÍNH văn bản AI viết ra: mọi con số dạng tiền («299.000», «299k», «1tr5», «300 nghìn», «299.000đ») ⇒
 * «[giá lấy từ ERP]». Sổ tay không bao giờ mang giá — giá chỉ từ công cụ ERP lúc chat. HÀM THUẦN.
 */
export function stripPrices(text: string): { text: string; removed: number } {
  let removed = 0;
  const re = /\d{1,3}(?:[.,]\d{3})+\s*(?:đ|₫|vnđ|vnd|đồng)?|\d+(?:[.,]\d+)?\s*(?:k|K|nghìn|ngàn|tr|triệu|củ|đ|₫|vnđ|vnd|đồng)(?![\p{L}])/gu;
  const out = text.replace(re, () => {
    removed += 1;
    return "[giá lấy từ ERP]";
  });
  return { text: out, removed };
}
