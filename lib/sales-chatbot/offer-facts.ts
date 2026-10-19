/**
 * ═══════════ DỮ KIỆN DANH MỤC CHO LỜI MỜI MUA THÊM (P0 #868) — CHỈ MÁY CHỦ ═══════════
 *
 * Đọc ERP lúc gọi (không bao giờ từ lời nhắc) để hàng rào lời mời (`next-best-action.ts::guardReply`) biết:
 *  · MÓN ĐƯỢC MỜI KÈM — sản phẩm shop đã KHAI là bổ trợ: món có trong câu mẫu UPSELL của shop (ô `{{giá:SKU}}` / `{{tồn:SKU}}` hoặc
 *    gọi tên trong câu), hoặc có mẫu mã CHỈ BÁN KÈM (0237/0238 — vd 0,5kg để khách dùng thử cùng món chính). Và chỉ khi còn ít nhất
 *    một mẫu mã ĐANG BÁN có GIÁ ĐÃ XÁC THỰC (`verifiedUnitPrices` — cùng phép tính với đơn) và CÒN HÀNG (tồn khả dụng > 0; shop bật
 *    «nhập hàng liên tục» thì không xét tồn — đúng luật 4 của bot). Không bao giờ một món ngẫu nhiên của danh mục.
 *  · LÝ DO GIÁ THẬT để mời khối lượng lớn hơn — giảm theo khối lượng shop khai (`volumeDiscount`), hoặc gói lớn hơn của CÙNG sản
 *    phẩm rẻ hơn tính theo gram (giá đã xác thực).
 * Chỉ đọc khi chữ bot có câu mời cần kiểm (`needsOfferFacts`) — lượt thường 0 truy vấn. Lỗi đọc ⇒ nơi gọi nhận `null` và câu mời bị
 * bỏ (không kiểm được thì không gửi), phần còn lại của tin vẫn đi.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { stockFor, type CatalogItem } from "@/lib/sales-chatbot/catalog";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { namedIn, type OfferFacts } from "@/lib/sales-chatbot/next-best-action";
import { loadPricingContext, verifiedUnitPrices } from "@/lib/sales-chatbot/quote";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";

/** Câu chữ của câu mẫu UPSELL shop đã chọn — `""` khi chưa chọn / đã tắt / không đọc được. */
async function upsellAnswer(id: string | null): Promise<string> {
  if (!id) return "";
  const qr = schema.salesChatQuickReplies;
  const [row] = await (await getDb()).select({ answer: qr.answer, active: qr.active }).from(qr).where(eq(qr.id, id)).limit(1);
  return row?.active ? row.answer : "";
}

/**
 * Khối lượng nhỏ nhất (gram) mà từ đó MỘT sản phẩm được lợi hơn theo gram — từ luật giảm theo khối lượng và từ bảng gói đã xác thực.
 * `null` = không có lý do giá thật. HÀM THUẦN.
 */
export function volumeSaveFrom(variants: readonly { grams: number | null; price: number | null; addOnOnly?: boolean }[], rule: SalesChatbotConfig["volumeDiscount"]): number | null {
  const main = variants.filter((v) => !v.addOnOnly && v.grams !== null && v.grams > 0 && v.price !== null && v.price > 0) as { grams: number; price: number }[];
  const out: number[] = [];
  if (rule.enabled && rule.amount > 0 && main.some((v) => v.grams === rule.unitGrams)) out.push(rule.minWeightGrams);
  const sorted = [...main].sort((a, b) => a.grams - b.grams);
  const base = sorted[0];
  if (base) for (const v of sorted.slice(1)) if (v.grams > base.grams && v.price / v.grams < base.price / base.grams) out.push(v.grams);
  return out.length ? Math.min(...out) : null;
}

export async function loadOfferFacts(cfg: SalesChatbotConfig, upsellReplyId: string | null, books: Parameters<typeof loadPricingContext>[1] = null): Promise<OfferFacts> {
  const ctx = await loadPricingContext(cfg, books);
  const catalog = [...ctx.byId.values()];
  const catalogNames = [...new Set(catalog.map((c) => c.name))];
  const byName = new Map<string, CatalogItem[]>();
  for (const c of catalog) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  // Giá mời: mẫu mã chỉ bán kèm được định giá như món đi kèm đơn chính (không phải đơn riêng) — xem `addOnAlone`.
  const verified = verifiedUnitPrices(
    catalog.map((c) => c.variantId),
    ctx,
    { addOnAlone: true },
  );
  // Món shop khai là bổ trợ.
  const answer = await upsellAnswer(upsellReplyId);
  const curatedSkus = new Set(parsePlaceholders(answer).filter((p) => p.kind !== "ship").map((p) => p.sku.toLowerCase()));
  const curated = new Set([...catalog.filter((c) => curatedSkus.has(c.sku.toLowerCase())).map((c) => c.name), ...(answer ? namedIn(answer.replace(/\{\{[^}]*\}\}/g, " "), catalogNames) : [])]);
  const complementary = catalogNames.filter((n) => curated.has(n) || (byName.get(n) ?? []).some((c) => c.addOnOnly));
  const candidates = complementary.flatMap((n) => byName.get(n) ?? []).filter((c) => verified.get(c.variantId)?.price != null);
  const stock = cfg.sellWithoutStockCheck ? null : await stockFor(candidates.map((c) => c.variantId));
  const inStock = (id: string) => stock === null || ((stock.get(id)?.stockKnown ?? false) && (stock.get(id)?.available ?? 0) > 0);
  const crossSell = complementary.filter((n) => candidates.some((c) => c.name === n && inStock(c.variantId)));
  // Lời mời CỤ THỂ cho câu mời sau chốt (P0 19/10/2026): mỗi món bổ trợ MỘT mẫu mã — ưu tiên mẫu mã CHỈ BÁN KÈM (gói dùng thử), không có
  // thì mẫu mã rẻ nhất — giá ĐÃ XÁC THỰC, còn hàng. Không có mẫu mã đủ điều kiện ⇒ món đó không được mời.
  const crossSellOffers = crossSell.flatMap((n) => {
    const ok = candidates.filter((c) => c.name === n && inStock(c.variantId));
    const pick = [...ok].sort((a, b) => Number(Boolean(b.addOnOnly)) - Number(Boolean(a.addOnOnly)) || (verified.get(a.variantId)?.price ?? 0) - (verified.get(b.variantId)?.price ?? 0))[0];
    const price = pick ? verified.get(pick.variantId)?.price : null;
    return pick && typeof price === "number" && price > 0 ? [{ name: n, productId: pick.productId, variantId: pick.variantId, variant: pick.variant, price }] : [];
  });
  const volume = catalogNames.flatMap((n) => {
    const from = volumeSaveFrom(
      (byName.get(n) ?? []).map((c) => ({ grams: ctx.weight.get(c.variantId) ?? null, price: verified.get(c.variantId)?.price ?? null, addOnOnly: c.addOnOnly })),
      cfg.volumeDiscount,
    );
    return from === null ? [] : [{ name: n, saveFromGrams: from }];
  });
  return { catalogNames, crossSell, crossSellOffers, volume, menu: Boolean(answer), freeShip: cfg.freeShipping.enabled };
}
