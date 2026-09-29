/**
 * ═══════════ ĐƠN GIÁ PHIẾU NHẬP HÀNG: GIÁ BÁO MKT HAY KHAI TAY (pilot P1 #9) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Tổ chức nhà: chủ shop chốt 25/09/2026 "luôn lấy giá báo MKT" — kho không nhập giá, máy chủ tự đặt đơn giá theo giá
 * báo của mã ở ngày nhập (`lib/inventory/receipt-pricing.ts`). Luật đó giả định có đội marketing khai giá báo; tổ chức
 * bán buôn không có sổ giá báo nào, nên mọi phiếu nhập của họ lưu với giá CHƯA BIẾT mãi mãi và giá vốn không bao giờ
 * có số.
 *
 * Cài đặt theo tổ chức `inventory.receiptPricing` = `"MKT_QUOTE"` | `"MANUAL"`. LUẬT CHỌN (một hàm, thứ tự cố định):
 *  1. Tổ chức NHÀ ⇒ LUÔN `MKT_QUOTE`, kể cả khi có ai lưu khoá này — quyết định của chủ shop nằm trong mã, đổi nó là
 *     việc phải hỏi chủ shop (AGENTS mục 7), không phải một dòng `settings`.
 *  2. Tổ chức khác đã LƯU một giá trị hợp lệ ⇒ đúng giá trị đó.
 *  3. Chưa lưu: đã có ÍT NHẤT MỘT dòng giá báo MKT ⇒ `MKT_QUOTE` (tổ chức ấy thật sự dùng giá báo); chưa có dòng
 *     nào ⇒ `MANUAL` — không có giá báo thì đòi giá báo là đòi thứ không tồn tại.
 * Giá trị lạ (gõ tay) bị bỏ qua như chưa lưu.
 *
 * `MANUAL`: phiếu NHẬP HÀNG MỚI nhận đơn giá người lập gõ trên từng dòng; ô bỏ trống = 0 = CHƯA BIẾT giá (cùng nghĩa với
 * phiếu nhập thiếu giá báo — `LAST_RECEIPT_COST` bỏ qua dòng giá 0). Loại phiếu khác không đổi gì.
 */

export const RECEIPT_PRICING_SETTING_KEY = "inventory.receiptPricing";
export const RECEIPT_PRICING_MODES = ["MKT_QUOTE", "MANUAL"] as const;
export type ReceiptPricingMode = (typeof RECEIPT_PRICING_MODES)[number];

export type ReceiptPricingSource = "HOME_FIXED" | "SAVED" | "HAS_MKT_QUOTES" | "NO_MKT_QUOTES";
export type ReceiptPricingResolution = { mode: ReceiptPricingMode; source: ReceiptPricingSource };

export const RECEIPT_PRICING_LABEL: Readonly<Record<ReceiptPricingMode, string>> = {
  MKT_QUOTE: "Theo giá báo MKT",
  MANUAL: "Khai đơn giá trên phiếu",
};

export const RECEIPT_PRICING_SOURCE_LABEL: Readonly<Record<ReceiptPricingSource, string>> = {
  HOME_FIXED: "tổ chức nhà — chủ shop chốt 25/09/2026",
  SAVED: "đã chọn trong cài đặt",
  HAS_MKT_QUOTES: "mặc định — tổ chức đã có giá báo MKT",
  NO_MKT_QUOTES: "mặc định — tổ chức chưa có giá báo MKT nào",
};

export function isReceiptPricingMode(v: unknown): v is ReceiptPricingMode {
  return typeof v === "string" && (RECEIPT_PRICING_MODES as readonly string[]).includes(v);
}

export function resolveReceiptPricingMode(input: { isHome: boolean; saved: unknown; hasMarketerPrices: boolean }): ReceiptPricingResolution {
  if (input.isHome) return { mode: "MKT_QUOTE", source: "HOME_FIXED" };
  if (isReceiptPricingMode(input.saved)) return { mode: input.saved, source: "SAVED" };
  return input.hasMarketerPrices ? { mode: "MKT_QUOTE", source: "HAS_MKT_QUOTES" } : { mode: "MANUAL", source: "NO_MKT_QUOTES" };
}
