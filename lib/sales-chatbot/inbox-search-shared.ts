/**
 * ═══════════ TÌM KIẾM HỘP THƯ — PHẦN THUẦN, DÙNG ĐƯỢC Ở TRÌNH DUYỆT (P0 inbox-search, chủ shop 11/10/2026) ═══════════
 *
 * Câu tìm dựng ở MÁY CHỦ (`inbox-search.ts`); tệp này chỉ giữ ba thứ trình duyệt cũng cần:
 *  · `foldSearchText` — bỏ dấu + bỏ khoảng trắng / dấu câu: «Hoa Mai» ⇄ «HoaMai», «Ánh» ⇄ «anh». CÙNG luật với
 *    `foldSql` bên máy chủ (bài kiểm chạy cả hai trên cùng chuỗi).
 *  · `inboxListKey` — danh tính của MỘT danh sách (mọi bộ lọc + ô tìm, trừ hội thoại đang mở và số hàng). Đổi khoá ⇒ danh sách
 *    MỚI: hàng đang mở của danh sách cũ KHÔNG được mang sang (trước đây `keepActiveInPlace` chèn nó vào kết quả tìm mới).
 *  · `inboxEmptyHint` — bộ lọc đang chọn rỗng mà «Tất cả» (cùng ô tìm, cùng page / bộ lọc nâng cao) có ⇒ một câu gợi ý.
 */
import { boDau } from "@/lib/constants/return-reason";
import type { InboxFilter, InboxFilterState } from "@/lib/sales-chatbot/inbox-shared";

/** Bỏ dấu tiếng Việt, hạ chữ, bỏ MỌI ký tự không phải chữ / số. HÀM THUẦN. */
export function foldSearchText(s: string | null | undefined): string {
  return boDau(s ?? "").replace(/[^a-z0-9]/g, "");
}

/** Danh tính danh sách: đổi bất kỳ bộ lọc / ô tìm nào là một danh sách khác. Hội thoại đang mở + số hàng («Xem thêm») KHÔNG tính. */
export function inboxListKey(s: InboxFilterState): string {
  return JSON.stringify([s.filter, s.q.trim(), s.page, s.channel, s.handler, s.assignee, s.phone, s.level, s.period, s.from, s.to, s.label]);
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
