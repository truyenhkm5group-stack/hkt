/**
 * ═══ MỘT LẦN CHỤP TRANG CHI TIẾT — DẠNG CHUẨN + LUẬT DẪN XUẤT (SRC-6) — HÀM THUẦN ═══
 *
 * Hai đường cùng đổ vào đây: tiện ích Chrome (`EXTENSION`, bộ đọc `lib/sourcing/capture-1688.ts`) và — khi chủ shop đã đăng ký
 * 采购服务商 — lời gọi API chính thức (`API`). Mỗi đường tự đọc nguồn của nó ra `CaptureFacts`; từ đó trở đi chỉ có MỘT bộ luật:
 *  · GIÁ MUA chỉ là giá của TRANG CHI TIẾT: bậc giá theo số lượng nếu trang có; không có bậc mà mọi SKU cùng một giá ⇒ một bậc từ
 *    MOQ; SKU khác giá nhau ⇒ KHÔNG chọn hộ (cờ `SKU_PRICES_DIFFER`). Giá khuyến mãi / 新人价 / giá thẻ tìm kiếm KHÔNG BAO GIỜ là giá
 *    mua (đo 25/10: polo 835865258913 thẻ ¥11.28, giá thật ¥17.28). Thiếu ⇒ `tiers = null` ⇒ giá về CHƯA BIẾT.
 *  · Bảng size đọc từ chữ Trung gốc (`parseSizeChart`) — không bao giờ từ bản dịch.
 *  · Mọi số thiếu là `null`, không 0 (AGENTS 42).
 */
import { z } from "zod";
import { SOURCING_PRICE_TIERS_MAX, type SourcingCaptureFlag } from "@/lib/constants/sourcing";
import { validatePriceTiers, type PriceTier } from "@/lib/sourcing/price";
import { parseSizeChart, type SizeChart } from "@/lib/sourcing/size-chart";

const fen = z.number().int().min(1).max(100_000_000);
const bp = z.number().int().min(0).max(10_000);
const text = (max: number) => z.string().max(max);

/** Dạng chuẩn của một lần chụp — đầu ra của MỌI bộ đọc nguồn. */
export const captureFactsSchema = z.object({
  offerId: z.string().regex(/^\d{6,20}$/, "Mã sản phẩm 1688 là chuỗi số"),
  titleZh: text(300),
  /** Tiêu đề 1688 đã dịch ở máy chủ của họ (tài khoản Global / tiếng Việt) — chỉ để người đọc nhận ra mẫu. */
  titleTranslated: text(300).nullable(),
  imageUrls: z.array(text(2000)).max(20),
  /** Bậc giá theo số lượng của trang chi tiết (fen). `null` = trang không có bậc. */
  rangePrices: z.array(z.object({ fromQty: z.number().int(), priceFen: z.number().int() })).max(20).nullable(),
  moq: z.number().int().min(1).max(10_000_000).nullable(),
  /** Giá từng SKU (màu × size) của trang chi tiết; `priceFen` null = SKU không ghi giá riêng. */
  skus: z
    .array(z.object({ color: text(100), size: text(100), priceFen: fen.nullable(), dropshipFen: fen.nullable() }))
    .max(500),
  /** Giá dropship / 一件代发 chung của trang (nếu có). */
  dropshipFen: fen.nullable(),
  /** Giá gạch ngang của trang — CHỈ THAM KHẢO, không vào bậc giá. */
  listPriceFen: fen.nullable(),
  /** Trang CÓ giá khuyến mãi / giá khách mới — đã bỏ qua, chỉ để gắn cờ. */
  promoSeen: z.boolean(),
  /** Nhãn giá khuyến mãi như trang ghi (vd «新人价»). */
  promoLabel: text(50).nullable(),
  /** Chữ bảng size GỐC (chữ Trung, chưa dịch). */
  sizeChartZh: text(20_000).nullable(),
  /** Khối lượng một cái (gam). */
  weightGrams: z.number().int().min(1).max(100_000).nullable(),
  supplier: z.object({
    name: text(200).nullable(),
    shopUrl: text(2000).nullable(),
    /** Số năm trên 1688 (入驻N年 / tpYear). */
    yearsOnPlatform: z.number().int().min(0).max(100).nullable(),
    /** Tỷ lệ khách quay lại (回头率), ×100 (%). */
    repurchaseRateBp: bp.nullable(),
    /** Tỷ lệ lấy hàng trong 24 giờ / 48 giờ, ×100 (%). */
    pickup24hBp: bp.nullable(),
    pickup48hBp: bp.nullable(),
    /** Các điểm dịch vụ / giao hàng như trang ghi: nhãn gốc + điểm ×100. */
    scores: z.array(z.object({ label: text(100), x100: z.number().int().min(0).max(100_000) })).max(20),
    /** Nơi gửi hàng (发货地). */
    shipFrom: text(200).nullable(),
    /** Câu cam kết giao như trang ghi (vd «承诺48小时发货») — lời hứa, không phải tỷ lệ đo được. */
    deliveryPromise: text(200).nullable(),
  }),
});

export type CaptureFacts = z.infer<typeof captureFactsSchema>;

export type CaptureDerived = {
  /** Bậc giá đưa vào ảnh chụp giá; `null` ⇒ không chụp bậc (giá về CHƯA BIẾT). */
  tiers: PriceTier[] | null;
  /** `{ colors, sizes }` cho ảnh chụp giá — chữ như trang ghi. */
  skuLabels: { colors: string[]; sizes: string[] } | null;
  sizeChart: SizeChart | null;
  flags: SourcingCaptureFlag[];
};

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/**
 * Luật dẫn xuất của một lần chụp. `sourceFlags` = cờ bộ đọc nguồn đã kết luận (vd `TRANSLATED_BY_1688`). HÀM THUẦN — cùng đầu
 * vào ra cùng đầu ra.
 */
export function deriveCapture(f: CaptureFacts, sourceFlags: readonly SourcingCaptureFlag[] = []): CaptureDerived {
  const flags: SourcingCaptureFlag[] = [...sourceFlags];
  let tiers: PriceTier[] | null = null;
  if (f.rangePrices !== null) {
    // Trang có bậc chung: dùng NGUYÊN bậc của trang; hỏng ⇒ không ghi bậc nào (không sửa hộ, không lùi về giá SKU).
    const sorted = [...f.rangePrices].sort((a, b) => a.fromQty - b.fromQty);
    if (sorted.length && sorted.length <= SOURCING_PRICE_TIERS_MAX && !validatePriceTiers(sorted)) tiers = sorted;
    else flags.push("TIERS_INVALID");
  } else {
    const prices = uniq(f.skus.map((s) => (s.priceFen === null ? "" : String(s.priceFen))));
    if (prices.length === 1) {
      const one = [{ fromQty: f.moq ?? 1, priceFen: Number(prices[0]) }];
      if (!validatePriceTiers(one)) tiers = one;
    } else if (prices.length > 1) flags.push("SKU_PRICES_DIFFER");
  }
  if (!tiers && !flags.includes("SKU_PRICES_DIFFER") && !flags.includes("TIERS_INVALID")) flags.push("NO_DETAIL_PRICE");
  if (f.promoSeen) flags.push("PROMO_PRICE_IGNORED");

  const sizeChart = parseSizeChart(f.sizeChartZh);
  // Dữ liệu đã dịch ⇒ «không có bảng size» là vì không được đọc, không phải trang không có — cờ dịch đã nói điều đó.
  if (!sizeChart && !flags.includes("TRANSLATED_BY_1688")) flags.push("SIZE_CHART_MISSING");
  else if (sizeChart && !sizeChart.rows.length) flags.push("SIZE_CHART_UNPARSED");
  if (f.weightGrams === null) flags.push("WEIGHT_UNKNOWN");

  const colors = uniq(f.skus.map((s) => s.color));
  const sizes = uniq(f.skus.map((s) => s.size));
  return { tiers, skuLabels: colors.length || sizes.length ? { colors, sizes } : null, sizeChart, flags };
}
