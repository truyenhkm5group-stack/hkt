/**
 * ═══════════ KIỂM TOÁN TOÀN VẸN BÁN HÀNG — HÀM THUẦN PHÂN LOẠI (P0 11/10/2026 · ops `sales-integrity-audit`) ═══════════
 *
 * Sự cố HSLC 11/10/2026 (chủ shop): AI báo «2kg = 540.000 ₫» rồi «2kg = 560.000 ₫» trong CÙNG hội thoại, đơn nháp 2 × 280.000;
 * hội thoại hiện «Đã xác nhận» và bot nói «đã lên đơn cho mình rồi ạ» khi đơn còn CẦN XÁC THỰC (địa chỉ chưa ghép xã / phường);
 * khách nhắn tiếp thì bot chuyển người mà KHÔNG AI NHẬN; đơn đã xác nhận vẫn bị nhắn «xác nhận / tiếp tục chốt đơn».
 *
 * Tệp này KHÔNG đọc CSDL, KHÔNG đọc đồng hồ (mốc «bây giờ» luôn là đối số) — cùng đầu vào ra cùng kết quả, để ops hôm nay và
 * trang /platform/saas về sau (Financial Accuracy · Order Integrity) đọc CÙNG một định nghĩa (AGENTS §8.3, §8.12).
 *
 * Mỗi thước đo khai MỨC TIN CẬY (`MEASURED` = đọc thẳng dữ kiện có mốc · `ESTIMATED` = suy từ chữ / trạng thái hiện tại). `null`
 * = CHƯA ĐO ĐƯỢC, không bao giờ 0 (luật 42). Tỷ lệ có mẫu < `INTEGRITY_MIN_SAMPLE` vẫn in số nhưng mang nhãn «mẫu nhỏ».
 *
 * Câu khẳng định «đã chốt / đã lên đơn» KHÔNG đọc ở đây — nơi gọi dùng `detectClaims` của `claim-guard.ts` (một luật duy nhất,
 * cùng hàng rào đang chạy) rồi đưa cờ vào.
 */
import { normalizeVnAddress } from "@/lib/address/vn-address";
import { manualOrderGaps } from "@/lib/constants/manual-orders";
import { foldVi } from "@/lib/sales-chatbot/text";

export type Confidence = "MEASURED" | "ESTIMATED";

/** Mẫu dưới ngưỡng ⇒ tỷ lệ in kèm «mẫu nhỏ». */
export const INTEGRITY_MIN_SAMPLE = 30;
/** Mốc kiểm hội thoại chuyển người không ai nhận (giờ). */
export const HANDOFF_THRESHOLDS_H = [1, 4, 24] as const;
/** Đệm giữa lúc ghi đơn và lúc ghi câu bot của CÙNG lượt (câu bot luôn ghi sau công cụ vài giây). */
export const CLAIM_SLACK_MS = 60_000;
/** Câu bot ngay SAU mốc chốt (vd «đã lên đơn rồi ạ») không phải tin nhắc lại. */
export const POST_ORDER_GRACE_MS = 2 * 60_000;
/** Câu bot / page không có tin khách trong chừng này phút trước nó ⇒ tin CHỦ ĐỘNG (không phải trả lời khách). */
export const UNPROMPTED_GAP_MS = 30 * 60_000;
/** Khách im chừng này giờ sau lỗi ⇒ coi là bỏ dở (ESTIMATED). */
export const SILENT_AFTER_FAULT_H = 48;
/** Hai số tiền «trông như nhau» của chủ shop báo (dùng cho `--find-name`). */
export const OWNER_CASE_AMOUNTS = [540_000, 560_000] as const;

// ─────────────────────────── SỐ TIỀN TRONG CHỮ ───────────────────────────

export type Mention = { value: number; index: number; end: number };

const MIN_VND = 1_000;
const MAX_VND = 1_000_000_000;

/**
 * Số tiền VND trong một câu: «540.000 ₫», «540.000đ», «1.080.000 ₫», «540k», «1,5tr», «2 triệu», «540000đ». Không bắt SĐT
 * («0938.885.324», «0938 885 324», «0938885324» — không có dạng nhóm nghìn đứng riêng, hoặc thiếu đơn vị tiền), số lượng («2kg»,
 * «3 hộp») hay số < 1.000. Không dùng nhìn-ngược (Safari < 16.4) — tiền tố bắt bằng nhóm. HÀM THUẦN.
 */
export function extractVndAmounts(text: string): Mention[] {
  const s = text.normalize("NFC").toLowerCase();
  const out: Mention[] = [];
  const push = (value: number, index: number, end: number) => {
    if (!Number.isFinite(value)) return;
    const v = Math.round(value);
    if (v < MIN_VND || v > MAX_VND) return;
    if (out.some((m) => index < m.end && m.index < end)) return;
    out.push({ value: v, index, end });
  };
  // 1) Nhóm nghìn: «540.000», «1.080.000», «540,000» — không đứng sát chữ số / dấu nhóm khác, không nối tiếp bằng chữ số.
  for (const m of s.matchAll(/(^|[^\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![.,]?\d)/g)) {
    const start = (m.index ?? 0) + m[1].length;
    const raw = m[2];
    if (raw.startsWith("0")) continue;
    push(Number(raw.replace(/[.,]/g, "")), start, start + raw.length);
  }
  // 2) «540k», «1,5tr», «2 triệu», «500 nghìn» — «k» phải sát số và không nối chữ (loại «1kg»).
  for (const m of s.matchAll(/(^|[^\d.,\p{L}])(\d{1,4}(?:[.,]\d{1,3})?)(?:(k)|\s*(nghìn|ngàn|tr|triệu|củ))(?![\p{L}\d])/gu)) {
    const start = (m.index ?? 0) + m[1].length;
    const base = Number(m[2].replace(",", "."));
    const unit = m[3] ?? m[4] ?? "";
    const mult = unit === "tr" || unit === "triệu" || unit === "củ" ? 1_000_000 : 1_000;
    push(base * mult, start, (m.index ?? 0) + m[0].length);
  }
  // 3) Chữ số trơn KÈM đơn vị tiền: «540000đ», «540000 vnd».
  for (const m of s.matchAll(/(^|[^\d.,])([1-9]\d{3,8})\s*(đ|₫|vnd|vnđ|đồng)(?![\p{L}\d])/gu)) {
    const start = (m.index ?? 0) + m[1].length;
    push(Number(m[2]), start, (m.index ?? 0) + m[0].length);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Khối lượng trong câu: «2kg», «0,5kg», «500g», «1 ký», «2 cân» ⇒ gram. HÀM THUẦN. */
export function extractWeights(text: string): Mention[] {
  const s = text.normalize("NFC").toLowerCase();
  const out: Mention[] = [];
  for (const m of s.matchAll(/(^|[^\d.,\p{L}])(\d{1,3}(?:[.,]\d{1,2})?)\s*(kg|kí|ký|ki|cân|gr|gram|gam|g)(?![\p{L}\d])/gu)) {
    const start = (m.index ?? 0) + m[1].length;
    const n = Number(m[2].replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    const grams = Math.round(m[3].startsWith("g") ? n : n * 1000);
    out.push({ value: grams, index: start, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Một cặp «khối lượng → tổng tiền» bot nói trong một đoạn câu. `grams = null` = đoạn không nhắc khối lượng. */
export type QuotePoint = { grams: number | null; amount: number };

/** Ranh giới đoạn: xuống dòng, chấm phẩy, gạch nối có cách, chấm giữa, gạch đứng. */
const SEGMENT_SPLIT = /\n|;|•|·|\||\s[-–—]\s/;
/** Số tiền đứng sau những chữ này là PHÍ / GIẢM / CỌC — không phải tổng hàng («giảm còn» thì vẫn là tổng). */
const NON_TOTAL_BEFORE = /(?:ship|phi|cuoc|van chuyen|coc|tiet kiem|bot|giam(?! con)|chenh|them)\s*(?:la|:)?\s*$/;
/** Số tiền ngay sau phép nhân («× 280.000») hoặc ngay trước «/kg», «mỗi kg», «1 gói» là ĐƠN GIÁ, không phải tổng. */
const UNIT_BEFORE = /[x×*]\s*$/;
const UNIT_AFTER = /^\s*(?:₫|đ|vnd|vnđ)?\s*(?:\/|mỗi|một|1)\s*(?:kg|kí|ký|ki|cân|gói|hộp|túi|hũ|lọ|phần)(?![\p{L}\d])/u;

/**
 * Các cặp khối lượng → tổng tiền trong một câu bot: mỗi số tiền ghép với khối lượng nhắc GẦN NHẤT TRƯỚC nó trong cùng đoạn;
 * bỏ đơn giá («× 280.000», «280k/kg») và phí / giảm / cọc; cùng đoạn cùng khối lượng giữ số LỚN NHẤT (tổng ≥ đơn giá).
 * Đoán từ CHỮ ⇒ ESTIMATED. HÀM THUẦN.
 */
export function quotePoints(text: string): QuotePoint[] {
  const out: QuotePoint[] = [];
  for (const rawSeg of text.split(SEGMENT_SPLIT)) {
    // Ngoặc không mang số tiền là chú thích quy cách («2kg (4 túi 0,5kg)») — bỏ để khối lượng gần nhất là khối lượng của gói.
    const seg = rawSeg.replace(/\([^()]*\)/g, (m) => (extractVndAmounts(m).length ? m : " ".repeat(m.length)));
    const amounts = extractVndAmounts(seg);
    if (!amounts.length) continue;
    const weights = extractWeights(seg);
    const folded = seg.normalize("NFC").toLowerCase();
    const best = new Map<number | null, number>();
    for (const a of amounts) {
      const before = foldVi(folded.slice(Math.max(0, a.index - 24), a.index));
      const rawBefore = folded.slice(Math.max(0, a.index - 3), a.index);
      const after = folded.slice(a.end, a.end + 14);
      if (UNIT_BEFORE.test(rawBefore) || UNIT_AFTER.test(after) || NON_TOTAL_BEFORE.test(before)) continue;
      let grams: number | null = null;
      for (const w of weights) if (w.end <= a.index) grams = w.value;
      best.set(grams, Math.max(best.get(grams) ?? 0, a.value));
    }
    for (const [grams, amount] of best) out.push({ grams, amount });
  }
  return out;
}

// ─────────────────────────── (a) GIÁ BOT ↔ GIÁ ĐƠN ───────────────────────────

/** Tiền của một đơn. `null` = chưa biết (một dòng chưa có đơn giá…). */
export type OrderMoney = { total: number | null; goods: number | null; shipping: number | null };
export type OrderLineMoney = { quantity: number; unitPrice: number | null; discount: number; isBonus: boolean };

/** Tổng đơn (`total_price_after_discount`), tiền hàng theo dòng (Σ đơn giá × SL − chiết khấu dòng, bỏ hàng tặng), phí ship. HÀM THUẦN. */
export function orderMoneyOf(order: { totalAfterDiscount: number | null; shippingFee: number | null }, lines: readonly OrderLineMoney[]): OrderMoney {
  const paid = lines.filter((l) => !l.isBonus);
  const goods = !paid.length || paid.some((l) => l.unitPrice === null) ? null : paid.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity - l.discount, 0);
  const total = order.totalAfterDiscount !== null && order.totalAfterDiscount > 0 ? order.totalAfterDiscount : null;
  return { total, goods, shipping: order.shippingFee !== null && order.shippingFee > 0 ? order.shippingFee : null };
}

/** Các số tiền «đúng» của đơn mà một câu báo giá có thể nhắc: tổng · tổng + ship · tiền hàng theo dòng. */
export function orderReferenceAmounts(m: OrderMoney): number[] {
  const out = new Set<number>();
  if (m.total !== null) out.add(m.total);
  if (m.total !== null && m.shipping !== null) out.add(m.total + m.shipping);
  if (m.goods !== null && m.goods > 0) out.add(m.goods);
  return [...out];
}

export type BotText = { at: Date; text: string };
export type QuoteVerdict = "MATCH" | "MISMATCH" | "NO_QUOTE" | "ORDER_AMOUNT_UNKNOWN";
export type QuoteVsOrder = { verdict: QuoteVerdict; quoted: number | null; reference: number | null; diff: number | null; messageAt: Date | null };

/**
 * So câu bot CÓ báo giá gần nhất TRƯỚC mốc lên đơn với tiền của đơn. Khớp ⇔ một số tiền trong câu bằng một số «đúng» của đơn.
 * Lệch ⇒ `diff` = tiền đơn − số bot báo gần nhất với nó (dương = đơn đắt hơn lời báo). HÀM THUẦN.
 */
export function compareQuoteToOrder(bot: readonly BotText[], anchor: Date, money: OrderMoney): QuoteVsOrder {
  const refs = orderReferenceAmounts(money);
  const reference = money.total ?? money.goods;
  const before = bot.filter((b) => b.at.getTime() < anchor.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
  const msg = before.find((b) => quotePoints(b.text).length > 0);
  if (!msg) return { verdict: "NO_QUOTE", quoted: null, reference, diff: null, messageAt: null };
  if (reference === null || !refs.length) return { verdict: "ORDER_AMOUNT_UNKNOWN", quoted: null, reference: null, diff: null, messageAt: msg.at };
  const all = extractVndAmounts(msg.text).map((m) => m.value);
  if (all.some((v) => refs.includes(v))) return { verdict: "MATCH", quoted: refs.find((r) => all.includes(r)) ?? null, reference, diff: 0, messageAt: msg.at };
  const candidates = quotePoints(msg.text).map((p) => p.amount);
  const quoted = candidates.reduce((best, v) => (Math.abs(v - reference) < Math.abs(best - reference) ? v : best), candidates[0]);
  return { verdict: "MISMATCH", quoted, reference, diff: reference - quoted, messageAt: msg.at };
}

// ─────────────────────────── (b) GIÁ TỰ ĐỔI TRONG HỘI THOẠI ───────────────────────────

export type PriceDrift = { grams: number; amounts: number[]; spread: number; secondAt: Date };

/** Cùng khối lượng («2kg»), bot báo hai tổng khác nhau trong cùng hội thoại. Đoán từ chữ ⇒ ESTIMATED. HÀM THUẦN. */
export function priceDrifts(bot: readonly BotText[]): PriceDrift[] {
  const seen = new Map<number, { amounts: number[]; secondAt: Date | null }>();
  for (const b of [...bot].sort((x, y) => x.at.getTime() - y.at.getTime())) {
    for (const p of quotePoints(b.text)) {
      if (p.grams === null) continue;
      const cur = seen.get(p.grams) ?? { amounts: [], secondAt: null };
      if (!cur.amounts.includes(p.amount)) {
        cur.amounts.push(p.amount);
        if (cur.amounts.length === 2) cur.secondAt = b.at;
      }
      seen.set(p.grams, cur);
    }
  }
  const out: PriceDrift[] = [];
  for (const [grams, v] of seen) if (v.amounts.length >= 2 && v.secondAt) out.push({ grams, amounts: [...v.amounts].sort((a, b) => a - b), spread: Math.max(...v.amounts) - Math.min(...v.amounts), secondAt: v.secondAt });
  return out.sort((a, b) => a.grams - b.grams);
}

// ─────────────────────────── (c) TRẠNG THÁI ĐƠN TẠI MỘT MỐC · XÁC NHẬN GIẢ ───────────────────────────

/** Một lượt cờ CẦN NGƯỜI KIỂM: mở lúc `at`, gỡ lúc `resolvedAt` (`null` = còn mở). */
export type ReviewSpan = { code: string; at: Date; resolvedAt: Date | null };
export type OrderFact = {
  id: string;
  insertedAt: Date;
  stage: string;
  /** Đơn tạo trong ERP (`erp-…`) — chỉ đơn này có cờ kiểm / ô thiếu. */
  manual: boolean;
  total: number | null;
  reviews: ReviewSpan[];
  /** Ô còn thiếu HIỆN TẠI theo `manualOrderGaps` (lõi ghi đơn từ chối xác nhận khi có). */
  gapsNow: string[];
};

export type OrderStateAt = "NO_ORDER" | "DRAFT" | "FLAGGED" | "MISSING_FIELDS" | "CONFIRMED" | "CANCELLED";
export const ORDER_STATE_LABEL: Record<OrderStateAt, string> = {
  NO_ORDER: "chưa có đơn",
  DRAFT: "đơn nháp",
  FLAGGED: "đơn có cờ cần người kiểm",
  MISSING_FIELDS: "đơn thiếu ô (lõi từ chối xác nhận)",
  CONFIRMED: "đơn đã chốt",
  CANCELLED: "đơn đã huỷ",
};

const DEAD = new Set(["CANCELLED", "DELETED"]);

/** Ô thiếu của đơn tay — cùng hàm lõi ghi đơn dùng (`manualOrderGaps`). HÀM THUẦN. */
export function gapsOf(o: { phone: string; address: string; province: string; ward: string; itemsCount: number }): string[] {
  return manualOrderGaps({ phone: o.phone, address: o.address, province: o.province, ward: o.ward }, o.itemsCount);
}

/**
 * Trạng thái đơn của hội thoại TẠI mốc `at` — đơn còn sống mới nhất đã tạo trước `at + CLAIM_SLACK_MS`:
 *  · không có ⇒ NO_ORDER (MEASURED — mốc tạo đơn là dữ kiện);
 *  · đơn tay có cờ kiểm mở tại mốc đó ⇒ FLAGGED (MEASURED — cờ mang mốc mở / gỡ);
 *  · đơn tay còn thiếu ô HÔM NAY ⇒ MISSING_FIELDS (ESTIMATED — ô thường chỉ được điền thêm, nên thiếu hôm nay ⇒ thiếu khi ấy);
 *  · chưa có lượt chốt nào tới mốc đó (sự kiện `order.confirmed`) và đơn hôm nay vẫn «Mới» ⇒ DRAFT;
 *  · còn lại ⇒ CONFIRMED. Đơn huỷ chỉ còn khi không có đơn sống nào ⇒ CANCELLED.
 * HÀM THUẦN.
 */
export function orderStateAt(at: Date, orders: readonly OrderFact[], confirmedAts: readonly Date[]): { state: OrderStateAt; order: OrderFact | null; confidence: Confidence } {
  const cut = at.getTime() + CLAIM_SLACK_MS;
  const existing = orders.filter((o) => o.insertedAt.getTime() <= cut).sort((a, b) => b.insertedAt.getTime() - a.insertedAt.getTime());
  const live = existing.filter((o) => !DEAD.has(o.stage));
  const o = live[0] ?? null;
  if (!o) return existing.length ? { state: "CANCELLED", order: existing[0], confidence: "ESTIMATED" } : { state: "NO_ORDER", order: null, confidence: "MEASURED" };
  if (o.manual && o.reviews.some((r) => r.at.getTime() <= cut && (r.resolvedAt === null || r.resolvedAt.getTime() > at.getTime()))) return { state: "FLAGGED", order: o, confidence: "MEASURED" };
  if (o.manual && o.gapsNow.length) return { state: "MISSING_FIELDS", order: o, confidence: "ESTIMATED" };
  const confirmedByThen = confirmedAts.some((c) => c.getTime() <= cut);
  if (o.stage === "NEW" && !confirmedByThen) return { state: "DRAFT", order: o, confidence: "MEASURED" };
  return { state: "CONFIRMED", order: o, confidence: o.stage === "NEW" ? "ESTIMATED" : "MEASURED" };
}

export type FalseConfirmKind = "NO_ORDER" | "DRAFT_ONLY" | "FLAGGED_AT_TIME" | "MISSING_FIELDS";
/** Câu bot khẳng định «đã chốt / đã lên đơn» tại mốc `at` có căn cứ không. `null` = có căn cứ. HÀM THUẦN. */
export function falseConfirmKind(state: OrderStateAt): FalseConfirmKind | null {
  if (state === "NO_ORDER" || state === "CANCELLED") return "NO_ORDER";
  if (state === "DRAFT") return "DRAFT_ONLY";
  if (state === "FLAGGED") return "FLAGGED_AT_TIME";
  if (state === "MISSING_FIELDS") return "MISSING_FIELDS";
  return null;
}

export type CurrentFix = "FIXED" | "OPEN" | "CANCELLED";
/** Hôm nay ca ấy ra sao: đơn sống mới nhất đã chốt, hết cờ, đủ ô ⇒ FIXED; chỉ còn đơn huỷ ⇒ CANCELLED; còn lại ⇒ OPEN. HÀM THUẦN. */
export function currentFix(orders: readonly OrderFact[]): CurrentFix {
  const live = orders.filter((o) => !DEAD.has(o.stage)).sort((a, b) => b.insertedAt.getTime() - a.insertedAt.getTime());
  const o = live[0];
  if (!o) return orders.length ? "CANCELLED" : "OPEN";
  if (o.stage === "NEW") return "OPEN";
  if (o.manual && (o.reviews.some((r) => r.resolvedAt === null) || o.gapsNow.length)) return "OPEN";
  return "FIXED";
}

// ─────────────────────────── (d) CHUYỂN NGƯỜI KHÔNG AI NHẬN ───────────────────────────

export type HandoffEvidenceKind = "HUMAN_REPLIED" | "HUMAN_TOOK_OVER" | "STAFF_SENT" | "ASSIGNED" | "AI_RESUMED_BY_HUMAN" | "PAGE_REPLY";
export type HandoffEvidence = { at: Date; kind: HandoffEvidenceKind };

/**
 * Mốc người đầu tiên đáp sau lượt chuyển người. `strict` chỉ nhận dấu vết NGƯỜI có trong ERP (nhân viên trả lời / nhận / gửi
 * tin từ hộp thư / được giao); bản nới thêm `PAGE_REPLY` (tin phía page — nhân viên gõ trên Pancake HOẶC tin tự động của Meta,
 * không tách được). `null` = chưa ai đáp. HÀM THUẦN.
 */
export function handoffResponseAt(handoffAt: Date, evidence: readonly HandoffEvidence[], strict: boolean): Date | null {
  const t = handoffAt.getTime();
  let best: Date | null = null;
  for (const e of evidence) {
    if (e.at.getTime() < t) continue;
    if (strict && e.kind === "PAGE_REPLY") continue;
    if (!best || e.at.getTime() < best.getTime()) best = e.at;
  }
  return best;
}

export type HandoffBucket = { thresholdH: number; eligible: number; late: number; never: number };

/** Mỗi mốc N giờ: lượt chuyển người đã đủ N giờ tuổi · trong đó trễ hơn N giờ mới có người đáp hoặc chưa ai đáp · chưa ai đáp. HÀM THUẦN. */
export function handoffBuckets(rows: readonly { at: Date; responseAt: Date | null }[], now: Date, thresholds: readonly number[] = HANDOFF_THRESHOLDS_H): HandoffBucket[] {
  return thresholds.map((h) => {
    const ms = h * 3_600_000;
    const old = rows.filter((r) => now.getTime() - r.at.getTime() >= ms);
    const late = old.filter((r) => r.responseAt === null || r.responseAt.getTime() - r.at.getTime() > ms);
    return { thresholdH: h, eligible: old.length, late: late.length, never: old.filter((r) => r.responseAt === null).length };
  });
}

// ─────────────────────────── (e) ĐỊA CHỈ CHƯA GHÉP ───────────────────────────

export type AddressIssue = "MISSING_PROVINCE" | "MISSING_WARD" | "LEGACY_WARD_SPLIT" | "LEGACY_DISTRICT_ONLY" | "AMBIGUOUS_NAME" | "RESOLVABLE_NOW";
/** Loại chỗ trống theo luật 45: chỉ RESOLVABLE (máy ghép được hôm nay) và AMBIGUOUS (người chọn) là việc máy / người làm ngay. */
export const ADDRESS_ISSUE_GAP: Record<AddressIssue, "TRUE_UNKNOWN" | "AMBIGUOUS" | "RESOLVABLE"> = {
  MISSING_PROVINCE: "TRUE_UNKNOWN",
  MISSING_WARD: "TRUE_UNKNOWN",
  LEGACY_WARD_SPLIT: "AMBIGUOUS",
  LEGACY_DISTRICT_ONLY: "AMBIGUOUS",
  AMBIGUOUS_NAME: "AMBIGUOUS",
  RESOLVABLE_NOW: "RESOLVABLE",
};
export const ADDRESS_ISSUE_LABEL: Record<AddressIssue, string> = {
  MISSING_PROVINCE: "thiếu tỉnh",
  MISSING_WARD: "thiếu phường / xã",
  LEGACY_WARD_SPLIT: "phường cũ trước sáp nhập (đã chia nhiều phường mới)",
  LEGACY_DISTRICT_ONLY: "chỉ có quận / huyện cũ",
  AMBIGUOUS_NAME: "trùng tên phường trong tỉnh",
  RESOLVABLE_NOW: "bộ đọc hôm nay ghép được (đơn chưa cập nhật)",
};

/**
 * Dòng địa chỉ có chữ mà ô tỉnh / xã còn trống ⇒ vì sao. Đọc bằng ĐÚNG bộ chuẩn hoá địa giới 2025 của lõi ghi đơn
 * (`normalizeVnAddress`) — không tự đoán. `null` = không có dòng địa chỉ, hoặc đã đủ tỉnh + xã. HÀM THUẦN.
 */
export function classifyAddress(r: { address: string; province: string; ward: string }): AddressIssue | null {
  if (r.address.trim().length < 5) return null;
  if (r.province.trim() && r.ward.trim()) return null;
  const m = normalizeVnAddress([r.address, r.province].filter((x) => x.trim()).join(", "));
  if (m.status === "MATCHED") return "RESOLVABLE_NOW";
  if (m.status === "UNKNOWN") return r.province.trim() ? "MISSING_WARD" : "MISSING_PROVINCE";
  const reason = foldVi(m.reason);
  if (/cu da duoc chia/.test(reason)) return "LEGACY_WARD_SPLIT";
  if (/chi co quan huyen cu/.test(reason)) return "LEGACY_DISTRICT_ONLY";
  if (m.status === "AMBIGUOUS") return "AMBIGUOUS_NAME";
  return "MISSING_WARD";
}

// ─────────────────────────── (h) TIN NHẮC SAU KHI ĐƠN ĐÃ CHỐT ───────────────────────────

export type OutboundSource = "ERP_FOLLOWUP" | "AI_UNPROMPTED" | "PAGE_SIDE";
export type OutboundMsg = { at: Date; source: OutboundSource; text: string | null };
/** Câu NHẮC CHỐT («xác nhận đơn», «tiếp tục chốt đơn», «chốt đơn nhé») — đọc trên chữ đã bỏ dấu. */
const NUDGE_CONFIRM_RE = /\b(?:xac nhan|chot don|tiep tuc|len don|dat hang|gui di)\b/;

/** Tin bot / page là lời nhắc chốt đơn. HÀM THUẦN. */
export function isConfirmNudge(text: string): boolean {
  return NUDGE_CONFIRM_RE.test(foldVi(text));
}

/**
 * Tin CHỦ ĐỘNG gửi khách SAU mốc chốt đơn (+ `POST_ORDER_GRACE_MS`): tin không có tin khách nào trong `UNPROMPTED_GAP_MS` trước nó.
 * `ERP_FOLLOWUP` đọc sự kiện `followup.sent` (MEASURED); `AI_UNPROMPTED` / `PAGE_SIDE` suy từ khoảng cách tới tin khách (ESTIMATED).
 * HÀM THUẦN.
 */
export function postOrderOutbound(orderAt: Date, outbound: readonly OutboundMsg[], customerAts: readonly Date[]): OutboundMsg[] {
  const from = orderAt.getTime() + POST_ORDER_GRACE_MS;
  return outbound.filter((m) => {
    const t = m.at.getTime();
    if (t < from) return false;
    if (m.source === "ERP_FOLLOWUP") return true;
    return !customerAts.some((c) => c.getTime() <= t && t - c.getTime() <= UNPROMPTED_GAP_MS);
  });
}

// ─────────────────────────── «2KG» HAI CÁCH BIỂU DIỄN ───────────────────────────

export type WeightShape = "PACK" | "MULTI_UNIT" | "MIXED" | "UNKNOWN";
export type OrderLineWeight = { quantity: number; grams: number | null; isBonus: boolean };

/** Khối lượng một dòng đọc từ mã / tên / quy cách («CHA-CA-THU-2KG», «Quy cách 2kg (4 túi 0,5kg)») — khối lượng nhắc ĐẦU TIÊN. HÀM THUẦN. */
export function lineGrams(sku: string, name: string, variation: string, variantWeightGrams: number | null): number | null {
  for (const s of [variation, sku.replace(/[-_]/g, " "), name]) {
    const w = extractWeights(s)[0];
    if (w) return w.value;
  }
  return variantWeightGrams && variantWeightGrams > 0 ? variantWeightGrams : null;
}

/**
 * Tổng khối lượng của đơn và cách biểu diễn: MỘT dòng SL 1 (gói đúng khối lượng) ⇒ PACK; MỘT dòng SL ≥ 2 ⇒ MULTI_UNIT (vd 2 × 1kg);
 * nhiều dòng ⇒ MIXED; dòng nào chưa biết khối lượng ⇒ UNKNOWN (`grams = null`). Hàng tặng không tính. HÀM THUẦN.
 */
export function orderWeightShape(lines: readonly OrderLineWeight[]): { grams: number | null; shape: WeightShape } {
  const paid = lines.filter((l) => !l.isBonus);
  if (!paid.length || paid.some((l) => l.grams === null)) return { grams: null, shape: "UNKNOWN" };
  const grams = paid.reduce((s, l) => s + (l.grams ?? 0) * l.quantity, 0);
  if (paid.length > 1) return { grams, shape: "MIXED" };
  return { grams, shape: paid[0].quantity === 1 ? "PACK" : "MULTI_UNIT" };
}

// ─────────────────────────── (f) MẤT DOANH THU ───────────────────────────

export type FaultKind = "PRICE_MISMATCH" | "PRICE_DRIFT" | "FALSE_CONFIRM" | "HANDOFF_UNANSWERED" | "ADDRESS_FAIL" | "FOLLOWUP_AFTER_ORDER";
export type LostOutcome = "CANCELLED_AFTER_FAULT" | "SILENT_NO_ORDER" | "DECLINED";
export type LostSale = { outcome: LostOutcome; amount: number | null; amountSource: "ORDER" | "QUOTE" | null };

/**
 * Hội thoại có lỗi rồi mất đơn (ESTIMATED — căn cứ: lỗi xảy ra TRƯỚC kết cục, không chứng minh lỗi là nguyên nhân):
 *  · đơn nối được nay đã huỷ ⇒ tiền = tổng đơn huỷ (số đo được);
 *  · khách từ chối (`conversation.declined`) ⇒ tiền = số bot báo lớn nhất (ước);
 *  · không có đơn sống nào và khách im ≥ `SILENT_AFTER_FAULT_H` giờ kể từ lỗi đầu ⇒ tiền = số bot báo lớn nhất (ước).
 * Không có lỗi / còn đơn sống ⇒ `null`. HÀM THUẦN.
 */
export function lostSaleOf(i: { firstFaultAt: Date | null; liveOrders: number; cancelledTotal: number | null; cancelledCount: number; declined: boolean; lastCustomerAt: Date | null; maxQuoted: number | null; now: Date }): LostSale | null {
  if (!i.firstFaultAt || i.liveOrders > 0) return null;
  if (i.cancelledCount > 0) return { outcome: "CANCELLED_AFTER_FAULT", amount: i.cancelledTotal, amountSource: i.cancelledTotal === null ? null : "ORDER" };
  const quote = { amount: i.maxQuoted, amountSource: i.maxQuoted === null ? null : ("QUOTE" as const) };
  if (i.declined) return { outcome: "DECLINED", ...quote };
  const last = Math.max(i.firstFaultAt.getTime(), i.lastCustomerAt?.getTime() ?? 0);
  if (i.now.getTime() - last >= SILENT_AFTER_FAULT_H * 3_600_000) return { outcome: "SILENT_NO_ORDER", ...quote };
  return null;
}

// ─────────────────────────── TIỆN ÍCH IN ───────────────────────────

/** «n/d (x,y%)» kèm «mẫu nhỏ» khi d < ngưỡng; d = 0 ⇒ «CHƯA ĐO ĐƯỢC». HÀM THUẦN. */
export function rateText(n: number, d: number, minSample = INTEGRITY_MIN_SAMPLE): string {
  if (d <= 0) return "CHƯA ĐO ĐƯỢC (mẫu 0)";
  const pct = ((n / d) * 100).toFixed(1).replace(".", ",");
  return `${n}/${d} (${pct}%)${d < minSample ? " · mẫu nhỏ" : ""}`;
}

/** Tiền VND nguyên, nhóm nghìn bằng dấu chấm; `null` ⇒ «CHƯA ĐO ĐƯỢC». HÀM THUẦN. */
export function vndText(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "CHƯA ĐO ĐƯỢC";
  const sign = n < 0 ? "−" : "";
  return `${sign}${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
}

/** Tên gập để tìm: bỏ dấu, chữ thường, BỎ CẢ khoảng trắng («KimThu Le» khớp «kim thu le»). HÀM THUẦN. */
export function nameKey(s: string): string {
  return foldVi(s).replace(/\s+/g, "");
}

/** Tên ứng viên có chứa chuỗi tìm (đều đã gập, bỏ khoảng trắng). Chuỗi tìm < 3 ký tự ⇒ không khớp gì. HÀM THUẦN. */
export function nameMatches(query: string, candidate: string | null | undefined): boolean {
  const q = nameKey(query);
  return q.length >= 3 && typeof candidate === "string" && nameKey(candidate).includes(q);
}
