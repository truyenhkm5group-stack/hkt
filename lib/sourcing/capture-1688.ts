/**
 * ═══ BỘ ĐỌC TRANG CHI TIẾT 1688 (SRC-6) — HÀM THUẦN, CHỈ MÁY CHỦ GỌI ═══
 *
 * Tiện ích (`extensions/sourcing-1688/main-world.js`) đọc biến `window.context` của trang detail.1688.com — dữ liệu khởi tạo trang
 * nhúng sẵn — và CHỈ gửi các nhánh trong `PICK_PATHS_1688` (danh sách CHO PHÉP, không phải danh sách chặn: nhánh người xem như
 * buyerModel / loginId / *Sign không bao giờ rời trình duyệt). Máy chủ LỌC LẠI theo đúng danh sách ấy trước khi đọc / lưu.
 *
 * Đường dẫn đo trên 3 trang thật 25/10/2026 (683567693110 · 815636568273 · 835865258913, `tests/fixtures/sourcing-1688/`):
 *  · Giá theo bậc: `orderParam.skuParam.skuRangePrices` khi `skuPriceType = rangePrice` — đó là giá ĐẶT HÀNG. KHÔNG BAO GIỜ
 *    `finalPriceModel.onHandPrice` (新人价 «giá đến tay khách mới»: polo 835865258913 ghi ¥11.28, giá thật ¥17.28). Giá gạch ngang
 *    (`tradeWithoutPromotion.offerPriceRanges` / `originalPrices`, ¥24.00 ở polo) chỉ ghi để tham khảo, không vào bậc.
 *  · `skuPriceType = skuPrice` ⇒ giá ở TỪNG SKU (`skuInfoMapOriginal` trước, bản không khuyến mãi); `discountPrice` thấp hơn `price`
 *    là khuyến mãi ⇒ bỏ qua + cờ.
 *  · Bảng size: tên SKU của thuộc tính 尺码 («M （建议90~100斤）») — nằm trong JSON, không ở mô tả.
 *  · BẪY DỊCH Ở MÁY CHỦ 1688: tài khoản đặt Global / tiếng Việt ⇒ chính `window.context` trả tiêu đề + tên SKU đã dịch («M (khuyến nghị
 *    90 ~ 100 kg)»). Nhận ra bằng DỮ LIỆU: tiêu đề không có chữ CJK ⇒ cờ `TRANSLATED_BY_1688`, giá (số) vẫn lưu, KHÔNG đọc cân nặng.
 *  · Khối lượng: `productPackInfo.fields.unitWeight` (kg); 0 = KHÔNG KHAI ⇒ null.
 *  · Số năm trên 1688 (入驻N年): KHÔNG có trong JSON (chỉ trên giao diện) ⇒ null. Dropship: `consignModel.hasConsignPrice` cho biết
 *    có hay không, con số nằm ở thành phần tải riêng ⇒ null + cờ khi có. Tỷ lệ lấy hàng 24h / 48h: không có — chỉ có câu cam kết.
 */
import { SOURCING_CAPTURE_MAX_BYTES, type SourcingCaptureFlag } from "@/lib/constants/sourcing";
import type { CaptureFacts } from "@/lib/sourcing/capture";
import { parseCnyInput, parseHundredthsInput } from "@/lib/sourcing/price";

/** Danh sách CHO PHÉP — đường dẫn dưới `window.context`. Tiện ích giữ bản sao y hệt; bài kiểm so hai bản. */
export const PICK_PATHS_1688 = [
  "result.data.gallery.fields.subject",
  "result.data.gallery.fields.mainImage",
  "result.data.Root.fields.dataJson.tempModel.offerId",
  "result.data.Root.fields.dataJson.tempModel.offerTitle",
  "result.data.Root.fields.dataJson.tempModel.companyName",
  "result.data.Root.fields.dataJson.offerBaseInfo.sellerWinportUrl",
  "result.data.Root.fields.dataJson.skuModel.skuProps",
  "result.data.Root.fields.dataJson.skuModel.skuInfoMap",
  "result.data.Root.fields.dataJson.skuModel.skuInfoMapOriginal",
  "result.data.Root.fields.dataJson.orderParamModel.orderParam.beginNum",
  "result.data.Root.fields.dataJson.orderParamModel.orderParam.skuParam",
  "result.data.mainPrice.fields.priceModel.currentPrices",
  "result.data.mainPrice.fields.priceModel.originalPrices",
  "result.data.mainPrice.fields.finalPriceModel.onHandPrice",
  "result.data.mainPrice.fields.finalPriceModel.onHandPriceTypeText",
  "result.data.mainPrice.fields.finalPriceModel.tradeWithoutPromotion.offerBeginAmount",
  "result.data.mainPrice.fields.finalPriceModel.tradeWithoutPromotion.offerPriceRanges",
  "result.data.productTitle.fields.shopInfo.companyName",
  "result.data.productTitle.fields.shopInfo.byrRepeatRate3m",
  "result.data.productTitle.fields.shopInfo.sellerSlrServiceScore",
  "result.data.productTitle.fields.rateInfo.goodRates",
  "result.data.shippingServices.fields.location",
  "result.data.shippingServices.fields.deliveryLimitText",
  "result.data.productPackInfo.fields.unitWeight",
  "result.global.globalData.model.consignModel.hasConsignPrice",
] as const;

export type Picks1688 = Partial<Record<(typeof PICK_PATHS_1688)[number], unknown>>;

const PICK_SET: ReadonlySet<string> = new Set(PICK_PATHS_1688);

/** Đọc một đường dẫn chấm trong cây JSON. Không thấy ⇒ `undefined`. HÀM THUẦN. */
export function pickPath(root: unknown, path: string): unknown {
  let o: unknown = root;
  for (const k of path.split(".")) {
    if (!o || typeof o !== "object" || Array.isArray(o) || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o;
}

/** Cả `window.context` ⇒ chỉ các nhánh được phép (bài kiểm dựng «tiện ích gửi gì» từ tệp trang thật bằng hàm này). HÀM THUẦN. */
export function pickFromContext(context: unknown): Picks1688 {
  const out: Picks1688 = {};
  for (const p of PICK_PATHS_1688) {
    const v = pickPath(context, p);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/** Thân tiện ích gửi ⇒ chỉ khoá trong danh sách cho phép (khoá lạ bị BỎ, không lưu). `null` khi không phải object. HÀM THUẦN. */
export function filterPicks(raw: unknown): Picks1688 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Picks1688 = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (PICK_SET.has(k)) out[k as keyof Picks1688] = v;
  return out;
}

const CJK = /[㐀-鿿]/;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const unescapeHtml = (s: string) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** «17.28» / 17.28 ⇒ fen. Hỏng ⇒ null. */
function fenOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? parseCnyInput(v.toFixed(2)) : null;
  if (typeof v !== "string") return null;
  const f = parseCnyInput(v);
  return f !== null && f > 0 ? f : null;
}

function intOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 10_000_000 ? n : null;
}

/** «52.67%» ⇒ 5267 · «3.5分» ⇒ 350 · 73.9 ⇒ 7390. Hỏng ⇒ null. */
function hundredthsOf(v: unknown, max: number): number | null {
  const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/分|%/g, "") : "";
  const r = parseHundredthsInput(raw, max);
  return typeof r === "number" ? r : null;
}

// Tên thuộc tính theo cả chữ Trung gốc lẫn chữ 1688 đã DỊCH (tài khoản Global / tiếng Việt: «màu sắc», «kích cỡ» — đo 25/10 trên
// 951023546393). Không nhận ra size ⇒ cả khoá SKU dồn vào ô màu (vd «rượu vang đỏ / S.»), nhãn sai dù giá vẫn đúng.
const COLOR_PROP = /颜色|色|màu/i;
const SIZE_PROP = /尺码|尺寸|码数|size|kích cỡ|kích thước/i;
const WEIGHT_UNIT = /斤|公斤|千克|kg/i;

type SkuEntry = { price?: unknown; discountPrice?: unknown };

export type Parse1688Result = { ok: true; facts: CaptureFacts; extraFlags: SourcingCaptureFlag[]; picks: Picks1688 } | { ok: false; error: string };

/**
 * Nhánh đã lọc ⇒ dạng chuẩn. `offerId` lấy từ ĐƯỜNG DẪN trang (tiện ích gửi) và phải khớp mã trong dữ liệu — lệch ⇒ từ chối (dữ liệu
 * của trang khác). Không thấy tiêu đề lẫn giá ⇒ «không đọc được», không ghi gì. HÀM THUẦN.
 */
export function parse1688Detail(rawPicks: unknown, offerIdFromUrl: string): Parse1688Result {
  const picks = filterPicks(rawPicks);
  if (!picks) return { ok: false, error: "Không đọc được dữ liệu trang (window.context)." };
  if (JSON.stringify(picks).length > SOURCING_CAPTURE_MAX_BYTES) return { ok: false, error: "Dữ liệu trang quá lớn." };
  const p = (k: (typeof PICK_PATHS_1688)[number]) => picks[k];
  const dataId = p("result.data.Root.fields.dataJson.tempModel.offerId");
  if (dataId !== undefined && String(dataId) !== offerIdFromUrl) return { ok: false, error: "Mã sản phẩm trong dữ liệu trang khác mã trên đường dẫn — tải lại trang rồi bấm lại." };
  const title = str(p("result.data.gallery.fields.subject")) ?? str(p("result.data.Root.fields.dataJson.tempModel.offerTitle"));
  if (!title) return { ok: false, error: "Không thấy tiêu đề sản phẩm trong dữ liệu trang — trang chưa tải xong hoặc 1688 đã đổi cấu trúc." };
  const translated = !CJK.test(title);
  const extraFlags: SourcingCaptureFlag[] = translated ? ["TRANSLATED_BY_1688"] : [];

  // ── Thuộc tính SKU ⇒ vai trò từng vị trí trong khoá «màu&gt;size».
  const propsRaw = Array.isArray(p("result.data.Root.fields.dataJson.skuModel.skuProps")) ? (p("result.data.Root.fields.dataJson.skuModel.skuProps") as unknown[]) : [];
  const props = propsRaw.map((x) => {
    const o = (x ?? {}) as { prop?: unknown; value?: unknown };
    const names = Array.isArray(o.value) ? o.value.map((v) => str((v as { name?: unknown })?.name)).filter((s): s is string => !!s) : [];
    return { prop: str(o.prop) ?? "", names };
  });
  const sizeIdx = props.findIndex((x) => SIZE_PROP.test(x.prop));
  const colorIdx = props.findIndex((x, i) => i !== sizeIdx && COLOR_PROP.test(x.prop));

  // ── Giá từng SKU.
  const asMap = (v: unknown): Record<string, SkuEntry> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, SkuEntry>) : {});
  const infoMap = asMap(p("result.data.Root.fields.dataJson.skuModel.skuInfoMap"));
  const original = asMap(p("result.data.Root.fields.dataJson.skuModel.skuInfoMapOriginal"));
  const skuParam = (p("result.data.Root.fields.dataJson.orderParamModel.orderParam.skuParam") ?? {}) as { skuPriceType?: unknown; skuRangePrices?: unknown };
  const priceType = str(skuParam.skuPriceType);
  let promoSeen = fenOf(p("result.data.mainPrice.fields.finalPriceModel.onHandPrice")) !== null;
  const keys = [...new Set([...Object.keys(original), ...Object.keys(infoMap)])].slice(0, 500);
  const skus = keys.map((key) => {
    const parts = unescapeHtml(key).split(">");
    const size = sizeIdx >= 0 ? (parts[sizeIdx] ?? "") : "";
    const color = parts.filter((_, i) => i !== sizeIdx).join(" / ") || (colorIdx >= 0 ? (parts[colorIdx] ?? "") : "");
    const o = original[key] ?? {};
    const live = infoMap[key] ?? {};
    const price = fenOf(o.price) ?? fenOf(live.price);
    const disc = fenOf(live.discountPrice);
    if (price !== null && disc !== null && disc < price) promoSeen = true;
    // Giá theo bậc chung (rangePrice) ⇒ SKU không có giá riêng: null, không chép giá bậc vào từng dòng.
    return { color: color.slice(0, 100), size: size.slice(0, 100), priceFen: priceType === "rangePrice" ? null : price, dropshipFen: null };
  });

  // ── Bậc giá: chỉ giá ĐẶT HÀNG của bậc chung.
  let rangePrices: { fromQty: number; priceFen: number }[] | null = null;
  if (priceType === "rangePrice" && Array.isArray(skuParam.skuRangePrices)) {
    const tiers = skuParam.skuRangePrices.map((t) => {
      const o = (t ?? {}) as { beginAmount?: unknown; price?: unknown };
      return { fromQty: intOf(o.beginAmount), priceFen: fenOf(o.price) };
    });
    rangePrices = tiers.every((t) => t.fromQty !== null && t.priceFen !== null) ? (tiers as { fromQty: number; priceFen: number }[]) : [];
  }
  const moq =
    intOf(p("result.data.Root.fields.dataJson.orderParamModel.orderParam.beginNum")) ??
    intOf(p("result.data.mainPrice.fields.finalPriceModel.tradeWithoutPromotion.offerBeginAmount"));

  // ── Bảng size: chỉ khi tên size mang đơn vị cân nặng, và chỉ khi chữ là chữ GỐC.
  const sizeNames = sizeIdx >= 0 ? props[sizeIdx].names : [];
  const sizeText = sizeNames.filter((n) => WEIGHT_UNIT.test(n)).join("\n");
  const sizeChartZh = translated || !sizeText ? null : sizeText;

  // ── Nhà cung cấp.
  const shop = str(p("result.data.Root.fields.dataJson.offerBaseInfo.sellerWinportUrl"));
  const scores: { label: string; x100: number }[] = [];
  const service = hundredthsOf(p("result.data.productTitle.fields.shopInfo.sellerSlrServiceScore"), 500);
  if (service !== null) scores.push({ label: "服务分", x100: service });
  const good = hundredthsOf(p("result.data.productTitle.fields.rateInfo.goodRates"), 10_000);
  if (good !== null) scores.push({ label: "好评率 (%)", x100: good });

  const kg = p("result.data.productPackInfo.fields.unitWeight");
  const grams = typeof kg === "number" && Number.isFinite(kg) && kg > 0 ? Math.round(kg * 1000) : null;
  if (p("result.global.globalData.model.consignModel.hasConsignPrice") === true) extraFlags.push("DROPSHIP_UNREAD");

  const images = Array.isArray(p("result.data.gallery.fields.mainImage")) ? (p("result.data.gallery.fields.mainImage") as unknown[]).map(str).filter((s): s is string => !!s).slice(0, 20) : [];
  const facts: CaptureFacts = {
    offerId: offerIdFromUrl,
    titleZh: translated ? "" : title.slice(0, 300),
    titleTranslated: translated ? title.slice(0, 300) : null,
    imageUrls: images,
    rangePrices,
    moq,
    skus,
    dropshipFen: null,
    listPriceFen: fenOf((p("result.data.mainPrice.fields.priceModel.originalPrices") as { price?: unknown }[] | undefined)?.[0]?.price),
    promoSeen,
    promoLabel: str(p("result.data.mainPrice.fields.finalPriceModel.onHandPriceTypeText")),
    sizeChartZh,
    weightGrams: grams !== null && grams >= 1 && grams <= 100_000 ? grams : null,
    supplier: {
      name: (str(p("result.data.productTitle.fields.shopInfo.companyName")) ?? str(p("result.data.Root.fields.dataJson.tempModel.companyName")))?.slice(0, 200) ?? null,
      shopUrl: shop,
      yearsOnPlatform: null,
      repurchaseRateBp: hundredthsOf(p("result.data.productTitle.fields.shopInfo.byrRepeatRate3m"), 10_000),
      pickup24hBp: null,
      pickup48hBp: null,
      scores,
      shipFrom: str(p("result.data.shippingServices.fields.location"))?.slice(0, 200) ?? null,
      deliveryPromise: str(p("result.data.shippingServices.fields.deliveryLimitText"))?.slice(0, 200) ?? null,
    },
  };
  return { ok: true, facts, extraFlags, picks };
}
