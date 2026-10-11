/**
 * ═══════════ BÁO GIÁ MÁY CHỦ — PHẦN THUẦN, CLIENT-SAFE (P0 authoritative-quote, chủ shop 11/10/2026) ═══════════
 *
 * Kiểu dữ liệu của báo giá + dữ kiện báo giá cho vòng đời hội thoại (`lib/sales-chatbot/lifecycle.ts` đọc `quoteFactOf`). Phép tính
 * nằm ở `quote.ts` (máy chủ). Tệp này không đọc CSDL, không băm — màn hình và vòng đời import được.
 */

/**
 * Lý do một báo giá CHƯA XÁC THỰC. Ba mã đầu là dữ liệu thiếu; ba mã sau là CATALOG MÂU THUẪN với luật giảm theo khối lượng chủ shop
 * đã khai — cùng một khối lượng có hai biểu diễn (gói lớn · N × gói đơn vị) ra hai số tiền khác nhau, máy KHÔNG chọn hộ.
 */
export const QUOTE_ISSUE_CODES = ["MISSING_SKU", "UNPRICED", "ADD_ON_ONLY", "UNIT_PACK_UNKNOWN", "WEIGHT_UNKNOWN", "PACK_PRICE_CONFLICT", "EMPTY"] as const;
export type QuoteIssueCode = (typeof QUOTE_ISSUE_CODES)[number];
export type QuoteIssue = { code: QuoteIssueCode; detail: string };

export type QuoteLine = { variantId: string; name: string; quantity: number; unitPrice: number; discount: number; lineTotal: number };

/**
 * Báo giá máy chủ. `quoteId` băm TẤT ĐỊNH từ phiên bản giá + dòng + phí ship + tổng: cùng giỏ, cùng dữ liệu giá ⇒ cùng mã.
 * `priceVersion` băm từ dữ liệu giá đang áp (đơn giá các mẫu mã liên quan, luật giảm theo khối lượng, luật miễn ship, phí ship) —
 * chủ shop đổi một con số là đổi phiên bản. `total = null` = phí ship CHƯA BIẾT (luật 42), không phải 0.
 */
export type Quote = {
  quoteId: string;
  priceVersion: string;
  lines: QuoteLine[];
  /** Tổng tiền giảm (giảm theo khối lượng) của cả giỏ. */
  discounts: number;
  subtotal: number;
  shipping: number | null;
  total: number | null;
  verified: boolean;
  unverifiedReasons: QuoteIssue[];
  /** Mọi số tiền bot ĐƯỢC nói theo báo giá này (đơn giá, thành tiền, giảm, tiền hàng, ship, tổng, phần còn thiếu để miễn ship). Rỗng khi chưa xác thực. */
  amounts: number[];
};

/** Bản báo giá lưu trong `state` hội thoại — đủ để hàng rào số tiền và vòng đời đọc, không mang dòng hàng. */
export type QuoteSnapshot = { id: string; priceVersion: string; verified: boolean; subtotal: number; total: number | null; amounts: number[]; reasons: string[]; at: string };

export function quoteSnapshotOf(q: Quote, at: Date): QuoteSnapshot {
  return { id: q.quoteId, priceVersion: q.priceVersion, verified: q.verified, subtotal: q.subtotal, total: q.total, amounts: q.amounts, reasons: q.unverifiedReasons.map((r) => r.detail), at: at.toISOString() };
}

/** Dữ kiện báo giá cho vòng đời: chưa báo · đã báo nhưng CHƯA xác thực · đã xác thực. HÀM THUẦN. */
export type QuoteFact = { state: "NONE" | "QUOTED" | "VERIFIED"; quoteId: string | null; priceVersion: string | null; total: number | null; reasons: string[] };

export function quoteFactOf(snapshot: QuoteSnapshot | null | undefined): QuoteFact {
  if (!snapshot || typeof snapshot.id !== "string") return { state: "NONE", quoteId: null, priceVersion: null, total: null, reasons: [] };
  return { state: snapshot.verified ? "VERIFIED" : "QUOTED", quoteId: snapshot.id, priceVersion: snapshot.priceVersion ?? null, total: snapshot.total ?? null, reasons: Array.isArray(snapshot.reasons) ? snapshot.reasons : [] };
}

/** Lý do chuyển người khi giá chưa xác thực — tiền tố «Giá / tồn bất thường» ⇒ `classifyHandoffReason` = PRICE_STOCK_ANOMALY. */
export const PRICE_UNVERIFIED_PREFIX = "Giá / tồn bất thường — PRICE_UNVERIFIED";
export const priceUnverifiedReason = (detail: string) => `${PRICE_UNVERIFIED_PREFIX}: ${detail}`.slice(0, 300);

/** Câu dặn model khi báo giá chưa xác thực — không nói số, không lên đơn. */
export const QUOTE_UNVERIFIED_INSTRUCTION = "GIÁ CHƯA XÁC THỰC — KHÔNG báo số tiền nào, KHÔNG lên đơn. Nói ngắn: em kiểm lại giá chính xác và báo mình ngay. Máy chủ đã chuyển nhân viên.";
