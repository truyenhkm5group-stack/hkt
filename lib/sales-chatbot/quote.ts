/**
 * ═══════════ BÁO GIÁ MÁY CHỦ — MỘT HÀM DUY NHẤT (P0 authoritative-quote, chủ shop 11/10/2026) ═══════════
 *
 * Sự cố HSLC 10–11/10/2026: cùng «2kg chả cá thu», khách nghe 540.000 ₫ ở chỗ này và 560.000 ₫ ở chỗ kia; đơn nháp ghi 560.000 ₫.
 * Nguyên nhân gốc: «2kg» có HAI biểu diễn trong danh mục — mẫu mã gói 2kg (`CHA-CA-THU-2KG` = 540.000 ₫) và 2 × mẫu mã 1kg
 * (2 × 280.000 = 560.000 ₫) — và BỐN đường nói ra số tiền đọc bốn nguồn khác nhau:
 *  · câu mẫu `{{giá:SKU}}` đọc thẳng `retail_price` của gói 2kg (quick-replies.ts `renderQuickAnswer`);
 *  · `search_products` / `get_product` trả `retail_price` thô của từng mẫu mã (tools.ts `itemView`);
 *  · `priceLines` quy gói lớn về gói đơn vị + trừ giảm theo khối lượng CHỈ khi nhận ra được gói đơn vị (khối lượng có thật);
 *    mẫu mã 1kg không mang khối lượng ⇒ không quy, không giảm ⇒ 2 × 1kg = 560.000 ₫ còn gói 2kg vẫn 540.000 ₫;
 *  · lõi đơn (`agentPriceProblems`) từ chối MỌI chiết khấu của máy ⇒ khi luật giảm chạy đúng thì đơn ≥ 2kg lại không ghi được.
 * Và không một kiểm nào của MÁY CHỦ đứng trên con số trong chữ bot gửi khách.
 *
 * Tệp này là NƠI DUY NHẤT tính tiền cho đường agent: `computePriced` (thuần) — `priceLines` của công cụ, giá hiển thị của công cụ
 * đọc, tập số tham chiếu cho hàng rào số tiền, và phép tính lại ở lõi đơn (`verifyAgentQuote`) đều đi qua nó.
 *
 * LUẬT CHỌN BIỂU DIỄN (khai rõ, không đoán theo giá rẻ hơn):
 *  · Chủ shop BẬT «bán theo gói đơn vị + giảm theo khối lượng» ⇒ gói đơn vị là biểu diễn DUY NHẤT (máy chủ quy gói lớn về N × gói
 *    đơn vị). Gói lớn còn trong danh mục mà giá ≠ N × gói đơn vị − giảm đã khai ⇒ CATALOG MÂU THUẪN ⇒ `verified = false`
 *    (`PACK_PRICE_CONFLICT`) cho tới khi chủ shop sửa giá / gỡ gói. Không nhận ra gói đơn vị (mẫu mã thiếu khối lượng) trong khi
 *    có gói lớn ⇒ `UNIT_PACK_UNKNOWN`; dòng thiếu khối lượng nhiều đơn vị ⇒ `WEIGHT_UNKNOWN` — giảm theo khối lượng không quyết
 *    được, máy không đoán.
 *  · Luật TẮT ⇒ mỗi mẫu mã là một giá riêng; khách nói đúng khối lượng của một gói có sẵn mà AI lên N × gói nhỏ (giá khác) ⇒ công
 *    cụ trả câu sửa (`packChoiceMistake`): «khối lượng có gói riêng ⇒ dùng đúng gói đó», trừ khi khách nói rõ số túi.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { agentUnitQuote, bookListsVariant, priceBooksForMode, type AgentPricingMode, type PriceBooks } from "@/lib/commerce/pricing";
import { formatVND } from "@/lib/format";
import { sellableCatalog, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { freeShipVerdict, variantWeightGrams, type ShipVerdict } from "@/lib/sales-chatbot/shipping";
import { foldVi } from "@/lib/sales-chatbot/text";
import { toUnitPacks, volumeDiscountFor } from "@/lib/sales-chatbot/volume-discount";
import type { Quote, QuoteIssue } from "@/lib/sales-chatbot/quote-shared";

export type CartLine = { variantId: string; quantity: number };

/** Phần cấu hình quyết tiền — luật giảm theo khối lượng, miễn ship, phí ship, báo giá sỉ. */
export type PricingConfig = Pick<SalesChatbotConfig, "volumeDiscount" | "freeShipping" | "shippingFee" | "wholesalePricing">;

/** Hai field quy cách của mẫu thực phẩm — nguồn khối lượng khi cột weight chưa nhập. Luôn đọc: luật chọn gói cần khối lượng. */
const WEIGHT_FIELDS = ["net_weight", "package_size"] as const;

type PackItem = { variantId: string; productId: string; name: string; price: number | null; weightGrams: number | null; addOnOnly: boolean };

/** Ngữ cảnh tính giá đã dựng sẵn (một lượt đọc danh mục) — `computePriced` thuần trên nó. */
export type PricingContext = {
  cfg: PricingConfig;
  books: PriceBooks;
  byId: ReadonlyMap<string, CatalogItem>;
  weight: ReadonlyMap<string, number | null>;
  byProduct: ReadonlyMap<string, readonly CatalogItem[]>;
};

export type Priced = {
  ship: ShipVerdict;
  /** Dòng hàng SAU khi quy về gói đơn vị (`toUnitPacks`) — đúng những dòng ghi vào đơn. `lineTotal` = đơn giá × SL − `discount`. */
  lines: { variantId: string; name: string; quantity: number; unitPrice: number; lineTotal: number; /** Tiền giảm của cả dòng (luật giảm theo khối lượng). */ discount: number; /** Khối lượng MỘT đơn vị mẫu mã (gram) — `null` khi không biết. */ weightGrams?: number | null; /** Nguồn đơn giá: giá lẻ hay bảng giá sỉ (bảng riêng / mặc định). */ priceSource?: "RETAIL" | "CUSTOMER_LIST" | "DEFAULT_LIST" }[];
  /** Dòng hàng AI GỬI LÊN (trước khi quy gói) — để bắt nhầm quy cách thành số lượng trên đúng thứ AI chọn. */
  asked: { variantId: string; productId: string | null; name: string; quantity: number; weightGrams: number | null }[];
  subtotal: number;
  shippingFee: number | null;
  total: number | null;
  unpriced: string[];
  missing: string[];
  /** Mọi dòng là mẫu mã chỉ bán kèm (0238). */
  addOnOnly?: boolean;
  /** Catalog mâu thuẫn với luật đã khai — báo giá CHƯA XÁC THỰC (xem đầu tệp). */
  issues: QuoteIssue[];
  /** Các gói bán được (có khối lượng) của những sản phẩm trong giỏ — cho luật chọn gói khi luật giảm TẮT. */
  packOptions: PackItem[];
};

const label = (it: CatalogItem) => `${it.name}${it.variant ? ` (${it.variant})` : ""}`;
const kgText = (g: number) => (g % 1000 === 0 ? `${g / 1000}kg` : g >= 1000 ? `${(g / 1000).toLocaleString("vi-VN")}kg` : `${g}g`);
const weightOf = (it: CatalogItem) => variantWeightGrams(it.weightGrams, it.variant, it.name, it.fields.net_weight ?? "", it.fields.package_size ?? "");

/** Dựng ngữ cảnh từ danh mục đã đọc — HÀM THUẦN (bài kiểm dựng danh mục giả được). */
export function pricingContextOf(catalog: readonly CatalogItem[], cfg: PricingConfig, books: PriceBooks): PricingContext {
  const byId = new Map(catalog.map((c) => [c.variantId, c]));
  const weight = new Map(catalog.map((c) => [c.variantId, weightOf(c)]));
  const byProduct = new Map<string, CatalogItem[]>();
  for (const c of catalog) byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c]);
  return { cfg, books, byId, weight, byProduct };
}

/** Một lượt đọc danh mục + bảng giá. `books` = bảng giá theo chế độ (null = giá lẻ). */
export async function loadPricingContext(cfg: PricingConfig, books: PriceBooks, db?: Db): Promise<PricingContext> {
  return pricingContextOf(await sellableCatalog([...WEIGHT_FIELDS], undefined, db), cfg, books);
}

/** Đơn / giỏ CHỈ gồm mẫu mã bán kèm ⇒ không bán (0238). HÀM THUẦN. */
export function onlyAddOns(lines: readonly { variantId: string }[], items: ReadonlyMap<string, Pick<CatalogItem, "addOnOnly">>): boolean {
  return lines.length > 0 && lines.every((l) => items.get(l.variantId)?.addOnOnly === true);
}

/**
 * Tính tiền MỘT giỏ — HÀM THUẦN trên ngữ cảnh đã dựng. `address` = địa chỉ giao (luật miễn ship theo khu vực); `null` khi chưa biết.
 * Thứ tự: quy gói đơn vị (luật bật) → đơn giá (giá lẻ / bảng giá) → giảm theo khối lượng từng sản phẩm → kiểm mâu thuẫn catalog →
 * phí ship.
 */
export function computePriced(lines: readonly CartLine[], ctx: PricingContext, address: string | null = null): Priced {
  const { cfg, books, byId, weight } = ctx;
  const rule = cfg.volumeDiscount;
  const products = [...new Set(lines.map((l) => byId.get(l.variantId)?.productId).filter((x): x is string => Boolean(x)))];
  const sub = products.flatMap((p) => ctx.byProduct.get(p) ?? []);
  const asked = lines.map((l) => {
    const it = byId.get(l.variantId);
    return { variantId: l.variantId, productId: it?.productId ?? null, name: it ? label(it) : l.variantId, quantity: l.quantity, weightGrams: it ? (weight.get(it.variantId) ?? null) : null };
  });
  // BÁN THEO GÓI ĐƠN VỊ (10/10/2026, volume-discount.ts): AI chọn gói lớn ⇒ máy chủ quy về N × gói đơn vị của cùng sản phẩm. Mẫu mã có
  // dòng RIÊNG trong bảng giá sỉ đang dùng thì giữ nguyên (giá bảng của chính gói đó thắng — không quy sang gói khác).
  const inBook = lines.filter((l) => bookListsVariant(books, l.variantId));
  const effective = [...toUnitPacks(lines.filter((l) => !bookListsVariant(books, l.variantId)), sub.map((c) => ({ variantId: c.variantId, productId: c.productId, price: c.price, weightGrams: weight.get(c.variantId) ?? null, ...(c.addOnOnly ? { addOnOnly: true } : {}) })), rule), ...inBook];
  const out: Priced["lines"] = [];
  const unpriced: string[] = [];
  const missing: string[] = [];
  for (const l of effective) {
    const it = byId.get(l.variantId);
    // MỘT công thức với lõi đơn (lib/commerce/pricing.ts) — lõi tính lại đúng hàm này và từ chối đơn lệch giá.
    const unit = it ? agentUnitQuote({ variantId: it.variantId, quantity: l.quantity, retailPrice: it.price, books }) : null;
    if (!it) missing.push(l.variantId);
    else if (unit === null) unpriced.push(it.name);
    else out.push({ variantId: l.variantId, name: label(it), quantity: l.quantity, unitPrice: unit.unitPrice, lineTotal: unit.unitPrice * l.quantity, discount: 0, weightGrams: weight.get(it.variantId) ?? null, priceSource: unit.source });
  }
  const issues: QuoteIssue[] = [];
  // GIẢM THEO KHỐI LƯỢNG — từng SẢN PHẨM; tiền giảm đặt vào dòng lớn nhất của sản phẩm (không vượt tiền dòng).
  // P0 11/10/2026 (ca «Phạm Minh Ái»: 2kg chả cá thu 560.000 thay vì 540.000, tổng 960.000 thay vì 940.000): trước đây cả khối này nằm
  // trong `if (!books)` — tổ chức BẬT «báo giá sỉ» thì `books` luôn khác null (bảng mặc định), nên MỌI khách, kể cả khách lẻ mua đúng
  // giá lẻ, mất giảm theo khối lượng. Luật nay đi theo NGUỒN GIÁ TỪNG DÒNG: sản phẩm mà mọi dòng là GIÁ LẺ ⇒ giảm áp như chế độ giá lẻ;
  // sản phẩm có dòng giá BẢNG SỈ ⇒ theo bảng, KHÔNG cộng thêm giảm khối lượng (bậc sỉ đã là giá theo số lượng — cộng là giảm hai lần).
  {
    const byProduct = new Map<string, Priced["lines"]>();
    for (const l of out) {
      const pid = byId.get(l.variantId)!.productId;
      byProduct.set(pid, [...(byProduct.get(pid) ?? []), l]);
    }
    for (const [pid, group] of byProduct) {
      if (group.some((l) => l.priceSource !== "RETAIL")) continue;
      const grams = group.every((l) => l.weightGrams != null) ? group.reduce((g, l) => g + l.weightGrams! * l.quantity, 0) : null;
      const d = volumeDiscountFor(grams, rule);
      if (d) {
        const top = group.reduce((a, b) => (b.lineTotal > a.lineTotal ? b : a));
        top.discount = Math.min(d, top.lineTotal);
        top.lineTotal -= top.discount;
      }
      issues.push(...catalogConflicts(pid, group, grams, asked.filter((a) => a.productId === pid), ctx));
    }
  }
  const subtotal = out.reduce((s, l) => s + l.lineTotal, 0);
  // Khối lượng đơn: một dòng không biết khối lượng ⇒ cả đơn KHÔNG xét ngưỡng khối lượng (không đoán).
  let weightSum: number | null = 0;
  for (const l of out) weightSum = weightSum === null || l.weightGrams == null ? null : weightSum + l.weightGrams * l.quantity;
  const ship = freeShipVerdict(cfg.freeShipping, subtotal, weightSum, address, formatVND);
  const shippingFee = ship.kind === "FREE" ? 0 : cfg.shippingFee;
  const packOptions: PackItem[] = sub.map((c) => ({ variantId: c.variantId, productId: c.productId, name: label(c), price: c.price, weightGrams: weight.get(c.variantId) ?? null, addOnOnly: Boolean(c.addOnOnly) }));
  return { ship, lines: out, asked, subtotal, shippingFee, total: shippingFee === null ? null : subtotal + shippingFee, unpriced, missing, ...(onlyAddOns(lines, byId) ? { addOnOnly: true } : {}), issues, packOptions };
}

/**
 * Mâu thuẫn giữa catalog và luật giảm theo khối lượng cho MỘT sản phẩm của giỏ. HÀM THUẦN. Ba mã (`WEIGHT_UNKNOWN` xét cả khi luật
 * TẮT — không có khối lượng thì không đối chiếu được N × gói này với gói lớn, kể cả để chọn gói; hai mã kia chỉ khi luật BẬT):
 *  · `UNIT_PACK_UNKNOWN` — giỏ có gói lớn (bội số gói đơn vị) nhưng không nhận ra gói đơn vị nào, và sản phẩm còn mẫu mã thiếu khối
 *    lượng: gói 2kg không quy được về 2 × 1kg ⇒ chính là cách «2kg» ra 540.000 ₫ (gói) ở đơn này và 560.000 ₫ (2 × 1kg) ở đơn kia;
 *  · `WEIGHT_UNKNOWN` — dòng thiếu khối lượng, nhiều đơn vị, trong khi sản phẩm có mẫu mã mang khối lượng: giảm không quyết được.
 *    Một đơn vị của một mẫu mã thì không mơ hồ (giá chính nó) — không gắn, để bán lẻ 1 gói vẫn chạy;
 *  · `PACK_PRICE_CONFLICT` — gói lớn trong danh mục có giá ≠ N × gói đơn vị − giảm đã khai, và giỏ ĐÚNG khối lượng đó (hoặc AI chọn
 *    đúng gói đó): hai biểu diễn, hai số tiền ⇒ chủ shop xác nhận.
 */
function catalogConflicts(pid: string, group: Priced["lines"], grams: number | null, askedP: Priced["asked"], ctx: PricingContext): QuoteIssue[] {
  const rule = ctx.cfg.volumeDiscount;
  const U = rule.unitGrams;
  const items = (ctx.byProduct.get(pid) ?? []).filter((c) => !c.addOnOnly && c.price !== null && c.price > 0);
  const name = ctx.byProduct.get(pid)?.[0]?.name ?? pid;
  const w = (c: { variantId: string }) => ctx.weight.get(c.variantId) ?? null;
  const unit = (ctx.byProduct.get(pid) ?? []).find((c) => w(c) === U && c.price !== null && !c.addOnOnly);
  const unknownWeight = items.some((c) => w(c) === null);
  const out: QuoteIssue[] = [];
  const bigAsked = askedP.find((a) => a.weightGrams !== null && a.weightGrams > U && a.weightGrams % U === 0);
  if (rule.enabled && !unit && bigAsked && unknownWeight) {
    out.push({ code: "UNIT_PACK_UNKNOWN", detail: `«${name}»: không nhận ra gói đơn vị ${kgText(U)} (mẫu mã thiếu khối lượng) — gói ${kgText(bigAsked.weightGrams!)} chưa đối chiếu được với ${bigAsked.weightGrams! / U} × ${kgText(U)}` });
  }
  const single = askedP.length === 1 && askedP[0].quantity === 1;
  if (!single && group.some((l) => l.weightGrams == null) && items.some((c) => w(c) !== null)) {
    out.push({ code: "WEIGHT_UNKNOWN", detail: `«${name}»: mẫu mã chưa khai khối lượng — không tính được giảm theo khối lượng` });
  }
  if (rule.enabled && unit && unit.price !== null && unit.price > 0) {
    for (const p of items) {
      const W = w(p);
      if (p.variantId === unit.variantId || W === null || W <= U || W % U !== 0) continue;
      const expected = (W / U) * unit.price - volumeDiscountFor(W, rule);
      const relevant = grams === W || askedP.some((a) => a.variantId === p.variantId);
      if (relevant && p.price !== expected) {
        out.push({ code: "PACK_PRICE_CONFLICT", detail: `«${name}»: gói ${kgText(W)} trong danh mục ${formatVND(p.price)} ≠ ${W / U} × ${kgText(U)} − giảm theo khối lượng = ${formatVND(expected)} — chủ shop xác nhận giá nào đúng` });
      }
    }
  }
  return out;
}

const sha = (v: unknown, n: number) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, n);

/** Phiên bản giá: dữ liệu giá đang áp cho các sản phẩm của giỏ + luật tiền. Đổi một con số ⇒ đổi phiên bản. HÀM THUẦN. */
export function priceVersionOf(priced: Pick<Priced, "packOptions" | "lines">, ctx: Pick<PricingContext, "cfg" | "books">): string {
  const prices = [...priced.packOptions.map((p) => [p.variantId, p.price]), ...priced.lines.map((l) => [`u:${l.variantId}:${l.quantity}`, l.unitPrice])].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const c = ctx.cfg;
  return `pv1-${sha({ mode: ctx.books ? "BOOK" : "RETAIL", prices, vd: c.volumeDiscount, fs: c.freeShipping, ship: c.shippingFee }, 12)}`;
}

/**
 * Báo giá từ một giỏ đã tính — HÀM THUẦN. `verified = false` khi: mẫu mã không có / chưa có giá / chỉ bán kèm / giỏ rỗng / catalog
 * mâu thuẫn. Chỉ báo giá đã xác thực mới mang `amounts` (số bot được phép nói).
 */
export function buildQuote(priced: Priced, ctx: Pick<PricingContext, "cfg" | "books">): Quote {
  const reasons: QuoteIssue[] = [
    ...priced.missing.map((v) => ({ code: "MISSING_SKU" as const, detail: `Không có mẫu mã ${v}` })),
    ...priced.unpriced.map((n) => ({ code: "UNPRICED" as const, detail: `«${n}» chưa có giá bán` })),
    ...(priced.addOnOnly ? [{ code: "ADD_ON_ONLY" as const, detail: "Giỏ chỉ có mẫu mã chỉ bán kèm" }] : []),
    ...(!priced.lines.length && !priced.missing.length && !priced.unpriced.length ? [{ code: "EMPTY" as const, detail: "Giỏ trống" }] : []),
    ...priced.issues,
  ];
  const verified = reasons.length === 0;
  const priceVersion = priceVersionOf(priced, ctx);
  const lines = priced.lines.map((l) => ({ variantId: l.variantId, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, lineTotal: l.lineTotal }));
  const discounts = lines.reduce((s, l) => s + l.discount, 0);
  const quoteId = `q1-${sha({ pv: priceVersion, lines: lines.map((l) => [l.variantId, l.quantity, l.unitPrice, l.discount]), ship: priced.shippingFee, total: priced.total, kind: priced.ship.kind }, 16)}`;
  const amounts = new Set<number>();
  if (verified) {
    for (const l of lines) {
      amounts.add(l.unitPrice);
      amounts.add(l.lineTotal);
      if (l.discount > 0) amounts.add(l.discount);
    }
    if (discounts > 0) amounts.add(discounts);
    amounts.add(priced.subtotal);
    if (priced.shippingFee !== null) amounts.add(priced.shippingFee);
    if (priced.total !== null) amounts.add(priced.total);
    const fs = ctx.cfg.freeShipping;
    if (fs.enabled && fs.minSubtotal !== null) {
      amounts.add(fs.minSubtotal);
      if (fs.minSubtotal > priced.subtotal) amounts.add(fs.minSubtotal - priced.subtotal);
    }
    if (ctx.cfg.volumeDiscount.enabled && ctx.cfg.volumeDiscount.amount > 0) amounts.add(ctx.cfg.volumeDiscount.amount);
  }
  return { quoteId, priceVersion, lines, discounts, subtotal: priced.subtotal, shipping: priced.shippingFee, total: priced.total, verified, unverifiedReasons: reasons, amounts: [...amounts].sort((a, b) => a - b) };
}

/**
 * LUẬT CHỌN GÓI khi luật giảm theo khối lượng TẮT — HÀM THUẦN. Một dòng N × gói nhỏ (N ≥ 2, khối lượng W) mà sản phẩm có gói bán
 * được đúng N × W với giá KHÁC N × đơn giá ⇒ «2kg» đang mang hai giá. Quy ước: khối lượng có gói riêng ⇒ dùng đúng gói đó; khách
 * nói rõ số túi («2 túi», «x2») trong câu cuối thì giữ. Trả câu sửa cho model, hoặc `null`. Luật bật ⇒ `null` (máy chủ tự quy gói).
 */
export function packChoiceMistake(priced: Pick<Priced, "lines" | "packOptions">, cfg: Pick<PricingConfig, "volumeDiscount">, customerText: string): string | null {
  if (cfg.volumeDiscount.enabled) return null;
  const folded = foldVi(customerText);
  const byVariant = new Map(priced.packOptions.map((p) => [p.variantId, p]));
  for (const l of priced.lines) {
    const me = byVariant.get(l.variantId);
    const w = me?.weightGrams ?? null;
    if (!me || w === null || l.quantity < 2) continue;
    const G = w * l.quantity;
    const pack = priced.packOptions.find((p) => p.productId === me.productId && p.variantId !== me.variantId && p.weightGrams === G && !p.addOnOnly && p.price !== null && p.price > 0);
    if (!pack || pack.price === l.unitPrice * l.quantity) continue;
    const explicit = new RegExp(`(?:^|[^\\d])${l.quantity}\\s*(?:tui|goi|hop|set|phan|bich|khay|combo|suat|cai|hu|lo|bao)(?![a-z])|x\\s*${l.quantity}(?!\\d)`);
    if (explicit.test(folded)) continue;
    return `Khách lấy ${kgText(G)} «${me.name}»: shop có gói ${kgText(G)} riêng («${pack.name}», ${formatVND(pack.price)}) — quy ước của shop: khối lượng có gói riêng ⇒ dùng ĐÚNG gói đó × 1 (variant_id ${pack.variantId}), KHÔNG ${l.quantity} × ${kgText(w)} (${formatVND(l.unitPrice * l.quantity)}). Sửa rồi gọi lại; khách thật sự muốn ${l.quantity} túi ${kgText(w)} riêng thì hỏi lại khách cho rõ.`;
  }
  return null;
}

/** Cụm khách yêu cầu ĐÓNG GÓI RIÊNG (đã bỏ dấu): «2 gói riêng», «chia 2 túi», «đóng riêng», «tách 2 gói», «mỗi túi 1kg». */
const PACKING_RE = /\b(?:\d+\s*(?:goi|tui|bich|hop|phan)\s*rieng|chia\s*(?:lam\s*|ra\s*)?\d+\s*(?:goi|tui|bich|hop|phan)|dong\s*(?:goi\s*)?rieng|tach\s*(?:ra\s*)?(?:\d+\s*)?(?:goi|tui|bich|hop)|moi\s*(?:goi|tui|bich)\s*\d+(?:[.,]\d+)?\s*(?:kg|g|ky|ki|lang))\b/;

/** Câu khách có yêu cầu đóng gói riêng không — trả NGUYÊN VĂN câu (cắt 200 ký tự) để ghi vào đơn, hoặc `null`. HÀM THUẦN. */
export function packingRequestOf(customerText: string): string | null {
  return PACKING_RE.test(foldVi(customerText)) ? customerText.trim().slice(0, 200) : null;
}

/**
 * Đóng gói riêng có đổi giá không — HÀM THUẦN. Khách đòi đóng riêng («2kg, 2 gói riêng») mà cùng khối lượng có HAI giá trong danh mục —
 * gói lớn (2kg 540k) và N × gói nhỏ (2 × 1kg 560k) — thì «tách gói có còn giá gói không» là QUYẾT ĐỊNH CỦA SHOP (ca «Chị Hoàn»
 * #B8E4E551: nhân viên trả lời 540k). Xét CẢ HAI chiều: AI chọn gói lớn hay chọn N × gói nhỏ đều mơ hồ. Cấu hình chưa khai ⇒ báo giá
 * CHƯA XÁC THỰC (`PACK_PRICE_CONFLICT`), không đoán. Luật giảm theo khối lượng BẬT ⇒ gói đơn vị đã là biểu diễn duy nhất (các túi vốn
 * tách) — mâu thuẫn giá gói đã bắt ở `catalogConflicts`, không xét ở đây.
 */
export function packingIssues(priced: Pick<Priced, "lines" | "packOptions">, ruleEnabled = false): QuoteIssue[] {
  if (ruleEnabled) return [];
  const out: QuoteIssue[] = [];
  const byVariant = new Map(priced.packOptions.map((p) => [p.variantId, p]));
  const groups = new Map<string, Priced["lines"]>();
  for (const l of priced.lines) {
    const pid = byVariant.get(l.variantId)?.productId;
    if (pid) groups.set(pid, [...(groups.get(pid) ?? []), l]);
  }
  for (const [pid, g] of groups) {
    if (g.some((l) => l.weightGrams == null)) continue;
    const grams = g.reduce((s, l) => s + l.weightGrams! * l.quantity, 0);
    const total = g.reduce((s, l) => s + l.lineTotal, 0);
    const sellable = priced.packOptions.filter((p) => p.productId === pid && p.weightGrams !== null && !p.addOnOnly && p.price !== null && p.price > 0);
    const pack = sellable.find((p) => p.weightGrams === grams);
    // Mọi cách ghép đúng khối lượng đó bằng N × một gói nhỏ hơn.
    const splits = sellable.filter((p) => p.weightGrams! < grams && grams % p.weightGrams! === 0).map((p) => ({ name: p.name, price: (grams / p.weightGrams!) * p.price! }));
    const prices = new Set([...(pack ? [pack.price!] : []), ...splits.map((x) => x.price), total]);
    if (pack && prices.size > 1) out.push({ code: "PACK_PRICE_CONFLICT", detail: `Khách đòi đóng gói riêng: «${pack.name}» ${formatVND(pack.price)} ≠ tách gói ${splits.map((x) => formatVND(x.price)).join(" / ") || formatVND(total)} — shop chưa khai tách gói có còn giá gói không` });
  }
  return out;
}

/** Giá ĐÃ XÁC THỰC của MỘT đơn vị từng mẫu mã (báo giá của giỏ [mẫu mã × 1]); chưa xác thực ⇒ `null` kèm lý do. HÀM THUẦN. */
export function verifiedUnitPrices(variantIds: readonly string[], ctx: PricingContext): Map<string, { price: number | null; reason: string | null }> {
  const out = new Map<string, { price: number | null; reason: string | null }>();
  for (const id of variantIds) {
    if (out.has(id)) continue;
    const q = buildQuote(computePriced([{ variantId: id, quantity: 1 }], ctx), ctx);
    out.set(id, q.verified ? { price: q.subtotal, reason: null } : { price: null, reason: q.unverifiedReasons.map((r) => r.detail).join(" · ") });
  }
  return out;
}

/** Số lượng tối đa của tập tham chiếu (1 … N gói mỗi mẫu mã). */
export const REFERENCE_MAX_QUANTITY = 10;

/**
 * TẬP SỐ THAM CHIẾU của tổ chức — mọi số tiền máy chủ có thể báo cho một giỏ MỘT mẫu mã × 1…10 (đã quy gói + giảm theo khối lượng),
 * cộng phí ship, ngưỡng miễn ship, mức giảm đã khai. Câu chữ CỐ ĐỊNH (câu mẫu điền giá, tin chào) và câu model viết trước khi có giỏ
 * đối chiếu với tập này. Báo giá chưa xác thực (catalog mâu thuẫn) KHÔNG góp số nào — giá ấy chưa ai xác nhận. HÀM THUẦN.
 */
export function referenceAmounts(ctx: PricingContext): Set<number> {
  const out = new Set<number>([0]);
  const cfg = ctx.cfg;
  for (const it of ctx.byId.values()) {
    if (it.addOnOnly || it.price === null || it.price <= 0) continue;
    for (let n = 1; n <= REFERENCE_MAX_QUANTITY; n++) {
      const priced = computePriced([{ variantId: it.variantId, quantity: n }], ctx);
      const q = buildQuote(priced, ctx);
      if (!q.verified) continue;
      // Luật tắt: N × gói nhỏ đúng khối lượng một gói lớn có giá khác (2 × 1kg = 560k vs gói 2kg 540k) ⇒ gói lớn là biểu diễn của khối
      // lượng đó; tổng N × gói nhỏ không phải giá tham chiếu (chỉ hợp lệ khi giỏ của khách nói rõ số túi — số của báo giá giỏ).
      if (packChoiceMistake(priced, cfg, "")) continue;
      for (const l of q.lines) {
        out.add(l.unitPrice);
        out.add(l.lineTotal);
        if (l.discount > 0) out.add(l.discount);
      }
      out.add(q.subtotal);
      if (cfg.shippingFee !== null) out.add(q.subtotal + cfg.shippingFee);
    }
  }
  if (cfg.shippingFee !== null) out.add(cfg.shippingFee);
  if (cfg.volumeDiscount.enabled && cfg.volumeDiscount.amount > 0) out.add(cfg.volumeDiscount.amount);
  if (cfg.freeShipping.enabled && cfg.freeShipping.minSubtotal !== null) out.add(cfg.freeShipping.minSubtotal);
  return out;
}

/**
 * Bảng số tham chiếu theo TỪNG mẫu mã (review vòng 3 — hàng rào tổng CẤU TRÚC): `byVariant` = mọi số máy chủ báo được cho giỏ chỉ có mẫu
 * mã đó × 1…10 (± phí ship); `unit` = giá MỘT đơn vị của mọi mẫu mã (± ship, kể cả mẫu mã chỉ bán kèm); `productOf` = mẫu mã → sản
 * phẩm. Hàng rào số tiền dùng để tách «giá niêm yết / bội số của món đang có trong giỏ» (được nói) khỏi «một TỔNG đã tính cho giỏ khác»
 * (không được nói khi không phải giỏ hiện tại). HÀM THUẦN.
 */
export type ReferenceBreakdown = { byVariant: Map<string, Set<number>>; unit: Set<number>; productOf: Map<string, string> };
export function referenceBreakdown(ctx: PricingContext): ReferenceBreakdown {
  const byVariant = new Map<string, Set<number>>();
  const unit = new Set<number>();
  const productOf = new Map<string, string>();
  const ship = ctx.cfg.shippingFee;
  for (const it of ctx.byId.values()) {
    productOf.set(it.variantId, it.productId);
    if (it.price === null || it.price <= 0) continue;
    unit.add(it.price);
    if (ship !== null) unit.add(it.price + ship);
    if (it.addOnOnly) continue;
    const set = new Set<number>();
    for (let n = 1; n <= REFERENCE_MAX_QUANTITY; n++) {
      const q = buildQuote(computePriced([{ variantId: it.variantId, quantity: n }], ctx), ctx);
      if (!q.verified) continue;
      if (n === 1) {
        unit.add(q.subtotal);
        if (ship !== null) unit.add(q.subtotal + ship);
      }
      set.add(q.subtotal);
      if (q.total !== null) set.add(q.total);
      if (ship !== null) set.add(q.subtotal + ship);
    }
    byVariant.set(it.variantId, set);
  }
  return { byVariant, unit, productOf };
}

export async function catalogReferenceBreakdown(cfg: PricingConfig): Promise<ReferenceBreakdown> {
  return referenceBreakdown(await loadPricingContext(cfg, await priceBooksForMode(cfg.wholesalePricing ? "DEFAULT_BOOK" : "RETAIL", null)));
}

/** Tập số tham chiếu đọc từ CSDL của tổ chức ngữ cảnh (bảng giá mặc định khi shop bật giá sỉ). */
export async function catalogReferenceAmounts(cfg: PricingConfig): Promise<Set<number>> {
  return referenceAmounts(await loadPricingContext(cfg, await priceBooksForMode(cfg.wholesalePricing ? "DEFAULT_BOOK" : "RETAIL", null)));
}

/** Cấu hình tính tiền của tổ chức. `dbIn` — CSDL mở tường minh (ops chỉ đọc); vắng ⇒ CSDL của ngữ cảnh hiện tại. */
export async function orgPricingConfig(dbIn?: Db): Promise<PricingConfig> {
  const db = dbIn ?? (await getDb());
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SALES_CHATBOT_SETTING_KEY)).limit(1);
  let raw: unknown = null;
  try {
    raw = row?.value ? (JSON.parse(row.value) as unknown) : null;
  } catch {
    raw = null;
  }
  return parseSalesChatbotConfig(raw);
}

/** Báo giá mà đường agent MANG THEO vào lõi đơn — lõi tính lại và đối chiếu, không tin số của người gọi. */
export type AgentQuoteClaim = { id: string; priceVersion: string; subtotal: number; total: number | null };

/**
 * LÕI ĐƠN tính lại báo giá cho đơn agent (`lib/records/order-create.ts` gọi khi đơn mang `quote`). Đối chiếu PHẦN HÀNG: từng dòng
 * (đơn giá + tiền giảm) và tiền hàng phải đúng phép tính máy chủ trên cấu hình CỦA TỔ CHỨC; tổng khai = tiền hàng + phí ship của
 * chính đơn. Phí ship / miễn ship theo địa chỉ có thể bị page đè (`PAGE_OVERRIDABLE`) nên lõi không tự tính phần đó — như trước.
 * Trả tiền giảm được phép theo chỉ số dòng, hoặc câu lỗi.
 */
export async function verifyAgentQuote(input: { lines: readonly { variantId: string; quantity: number; unitPrice: number; discount: number }[]; mode: AgentPricingMode; customerId: string | null; shippingFee: number; quote: AgentQuoteClaim }): Promise<{ ok: true; discounts: Map<string, number>; priceVersion: string } | { ok: false; message: string }> {
  const cfg = await orgPricingConfig();
  const ctx = await loadPricingContext(cfg, await priceBooksForMode(input.mode, input.customerId));
  const priced = computePriced(input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), ctx);
  const q = buildQuote(priced, ctx);
  if (!q.verified) return { ok: false, message: `Báo giá chưa xác thực: ${q.unverifiedReasons.map((r) => r.detail).join(" · ")}` };
  const discounts = new Map<string, number>();
  for (const [i, l] of input.lines.entries()) {
    const s = q.lines.find((x) => x.variantId === l.variantId);
    if (!s || s.quantity !== l.quantity) return { ok: false, message: `Dòng ${i + 1} không khớp báo giá máy chủ (mẫu mã / số lượng) — đọc lại báo giá.` };
    discounts.set(`${i}`, s.discount);
  }
  if (q.lines.length !== input.lines.length) return { ok: false, message: "Số dòng hàng không khớp báo giá máy chủ — đọc lại báo giá." };
  if (q.subtotal !== input.quote.subtotal) return { ok: false, message: `Tiền hàng của báo giá (${formatVND(input.quote.subtotal)}) khác phép tính máy chủ (${formatVND(q.subtotal)}) — đọc lại báo giá cho khách.` };
  if (input.quote.total !== null && input.quote.total !== q.subtotal + input.shippingFee) return { ok: false, message: `Tổng đơn (${formatVND(q.subtotal + input.shippingFee)}) khác tổng đã báo khách (${formatVND(input.quote.total)}).` };
  return { ok: true, discounts, priceVersion: q.priceVersion };
}
