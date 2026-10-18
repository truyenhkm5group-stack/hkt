/**
 * P0 18/10/2026 — AI SALES TƯ VẤN SAI MÓN KHÁCH HỎI (HSLC, ca «ThanhPhương», đã che tên):
 *
 *  · Khách nhắn «xin giá chả cá». 0,3 giây sau bot gửi câu mẫu NEM HẢI SẢN (120.000 ₫ + 3 ảnh nem). Không có lời gọi AI nào: câu mẫu
 *    «Nem hải sản tôm bề bề giá bao nhiêu» mang nhầm các cách hỏi «xin giá chả cá», «Xin giá chả cá nhé shop», «Báo giá chả cá thu?»,
 *    «báo giá» — khớp chữ liền cả cụm (8 điểm) thắng câu mẫu chả cá thu (cách hỏi «Xin giá chả cá thu?» thiếu chữ «thu» nên 0 điểm).
 *  · Gốc ở LÕI: bước khớp chữ chỉ so cụm từ, không biết câu mẫu nói về MÓN nào. Nay (`quick-reply-focus.ts`): món khách đang hỏi (tin
 *    khách mới nhất có gọi tên món trong lượt mua → câu shop / page vừa nói) khoá câu mẫu được trả lời — ở khớp chữ, AI chọn mã, và công
 *    cụ `send_quick_reply`. Câu mẫu không gắn món (ship, cảm ơn, menu chung) không bị ảnh hưởng.
 *
 * Các ca chủ shop yêu cầu: hỏi chả cá → chả cá · hỏi nem → nem · hỏi cả hai → không trả lời nửa câu · từ chối nem → không mời nem lại
 * · tin tự động của page nói chả cá → «báo giá» không thành nem · model gửi câu mẫu nem khi khách hỏi chả cá → máy chủ chặn.
 * Review: shop vừa MỜI nem rồi khách hỏi «giá sao em» ⇒ nem cũng là món đang bàn (không khoá cứng vào món khách nói trước); «nước» một
 * mình không gọi tên nước mắm; câu UPSELL được miễn ở khớp chữ như ở công cụ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createProductCore } from "@/lib/records/product-create";
import { SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { matchQuickReplyByKeyword, QUICK_REPLY_SETTING_KEY, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { quickReplyByKeyword } from "@/lib/sales-chatbot/quick-replies";
import { productFocusOf, productsNamedIn, quickReplyCovers, quickReplyFocusGuard, triggerProductConflicts, unavailableQuickReplyGuard, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

// Danh mục giống HSLC (tên thật của shop — không phải dữ liệu khách).
const PRODUCTS: FocusProduct[] = [
  { name: "Chả cá thu", skus: ["CHA-CA-THU", "CHA-CA-THU-05KG", "CHA-CA-THU-2KG"] },
  { name: "Chả mực giã tay", skus: ["CHA-MUC-GIA-TAY"] },
  { name: "Nem hải sản tôm bề bề", skus: ["NEM-HAI-SAN-TOM-BE-BE"] },
  { name: "Nước mắm cốt cá cơm truyền thống", skus: ["NUOC-MAM-COT-CA-COM"] },
  { name: "Ruốc bông (chà bông) cá thu nguyên chất", skus: ["RUOC-BONG-CA-THU-100"] },
  { name: "Ruốc bông (chà bông) tôm biển nguyên chất", skus: ["RUOC-BONG-TOM-100"] },
];
const E = (id: string, title: string, triggers: string[], answer: string): QuickReplyEntry => ({ id, title, triggers, answer });
const A01 = E("a01", "A01 Báo giá chả cá thu", ["báo giá chả cá thu", "giá chả cá thu", "Cha ca", "Xin giá chả cá thu?"], "Dạ chả cá thu bên em 1kg giá {{giá:CHA-CA-THU}} ạ.");
const A03 = E("a03", "A03 Xin giá (chưa nói món nào)", ["xin giá", "cho giá", "hỏi giá"], "Dạ chả cá thu bên em 1kg giá {{giá:CHA-CA-THU}} ạ.");
// Đúng các cách hỏi đang gắn trên câu nem ở production 18/10/2026.
const A07 = E("a07", "A07 Nem hải sản tôm bề bề giá bao nhiêu", ["nem bao nhiêu", "nem hải sản bn", "giá nem", "xin giá chả cá", "Xin giá chả cá nhé shop", "Xin giá 1 kg", "Báo giá chả cá thu?", "báo giá"], "Nem hải sản giá {{giá:NEM-HAI-SAN-TOM-BE-BE}}/1 hộp 10 cái ạ.");
const B10 = E("b10", "B10 Nem 1 hộp mấy cái", ["nem mấy cái", "1 hộp mấy cái"], "1 hộp nem có 10 cái. Mình lấy mấy hộp ạ?");
const UPSELL = E("up", "[UPSELL] Các món bán chạy", ["còn món gì", "menu", "Shop có chả Mực ko ?"], "Dạ bên em còn có các món ngon bán chạy khác, mình lấy thêm món nào báo em giao luôn ạ?");
const THANKS = E("ty", "Cảm ơn khách hàng", ["cảm ơn shop"], "Dạ em cảm ơn anh/chị nhiều ạ!");
const ALL = [A01, A03, A07, B10, UPSELL, THANKS];

const C = (text: string): FocusLine => ({ who: "CUSTOMER", text });
const S = (text: string): FocusLine => ({ who: "SHOP", text });
/** Tin khách (cũ ⇒ mới); `shop` ⇒ một câu shop / page đứng ngay TRƯỚC tin khách cuối. */
const lines = (texts: string[], shop: string | null = null): FocusLine[] => (shop ? [...texts.slice(0, -1).map(C), S(shop), C(texts[texts.length - 1])] : texts.map(C));

/** Đúng phép lọc của `quickReplyByKeyword` (quick-replies.ts): câu mẫu thay cả lượt trả lời phải nói đủ mọi món đang bàn. */
function keywordOf(tl: FocusLine[], exempt: string[] = []) {
  const g = quickReplyFocusGuard(tl, PRODUCTS, exempt);
  const m = matchQuickReplyByKeyword(tl[tl.length - 1].text, ALL.filter((e) => g.answers(e)));
  return m.kind === "MATCH" ? m.entry.id : m.kind === "AMBIGUOUS" ? `AMBIGUOUS:${m.entries.map((e) => e.id).sort().join(",")}` : "NONE";
}
const keyword = (texts: string[], shop: string | null = null) => keywordOf(lines(texts, shop));
const focusOf = (texts: string[], shop: string | null = null) => productFocusOf(lines(texts, shop), PRODUCTS);
const names = PRODUCTS.map((p) => p.name);

function testThuan() {
  // Lỗi gốc còn tái hiện được ở bộ khớp chữ trần — bài kiểm phải đỏ nếu ai đó gỡ bộ lọc.
  const raw = matchQuickReplyByKeyword("xin giá chả cá", ALL);
  assert.equal(raw.kind === "MATCH" ? raw.entry.id : raw.kind, "a07", "bộ khớp chữ trần chọn câu nem cho «xin giá chả cá» (đúng lỗi production)");

  // Món của câu mẫu.
  assert.deepEqual(quickReplyCovers(A01, PRODUCTS), ["Chả cá thu"]);
  assert.deepEqual(quickReplyCovers(A07, PRODUCTS), ["Nem hải sản tôm bề bề"]);
  assert.deepEqual(quickReplyCovers(B10, PRODUCTS), ["Nem hải sản tôm bề bề"], "tiêu đề gọi tên nem ⇒ câu mẫu nói về nem dù không có chỗ trống giá");
  assert.deepEqual(quickReplyCovers(UPSELL, PRODUCTS), [], "câu menu chung không gắn món");
  assert.deepEqual(quickReplyCovers(THANKS, PRODUCTS), []);

  // Bộ nhận tên: «giá» ≠ «giã» (bỏ dấu trùng nhau); không dấu vẫn nhận; từ đầu thông dụng cần từ thứ hai; tên lồng nhau.
  assert.deepEqual(productsNamedIn("xin giá chả cá", names), ["Chả cá thu"], "«giá» không gọi tên «Chả mực giã tay»");
  assert.deepEqual(productsNamedIn("xin gia cha ca", names), ["Chả cá thu"], "khách gõ không dấu");
  assert.deepEqual(productsNamedIn("ruốc bông tôm còn không", names), ["Ruốc bông (chà bông) tôm biển nguyên chất"]);
  assert.deepEqual(productsNamedIn("ship nước ngoài được không", names), [], "«nước» một mình không gọi tên nước mắm");
  assert.deepEqual(productsNamedIn("chả cá luộc nước sôi được không", names), ["Chả cá thu"]);
  assert.deepEqual(productsNamedIn("nước mắm bao nhiêu", names), ["Nước mắm cốt cá cơm truyền thống"]);
  const motNang = [...names, "Cá thu một nắng"];
  assert.deepEqual(productsNamedIn("cho chị 1kg chả cá thu", motNang), ["Chả cá thu"], "«chả cá thu» chứa «cá thu» nhưng không gọi tên «Cá thu một nắng»");
  assert.deepEqual(productsNamedIn("cá thu một nắng giá sao", motNang), ["Cá thu một nắng"]);
  // Gọi bằng phần đuôi tên (hai từ liền nhau): «món mực giã đó», «tôm bề bề»; một từ đuôi một mình thì không.
  assert.deepEqual(productsNamedIn("món mực giã đó tính tiền sao em", names), ["Chả mực giã tay"]);
  assert.deepEqual(productsNamedIn("tôm bề bề còn không", names), ["Nem hải sản tôm bề bề"]);
  // Một từ đuôi CÓ DẤU chỉ một món mang: «mực», «mắm»; không dấu / từ thông dụng thì không.
  assert.deepEqual(productsNamedIn("món mực nhà mình có ngon không em", names), ["Chả mực giã tay"]);
  assert.deepEqual(productsNamedIn("có mắm không shop", names), ["Nước mắm cốt cá cơm truyền thống"]);
  assert.deepEqual(productsNamedIn("giá một hộp sao em", names), [], "«giá», «một», «hộp» không gọi tên món nào");
  assert.deepEqual(productsNamedIn("ruốc bông cá thu còn không", names), ["Ruốc bông (chà bông) cá thu nguyên chất"], "«cá thu» nằm gọn trong «ruốc bông cá thu» ⇒ không gọi tên Chả cá thu");

  // 1. Hỏi chả cá → chả cá.
  assert.deepEqual(focusOf(["xin giá chả cá"]), { focus: ["Chả cá thu"], offered: [], declined: [], source: "CUSTOMER" });
  assert.equal(keyword(["xin giá chả cá"]), "AMBIGUOUS:a01,a03", "«xin giá chả cá» ⇒ chỉ còn câu mẫu chả cá (hai câu ngang điểm ⇒ AI đọc hiểu chọn giữa HAI câu chả cá)");
  assert.equal(keyword(["Xin giá chả cá nhé shop"]), "AMBIGUOUS:a01,a03");
  assert.equal(keyword(["chả mực giá sao"]), "NONE", "hỏi chả mực ⇒ không câu mẫu chả cá / nem nào trả lời");
  // 2. Hỏi nem → nem.
  assert.equal(keyword(["nem bao nhiêu"]), "a07");
  assert.equal(keyword(["nem 1 hộp mấy cái"]), "b10");
  assert.equal(keyword(["ruốc tôm 1 hộp mấy cái"]), "NONE", "câu «1 hộp mấy cái» của NEM không trả lời câu hỏi về ruốc");
  // 3. Hỏi cả hai → không câu mẫu một món nào thay cả lượt; công cụ của model gửi được cả hai.
  const both = quickReplyFocusGuard(lines(["giá chả cá với nem sao shop"]), PRODUCTS);
  assert.deepEqual([...both.focus.focus].sort(), ["Chả cá thu", "Nem hải sản tôm bề bề"]);
  assert.equal(keyword(["giá chả cá với nem sao shop"]), "NONE", "một câu báo giá một món không trả lời câu hỏi hai món");
  assert.ok(both.fits(A01) && both.fits(A07), "model gửi câu chả cá rồi câu nem trong một lượt được");
  // 4. Từ chối nem → câu nem không quay lại, kể cả với «báo giá» (cách hỏi đang gắn nhầm trên câu nem).
  assert.deepEqual(focusOf(["không lấy nem đâu em", "báo giá"]).declined, ["Nem hải sản tôm bề bề"]);
  assert.equal(keyword(["không lấy nem đâu em", "báo giá"]), "NONE");
  assert.equal(keyword(["chả cá thu", "không lấy nem đâu em", "báo giá"]), "NONE", "món chính vẫn là chả cá: câu nem «báo giá» bị loại");
  assert.equal(focusOf(["không lấy nem đâu", "cho chị 1 hộp nem nhé"]).declined.length, 0, "khách đổi ý gọi tên lại ⇒ không còn là từ chối");
  // 5. Tin tự động của page nói chả cá → «báo giá» không thành nem.
  const page = `${SHOP_SAID} Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ`;
  assert.deepEqual(focusOf(["báo giá"], page), { focus: ["Chả cá thu"], offered: [], declined: [], source: "SHOP" });
  assert.equal(keyword(["báo giá"], page), "NONE");
  // 7. (chủ shop 18/10) Chưa xác định được món ⇒ câu mẫu GẮN MÓN không tự trả lời — kể cả cụm chung đang giữ trên câu chả cá.
  assert.equal(keyword(["báo giá"]), "NONE", "không biết khách hỏi món gì ⇒ không mặc định món nào");
  assert.equal(keyword(["xin giá"]), "NONE", "«xin giá» của câu chả cá chung chỉ khớp khi có căn cứ món");
  assert.equal(keyword(["xin giá"], page), "a03", "page vừa nói chả cá ⇒ cụm chung của câu chả cá được dùng");
  assert.equal(keywordOf([C("cho mình xem chả cá thu"), S("Dạ bên em có chả cá thu Hạ Long ạ"), C("xin giá")]), "a03", "khách nói món ở tin trước ⇒ căn cứ");
  assert.ok(!quickReplyFocusGuard(lines(["xin giá"]), PRODUCTS).fits(A01), "công cụ cũng không gửi câu một món khi chưa rõ món");
  assert.ok(quickReplyFocusGuard(lines(["xin giá"]), PRODUCTS).fits(THANKS), "câu không gắn món vẫn gửi được");
  // Danh mục chỉ MỘT món ⇒ câu hỏi chung không mơ hồ.
  const one = [PRODUCTS[0]];
  const gOne = quickReplyFocusGuard(lines(["xin giá"]), one);
  assert.equal(gOne.focus.source, "CATALOG");
  assert.ok(gOne.answers(A03) && gOne.fits(A01));
  assert.ok(!quickReplyFocusGuard(lines(["không lấy chả cá đâu", "xin giá"]), one).answers(A03), "khách vừa từ chối món duy nhất ⇒ không mặc định");
  // 8. Đọc danh mục LỖI ⇒ bộ lọc ĐÓNG: chỉ câu UPSELL còn đi được.
  const closed = unavailableQuickReplyGuard(["up"]);
  assert.ok(closed.unavailable && !closed.answers(A01) && !closed.answers(THANKS) && !closed.fits(A07) && closed.fits(UPSELL));
  // Đường lỗi THẬT không dựng lại được bằng dữ liệu (đọc danh mục phải hỏng) ⇒ khoá ở mức mã nguồn: đọc lỗi ⇒ bộ lọc ĐÓNG, ở cả lõi lẫn
  // engine. Đổi về «lỗi ⇒ null / không lọc» là bài này đỏ.
  const qrSrc = readFileSync("lib/sales-chatbot/quick-replies.ts", "utf8");
  assert.match(qrSrc, /loadFocusProducts\(\)\.catch\(\(\) => null\);\s*return products === null \? unavailableQuickReplyGuard\(ids\)/, "quickReplyFocus: đọc lỗi ⇒ bộ lọc đóng");
  const engSrc = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.match(engSrc, /quickReplyFocus\(focusLines, qrSettings\.upsellReplyId\)\.catch\(\(\) => unavailableQuickReplyGuard\(/, "engine: lỗi ⇒ bộ lọc đóng, không bao giờ null");
  // Khách gọi tên món ⇒ thắng câu page đứng TRƯỚC tin đó.
  assert.deepEqual(focusOf(["nem bao nhiêu"], page).focus, ["Nem hải sản tôm bề bề"]);
  // 6. (review) Shop vừa MỜI món khác sau tin khách gọi tên ⇒ món đó cũng đang bàn: «giá sao em» có thể là hỏi giá nem — câu nem gửi
  //    được qua công cụ, còn khớp chữ không được ĐOÁN bằng câu báo giá một món (cả chả cá lẫn nem đều bị loại ⇒ chatbot đầy đủ đọc ngữ cảnh).
  const moiNem = [C("chả cá thu giá sao em"), S("Dạ chả cá thu 1kg 280.000đ ạ. Chị lấy thêm nem hải sản không ạ?"), C("giá sao em")];
  const g6 = quickReplyFocusGuard(moiNem, PRODUCTS);
  assert.deepEqual(g6.focus, { focus: ["Chả cá thu"], offered: ["Nem hải sản tôm bề bề"], declined: [], source: "CUSTOMER" });
  assert.ok(g6.fits(A07), "câu nem KHÔNG bị từ chối khi shop vừa mời nem");
  assert.ok(g6.fits(A01));
  assert.ok(!g6.answers(A01) && !g6.answers(A07), "khớp chữ không đoán món nào khách đang hỏi giá");
  // Chỉ câu shop GẦN NHẤT, và chỉ khi nó mời đúng MỘT món mới: câu menu / bảng giá nhắc nhiều món không phải lời mời một món.
  assert.deepEqual(productFocusOf([C("chả cá thu giá sao em"), S("Dạ bên em còn chả mực, nem hải sản, nước mắm ạ"), C("1kg bao nhiêu")], PRODUCTS).offered, []);
  assert.deepEqual(productFocusOf([C("chả cá thu giá sao em"), S("Chị lấy thêm nem hải sản không ạ?"), S("Dạ chả cá thu 280k ạ"), C("ok")], PRODUCTS).offered, [], "lời mời cũ đã bị câu shop mới hơn thay");
  // Câu shop đứng TRƯỚC tin khách gọi tên món thì không mở rộng món đang bàn.
  assert.deepEqual(productFocusOf([S("Chị lấy thêm nem hải sản không ạ?"), C("xin giá chả cá")], PRODUCTS).offered, []);
  // Món khách đã từ chối không quay lại qua câu shop.
  assert.deepEqual(productFocusOf([C("chả cá thu thôi, không lấy nem đâu"), S("Dạ nem hải sản 120k ạ"), C("ok")], PRODUCTS).offered, []);
  // Câu mẫu không gắn món luôn trả lời được.
  assert.equal(keyword(["chả cá ngon", "cảm ơn shop"]), "ty");
  assert.equal(keyword(["chả cá thu", "còn món gì"]), "up");
  // NB3: câu UPSELL được miễn ở khớp chữ như ở công cụ (nó có cửa sổ lời mời riêng), kể cả khi nó gắn món khác.
  const upNem = E("upnem", "[UPSELL] Nem kèm", ["còn món gì"], "Dạ bên em còn nem hải sản {{giá:NEM-HAI-SAN-TOM-BE-BE}} ăn kèm rất hợp ạ");
  const gUp = quickReplyFocusGuard(lines(["chả cá thu", "còn món gì"]), PRODUCTS, ["upnem"]);
  assert.ok(gUp.answers(upNem) && gUp.fits(upNem));
  assert.ok(!quickReplyFocusGuard(lines(["chả cá thu", "còn món gì"]), PRODUCTS).answers(upNem), "không khai là UPSELL ⇒ bị lọc như câu thường");
  // «chà bông» không gọi tên chả cá / chả mực.
  assert.deepEqual(focusOf(["chà bông bao nhiêu"]).focus, []);

  // KIỂM TĨNH: cách hỏi gắn nhầm món trên câu nem — đúng ba cách hỏi gọi tên chả cá.
  assert.deepEqual(triggerProductConflicts(A07, PRODUCTS).map((x) => x.trigger), ["xin giá chả cá", "Xin giá chả cá nhé shop", "Báo giá chả cá thu?"]);
  assert.deepEqual(triggerProductConflicts(A01, PRODUCTS), []);
  assert.deepEqual(triggerProductConflicts(UPSELL, PRODUCTS), [], "câu menu chung mang «có chả mực không» là hợp lệ");
}

// ═══ chatTurn THẬT + PGlite: đường khớp chữ, AI chọn mã và công cụ send_quick_reply ═══

const CHA_CA = "Dạ chả cá thu bên em 1kg giá {{giá:CCT-1KG}} ạ.";
const NEM = "Nem hải sản giá {{giá:NEM-HOP}}/1 hộp 10 cái ạ.";

async function seed(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  const ids = ctx.ids as Map<string, string>;
  if (ids.has("CCT-1KG")) return;
  const admin = await ctx.admin();
  const db = await getDb();
  for (const p of [
    { name: "Chả cá thu", code: "CCT", sku: "CCT-1KG", size: "1kg", price: 280_000 },
    { name: "Nem hải sản tôm bề bề", code: "NEM", sku: "NEM-HOP", size: "Hộp 10 cái", price: 120_000 },
  ]) {
    const r = await createProductCore(admin, { name: p.name, code: p.code, unit: "gói", retailPrice: p.price, cost: null, variants: [{ sku: p.sku, size: p.size, color: "", retailPrice: p.price, cost: null, selling: true }] });
    assert.ok(r.ok, JSON.stringify(r));
    for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) ids.set(v.sku, v.id);
  }
  const qr = schema.salesChatQuickReplies;
  await db.insert(qr).values([
    { title: "A01 Báo giá chả cá thu", triggers: ["giá chả cá thu", "Cha ca", "Xin giá chả cá thu?", "giá bao nhiêu 1kg"], answer: CHA_CA, active: true },
    { title: "A07 Nem hải sản tôm bề bề giá bao nhiêu", triggers: ["nem bao nhiêu", "giá nem", "xin giá chả cá", "Báo giá chả cá thu?", "báo giá"], answer: NEM, active: true },
  ]);
}

async function shopSays(conversationId: string, text: string): Promise<void> {
  const db = await getDb();
  const m = schema.salesChatMessages;
  const [mx] = await db.select({ n: sql<number>`coalesce(max(${m.seq}), 0)::int` }).from(m).where(eq(m.conversationId, conversationId));
  await db.insert(m).values({ conversationId, seq: Number(mx?.n ?? 0) + 1, role: "assistant", content: [{ type: "text", text: `${SHOP_SAID} ${text}` }] });
}

async function onlyActive(titles: string[]): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  await db.update(qr).set({ active: false });
  for (const t of titles) await db.update(qr).set({ active: true }).where(sql`${qr.title} like ${`${t}%`}`);
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
}

const CASES: GoldenCase[] = [
  { key: "qrf-hoi-cha-ca", title: "«xin giá chả cá» ⇒ câu mẫu chả cá thu, không phải câu nem đang mang nhầm cách hỏi đó", shop: "food", channel: "WEB", turns: [{ say: "xin giá chả cá", ai: [] }] },
  { key: "qrf-hoi-nem", title: "«nem bao nhiêu» ⇒ câu mẫu nem", shop: "food", channel: "WEB", turns: [{ say: "nem bao nhiêu", ai: [] }] },
  {
    key: "qrf-page-cha-ca",
    title: "Tin tự động của page giới thiệu chả cá, khách «báo giá» ⇒ không gửi câu nem; AI trả lời chả cá",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "báo giá",
        before: (ctx) => shopSays(ctx.conversationId, "Chả cá thu Hạ Long nhà làm, nhắn shop để được báo giá ạ"),
        ai: [() => [say("Dạ chả cá thu 1kg bên em giá 280.000đ ạ.")]],
      },
    ],
  },
  {
    key: "qrf-cong-cu-sai-mon",
    title: "Khách hỏi chả cá, model gọi send_quick_reply câu nem ⇒ máy chủ từ chối «sai món», khách nhận câu chả cá",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "chả cá thu ship mấy ngày tới nơi", ai: [() => [tool("send_quick_reply", { code: "Q1" })], () => [say("Dạ chả cá thu 1kg 280.000đ, giao 1–2 ngày ạ.")]] }],
  },
  {
    key: "qrf-hoi-chung",
    title: "(chủ shop 18/10) «giá bao nhiêu 1kg» không ai nói món ⇒ câu chả cá chung KHÔNG tự trả lời, AI hỏi lại; page vừa nói chả cá ⇒ câu chả cá trả lời",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "giá bao nhiêu 1kg", ai: [() => [say("Dạ anh/chị hỏi giá món nào ạ? Bên em có chả cá thu, nem hải sản…")]] },
      { say: "giá bao nhiêu 1kg", before: (ctx) => shopSays(ctx.conversationId, "Chả cá thu Hạ Long nhà làm ạ"), ai: [] },
    ],
  },
  {
    key: "qrf-shop-moi-nem",
    title: "(review) Khách hỏi chả cá, shop mời thêm nem, khách «giá sao em» ⇒ câu mẫu nem KHÔNG bị từ chối (nem là món đang bàn)",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "chả cá thu giá sao em", ai: [() => [say("Dạ chả cá thu 1kg bên em giá 280.000đ ạ.")]] },
      { say: "giá sao em", before: (ctx) => shopSays(ctx.conversationId, "Chị lấy thêm nem hải sản tôm bề bề ăn kèm không ạ?"), ai: [() => [tool("send_quick_reply", { code: "Q1" })], () => [say("Mình lấy mấy hộp ạ?")]] },
    ],
  },
];

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-qrf",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      await onlyActive(c.key === "qrf-cong-cu-sai-mon" || c.key === "qrf-shop-moi-nem" ? ["A07"] : ["A01", "A07"]);
    },
    afterCase: async (c, _ctx, t) => {
      seen.add(c.key);
      const shown = t.turns.flatMap((x) => x.shown).join("\n");
      const results = JSON.stringify(t.turns.map((x) => x.rounds.map((r) => r.results)));
      assert.doesNotMatch(shown, /HẾT KỊCH BẢN/, `[${c.key}] ${shown}`);
      if (c.key === "qrf-hoi-cha-ca") {
        assert.equal(t.turns[0].rounds.length, 0, "câu mẫu trả lời, không lời gọi AI");
        assert.match(shown, /chả cá thu bên em 1kg giá 280\.000/, shown);
        assert.doesNotMatch(shown, /Nem|120\.000/, `không bao giờ báo giá nem cho câu hỏi chả cá: ${shown}`);
      }
      if (c.key === "qrf-hoi-nem") {
        assert.equal(t.turns[0].rounds.length, 0);
        assert.match(shown, /Nem hải sản giá 120\.000/, shown);
      }
      if (c.key === "qrf-page-cha-ca") {
        assert.equal(t.turns[0].rounds.length, 1, "câu nem bị loại ⇒ AI trả lời");
        assert.doesNotMatch(shown, /Nem|120\.000/, shown);
        assert.match(shown, /chả cá thu/i);
      }
      if (c.key === "qrf-hoi-chung") {
        assert.equal(t.turns[0].rounds.length, 1, "chưa rõ món ⇒ AI trả lời (không câu mẫu chả cá mặc định)");
        assert.doesNotMatch(t.turns[0].shown.join("\n"), /280\.000/, t.turns[0].shown.join("\n"));
        assert.equal(t.turns[1].rounds.length, 0, "page vừa nói chả cá ⇒ câu mẫu chả cá trả lời, 0 token");
        assert.match(t.turns[1].shown.join("\n"), /chả cá thu bên em 1kg giá 280\.000/, t.turns[1].shown.join("\n"));
        // Đọc danh mục lỗi ⇒ bước khớp chữ THẬT bỏ qua câu mẫu (không «không lọc»).
        const step = await quickReplyByKeyword("xin giá chả cá", { ordering: false, cfg: { shippingFee: 0 }, focus: unavailableQuickReplyGuard() });
        assert.equal(step.kind, "SKIP");
      }
      if (c.key === "qrf-shop-moi-nem") {
        const r2 = JSON.stringify(t.turns[1].rounds.map((r) => r.results));
        assert.doesNotMatch(r2, /không khớp món đang bàn/, r2);
        assert.match(t.turns[1].shown.join("\n"), /Nem hải sản giá 120\.000/, t.turns[1].shown.join("\n"));
      }
      if (c.key === "qrf-cong-cu-sai-mon") {
        assert.match(results, /không khớp món đang bàn/, results);
        assert.doesNotMatch(results, /khách đang hỏi/, "lời từ chối không khẳng định khách đang hỏi gì");
        assert.doesNotMatch(shown, /Nem|120\.000/, shown);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
}

export async function testP0QuickReplyFocus(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 câu mẫu đúng món khách hỏi (18/10/2026): khớp chữ · AI chọn mã · send_quick_reply · page tự động · từ chối · kiểm tĩnh");
}
