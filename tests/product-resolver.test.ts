/**
 * NHẬN DIỆN SẢN PHẨM v2 — khoá các luật mà mẻ chạy thử đầu đã cho thấy là cần.
 *
 * Bản v1 khớp 0/20 và gọi `product.search` rỗng 36/36 lần. Các khẳng định dưới đây không kiểm
 * "có khớp được không" (điều đó phụ thuộc danh mục thật) mà kiểm những luật KHÔNG ĐƯỢC PHÁ:
 * không chọn bừa khi thiếu căn cứ, không nhận khi hai ứng viên ngang điểm, và bản đồ do NGƯỜI đặt
 * không bao giờ bị máy ghi đè.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { resolveProduct } from "@/lib/ai-workforce/agents/sales/resolve-product";
import { learnAdMapping } from "@/lib/ai-workforce/agents/sales/ad-map";
import { PRODUCT_RESOLUTION_ACCEPT_MIN, PRODUCT_RESOLUTION_UNAVAILABLE, TEXT_MATCH_CONFIDENCE } from "@/lib/constants/product-resolution";
import { buildVndPricing, pricingVersionLabel } from "@/lib/constants/ai-model-pricing";

export async function testProductResolver(db: Db) {
  // ── dựng danh mục tối thiểu ──
  const [dam] = await db.insert(schema.products).values({ id: "sp-dam-lua", name: "Đầm lụa Tinh Khôi", customId: "Q004", isHidden: false, isRemoved: false }).returning();
  const [ao] = await db.insert(schema.products).values({ id: "sp-ao-linen", name: "Áo linen Thanh Lịch", customId: "Q009", isHidden: false, isRemoved: false }).returning();
  await db.insert(schema.productVariants).values([
    { id: "mm-1", productId: dam.id, size: "M", color: "Trắng", retailPrice: 499_000, isRemoved: false },
    { id: "mm-2", productId: ao.id, size: "L", color: "Be", retailPrice: 399_000, isRemoved: false },
  ]);
  const [ht] = await db.insert(schema.salesConversations).values({ pageId: "page-1", externalId: "ht-1", customerName: "Khách" }).returning();

  // ── 1. KHÁCH GÕ MÃ HÀNG ⇒ chắc chắn nhất ──
  const theoMa = await resolveProduct({ conversationId: ht.id, pageId: "page-1", text: "cho em hỏi mẫu Q004 còn không ạ" }, db);
  assert.equal(theoMa.source, "EXPLICIT_CODE");
  assert.equal(theoMa.productId, dam.id);
  assert.equal(theoMa.confidence, 1);
  assert.ok(theoMa.evidence.includes("Q004"), "phải nêu được căn cứ, không kết luận suông");

  // ── 2. CÂU HỎI TRỐNG RỖNG ⇒ KHÔNG ĐƯỢC CHỌN BỪA ──
  //
  // Đây chính là cảnh của 20 hội thoại thật: khách bấm quảng cáo rồi nhắn một câu không có gì để
  // khớp. Danh mục nào cũng có "ứng viên tốt nhất" — nhận nó là bịa.
  const rong = await resolveProduct({ conversationId: ht.id, pageId: "page-1", text: "còn hàng không ạ" }, db);
  assert.equal(rong.productId, null, "không có căn cứ thì KHÔNG được ra sản phẩm");
  assert.equal(rong.source, "NONE");
  assert.ok(rong.evidence.length > 0, "không kết luận được cũng phải nói vì sao");

  // ── 3. CÂU QUẢNG CÁO nhận ra mẫu, dù chữ khách không nói gì ──
  const theoQC = await resolveProduct(
    { conversationId: ht.id, pageId: "page-1", text: "shop ơi", adId: "120247693159380618", adDescription: "🤍 Đầm lụa Tinh Khôi — chất lụa mát, dáng suông" },
    db,
  );
  assert.equal(theoQC.source, "AD_DESCRIPTION");
  assert.equal(theoQC.productId, dam.id, "câu quảng cáo là chữ của SHOP nên khớp được, khác hẳn chữ khách");

  // ── 4. HỌC BẢN ĐỒ rồi dùng lại — hai lượt phải ra CÙNG kết quả ──
  const hoc = await learnAdMapping({ pageId: "page-1", adId: "120247693159380618", postUrl: "", adDescription: "🤍 Đầm lụa Tinh Khôi", resolution: theoQC }, db);
  assert.equal(hoc.learned, true);
  const lanSau = await resolveProduct({ conversationId: ht.id, pageId: "page-1", text: "ib giá", adId: "120247693159380618" }, db);
  assert.equal(lanSau.source, "AD_MAP_AUTO", "lần sau phải đọc bản đồ, không đoán lại");
  assert.equal(lanSau.productId, dam.id);

  // ── 5. MÁY KHÔNG ĐƯỢC GHI ĐÈ BẢN ĐỒ DO NGƯỜI ĐẶT ──
  //
  // Người sửa bản đồ là để chữa cái máy đoán sai. Máy đoán lại rồi ghi đè thì việc sửa ấy biến mất
  // trong im lặng — và lần sau người lại phải sửa đúng chỗ cũ.
  await db.update(schema.salesAdProductMap).set({ source: "HUMAN", productId: ao.id, confidence: 1 }).where(eq(schema.salesAdProductMap.adKey, "120247693159380618"));
  const deNguoi = await learnAdMapping({ pageId: "page-1", adId: "120247693159380618", postUrl: "", adDescription: "🤍 Đầm lụa Tinh Khôi", resolution: theoQC }, db);
  assert.equal(deNguoi.learned, false, "máy phải từ chối ghi đè dòng của người");
  const [vanLaNguoi] = await db.select().from(schema.salesAdProductMap).where(eq(schema.salesAdProductMap.adKey, "120247693159380618"));
  assert.equal(vanLaNguoi.productId, ao.id, "dòng người đặt phải còn nguyên");
  assert.equal(vanLaNguoi.source, "HUMAN");
  const theoNguoi = await resolveProduct({ conversationId: ht.id, pageId: "page-1", text: "ib giá", adId: "120247693159380618" }, db);
  assert.equal(theoNguoi.source, "AD_MAP_HUMAN");
  assert.equal(theoNguoi.confidence, 1, "người đặt là sự thật, không phải suy luận");

  // ── 6. NGƯỠNG NHẬN: điểm khớp yếu ⇒ CHƯA BIẾT ──
  assert.ok(TEXT_MATCH_CONFIDENCE[2] < PRODUCT_RESOLUTION_ACCEPT_MIN, "khớp 2 điểm phải nằm DƯỚI ngưỡng — nếu không, một từ trùng là đủ để khoá nhầm mẫu");
  assert.ok(TEXT_MATCH_CONFIDENCE[5] >= PRODUCT_RESOLUTION_ACCEPT_MIN);

  // ── 7. TẦNG KHÔNG DÙNG ĐƯỢC phải khai LÝ DO, không im lặng biến mất ──
  for (const [ten, lyDo] of Object.entries(PRODUCT_RESOLUTION_UNAVAILABLE)) {
    assert.ok(lyDo.length > 40, `${ten} phải nêu lý do đo được, không phải một câu cho có`);
  }

  // ── 8. BẢNG GIÁ: không có tỷ giá thì KHÔNG được tự bịa ──
  assert.throws(() => buildVndPricing(0), /dương/, "tỷ giá 0 phải hỏng, không được lặng lẽ ra giá 0đ");
  assert.throws(() => buildVndPricing(Number.NaN), /dương/);
  const gia = buildVndPricing(26_000);
  assert.equal(gia["claude-haiku-4-5"].inputVndPerMillion, 26_000, "1 USD/triệu token × 26.000 = 26.000đ");
  assert.equal(gia["claude-sonnet-5"].outputVndPerMillion, 260_000, "10 USD/triệu token × 26.000 = 260.000đ");
  assert.ok(pricingVersionLabel(26_000).includes("26000"), "nhãn phiên bản phải mang tỷ giá — đổi tỷ giá là ra con số khác");

  console.log("  ✓ nhận diện sản phẩm v2, bản đồ quảng cáo, bảng giá");
}
