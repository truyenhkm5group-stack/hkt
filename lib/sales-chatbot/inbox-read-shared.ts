/**
 * ═══════════ VÁ DANH SÁCH THEO XÁC NHẬN ĐỌC (P0.4 · P0.7 — chủ shop 10/10/2026 tối) — HÀM THUẦN, DÙNG Ở TRÌNH DUYỆT ═══════════
 *
 * Đo production 7af2bca4 (lọc «Chưa đọc»): mở A ⇒ A hiện đã đọc; chuyển sang B ⇒ 0,8 s sau A QUAY LẠI vị trí 0 với «1 chưa đọc», ~3,3 s
 * mới biến mất. Nguyên nhân: trạng thái «đã đọc» trên trình duyệt chỉ là một lớp phủ cho hàng ĐANG MỞ (`keepActiveInPlace` + ép
 * `unread: false`); rời A là lớp phủ mất, còn bản danh sách đang hiện là bản máy chủ dựng TRƯỚC lượt ghi (hoặc lượt làm mới đang bay
 * dở) — nó nói A chưa đọc, và trình duyệt tin nó cho tới khi một lượt `router.refresh` (1,5 s chờ + dựng lại cả trang) về tới.
 *
 * Nay trình duyệt giữ XÁC NHẬN của từng lượt đọc (máy chủ trả từ `POST /api/ai-sales/inbox-read`) và chỉ cho dữ liệu máy chủ đè lên
 * khi nó MỚI HƠN lượt đọc:
 *  · HÀNG: máy chủ gửi kèm con trỏ đọc nó đã dùng (`readCursorAt`). Con trỏ đó cũ hơn mốc đã xác nhận ⇒ bản cũ ⇒ vá: đã đọc, trừ khi
 *    chính bản ấy có tin khách MỚI HƠN mốc đọc (`newestCustomerAt`) — khi đó hàng vẫn chưa đọc (tin tới sau lúc đọc).
 *  · THẺ «Tin khách chưa đọc»: câu đếm của máy chủ mang dấu `max(updated_at)` con trỏ của người xem (CÙNG câu SQL ⇒ cùng ảnh chụp).
 *    Xác nhận có `stamp` mới hơn dấu đó ⇒ bản đếm chưa thấy lượt đọc ⇒ trừ 1 cho mỗi hội thoại vừa chuyển từ chưa đọc sang đã đọc.
 *  · THÀNH VIÊN: ở thẻ «Tin khách chưa đọc», hàng đã đọc rời danh sách NGAY khi không còn đang mở; ở thẻ khác, hàng vừa đọc về NHÓM ĐÃ
 *    ĐỌC đúng chỗ của nó (tin mới nhất trước) — đúng thứ tự máy chủ sẽ trả ở lượt sau.
 * Lượt làm mới nền (5 giây) vẫn chạy và là ĐỐI SOÁT: bản mới hơn lượt đọc thì máy chủ thắng, kể cả khi nó nói «chưa đọc».
 */
import { keepActiveInPlace, type InboxFilter, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";

/** Xác nhận của MỘT lượt đánh dấu đọc (máy chủ trả). Mốc là ISO (mili giây). */
export type InboxReadConfirmation = {
  conversationId: string;
  /** Con trỏ đọc của người này SAU lượt ghi (mốc tin khách đã đọc tới) — `null` nếu không đọc được. */
  throughAt: string | null;
  /** Số tin khách chưa đọc của người này ngay trước / ngay sau lượt ghi. */
  unreadBefore: number;
  unreadAfter: number;
  /** `sales_chat_reads.updated_at` sau lượt ghi — so với dấu của bản đếm. */
  stamp: string | null;
};

/** Gộp xác nhận mới vào xác nhận cũ của cùng hội thoại: giữ con trỏ / dấu MỚI hơn; «trước đó chưa đọc» không mất khi đọc lại lần hai. */
export function mergeReadConfirmation(prev: InboxReadConfirmation | undefined, next: InboxReadConfirmation): InboxReadConfirmation {
  if (!prev) return next;
  const newer = (next.stamp ?? "") >= (prev.stamp ?? "") ? next : prev;
  return { ...newer, throughAt: maxIso(prev.throughAt, next.throughAt), unreadBefore: Math.max(prev.unreadBefore, next.unreadBefore) };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Bản hàng máy chủ dựng TRƯỚC lượt đọc đã xác nhận (con trỏ của bản hàng cũ hơn con trỏ đã xác nhận)? */
export function rowBehindRead(r: Pick<InboxRow, "readCursorAt">, c: InboxReadConfirmation | undefined): boolean {
  if (!c?.throughAt) return false;
  return !r.readCursorAt || r.readCursorAt < c.throughAt;
}

/** Hàng ở trạng thái ĐÃ ĐỌC: bỏ huy hiệu, xem trước quay về tin mới nhất (mọi phía). */
export function asReadRow(r: InboxRow): InboxRow {
  if (!r.unread && r.unreadCount === 0) return r;
  return { ...r, unread: false, unreadCount: 0, preview: r.latestPreview, previewSide: r.latestSide, previewAt: r.latestAt, afterPreview: null };
}

/** Vá MỘT hàng theo xác nhận đọc: bản cũ hơn lượt đọc mà không có tin khách nào mới hơn mốc đọc ⇒ đã đọc. Còn lại: máy chủ thắng. */
export function patchRowWithRead(r: InboxRow, c: InboxReadConfirmation | undefined): InboxRow {
  if (!c || !rowBehindRead(r, c) || !r.unread) return r;
  const newerCustomer = r.newestCustomerAt !== null && c.throughAt !== null && r.newestCustomerAt > c.throughAt;
  return newerCustomer ? r : asReadRow(r);
}

/** Khoá xếp của nhóm đã đọc — ĐÚNG `inboxOrderBy` (tin có nghĩa mới nhất trước, rồi mã giảm dần). */
function readOrderBefore(a: InboxRow, b: InboxRow): boolean {
  return a.lastActivityAt > b.lastActivityAt || (a.lastActivityAt === b.lastActivityAt && a.id > b.id);
}

/**
 * Danh sách sẽ VẼ: bản máy chủ → vá theo xác nhận đọc → thành viên của thẻ → hàng đang mở đứng yên (`keepActiveInPlace`) và hiện
 * đã đọc ngay. `prevShown` = bản đã vẽ lần trước. HÀM THUẦN.
 */
export function inboxDisplayRows(serverRows: readonly InboxRow[], prevShown: readonly InboxRow[] | null, opts: { activeId: string | null; filter: InboxFilter; reads: ReadonlyMap<string, InboxReadConfirmation> }): InboxRow[] {
  const { activeId, filter, reads } = opts;
  let rows: InboxRow[] = [];
  const moved: InboxRow[] = [];
  for (const r of serverRows) {
    const p = patchRowWithRead(r, reads.get(r.id));
    if (p !== r && r.id !== activeId && filter !== "UNANSWERED") moved.push(p);
    else rows.push(p);
  }
  if (filter === "UNREAD") rows = rows.filter((r) => r.unread || r.id === activeId);
  else {
    // Hàng vừa thành đã đọc (bản máy chủ còn xếp nó trong nhóm chưa đọc) ⇒ về đúng chỗ trong nhóm đã đọc.
    for (const m of moved) {
      let at = rows.findIndex((r) => !r.unread && r.id !== activeId && readOrderBefore(m, r));
      if (at < 0) at = rows.length;
      rows.splice(at, 0, m);
    }
  }
  return keepActiveInPlace(rows, prevShown, activeId).map((r) => (r.id === activeId ? asReadRow(r) : r));
}

/**
 * Số trên thẻ «Tin khách chưa đọc»: số máy chủ đếm, trừ các hội thoại mà người xem vừa đọc SAU ảnh chụp của câu đếm (`snapshotStamp`
 * = `max(updated_at)` con trỏ của người xem, đọc trong CÙNG câu đếm). Không âm. HÀM THUẦN.
 */
export function patchUnreadCount(serverCount: number, snapshotStamp: string | null, reads: Iterable<InboxReadConfirmation>): number {
  let n = serverCount;
  for (const c of reads) if (c.unreadBefore > 0 && c.unreadAfter === 0 && c.stamp && (!snapshotStamp || c.stamp > snapshotStamp)) n -= 1;
  return Math.max(0, n);
}
