/**
 * ═══════════ TÌM KIẾM HỘP THƯ — PHẦN THUẦN, DÙNG ĐƯỢC Ở TRÌNH DUYỆT (P0 inbox-search, chủ shop 11/10/2026) ═══════════
 *
 * Câu tìm dựng ở MÁY CHỦ (`inbox-search.ts`); tệp này chỉ giữ ba thứ trình duyệt cũng cần:
 *  · `foldSearchText` — bỏ dấu + bỏ khoảng trắng / dấu câu: «Hoa Mai» ⇄ «HoaMai», «Ánh» ⇄ «anh». CÙNG luật với
 *    `foldSql` bên máy chủ (bài kiểm chạy cả hai trên cùng chuỗi).
 *  · `inboxListKey` — danh tính của MỘT danh sách (mọi bộ lọc + ô tìm, trừ hội thoại đang mở và số hàng). Đổi khoá ⇒ danh sách
 *    MỚI: hàng đang mở của danh sách cũ KHÔNG được mang sang (trước đây `keepActiveInPlace` chèn nó vào kết quả tìm mới).
 *  · `inboxEmptyHint` — bộ lọc đang chọn rỗng mà «Tất cả» (cùng ô tìm, cùng page / bộ lọc nâng cao) có ⇒ một câu gợi ý.
 *
 * ═══ Ô TÌM = TÌM TOÀN HỘP THƯ (P0 inbox-search-global, chủ shop 12/10/2026) ═══
 * Ca thật: URL đang `f=UNREAD`, gõ một SĐT ⇒ chỉ tìm trong «Tin khách chưa đọc», khách đã đọc / đã xử lý biến mất ⇒ ô tìm «trông như
 * hỏng». Luật: ô tìm CÓ chữ ⇒ tìm qua MỌI trạng thái, không ngầm giữ thẻ lọc / AI-người / người phụ trách / page / kênh / nhãn / …,
 * trừ khi người dùng CHỌN tường minh «Chỉ tìm trong bộ lọc hiện tại» (`pv=loc`). Bộ lọc vẫn nằm nguyên trong URL trong lúc tìm —
 * xoá ô tìm là về ĐÚNG bộ lọc trước đó. Mọi quyết định «áp bộ lọc nào» đi qua MỘT hàm: `inboxQueryState`.
 */
import { boDau } from "@/lib/constants/return-reason";
import { INBOX_CHANNEL_LABEL, INBOX_FILTER_LABEL, INBOX_HANDLER_LABEL, inboxHref, type InboxFilter, type InboxFilterState } from "@/lib/sales-chatbot/inbox-shared";

/** Gõ xong chừng này mili giây mới tự tìm (Enter / nút «Tìm» thì tìm ngay). */
export const INBOX_SEARCH_DEBOUNCE_MS = 300;
/** Tự tìm khi gõ chỉ từ chừng này ký tự (ô một ký tự quét gần cả hộp thư); Enter vẫn tìm mọi độ dài, xoá ô thì tìm lại ngay. */
export const INBOX_LIVE_SEARCH_MIN = 2;

/** Ô tìm như sẽ vào URL: cắt hai đầu, tối đa 80 ký tự (đúng giới hạn `page.tsx` đọc). HÀM THUẦN. */
export function normalizeInboxQuery(q: string | null | undefined): string {
  return (q ?? "").trim().slice(0, 80);
}

/** Có tự tìm chuỗi đang gõ không (gõ-là-tìm): rỗng (xoá ô) hoặc đủ `INBOX_LIVE_SEARCH_MIN` ký tự. HÀM THUẦN. */
export function shouldLiveSearch(text: string): boolean {
  const q = normalizeInboxQuery(text);
  return q.length === 0 || q.length >= INBOX_LIVE_SEARCH_MIN;
}

/** Có bộ lọc nào (thẻ trạng thái hoặc bộ lọc nâng cao) đang nằm trong URL không — kể cả khi ô tìm đang tạm bỏ qua chúng. HÀM THUẦN. */
export function inboxHasFilters(s: InboxFilterState): boolean {
  return s.filter !== "ALL" || [s.page, s.channel, s.handler, s.assignee, s.phone, s.level, s.period, s.from, s.to, s.label].some(Boolean);
}

/**
 * Chế độ của ô tìm: `NONE` = không tìm (bộ lọc áp như thường) · `GLOBAL` = tìm toàn hộp thư (mặc định — bộ lọc trong URL tạm KHÔNG
 * áp) · `FILTERED` = người dùng đã chọn «Chỉ tìm trong bộ lọc hiện tại» VÀ có bộ lọc để tìm trong. HÀM THUẦN.
 */
export type InboxSearchMode = "NONE" | "GLOBAL" | "FILTERED";
export function inboxSearchMode(s: InboxFilterState): InboxSearchMode {
  if (!normalizeInboxQuery(s.q)) return "NONE";
  return s.searchScope === "FILTER" && inboxHasFilters(s) ? "FILTERED" : "GLOBAL";
}

/**
 * Bộ lọc THẬT SỰ áp cho danh sách + bộ đếm — MỘT chỗ quyết. Đang tìm toàn hộp thư ⇒ bỏ MỌI bộ lọc (thẻ trạng thái, page, kênh,
 * AI / người, người phụ trách, SĐT, level, thời gian, nhãn); còn lại ⇒ đúng trạng thái URL. Hội thoại đang mở + số hàng giữ nguyên.
 * HÀM THUẦN.
 */
export function inboxQueryState(s: InboxFilterState): InboxFilterState {
  if (inboxSearchMode(s) !== "GLOBAL") return s;
  return { ...s, filter: "ALL", page: null, channel: null, handler: null, assignee: null, phone: null, level: null, period: null, from: null, to: null, label: null };
}

/** Tham số `listInbox` của trang hộp thư — dựng từ `inboxQueryState`, để trang và bài kiểm đi CÙNG một đường. HÀM THUẦN. */
export function inboxListQuery(s: InboxFilterState) {
  const e = inboxQueryState(s);
  return { filter: e.filter, channel: e.channel, q: e.q, label: e.label, page: e.page, phone: e.phone, level: e.level, assignee: e.assignee, period: e.period, from: e.from, to: e.to, limit: e.limit, handler: e.handler };
}

/**
 * Tên các bộ lọc đang nằm trong URL — để nói «đang tạm bỏ qua …» (tìm toàn hộp thư) hoặc «đang tìm trong …» (trong bộ lọc). HÀM THUẦN.
 */
export function inboxFilterLabels(s: InboxFilterState, pageNames: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  if (s.filter !== "ALL") out.push(INBOX_FILTER_LABEL[s.filter]);
  if (s.page) out.push(`Page ${pageNames[s.page] ?? s.page}`);
  if (s.channel) out.push(`Kênh ${INBOX_CHANNEL_LABEL[s.channel]}`);
  if (s.handler) out.push(INBOX_HANDLER_LABEL[s.handler]);
  if (s.assignee) out.push(s.assignee === "none" ? "Chưa ai nhận" : "Nhân viên phụ trách");
  if (s.phone) out.push(s.phone === "HAS" ? "Có SĐT" : "Chưa có SĐT");
  if (s.level) out.push("Level khách");
  if (s.period || s.from || s.to) out.push("Thời gian tin cuối");
  if (s.label) out.push("Nhãn");
  return out;
}

/**
 * Đường dẫn khi ô tìm đổi thành `q` (gõ — sau debounce, Enter, nút «Tìm», nút xoá). Ô tìm có chữ ⇒ GIỮ bộ lọc trong URL nhưng mặc định
 * tìm toàn hộp thư; phạm vi «trong bộ lọc» chỉ giữ khi người dùng ĐÃ chọn nó cho lần tìm đang chạy. Ô tìm rỗng ⇒ bỏ `q` + `pv` ⇒ về
 * ĐÚNG bộ lọc trước đó. Hội thoại đang mở (URL sống) đi theo; danh sách tự bỏ nó nếu nó không nằm trong kết quả
 * (`dropSelectionOnSearch`). Về đầu danh sách (`n`). HÀM THUẦN.
 */
export function inboxSearchHref(s: InboxFilterState, q: string, liveSelected: string | null): string {
  const nq = normalizeInboxQuery(q);
  const keepScope = Boolean(normalizeInboxQuery(s.q)) && s.searchScope === "FILTER";
  return inboxHref(s, { q: nq || null, pv: nq && keepScope ? "loc" : null, c: liveSelected, n: null });
}

/** Đổi phạm vi của lần tìm đang chạy: «Chỉ tìm trong bộ lọc hiện tại» (`FILTER`) ⇄ «Tìm toàn hộp thư» (`GLOBAL`). HÀM THUẦN. */
export function inboxScopeHref(s: InboxFilterState, scope: "GLOBAL" | "FILTER", liveSelected: string | null): string {
  return inboxHref(s, { pv: scope === "FILTER" ? "loc" : null, c: liveSelected, n: null });
}

/**
 * Bấm một thẻ nhanh. Không tìm ⇒ như cũ (bấm lại thẻ đang bật ⇒ «Tất cả»). Đang tìm toàn hộp thư ⇒ bấm thẻ là CHỌN TƯỜNG MINH lọc
 * kết quả tìm theo thẻ đó (`pv=loc`), không phải bật lại một bộ lọc ngầm. HÀM THUẦN.
 */
export function inboxChipHref(s: InboxFilterState, f: InboxFilter): string {
  const mode = inboxSearchMode(s);
  if (mode === "GLOBAL") return inboxHref(s, { f, pv: "loc", c: null, n: null });
  return inboxHref(s, { f: f === s.filter ? null : f, c: null, n: null });
}

/** Thẻ nhanh nào đang BẬT trên màn hình — đang tìm toàn hộp thư thì không thẻ nào (thẻ trong URL đang tạm không áp). HÀM THUẦN. */
export function inboxActiveChip(s: InboxFilterState): InboxFilter {
  return inboxQueryState(s).filter;
}

/**
 * Giữ hội thoại đang mở CHỈ khi nó nằm trong kết quả tìm: đang tìm, có hội thoại mở, nó không có trong danh sách đang vẽ, và danh
 * sách đã chứa ĐỦ mọi kết quả (`rows.length >= total` — quá trang đầu thì không biết nó có ở trang sau không ⇒ không bỏ, chỉ báo).
 * HÀM THUẦN.
 */
export function dropSelectionOnSearch(q: string, activeId: string | null, rows: readonly { id: string }[], total: number): boolean {
  if (!normalizeInboxQuery(q) || !activeId) return false;
  if (rows.some((r) => r.id === activeId)) return false;
  return rows.length >= total;
}

/** Bỏ dấu tiếng Việt, hạ chữ, bỏ MỌI ký tự không phải chữ / số. HÀM THUẦN. */
export function foldSearchText(s: string | null | undefined): string {
  return boDau(s ?? "").replace(/[^a-z0-9]/g, "");
}

/** Danh tính danh sách: đổi bất kỳ bộ lọc / ô tìm nào là một danh sách khác. Hội thoại đang mở + số hàng («Xem thêm») KHÔNG tính. */
export function inboxListKey(s: InboxFilterState): string {
  // Theo bộ lọc THẬT SỰ áp (`inboxQueryState`): tìm toàn hộp thư từ «Chưa đọc» hay từ «Tất cả» là CÙNG một danh sách.
  const e = inboxQueryState(s);
  return JSON.stringify([e.filter, e.q.trim(), e.page, e.channel, e.handler, e.assignee, e.phone, e.level, e.period, e.from, e.to, e.label]);
}

/**
 * Bản danh sách đã hiện lần trước — CHỈ khi nó thuộc cùng danh sách (`inboxListKey`). Khác khoá ⇒ `null`: `keepActiveInPlace` không
 * có bản trước nên không giữ (không chèn) hội thoại đang mở của danh sách cũ vào danh sách mới. HÀM THUẦN.
 */
export function shownForList<T>(shown: { key: string; rows: T[] } | null, key: string): T[] | null {
  return shown && shown.key === key ? shown.rows : null;
}

/**
 * Gợi ý khi bộ lọc đang chọn KHÔNG có hội thoại nào mà «Tất cả» có: «Tin khách chưa đọc» rỗng là ĐÚNG luật (tin cuối là của AI /
 * page) nhưng người tìm SĐT không biết vì sao không ra. Số lấy từ CÙNG câu đếm của trang (`counts.ALL` — cùng ô tìm, cùng phạm vi
 * page / tổ chức), không phải một câu thứ hai. `null` ⇒ không gợi ý. HÀM THUẦN.
 */
export function inboxEmptyHint(filter: InboxFilter, counts: Record<InboxFilter, number>, q: string): { count: number; text: string } | null {
  if (filter === "ALL") return null;
  if ((counts[filter] ?? 0) > 0) return null;
  const all = counts.ALL ?? 0;
  if (all <= 0) return null;
  return { count: all, text: q.trim() ? `Có ${all} hội thoại khớp «${q.trim()}» ở «Tất cả»` : `Có ${all} hội thoại ở «Tất cả»` };
}

/** Hội thoại đang mở KHÔNG nằm trong danh sách đang hiện (đổi ô tìm / bộ lọc, hoặc mở bằng đường dẫn). HÀM THUẦN. */
export function activeOutsideList(activeId: string | null, rows: readonly { id: string }[]): boolean {
  return Boolean(activeId) && !rows.some((r) => r.id === activeId);
}
