/**
 * ═══════════ KHÁCH HUỶ VÌ LỖI CỦA BOT — XIN LỖI CỤ THỂ, SỬA ĐÚNG, MỘT LẦN GIỮ ĐƠN (P0 #863 · chủ shop 16/10/2026) ═══════════
 *
 * Ca HSLC 16/10/2026 (hội thoại 54cf199f…): khách đặt 1kg chả cá thu + «Lấy thêm 1/2 kg chả mực» ⇒ đơn nháp ghi 2kg chả mực + 1kg cá =
 * 1.060.000 ₫. Khách «Vậy anh ko mua nhé, hủy đơn» ⇒ bot giữ đơn bằng câu CHUNG («cần đổi món hay điều chỉnh gì…») — không nhận lỗi,
 * không sửa số; khách «Ko mua» ⇒ đơn vẫn nằm «CẦN XÁC THỰC», chỉ có dòng cảnh báo «Khách báo huỷ trong hội thoại».
 *
 * Luật chủ shop 16/10/2026 (sửa ở MÁY CHỦ, không ở lời nhắc):
 *  1. Khách huỷ RÕ RÀNG ngay sau một lỗi giá / số lượng của bot (đơn mang cờ món chưa đồng ý / giá, hoặc giỏ khách nói gần nhất lệch đơn
 *     nháp) ⇒ máy chủ trả lời: (a) xin lỗi CỤ THỂ — gọi tên cái sai; (b) sửa giỏ + tổng theo BÁO GIÁ MÁY CHỦ của chính giỏ khách nói
 *     (không bao giờ một con số model tự nghĩ); (c) đề nghị ĐÚNG MỘT phương án giữ đơn — đơn đã sửa.
 *  2. Khách từ chối lần nữa (hoặc khách huỷ lần hai sau lượt giữ đơn bất kỳ) ⇒ huỷ qua vòng đời đơn (`executeCustomerCancel`); chỉ nói
 *     «đã huỷ» khi CSDL đã ghi; đã giao ĐVVC / đã thu tiền / nhiều đơn ⇒ chuyển người, không khẳng định gì.
 *  3. Không bao giờ quá một lượt giữ đơn cho một lần huỷ.
 *
 * Tệp này THUẦN (không đọc CSDL): nhận diện câu huỷ, ghép giỏ khách nói ⇒ dòng hàng để máy chủ báo giá, dựng câu xin lỗi từ số MÁY CHỦ
 * đã tính, và nhận ra lời nhân viên báo tổng / món khác đơn nháp.
 */
import { amountText, classifyCartMessage, declinesAddOnOnly, labelsMatch, negatedCancel, type CartCommitment, type CartDraftDiff } from "@/lib/sales-chatbot/cart-commitment";
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { formatVND } from "@/lib/format";
import { foldVi } from "@/lib/sales-chatbot/text";

/**
 * Câu khách HUỶ cả đơn, rõ ràng: «hủy đơn», «ko mua», «không mua nữa», «thôi khỏi», «bỏ đơn đi» — đúng bộ nhận diện của giỏ có thẩm quyền
 * (`classifyCartMessage` ⇒ CANCEL, một định nghĩa). KHÔNG phải huỷ: câu hỏi («hủy được không?»), từ chối lời mời thêm món («không lấy
 * thêm»), câu có số lượng (sửa giỏ). HÀM THUẦN.
 */
export function explicitCancel(text: string): boolean {
  const t = text.trim();
  if (!t || /[?？]\s*$/.test(t)) return false;
  if (declinesAddOnOnly(t) || negatedCancel(t)) return false;
  return classifyCartMessage(t).kind === "CANCEL";
}

/** Mẫu mã đủ để ghép giỏ ⇒ dòng hàng (tập con của `CatalogItem` — bài kiểm dựng được). */
export type CatalogLite = { variantId: string; productId: string; name: string; price: number | null; weightGrams: number | null; addOnOnly?: boolean };

/**
 * GIỎ KHÁCH NÓI ⇒ DÒNG HÀNG để MÁY CHỦ báo giá (`computePriced`). Chỉ món khách nói TƯỜNG MINH. Mỗi món phải ra ĐÚNG MỘT sản phẩm (đã gắn
 * mã, hoặc tên khớp đúng một sản phẩm) và đo được: theo khối lượng ⇒ mẫu mã ĐÚNG khối lượng đó (kể cả mẫu mã chỉ bán kèm — giỏ có món chính),
 * không có thì N × mẫu mã lớn nhất chia hết; theo gói ⇒ sản phẩm chỉ có một mẫu mã bán riêng. Không chắc bất kỳ món nào ⇒ `null` (không
 * đoán — nơi gọi chuyển người). HÀM THUẦN.
 */
export function cartQuoteLines(cart: CartCommitment | undefined, catalog: readonly CatalogLite[]): { variantId: string; quantity: number }[] | null {
  const explicit = (cart?.selectedItems ?? []).filter((x) => x.customerExplicit && x.quantity > 0);
  if (!explicit.length) return null;
  const priced = catalog.filter((c) => c.price !== null && c.price > 0);
  const lines = new Map<string, number>();
  for (const item of explicit) {
    const pids = item.productId ? [item.productId] : [...new Set(priced.filter((c) => labelsMatch(item.match || item.label, c.name)).map((c) => c.productId))];
    if (pids.length !== 1) return null;
    const vs = priced.filter((c) => c.productId === pids[0]);
    let pick: { variantId: string; quantity: number } | null = null;
    if (item.unit === "g") {
      const exact = vs.find((v) => v.weightGrams === item.quantity);
      if (exact) pick = { variantId: exact.variantId, quantity: 1 };
      else {
        const div = vs.filter((v) => !v.addOnOnly && v.weightGrams && v.weightGrams > 0 && item.quantity % v.weightGrams === 0).sort((a, b) => (b.weightGrams ?? 0) - (a.weightGrams ?? 0))[0];
        if (div?.weightGrams) pick = { variantId: div.variantId, quantity: item.quantity / div.weightGrams };
      }
    } else if (!item.pieces) {
      const sellable = vs.filter((v) => !v.addOnOnly);
      if (sellable.length === 1) pick = { variantId: sellable[0].variantId, quantity: item.quantity };
    }
    if (!pick) return null;
    lines.set(pick.variantId, (lines.get(pick.variantId) ?? 0) + pick.quantity);
  }
  return [...lines.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/** Loại lỗi của bot mà khách huỷ ngay sau — quyết câu xin lỗi gọi tên cái gì. */
export type BotErrorKind = "QUANTITY" | "UNCONSENTED" | "PRICE" | "STAFF_CONFLICT";

/** Cờ cần người kiểm (`ORDER_REVIEW_CODES`) nói rằng đơn sai do máy ⇒ loại lỗi; còn lại ⇒ `null`. HÀM THUẦN. */
export function botErrorFromReview(codes: readonly string[]): BotErrorKind | null {
  if (codes.includes("UPSELL_UNCONSENTED")) return "UNCONSENTED";
  if (codes.includes("PRICE_MISMATCH") || codes.includes("PRICE_DISPUTED")) return "PRICE";
  return null;
}

/** Một dòng mô tả giỏ khách nói: «1kg Chả cá thu + 500g Chả mực giã tay». HÀM THUẦN. */
export function cartItemsText(cart: CartCommitment | undefined): string {
  return (cart?.selectedItems ?? [])
    .filter((x) => x.customerExplicit && x.quantity > 0)
    .map((x) => `${amountText(x.quantity, x.unit, x.pieces)} ${x.label}`.trim())
    .join(" + ");
}

/** Câu gọi tên lỗi: «em đã ghi nhầm số lượng: đơn ghi 2kg Chả mực giã tay trong khi mình đặt 500g». HÀM THUẦN. */
export function botErrorPhrase(kind: BotErrorKind, diffs: readonly CartDraftDiff[]): string {
  if (kind === "QUANTITY" && diffs.length) {
    const what = diffs.map((d) => (d.gotAmount === 0 ? `đơn thiếu ${d.want} ${d.label} mình đã đặt` : `đơn ghi ${d.got} ${d.label} trong khi mình đặt ${d.want}`)).join("; ");
    return `em đã ghi nhầm số lượng: ${what}`;
  }
  if (kind === "UNCONSENTED") return "em đã đưa vào đơn món / số lượng mình chưa đồng ý";
  if (kind === "STAFF_CONFLICT") return "đơn em ghi lệch với số shop đã báo mình";
  return "em đã báo sai giá đơn";
}

export type RecoveryOffer = { items: string; subtotal: number; total: number | null; shipFree: boolean };

/**
 * CÂU XIN LỖI + MỘT PHƯƠNG ÁN GIỮ ĐƠN — mọi số tiền lấy từ báo giá máy chủ (`offer`), không có chỗ cho số model nghĩ ra. Một lời đề nghị
 * duy nhất (đơn đã sửa) và để khách nói «không» dễ dàng. HÀM THUẦN.
 */
export function recoveryText(kind: BotErrorKind, diffs: readonly CartDraftDiff[], offer: RecoveryOffer): string {
  const money =
    offer.total === null
      ? `tiền hàng ${formatVND(offer.subtotal)}, phí ship nhân viên báo sau`
      : offer.shipFree || offer.total === offer.subtotal
        ? `tổng ${formatVND(offer.total)}${offer.shipFree ? " (miễn ship)" : ""}`
        : `tiền hàng ${formatVND(offer.subtotal)} + ship ${formatVND(offer.total - offer.subtotal)} = tổng ${formatVND(offer.total)}`;
  return `Dạ em xin lỗi mình ạ, ${botErrorPhrase(kind, diffs)}. Đơn đúng như mình đặt là ${offer.items}, ${money}. Nếu mình vẫn muốn nhận đúng đơn này thì nhắn em «ok» để em sửa ngay ạ; còn không em huỷ đơn giúp mình.`;
}

/** Câu khi huỷ ĐÃ GHI XONG trong CSDL (`cancelled = true`) — chỉ dùng sau khi lõi huỷ trả kết quả thật. HÀM THUẦN. */
export function cancelledText(shortCode: string | null, botError: boolean): string {
  return `Dạ em đã huỷ đơn${shortCode ? ` ${shortCode}` : ""} theo yêu cầu của mình rồi ạ.${botError ? " Em xin lỗi mình vì sơ suất của em." : ""} Khi cần mình nhắn shop nhé.`;
}

/** Không có đơn mở để huỷ (đơn chưa lên / đã huỷ trước đó): ghi nhận, không khẳng định «đã huỷ». HÀM THUẦN. */
export const DECLINE_NOTED_TEXT = "Dạ vâng, em ghi nhận mình không lấy nữa ạ. Khi cần mình nhắn shop nhé.";

// ─────────────────────────── LỜI NHÂN VIÊN LỆCH ĐƠN NHÁP ───────────────────────────

/** Chữ báo TỔNG ĐƠN NÀY («tổng 480k», «tất cả 480k», «thu hộ 480k») — «hết» / «cod» một mình không đủ («hết hàng», «cod 30k» là phí). */
const TOTAL_CUE_RE = /(?:^| )(?:tong|tat ca|ca thay|thanh tien|thu ho)(?: |$)/;
/** Mệnh đề nói PHÍ SHIP / ĐƠN GIÁ / ĐƠN CŨ / tổng CHƯA gồm ship — số trong đó không phải tổng đơn hiện tại (review #869). */
const NOT_TOTAL_RE = /(?:^| )(?:phi (?:ship|van chuyen|giao)|tien ship|cuoc|ship \d|chua (?:bao )?gom|don cu|don truoc|don hom|gia)(?: |$)|\/ ?(?:kg|ky|ki|hop|goi|hu)\b/;

/**
 * Nhân viên (tin phía page chép vào lịch sử) báo một TỔNG khác mọi tổng máy chủ của đơn nháp ⇒ số nhân viên nói (để ghi chú); khớp / không
 * nói tổng ⇒ `null`. Chỉ câu có chữ báo tổng mới tính — «1kg 280k» là đơn giá, không phải tổng. HÀM THUẦN.
 */
export function staffTotalConflict(staffTexts: readonly string[], draftTotals: readonly number[]): number | null {
  const known = new Set(draftTotals.filter((n) => Number.isFinite(n) && n > 0));
  if (!known.size) return null;
  for (const s of staffTexts) {
    for (const clause of s.split(/[,.;!?\n]+/)) {
      const f = foldVi(clause);
      if (!TOTAL_CUE_RE.test(f) || NOT_TOTAL_RE.test(f)) continue;
      const amounts = extractVndAmounts(clause).filter((a) => a >= 10_000);
      if (amounts.length && !amounts.some((a) => known.has(a))) return amounts[amounts.length - 1];
    }
  }
  return null;
}
