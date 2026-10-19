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
import { applyCustomerCartMessage } from "@/lib/sales-chatbot/cart-commitment";
import { SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { quickReplySizeConflict } from "@/lib/sales-chatbot/next-best-action";
import { matchQuickReplyByKeyword, QUICK_REPLY_SETTING_KEY, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { bulkQuickReplies, insertLearned, quickReplyByKeyword, removeWrongProductTriggers, saveQuickReply, setQuickReplyActive } from "@/lib/sales-chatbot/quick-replies";
import { consistentTriggers, productConsistencyError, productFocusOf, productsNamedIn, quickReplyCovers, quickReplyFocusGuard, triggerProductConflicts, unavailableQuickReplyGuard, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
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
  // Review #config-guard: câu có SỐ (giá, khối lượng) vẫn nhận một từ đuôi — trước đây «280k» làm lệch hai dãy từ và tắt luật.
  assert.deepEqual(productsNamedIn("Chả cá 280k/1kg, còn mực thì 350k/1kg ạ", names), ["Chả cá thu", "Chả mực giã tay"]);
  assert.deepEqual(productsNamedIn("Chả cá thu Hạ Long giã tay, 1kg 280k", names), ["Chả cá thu"], "«giã tay» là cách làm, không phải tên Chả mực");
  // Review config-guard (lỗi chặn): món mà từ PHÂN BIỆT là từ chế biến («hấp», «chiên») vẫn nhận ra — tên đầy đủ, combo, câu mẫu không SKU.
  const CAT2: FocusProduct[] = ["Chả cá thu", "Chả mực giã tay", "Chả chiên", "Chả cá hấp", "Chả cá chiên", "Nem hải sản tôm bề bề", "Ruốc bông (chà bông) cá thu nguyên chất"].map((name) => ({ name, skus: [] }));
  const n2 = CAT2.map((p) => p.name);
  assert.deepEqual(productsNamedIn("chả cá hấp còn không", n2), ["Chả cá hấp"]);
  assert.deepEqual(productsNamedIn("chả cá chiên bao nhiêu", n2), ["Chả cá chiên"], "«chả cá chiên» không gọi tên «Chả chiên»");
  assert.deepEqual(productsNamedIn("chả cá thu giá sao", n2), ["Chả cá thu"]);
  assert.deepEqual([...productsNamedIn("1/2 kg chả chiên, 1/2 kg chả cá hấp", n2)].sort(), ["Chả chiên", "Chả cá hấp"].sort(), "combo hai món");
  const hap = E("hap", "Chả cá hấp giá", ["chả cá hấp bao nhiêu", "xin giá chả cá thu"], "Chả cá hấp bên em 300k/kg ạ");
  assert.deepEqual(quickReplyCovers(hap, CAT2), ["Chả cá hấp"], "câu mẫu chả cá hấp không SKU vẫn GẮN món (không thành câu chung)");
  assert.deepEqual(triggerProductConflicts(hap, CAT2).map((c) => c.trigger), ["xin giá chả cá thu"], "cách hỏi chả cá thu trên câu hấp vẫn bị gắn cờ ⇒ nút gỡ gỡ nó");
  const gThu = quickReplyFocusGuard([C("chả cá thu giá sao")], CAT2);
  assert.ok(!gThu.fits(hap) && !gThu.answers(hap), "«chả cá thu giá sao» KHÔNG được trả lời bằng câu chả cá hấp");
  const comboChien = E("cc", "Chả chiên giá", ["chả chiên"], "Chả chiên bên em 250k/kg ạ");
  assert.ok(!quickReplyFocusGuard([C("1/2 kg chả chiên, 1/2 kg chả cá hấp")], CAT2).answers(comboChien), "câu một món không thay cả lượt cho combo hai món");
  // Review #902 (CI đỏ thật ở inbox-composer): từ chỉ chung một món hàng không tự gọi tên món — kể cả khi chỉ một món mang nó ở đầu tên.
  const CAT3 = ["Hàng riêng OSOAN-O-SOAN-A-4417", "Sản phẩm Y", "Món Z", "Nước mắm X"];
  for (const t of ["còn hàng không", "sản phẩm này còn không", "món này giá sao", "hàng còn không shop", "đặc sản gì vậy"]) assert.deepEqual(productsNamedIn(t, CAT3), [], `«${t}» không gọi tên món nào`);
  assert.deepEqual(productsNamedIn("hàng riêng osoan còn không", CAT3), ["Hàng riêng OSOAN-O-SOAN-A-4417"]);
  assert.deepEqual(productsNamedIn("sản phẩm y bao nhiêu", CAT3), ["Sản phẩm Y"]);
  assert.deepEqual(productsNamedIn("món z còn không", CAT3), ["Món Z"]);
  assert.deepEqual(productsNamedIn("nước mắm x", CAT3), ["Nước mắm X"]);
  assert.equal(productConsistencyError(E("ton", "Tồn chả mực", ["còn hàng không"], "Còn {{tồn:OS-NOREC}} hộp ạ."), CAT3.map((name) => ({ name, skus: [] }))), null, "câu mẫu tồn kho chung lưu được");
  const giaChaCa = E("gcc", "Giá chả cá", ["chả cá bao nhiêu", "mực bao nhiêu", "món mực còn không"], "Chả cá 280k/1kg, còn mực thì 350k/1kg ạ");
  assert.deepEqual(triggerProductConflicts(giaChaCa, PRODUCTS), [], "câu trả lời có giá nói cả mực ⇒ cách hỏi về mực KHÔNG bị coi là gắn nhầm");
  // Review #p0-quick-reply-evidence (lỗi chặn): ngành hàng / tên shop không phải tên món; màu / cỡ / thời tiết cũng vậy.
  for (const t of ["shop bán hải sản gì", "báo giá hải sản", "hai san", "Hải Sản Hạ Long xin chào", "nước mắm truyền thống không", "loại nguyên chất không", "cá cơm"]) {
    assert.ok(!productsNamedIn(t, names).includes("Nem hải sản tôm bề bề") && !productsNamedIn(t, names).some((n) => n.startsWith("Ruốc")), `«${t}» không gọi tên nem / ruốc: ${productsNamedIn(t, names).join(", ")}`);
  }
  assert.deepEqual(productsNamedIn("nước mắm truyền thống không", names), ["Nước mắm cốt cá cơm truyền thống"], "«nước mắm» (từ đầu + từ hai) vẫn gọi tên");
  const shopKhac = ["Áo sơ mi trắng", "Đầm Q005 đen", "Cá thu một nắng", "Quần jean xanh"];
  for (const t of ["màu trắng còn không", "có đen không", "trời nắng ship có sao không", "xanh hay đen đẹp hơn"]) assert.deepEqual(productsNamedIn(t, shopKhac), [], `«${t}» không gọi tên món nào`);
  assert.equal(keyword(["báo giá hải sản"]), "NONE", "«báo giá hải sản» (lạnh) không được trả lời bằng câu nem");
  assert.equal(keyword(["báo giá"], `${SHOP_SAID} Cảm ơn bạn đã nhắn tin cho Hải Sản Hạ Long, chúng tôi sẽ phản hồi sớm`), "NONE", "lời chào của page mang tên shop không phải căn cứ món nem");
  assert.deepEqual(productFocusOf([C("xin giá chả cá"), S("Dạ chả cá thu 280k ạ. Cảm ơn chị đã ủng hộ Hải Sản Hạ Long"), C("1kg nhé")], PRODUCTS).offered, [], "lời chào ký tên shop không thành lời mời nem");
  // Ngữ cảnh bài viết (lượt bình luận) là căn cứ món.
  assert.deepEqual(productFocusOf([S("BÌNH LUẬN DƯỚI BÀI VIẾT: … «Chả cá thu Hạ Long giã tay, 1kg 280k»"), C("giá sao")], PRODUCTS).focus, ["Chả cá thu"]);
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
  assert.match(engSrc, /if \(qrFocus\?\.unavailable\) \{\s*console\.warn\(/, "bộ lọc đóng để lại log");
  assert.match(engSrc, /quickGuardClosed: \{ at: now\.toISOString\(\), turn: turnSeq \}/, "bộ lọc đóng để lại dấu trên hội thoại (trace đếm)");
  assert.match(engSrc, /\.\.\.\(opts\.context \? \[\{ who: "SHOP" as const, text: opts\.context \}\] : \[\]\)/, "ngữ cảnh bài viết vào căn cứ món");
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

  // Tự nạp / nhập: cách hỏi đề xuất sai món bị bỏ trước khi thêm vào câu mẫu cũ.
  assert.deepEqual(consistentTriggers(A07, ["nem tôm bao nhiêu", "xin giá chả cá", "1 hộp ruốc tôm", "báo giá nhé"], PRODUCTS), ["nem tôm bao nhiêu", "báo giá nhé"]);
  assert.equal(productConsistencyError(A01, PRODUCTS), null);
  assert.match(productConsistencyError(A07, PRODUCTS) ?? "", /«xin giá chả cá» \(gọi tên Chả cá thu\)/);
  const learnSrc = readFileSync("lib/sales-chatbot/quick-replies-learn.ts", "utf8");
  assert.match(learnSrc, /mergeTriggers\(current, consistentTriggers\(/, "tự nạp lọc cách hỏi qua consistentTriggers trước khi thêm");
  // KIỂM TĨNH: cách hỏi gắn nhầm món trên câu nem — đúng ba cách hỏi gọi tên chả cá.
  assert.deepEqual(triggerProductConflicts(A07, PRODUCTS).map((x) => x.trigger), ["xin giá chả cá", "Xin giá chả cá nhé shop", "Báo giá chả cá thu?"]);
  assert.deepEqual(triggerProductConflicts(A01, PRODUCTS), []);
  assert.deepEqual(triggerProductConflicts(UPSELL, PRODUCTS), [], "câu menu chung mang «có chả mực không» là hợp lệ");

  // #868 TRÊN CÂU MẪU (production 19/10/2026, HSLC): câu mẫu gửi nguyên văn mà hỏi lại «1kg hay 2kg» cho món khách đã chọn khối lượng ⇒
  // nhường AI. Dùng lại phán xét của guardReply; quy cách đã chọn của món KHÁC không chặn câu mẫu món này.
  const NAMES = ["Chả cá thu", "Nem hải sản tôm bề bề"];
  const factsQ = { catalogNames: NAMES, crossSell: [], volume: [], menu: false, freeShip: false };
  const ASK = "Dạ chả cá thu bên em 1kg giá 280.000 ₫ ạ. Dạ, mình muốn mua 1kg hay 2kg ạ?";
  const cartOf = (t: string) => applyCustomerCartMessage(undefined, t, 1, new Date(), { catalog: NAMES });
  const caKg = cartOf("cho chị 1kg chả cá thu");
  assert.ok(caKg?.selectedItems.some((x) => x.customerExplicit), JSON.stringify(caKg));
  assert.ok(quickReplySizeConflict(ASK, { cart: caKg, lastUserText: "cho chị 1kg chả cá thu", facts: factsQ }), "đã chọn 1kg ⇒ câu mẫu hỏi lại quy cách nhường AI");
  assert.ok(!quickReplySizeConflict(ASK, { cart: undefined, lastUserText: "giá chả cá thu", facts: factsQ }), "chưa chọn ⇒ câu mẫu vẫn gửi");
  assert.ok(!quickReplySizeConflict("Dạ chả cá thu bên em 1kg giá 280.000 ₫ ạ.", { cart: caKg, lastUserText: "cho chị 1kg chả cá thu", facts: factsQ }), "câu mẫu không hỏi lại quy cách ⇒ gửi");
  const nem2 = cartOf("cho chị 2 hộp nem hải sản tôm bề bề");
  assert.ok(nem2?.selectedItems.some((x) => x.customerExplicit), JSON.stringify(nem2));
  assert.ok(!quickReplySizeConflict(ASK, { cart: nem2, lastUserText: "giá chả cá thu", facts: factsQ }), "(1) chọn quy cách NEM không chặn câu mẫu CHẢ CÁ");
  assert.ok(!quickReplySizeConflict(ASK, { cart: nem2, lastUserText: "ok em", facts: factsQ }), "(1) khách không gọi tên món, giỏ chỉ có nem ⇒ câu mẫu gọi tên chả cá vẫn đi");
  assert.ok(!quickReplySizeConflict(ASK, { cart: caKg, lastUserText: "cho chị 1kg chả cá thu, có mấy loại size em", facts: factsQ }), "khách HỎI các quy cách ⇒ câu hỏi quy cách là câu trả lời (luật guardReply)");
  const engQ = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.match(engQ, /quick\.kind === "ANSWER" && !quickReasks\(quick\.pick\) && !\(await quickSizeReask\(quick\.pick\)\)\) return sendQuick/, "đường khớp chữ qua luật quy cách");
  assert.match(engQ, /qrFocus\.answers\(pick\.entry\)\) && !\(await quickSizeReask\(pick\)\)\) return sendQuick\(pick, pre\)/, "đường AI chọn mã qua luật quy cách");
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
    // Dáng câu A01 thật của HSLC: báo giá rồi HỎI quy cách (#868 trên câu mẫu, 19/10/2026).
    { title: "B90 Chả cá thu hỏi quy cách", triggers: ["chả cá thu", "giá chả cá thu"], answer: `${CHA_CA} Dạ, mình muốn mua 1kg hay 2kg ạ?`, active: false },
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
    key: "qrf-da-chon-quy-cach",
    title: "(#868 trên câu mẫu, 19/10) «cho chị 1kg chả cá thu» ⇒ câu mẫu hỏi lại «1kg hay 2kg» KHÔNG gửi, AI trả lời và không hỏi lại",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "cho chị 1kg chả cá thu", ai: [() => [say("Dạ chị lấy 1kg chả cá thu 280.000đ ạ. Dạ, mình muốn mua 1kg hay 2kg ạ? Chị cho em xin SĐT và địa chỉ nhận hàng nhé.")]] }],
  },
  {
    key: "qrf-cong-cu-quy-cach",
    title: "(#868 trên câu mẫu) «cho chị 1kg chả cá thu», model gọi send_quick_reply câu mẫu hỏi quy cách ⇒ máy chủ từ chối, model trả lời bằng chữ, không hỏi lại",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "cho chị 1kg chả cá thu", ai: [() => [tool("send_quick_reply", { code: "Q1" })], () => [say("Dạ chị lấy 1kg chả cá thu 280.000đ ạ. Chị cho em xin SĐT và địa chỉ nhận hàng nhé.")]] }],
  },
  { key: "qrf-chua-chon-quy-cach", title: "(#868 trên câu mẫu) «giá chả cá thu» (chưa chọn khối lượng) ⇒ câu mẫu hỏi quy cách VẪN gửi nguyên văn", shop: "food", channel: "WEB", turns: [{ say: "giá chả cá thu", ai: [] }] },
  {
    key: "qrf-quy-cach-mon-khac",
    title: "(#868 trên câu mẫu) khách chọn 2 hộp nem rồi hỏi giá chả cá thu ⇒ câu mẫu chả cá vẫn gửi (quy cách của món KHÁC không chặn)",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "cho chị 2 hộp nem hải sản tôm bề bề", ai: [() => [say("Dạ chị lấy 2 hộp nem hải sản tôm bề bề ạ.")]] },
      { say: "giá chả cá thu", ai: [] },
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

/**
 * (chủ shop 18/10, chốt hoàn thành) CẤU HÌNH SAI KHÔNG ĐƯỢC TỰ TÁI XUẤT HIỆN: lưu / sửa · bật một câu · bật hàng loạt · câu AI soạn
 * (tự bật) đều kiểm cách hỏi ↔ câu trả lời ↔ SKU cùng món; nút «Gỡ cách hỏi gắn nhầm món» gỡ ĐÚNG các cách hỏi đó, giữ câu mẫu / câu
 * trả lời / cách hỏi khác, và ghi nhật ký trước / sau để khôi phục. Chạy ở ca cuối (sửa dữ liệu câu mẫu của tổ chức thử).
 */
async function testConfigPaths(ctx: GoldenHookCtx): Promise<void> {
  const admin = await ctx.admin();
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const bad = await saveQuickReply(admin, { title: "Nem sai", triggers: "nem bao nhiêu\nxin giá chả cá", answer: NEM, active: true });
  assert.ok("error" in bad && /xin giá chả cá.*gọi tên Chả cá thu/.test(bad.error), JSON.stringify(bad));
  const combo = await saveQuickReply(admin, { title: "Combo chả cá + nem", triggers: "1 chả cá 1 nem", answer: `${CHA_CA} ${NEM}`, active: true });
  assert.ok("ok" in combo, `combo có câu trả lời nói CẢ HAI món ⇒ lưu được: ${JSON.stringify(combo)}`);
  // Câu đang có (dữ liệu cũ) mang cách hỏi sai ⇒ không bật được, bật hàng loạt bỏ qua.
  const [old] = await db.insert(qr).values({ title: "Nem cũ", triggers: ["nem hộp", "Báo giá chả cá thu?"], answer: NEM, active: false }).returning({ id: qr.id });
  const act = await setQuickReplyActive(admin, old.id, true);
  assert.ok("error" in act && /gọi tên Chả cá thu/.test(act.error), JSON.stringify(act));
  const bulk = await bulkQuickReplies(admin, [old.id], "ACTIVATE");
  assert.ok("ok" in bulk && bulk.changed === 0 && bulk.skipped === 1, JSON.stringify(bulk));
  // Câu AI soạn: «tự bật» không bật câu có cách hỏi sai.
  assert.equal(await insertLearned([{ title: "AI nem", triggers: ["xin giá chả cá"], answer: NEM }, { title: "AI nem đúng", triggers: ["nem hải sản bn"], answer: NEM }], { actorEmail: "bot", active: true }), 2);
  const learned = await db.select({ title: qr.title, active: qr.active }).from(qr).where(sql`${qr.title} in ('AI nem', 'AI nem đúng')`);
  assert.deepEqual(learned.map((r) => `${r.title}:${r.active}`).sort(), ["AI nem đúng:true", "AI nem:false"]);
  // Nút dọn: chỉ gỡ cách hỏi gắn nhầm món; ghi nhật ký trước / sau.
  const pruned = await removeWrongProductTriggers(admin);
  assert.ok("ok" in pruned && pruned.triggers >= 3, JSON.stringify(pruned));
  const after = new Map((await db.select({ title: qr.title, triggers: qr.triggers }).from(qr)).map((r) => [r.title, r.triggers ?? []]));
  assert.deepEqual(after.get("A07 Nem hải sản tôm bề bề giá bao nhiêu"), ["nem bao nhiêu", "giá nem", "báo giá"], "A07 chỉ mất hai cách hỏi chả cá");
  assert.deepEqual(after.get("Nem cũ"), ["nem hộp"]);
  assert.deepEqual(after.get("A01 Báo giá chả cá thu"), ["giá chả cá thu", "Cha ca", "Xin giá chả cá thu?", "giá bao nhiêu 1kg"], "câu đúng không bị đụng");
  const logs = await db.select({ detail: schema.auditLogs.detail }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "SALES_QUICK_REPLY_TRIGGERS_PRUNE"));
  assert.ok(logs.length >= 2 && logs.every((l) => Array.isArray((l.detail as { before?: { triggers?: unknown } } | null)?.before?.triggers)), "nhật ký giữ cách hỏi cũ để khôi phục");
  const again = await removeWrongProductTriggers(admin);
  assert.ok("ok" in again && again.triggers === 0 && again.skippedConcurrent === 0, "chạy lại không gỡ gì thêm");
}

async function testChatTurn() {
  const seen = new Set<string>();
  await runGoldenCases(CASES, {
    orgSuffix: "-qrf",
    beforeCase: async (c, ctx) => {
      await seed(ctx);
      await onlyActive(c.key === "qrf-cong-cu-sai-mon" || c.key === "qrf-shop-moi-nem" ? ["A07"] : c.key.includes("quy-cach") ? ["B90"] : ["A01", "A07"]);
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      if (c.key === "qrf-shop-moi-nem") await testConfigPaths(ctx);
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
      if (c.key.includes("quy-cach")) {
        const db = await getDb();
        const [row] = await db.select({ state: schema.salesChatConversations.state }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
        const yields = ((row?.state ?? {}) as { quickSizeYields?: string[] }).quickSizeYields ?? [];
        if (c.key === "qrf-cong-cu-quy-cach") {
          assert.match(results, /hỏi lại quy cách khách đã chọn/, results);
          assert.doesNotMatch(results, /"sent":true/, "câu mẫu KHÔNG được gửi qua công cụ");
          assert.equal(t.turns[0].rounds.length, 2, "từ chối ⇒ model đi tiếp trong cùng lượt (không vòng lặp, không chuyển người)");
          assert.doesNotMatch(shown, /1kg hay 2kg/, shown);
          assert.match(shown, /SĐT/, shown);
        } else if (c.key === "qrf-da-chon-quy-cach") {
          assert.equal(t.turns[0].rounds.length, 1, "câu mẫu nhường ⇒ AI trả lời");
          assert.doesNotMatch(shown, /1kg hay 2kg/, `không hỏi lại quy cách khách đã chọn: ${shown}`);
          assert.match(shown, /SĐT/, shown);
          assert.equal(yields.length, 1, "ghi một mốc nhường AI (ops đếm giá token)");
        } else {
          const last = t.turns[t.turns.length - 1];
          assert.equal(last.rounds.length, 0, "câu mẫu trả lời, 0 lời gọi AI");
          assert.match(last.shown.join("\n"), /chả cá thu bên em 1kg giá 280\.000.*1kg hay 2kg/, last.shown.join("\n"));
          assert.equal(yields.length, 0);
        }
      }
      if (c.key === "qrf-cong-cu-sai-mon") {
        assert.match(results, /không khớp món đang bàn/, results);
        assert.doesNotMatch(results, /khách đang hỏi/, "lời từ chối không khẳng định khách đang hỏi gì");
        assert.doesNotMatch(shown, /Nem|120\.000/, shown);
      }
    },
  });
  assert.equal(seen.size, CASES.length, "mọi ca đều chạy");
  assert.ok(seen.has("qrf-shop-moi-nem"), "ca chạy kiểm đường cấu hình (testConfigPaths) đã chạy");
}

export async function testP0QuickReplyFocus(): Promise<void> {
  testThuan();
  await testChatTurn();
  console.log("✓ P0 câu mẫu đúng món khách hỏi (18/10/2026): khớp chữ · AI chọn mã · send_quick_reply · page tự động · từ chối · kiểm tĩnh");
}
