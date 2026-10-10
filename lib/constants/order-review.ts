/**
 * ═══════════ ĐƠN CẦN NGƯỜI KIỂM — THUẦN, CLIENT-SAFE (chủ shop quyết 08/10/2026) ═══════════
 *
 * Hai tình huống MÁY không được tự quyết thay người, nhưng cũng không được tự làm mất đơn:
 *  · KHÁCH HUỶ sau khi đã có đơn (nháp hoặc đã xác nhận) — `mark_declined` của chatbot KHÔNG huỷ đơn, chỉ GHI CHÚ «khách
 *    huỷ» (nguyên văn câu khách + mốc) lên đơn của chính hội thoại. Người huỷ đơn, hoặc cứu được thì xác nhận lại.
 *  · ĐỊA CHỈ CHƯA GHÉP ĐƯỢC XÃ / PHƯỜNG mà khách đã đồng ý — máy VẪN chốt (như trước), kèm cờ để người kiểm địa chỉ.
 *
 * NƠI LƯU: `orders.raw.review` của đơn tay `erp-` (cùng chỗ lời khai gốc của đơn tay — `origin`, `agentKey`…): KHÔNG cột mới,
 * KHÔNG migration. Có khoá `review` (một object) = ĐANG cần người kiểm; người bấm «Xác nhận đơn» / «Huỷ đơn» ⇒ khoá về
 * `null` và lượt kiểm chuyển vào `raw.reviewLog` (vết: ai, lúc nào, quyết gì). Đơn đồng bộ Pancake không bao giờ mang cờ này.
 *
 * Cờ KHÔNG đổi `stage` và KHÔNG chạm `ORDER_OUTCOME` / báo cáo: đơn cần kiểm vẫn là đơn (luật 04/10/2026) — chỉ thêm một lớp
 * «người xem trước khi đi tiếp». Danh sách đơn lọc được «Cần người kiểm»; hộp thư và trang đơn hiện lý do + nút nhanh.
 */

/**
 * `CANCEL_BLOCKED` (chủ shop 10/10/2026 — `lib/constants/order-cancel.ts`): khách đã chốt huỷ sau lượt giữ đơn nhưng máy KHÔNG tự
 * huỷ được (đã bàn giao ĐVVC · hãng từ chối / không trả lời · ghi hỏng …) — lý do nằm ở `note`, người xử lý tiếp.
 */
export const ORDER_REVIEW_CODES = ["CUSTOMER_CANCELLED", "ADDRESS_UNRESOLVED", "CANCEL_BLOCKED"] as const;
export type OrderReviewCode = (typeof ORDER_REVIEW_CODES)[number];

export const ORDER_REVIEW_LABEL: Record<OrderReviewCode, string> = {
  CUSTOMER_CANCELLED: "Khách báo huỷ trong hội thoại",
  ADDRESS_UNRESOLVED: "Địa chỉ chưa ghép được xã / phường",
  CANCEL_BLOCKED: "Khách chốt huỷ — máy không tự huỷ được",
};

/** Nhãn NGẮN (dòng lý do của khung đơn hộp thư). */
export const ORDER_REVIEW_SHORT_LABEL: Record<OrderReviewCode, string> = {
  CUSTOMER_CANCELLED: "khách báo huỷ",
  ADDRESS_UNRESOLVED: "địa chỉ chưa ghép",
  CANCEL_BLOCKED: "khách chốt huỷ, máy chưa huỷ được",
};

/** Việc người phải làm với từng lý do — in cạnh lý do để người đọc biết bấm gì. */
export const ORDER_REVIEW_HINT: Record<OrderReviewCode, string> = {
  CUSTOMER_CANCELLED: "Gọi / nhắn lại khách: khách huỷ thật ⇒ «Huỷ đơn»; cứu được ⇒ «Xác nhận đơn».",
  ADDRESS_UNRESOLVED: "Hỏi lại khách xã / phường mới, sửa đơn chọn xã rồi «Xác nhận đơn».",
  CANCEL_BLOCKED: "Đọc lý do: hãng đã lấy hàng ⇒ chặn giao / chờ hoàn; hãng lỗi ⇒ huỷ vận đơn trên trang hãng rồi «Huỷ đơn».",
};

/** Câu lý do mặc định khi huỷ bằng nút nhanh (người sửa được trước khi bấm). */
export const ORDER_REVIEW_CANCEL_REASON: Record<OrderReviewCode, string> = {
  CUSTOMER_CANCELLED: "Khách huỷ (theo hội thoại)",
  ADDRESS_UNRESOLVED: "Không xác định được địa chỉ giao",
  CANCEL_BLOCKED: "Khách huỷ (theo hội thoại)",
};

/** Một lý do cần kiểm. `quote` = NGUYÊN VĂN câu khách (khách huỷ); `by` = tên máy / người ghi; `at` = mốc ISO. */
export type OrderReviewEntry = { code: OrderReviewCode; note: string; quote: string | null; at: string; by: string };
export type OrderReview = { entries: OrderReviewEntry[] };
/**
 * Một dòng VẾT của cờ: người đã kiểm (`CONFIRMED` · `CANCELLED` — lý do lúc đó + ai quyết gì), hoặc khách XÁC NHẬN LẠI qua bot sau
 * khi đã báo huỷ (`CUSTOMER_RECONFIRMED` — chỉ là lời khai mới, KHÔNG gỡ cờ; người vẫn quyết). Quy kết bằng KHOÁ TÀI KHOẢN (AGENTS
 * mục 34) — tên chỉ là ảnh chụp; `byUserId = null` = máy ghi.
 */
export type OrderReviewAction = "CONFIRMED" | "CANCELLED" | "CUSTOMER_RECONFIRMED";
export type OrderReviewResolution = { entries: OrderReviewEntry[]; action: OrderReviewAction; at: string; byUserId: string | null; byName: string; quote?: string | null };

/** Trần — chặn một hội thoại «huỷ» trăm lần làm phình `raw`. */
export const ORDER_REVIEW_LIMITS = { entries: 10, log: 20, quoteMax: 300, noteMax: 300 } as const;

const isCode = (v: unknown): v is OrderReviewCode => typeof v === "string" && (ORDER_REVIEW_CODES as readonly string[]).includes(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function parseEntry(v: unknown): OrderReviewEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (!isCode(e.code)) return null;
  return { code: e.code, note: str(e.note), quote: typeof e.quote === "string" && e.quote ? e.quote : null, at: str(e.at), by: str(e.by) };
}

/** Cờ cần kiểm ĐANG MỞ của một đơn, đọc từ `orders.raw`; không có / hỏng ⇒ `null`. HÀM THUẦN. */
export function orderReviewOf(raw: unknown): OrderReview | null {
  if (!raw || typeof raw !== "object") return null;
  return reviewFromValue((raw as Record<string, unknown>).review);
}

/** Đọc thẳng giá trị `raw->'review'` (truy vấn danh sách chỉ chọn khoá này). HÀM THUẦN. */
export function reviewFromValue(v: unknown): OrderReview | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const list = (v as { entries?: unknown }).entries;
  const entries = Array.isArray(list) ? list.map(parseEntry).filter((e): e is OrderReviewEntry => e !== null) : [];
  return entries.length ? { entries } : null;
}

/** Lượt kiểm đã xong (mới nhất trước). HÀM THUẦN. */
export function orderReviewLogOf(raw: unknown): OrderReviewResolution[] {
  if (!raw || typeof raw !== "object") return [];
  const log = (raw as Record<string, unknown>).reviewLog;
  if (!Array.isArray(log)) return [];
  const out: OrderReviewResolution[] = [];
  for (const v of log) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (r.action !== "CONFIRMED" && r.action !== "CANCELLED" && r.action !== "CUSTOMER_RECONFIRMED") continue;
    const entries = Array.isArray(r.entries) ? r.entries.map(parseEntry).filter((e): e is OrderReviewEntry => e !== null) : [];
    out.push({ entries, action: r.action, at: str(r.at), byUserId: typeof r.byUserId === "string" ? r.byUserId : null, byName: str(r.byName), quote: typeof r.quote === "string" && r.quote ? r.quote : null });
  }
  return out.reverse();
}

/**
 * Thêm một lý do vào cờ đang mở. Trùng lý do: «địa chỉ chưa ghép» chỉ giữ MỘT dòng (cùng sự việc); «khách huỷ» giữ mỗi câu khách
 * khác nhau (mỗi câu là một lời khai có mốc), câu y hệt thì không thêm. Trả `changed = false` khi không có gì mới. HÀM THUẦN.
 */
export function withReviewEntry(raw: Record<string, unknown>, entry: OrderReviewEntry): { raw: Record<string, unknown>; changed: boolean } {
  const clean: OrderReviewEntry = { ...entry, note: entry.note.trim().slice(0, ORDER_REVIEW_LIMITS.noteMax), quote: entry.quote ? entry.quote.trim().slice(0, ORDER_REVIEW_LIMITS.quoteMax) || null : null };
  const current = orderReviewOf(raw)?.entries ?? [];
  // «địa chỉ chưa ghép» một dòng; «máy không tự huỷ được» một dòng mỗi LÝ DO (note); «khách huỷ» một dòng mỗi câu khách.
  const dup = current.some((e) => e.code === clean.code && (clean.code === "ADDRESS_UNRESOLVED" || (clean.code === "CANCEL_BLOCKED" ? e.note === clean.note : (e.quote ?? "") === (clean.quote ?? ""))));
  if (dup) return { raw, changed: false };
  const entries = [...current, clean].slice(-ORDER_REVIEW_LIMITS.entries);
  return { raw: { ...raw, review: { entries } }, changed: true };
}

/** Người đã kiểm: cờ về `null`, lượt kiểm vào `reviewLog`. Không có cờ ⇒ không đổi gì (`changed = false`). HÀM THUẦN. */
export function withReviewResolved(raw: Record<string, unknown>, by: { action: "CONFIRMED" | "CANCELLED"; at: string; byUserId: string | null; byName: string }): { raw: Record<string, unknown>; changed: boolean; resolved: OrderReviewEntry[] } {
  const open = orderReviewOf(raw);
  if (!open) return { raw, changed: false, resolved: [] };
  const prior = Array.isArray(raw.reviewLog) ? (raw.reviewLog as unknown[]) : [];
  const entry: OrderReviewResolution = { entries: open.entries, ...by };
  return { raw: { ...raw, review: null, reviewLog: [...prior, entry].slice(-ORDER_REVIEW_LIMITS.log) }, changed: true, resolved: open.entries };
}

/**
 * Khách đã báo huỷ rồi lại ĐỒNG Ý qua bot (lời xác nhận hợp lệ): ghi MỘT dòng vết «khách xác nhận lại» — KHÔNG gỡ cờ, người vẫn
 * quyết (chủ shop 08/10/2026: «người huỷ, hoặc cứu được thì xác nhận lại»). Không có cờ «khách huỷ» đang mở ⇒ không ghi; câu y
 * hệt đã ghi ⇒ không ghi lại. HÀM THUẦN.
 */
export function withCustomerReconfirm(raw: Record<string, unknown>, note: { at: string; byName: string; quote: string | null }): { raw: Record<string, unknown>; changed: boolean } {
  const open = orderReviewOf(raw);
  if (!open?.entries.some((e) => e.code === "CUSTOMER_CANCELLED" || e.code === "CANCEL_BLOCKED")) return { raw, changed: false };
  const quote = note.quote ? note.quote.trim().slice(0, ORDER_REVIEW_LIMITS.quoteMax) || null : null;
  const prior = Array.isArray(raw.reviewLog) ? (raw.reviewLog as unknown[]) : [];
  if (orderReviewLogOf(raw).some((r) => r.action === "CUSTOMER_RECONFIRMED" && (r.quote ?? null) === quote && r.at >= (open.entries[open.entries.length - 1]?.at ?? ""))) return { raw, changed: false };
  const entry: OrderReviewResolution = { entries: [], action: "CUSTOMER_RECONFIRMED", at: note.at, byUserId: null, byName: note.byName, quote };
  return { raw: { ...raw, reviewLog: [...prior, entry].slice(-ORDER_REVIEW_LIMITS.log) }, changed: true };
}

/** Lời «khách xác nhận lại» ghi SAU lý do «khách huỷ» đang mở — để người đọc thấy cạnh cờ (mới nhất trước). HÀM THUẦN. */
export function reconfirmsSinceOpen(raw: unknown): OrderReviewResolution[] {
  const open = orderReviewOf(raw);
  const since = open?.entries.find((e) => e.code === "CUSTOMER_CANCELLED")?.at;
  if (!since) return [];
  return orderReviewLogOf(raw).filter((r) => r.action === "CUSTOMER_RECONFIRMED" && r.at >= since);
}

/**
 * DẤU VẾT NGƯỜI BẤM ĐÃ THẤY (review độc lập #675, M1): số lý do + mốc lý do mới nhất trên trang lúc dựng. Máy chủ so với dòng ĐÃ
 * KHOÁ: có lý do mới người bấm chưa thấy (bot vừa gắn «khách huỷ» sau khi trang dựng) ⇒ từ chối, không chốt / gỡ cờ thay người.
 */
export type ReviewSeen = { count: number; latestAt: string | null };
export function reviewSeenOf(entries: readonly OrderReviewEntry[]): ReviewSeen {
  return { count: entries.length, latestAt: entries.reduce<string | null>((m, e) => (e.at && (!m || e.at > m) ? e.at : m), null) };
}

/** Lý do đang mở mà người bấm CHƯA thấy (mốc ISO cùng định dạng nên so chuỗi là so thời gian). HÀM THUẦN. */
export function unseenReviewEntries(current: OrderReview | null, seen: ReviewSeen): OrderReviewEntry[] {
  const list = current?.entries ?? [];
  const newer = list.filter((e) => seen.latestAt === null || e.at > seen.latestAt);
  if (newer.length) return newer;
  return list.length > seen.count ? list.slice(seen.count) : [];
}

/** Câu từ chối khi có lý do mới chưa thấy. */
export function reviewConflictMessage(unseen: readonly OrderReviewEntry[]): string {
  return unseen.some((e) => e.code === "CUSTOMER_CANCELLED" || e.code === "CANCEL_BLOCKED") ? "Khách vừa báo huỷ — tải lại để xem rồi quyết." : "Đơn vừa có lý do cần kiểm mới — tải lại để xem rồi quyết.";
}

/** Mã lý do đang mở (sắp xếp, không trùng) — bộ đo và màn hình đọc chung. HÀM THUẦN. */
export function reviewCodes(review: OrderReview | null): OrderReviewCode[] {
  return review ? [...new Set(review.entries.map((e) => e.code))].sort() : [];
}

/** Giai đoạn đơn còn gắn cờ được (đơn đã huỷ / đã giao / đã hoàn thì lời huỷ của khách không còn việc gì cho người). */
export const ORDER_REVIEW_FLAGGABLE_STAGES = ["NEW", "WAITING", "CONFIRMED"] as const;
export function canFlagOrderForReview(stage: string): boolean {
  return (ORDER_REVIEW_FLAGGABLE_STAGES as readonly string[]).includes(stage);
}

/** Đơn tay ở giai đoạn này thì nút nhanh «Xác nhận đơn» làm được gì: CHỐT (Mới / Chờ hàng ⇒ Đã xác nhận) hay chỉ GỠ CỜ. */
export function quickConfirmKind(stage: string, flagged: boolean): "CONFIRM" | "RESOLVE" | null {
  if (stage === "NEW" || stage === "WAITING") return "CONFIRM";
  return flagged && stage !== "CANCELLED" && stage !== "DELETED" ? "RESOLVE" : null;
}
