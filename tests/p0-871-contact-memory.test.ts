/**
 * ═══════════ #871 — THÔNG TIN NHẬN HÀNG LÀ NGUỒN SỰ THẬT · HẸN GIỜ GIAO · HẬU MÃI KHÔNG BÁN TIẾP (P0 HSLC 16/10/2026) ═══════════
 *
 * Hai ca thật (dữ liệu đã thay — SĐT 0900000xxx, số nhà / toà nhà bịa, không PII khách):
 *  · «Ngọc Nguyễn» (hội thoại 904b7c9b…, 17:29–17:32): «Ship gò vấp bn? Mình muốn mua 1 kg» → SĐT + địa chỉ đầy đủ trong MỘT bong bóng →
 *    bot «em ghi nhận địa chỉ» → «Giao sáng mai khoảng 9h» ⇒ bot xin lại SĐT + địa chỉ → «Lấy 10 cái nem hải sản» ⇒ bot xin xác nhận lại
 *    «Phường An Hội Tây»; không đơn nào được lên.
 *    ROOT CAUSE (1) `addressReaskVerdict` coi địa chỉ là «đã biết» CHỈ khi tin MỚI NHẤT chốt địa chỉ (`lastSettlesAddress`) — đổi chủ đề
 *    là câu xin lại lọt; (2) câu mẫu khớp chữ «giao» đi NGUYÊN VĂN tới khách, không qua hàng rào thông tin nhận hàng (chỉ chữ model qua
 *    nó), và `ordering` của câu mẫu chỉ bật khi đã có đơn nháp — đơn chưa lên (3) nên cửa này mở; (3) model muốn «xác nhận lại địa chỉ»
 *    trước khi lên đơn, hàng rào bỏ câu hỏi và chỉ còn «em ghi nhận địa chỉ», không gì nói với model rằng thông tin đã ĐỦ để lên đơn.
 *  · «Nguyễn Hà»: đơn 280.000 ₫ đã chốt; bot vẫn xin xác nhận đơn, hỏi lại địa chỉ, mời mua; khách hỏi trạng thái thì bot upsell.
 *    ROOT CAUSE: giai đoạn sau chốt chỉ có LỜI DẶN trong lời nhắc (`postSalePrompt`), không có hàng rào máy chủ.
 *
 * Luật khoá ở đây: tin đổi chủ đề KHÔNG mở lại câu hỏi thông tin nhận hàng · câu mẫu cũng chịu hàng rào · hẹn giờ giao ⇒ ghi chú đơn,
 * không hứa mốc · lên đơn đủ món (10 cái nem = 1 hộp 10 cái) · sau chốt không xin chốt lại / không mời mua / «lần sau» không thành đơn ·
 * lượt lặp không sinh đơn thứ hai. Hội thoại vàng qua ĐÚNG `chatTurn` với model giả, trên tổ chức thử — KHÔNG gửi tin thật.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiBlock, AiProvider, AiResponse } from "@/lib/ai/provider";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { parsePancakeWebhook, processFanpageThread, receiveFanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { withoutPhones } from "@/lib/address/customer-address";
import { createProductCore } from "@/lib/records/product-create";
import { ADDRESS_KNOWN_TEXT, SCHEDULE_NOTED_TEXT, addressKnowledge, addressReaskVerdict, continuesSameOrder, knownContactPrompt, placeOrRecipientSignal } from "@/lib/sales-chatbot/address-memory";
import { deliveryPreferenceNote, deliveryPreferenceOf, deliveryPromiseIn } from "@/lib/sales-chatbot/delivery-intent";
import { applyCustomerCartMessage, classifyCartMessage } from "@/lib/sales-chatbot/cart-commitment";
import { POST_SALE_NEUTRAL_TEXT, POST_SALE_THANKS_TEXT, asksQuestion, futurePurchaseOnly, orderStatusSayOf, postSaleDropsIn, postSaleFallbackText, postSaleReplyGuard } from "@/lib/sales-chatbot/post-sale-guard";
import { quickReplyByKeyword } from "@/lib/sales-chatbot/quick-replies";
import { QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";
import { runGoldenCases, say, tool, type GoldenCase, type GoldenHookCtx } from "./sales-agent-golden/harness";

/** Ca «Ngọc Nguyễn» — đã thay: SĐT giả, số nhà + toà nhà bịa (giữ dạng «số nhà + chung cư + Quang Trung + An Hội Tây + TP.HCM»). */
const NGOC_PHONE = "0900000871";
const NGOC_ADDR = "Số 12 lô B chung cư Ví Dụ, Quang Trung, An Hội Tây, TP.HCM";
const NGOC_BUBBLE = `${NGOC_PHONE}\n${NGOC_ADDR}`;
/** Câu mẫu của shop (nguyên văn trong ảnh chủ shop gửi — không PII) — khớp chữ «giao». */
const QR_TEXT = "Dạ bên em giao hàng nhanh chóng tận nơi rồi ạ. Dạ, mình cho em xin SĐT + địa chỉ chính xác để em check tuyến giao sớm nhất cho mình nhé!";
const WARD_RECONFIRM = "Dạ, anh/chị cho em xác nhận lại địa chỉ nhận hàng ở Phường An Hội Tây đúng không ạ?";
/** Ca «Nguyễn Hà» — đã thay. */
const HA_PHONE = "0900000872";
const HA_ADDR = "Số 8 ngõ 2 phố Ví Dụ, phường Cầu Giấy, Hà Nội";

function testPure() {
  // ① ĐỔI CHỦ ĐỀ KHÔNG MỞ LẠI CÂU HỎI THÔNG TIN NHẬN HÀNG.
  const st = { customer: { id: null, name: "Ngọc", phone: NGOC_PHONE, address: NGOC_ADDR, province: "", simulated: true } } as Pick<ChatState, "customer">;
  for (const last of ["Giao sáng mai khoảng 9h", "Lấy 10 cái nem hải sản", "giao cho chị 9h sáng mai nhé", "nem hải sản bao nhiêu em"]) {
    assert.equal(continuesSameOrder(last), true, last);
    const k = addressKnowledge(st, ["Ship gò vấp bn? Mình muốn mua 1 kg", NGOC_BUBBLE, last]);
    assert.deepEqual([k.lastSettlesAddress, k.phoneKnown, k.ward], [true, true, "Phường An Hội Tây"], `${last}: ${JSON.stringify(k)}`);
    assert.deepEqual(addressReaskVerdict(QR_TEXT, k, 5)?.rest, "Dạ bên em giao hàng nhanh chóng tận nơi rồi ạ.", `${last}: câu xin SĐT + địa chỉ bị bỏ, câu còn lại giữ`);
    assert.equal(addressReaskVerdict(WARD_RECONFIRM, k, 5)?.rest, "", `${last}: câu xác nhận lại phường bị bỏ`);
  }
  // ... nhưng lời đổi nơi giao / người nhận vẫn mở được câu hỏi (review PR #848 lần 4 giữ nguyên).
  for (const last of ["gửi cho mẹ chị dưới quê nhé", "ship về quê chị ở Nghệ An nhé", "à đơn này người nhận khác nha em", "giao cho anh Huy nhé", "chị không ở đó nữa rồi em", "à chị muốn đổi địa chỉ giao nhé"]) {
    assert.equal(continuesSameOrder(last), false, last);
    assert.equal(addressReaskVerdict("Dạ chị cho em xin địa chỉ của người nhận ạ?", addressKnowledge(st, [NGOC_BUBBLE, last]), 3), null, last);
  }
  // «giao cho chị …» với chính khách xưng hô ⇒ SĐT vẫn là đã biết; «giao cho anh Huy» ⇒ người khác.
  assert.equal(addressKnowledge(st, [NGOC_BUBBLE, "giao cho chị sáng mai nhé"]).phoneKnown, true);
  assert.equal(addressKnowledge(st, [NGOC_BUBBLE, "giao cho anh Huy nhé"]).phoneKnown, false);

  // ② SĐT + địa chỉ trên CÙNG một dòng: SĐT không thành số nhà.
  assert.equal(withoutPhones(`${NGOC_PHONE} ${NGOC_ADDR}`).trim(), NGOC_ADDR);
  assert.equal(withoutPhones(`${NGOC_ADDR}. SĐT: 0900 000 871`).trim(), `${NGOC_ADDR}.`);
  assert.equal(addressKnowledge({}, [`${NGOC_PHONE} ${NGOC_ADDR}`]).ward, "Phường An Hội Tây");

  // ③ KHỐI «THÔNG TIN NHẬN HÀNG ĐÃ CÓ» — chỉ khi chắc, không chép SĐT / số nhà.
  const block = knownContactPrompt(st, [NGOC_BUBBLE, "Giao sáng mai khoảng 9h"]);
  assert.ok(/THÔNG TIN NHẬN HÀNG ĐÃ CÓ/.test(block) && /create_draft_order/.test(block), block);
  assert.ok(!block.includes(NGOC_PHONE) && !block.includes("Số 12"), "khối không chép SĐT / số nhà");
  assert.equal(knownContactPrompt(st, [NGOC_BUBBLE, "gửi cho mẹ chị dưới quê nhé"]), "", "đổi người nhận ⇒ không khẳng định");
  assert.equal(knownContactPrompt({}, ["Ship gò vấp bn? Mình muốn mua 1 kg"]), "", "chưa có gì ⇒ không khối");

  // ④ HẸN GIỜ GIAO: là mong muốn (ghi chú), không phải lời hứa.
  assert.equal(deliveryPreferenceOf("Giao sáng mai khoảng 9h"), "Giao sáng mai khoảng 9h");
  assert.equal(deliveryPreferenceOf("thứ 7 giao giúp chị nhé"), "thứ 7 giao giúp chị nhé");
  assert.equal(deliveryPreferenceOf("bao giờ giao em?"), null, "hỏi «bao giờ» trần không phải hẹn giờ");
  assert.equal(deliveryPreferenceOf("giao trong ngày được không"), null, "câu hỏi chính sách không phải lời hẹn");
  assert.equal(deliveryPreferenceOf("Lấy 10 cái nem hải sản"), null);
  assert.deepEqual(deliveryPromiseIn(SCHEDULE_NOTED_TEXT), [], "câu ghi nhận không phải lời hứa");
  assert.deepEqual(deliveryPromiseIn("Dạ em ghi nhận mong muốn giao khoảng 9h sáng mai, shop kiểm tra lịch giao rồi báo lại mình nhé."), [], "ghi nhận có nêu mốc vẫn không phải hứa");
  assert.deepEqual(deliveryPromiseIn("Dạ sáng mai 9h bên em giao tới cho mình nhé. Mình cần thêm gì không ạ?"), ["Dạ sáng mai 9h bên em giao tới cho mình nhé."]);
  const note = deliveryPreferenceNote({ text: "Giao sáng mai khoảng 9h", at: "2026-10-16T10:31:00.000Z" });
  assert.ok(/CHƯA xác nhận với ĐVVC/.test(note) && /«Giao sáng mai khoảng 9h»/.test(note) && /17:31/.test(note), `mốc giờ VN của tin khách: ${note}`);

  // ⑤ HẬU MÃI: bỏ câu mời mua + câu xin chốt lại; câu trạng thái giữ nguyên; câu KỂ «đã chốt» không bị bỏ.
  const ps = postSaleReplyGuard("Dạ đơn của chị đang chờ gửi đi ạ. Chị xác nhận lại đơn giúp em nhé? Mình lấy thêm 1 hộp nem hải sản không ạ?");
  assert.deepEqual([ps.text, ps.dropped], ["Dạ đơn của chị đang chờ gửi đi ạ.", ["RECONFIRM", "UPSELL"]]);
  assert.deepEqual(postSaleReplyGuard("Dạ đơn của chị đã chốt rồi ạ, shop đóng gói và gửi sớm nhé.").dropped, [], "câu kể không bị bỏ");
  assert.deepEqual(postSaleReplyGuard("Đã chốt đơn (thử — không tạo đơn thật, không báo nhóm), tổng thu 400.000 ₫.").dropped, [], "«không» giữa câu kể không biến nó thành câu hỏi");
  // Luật chủ shop (không bán tiếp sau chốt — review PR #878 vòng 2): tin CHỈ có lời mời thì chữ GỬI ĐI là rỗng, không phải nguyên tin.
  assert.deepEqual(postSaleReplyGuard("Dạ bên em đang có combo nem hải sản ưu đãi cho chị nè."), { text: "", dropped: ["UPSELL"], emptied: true });
  assert.equal(futurePurchaseOnly("ok em, mua tiếp lần sau nhé"), true);
  assert.equal(futurePurchaseOnly("hôm khác chị đặt tiếp"), true);
  assert.equal(futurePurchaseOnly("lần sau thì lấy 2kg, giờ lấy luôn 1kg nhé"), false, "có lời mua ngay ⇒ không phải chỉ tương lai");
  assert.equal(futurePurchaseOnly("Lấy 10 cái nem hải sản"), false);
  console.log("  ✓ #871 thuần: đổi chủ đề (hẹn giờ giao · thêm món · hỏi giá) giữ SĐT + địa chỉ đã biết, đổi người nhận / nơi giao vẫn hỏi được · SĐT cùng dòng không thành số nhà · khối «thông tin nhận hàng đã có» không chép PII · hẹn giờ giao là ghi chú, không phải lời hứa · hậu mãi bỏ câu mời mua / xin chốt lại · «lần sau» không phải đơn");
}

/** Bốn điểm chặn của review PR #878 — mỗi ca là một câu thật reviewer dựng lại; tất cả HÀM THUẦN. */
function testReviewBlockers() {
  const st = { customer: { id: null, name: "Ngọc", phone: NGOC_PHONE, address: NGOC_ADDR, province: "", simulated: true } } as Pick<ChatState, "customer">;
  const ask = "Dạ mình cho em xin SĐT + địa chỉ chính xác để em check tuyến giao nhé!";
  // B1 — AN TOÀN MẶC ĐỊNH: một dấu hiệu nơi giao / người nhận ⇒ không «cùng đơn», câu hỏi đi qua, không khối «lên đơn NGAY».
  for (const last of [
    "giao 2kg tới chỗ làm chị nha",
    "mai giao 9h ở công ty chị nhé",
    "mai chị đi làm, giao 9h tới cơ quan nhé",
    "lấy 2kg gửi ra Hà Nội giúp chị",
    "lấy 2kg giao tận Biên Hòa nha",
    "chiều mai giao Thủ Đức giúp chị",
    "lấy 2 hộp gửi về Thủ Đức cho chị",
    "ship 2 hộp cho chị Lan nhé",
    "lấy 2 hộp cho em gái chị",
    "lấy 2kg gửi giúp bạn chị",
    "giao 2kg cho bé nhà chị ở trường",
    "giao cho chị Mai sáng mai",
  ]) {
    assert.equal(continuesSameOrder(last), false, `cùng đơn? ${last}`);
    assert.equal(placeOrRecipientSignal(last), true, `dấu hiệu nơi / người: ${last}`);
    const texts = ["Ship gò vấp bn? Mình muốn mua 1 kg", NGOC_BUBBLE, last];
    assert.equal(addressReaskVerdict(ask, addressKnowledge(st, texts), 5), null, `câu xin SĐT + địa chỉ phải đi qua: ${last}`);
    assert.equal(addressReaskVerdict(WARD_RECONFIRM, addressKnowledge(st, texts), 5), null, `câu xác nhận phường phải đi qua: ${last}`);
    assert.equal(knownContactPrompt(st, texts), "", `không bảo model lên đơn NGAY: ${last}`);
  }
  // ... chỉ tin KHÔNG có dấu hiệu nào mới tiếp tục: «giao cho chị nhé» · giờ thuần · món thuần · hỏi giá thuần.
  for (const last of ["giao cho chị nhé", "Giao sáng mai khoảng 9h", "giao cho chị 9h sáng mai nhé", "Lấy 10 cái nem hải sản", "nem hải sản bao nhiêu em", "cho chị 1kg nhé", "đổi sang 2kg nhé", "giao cho chị mai nhé"]) {
    assert.equal(placeOrRecipientSignal(last), false, `không dấu hiệu nơi / người: ${last}`);
    assert.equal(continuesSameOrder(last), true, `cùng đơn: ${last}`);
  }

  // B2 — câu hỏi giá đứng SAU số lượng vẫn là câu HỎI (không thành món đã chốt); câu hỏi ở câu TRƯỚC thì không kéo lời mua sau thành câu hỏi.
  const cat = ["Chả cá thu (1kg)", "Nem hải sản hộp 10 cái"];
  for (const m of ["2kg chả cá thu. Bao nhiêu vậy em?", "Chả cá thu 2kg. Giá sao em?", "Cho chị hỏi 2kg chả cá thu\nbao nhiêu tiền"]) {
    assert.equal(classifyCartMessage(m, cat).kind, "QUESTION", m);
    assert.equal(applyCustomerCartMessage(undefined, m, 1, new Date("2026-10-16T10:00:00Z"), { catalog: cat, products: cat }), undefined, `không vào giỏ: ${m}`);
  }
  assert.equal(classifyCartMessage("Ship gò vấp bn? Mình muốn mua 1 kg", cat).kind, "ORDER", "«?» ở câu TRƯỚC không biến lời mua thành câu hỏi");

  // B3 — lời mua thật kèm ngày giao muộn KHÔNG phải «mua lần sau»; ngày giao muộn là mong muốn giờ giao.
  for (const m of ["chị lấy 2kg, tuần sau giao", "lấy 2kg giao tháng sau nhé", "tuần sau giao giúp chị 2kg nhé", "lần sau chị lấy 2kg nhé", "tuần sau giao giúp chị nhé"]) {
    assert.equal(futurePurchaseOnly(m), false, `không phải «chỉ tương lai»: ${m}`);
  }
  assert.equal(deliveryPreferenceOf("tuần sau giao giúp chị nhé"), "tuần sau giao giúp chị nhé", "ngày giao muộn trên đơn = mong muốn giờ giao");
  assert.equal(deliveryPreferenceOf("chị lấy 2kg, tuần sau giao"), "chị lấy 2kg, tuần sau giao");
  assert.equal(futurePurchaseOnly("ok em, mua tiếp lần sau nhé"), true, "«mua tiếp lần sau» vẫn là ý định tương lai (công cụ chỉ chặn nó sau chốt)");
  assert.equal(deliveryPreferenceOf("mai giao em nhé, sdt 0912345678"), "mai giao em nhé", "SĐT không vào ghi chú giờ giao");
  assert.ok(!(deliveryPreferenceOf("Giao sáng mai 9h nhé, SĐT 0900 000 871") ?? "").includes("871"), "SĐT có dấu cách cũng bị bỏ");

  // B4 — hàng rào hậu mãi không bỏ câu kể / câu trả lời, không bỏ khi khách vừa hỏi, không bao giờ làm rỗng cả tin.
  for (const r of [
    "Dạ em đã thêm 1 hộp nem vào đơn cho chị rồi ạ.",
    "Dạ em ghi nhận chị lấy thêm 1 hộp nem, nhân viên sẽ cập nhật đơn ạ.",
    "Dạ combo 2kg bên em giá 300.000đ ạ.",
    "Dạ đây là món bán chạy nhất bên em ạ.",
    "Dạ em đã chốt đơn cho chị nhé.",
  ]) {
    assert.deepEqual(postSaleReplyGuard(r), { text: r, dropped: [] }, r);
  }
  const addrConfirm = "Dạ chị xác nhận giúp em địa chỉ mới để em báo nhân viên cập nhật nhé?";
  assert.deepEqual(postSaleReplyGuard(addrConfirm, "à chị đổi địa chỉ sang 25 Nguyễn Trãi nhé"), { text: addrConfirm, dropped: [] }, "khách vừa xin đổi địa chỉ ⇒ câu xác nhận địa chỉ mới giữ");
  assert.deepEqual(postSaleReplyGuard(addrConfirm), { text: addrConfirm, dropped: [] }, "xác nhận một THAY ĐỔI không phải xin chốt lại");
  const askedProduct = "Dạ nem hải sản 120.000đ/hộp ạ. Chị lấy thêm 1 hộp không ạ?";
  assert.deepEqual(postSaleReplyGuard(askedProduct, "nem hải sản giá bao nhiêu em").dropped, [], "khách vừa hỏi món ⇒ không lọc");
  // Đổi kỳ vọng (review PR #878 vòng 2): bản cũ «giữ nguyên tin» khi mọi câu đều bị lọc ⇒ tin CHỈ có lời mời vẫn tới khách — trái luật chủ
  // shop «không bán tiếp sau chốt». Nay chữ gửi đi rỗng; engine thay bằng `postSaleFallbackText` (kiểm ở dưới + hội thoại vàng).
  assert.deepEqual(postSaleReplyGuard("Mình lấy thêm 1 hộp nem hải sản không ạ?"), { text: "", dropped: ["UPSELL"], emptied: true }, "tin chỉ có lời mời ⇒ không gửi chữ nào của model");
  // Hai ca reviewer dựng lại: không lời mời nào tới khách; khách hỏi trạng thái thì câu thay PHẢI là câu trạng thái (chưa có ⇒ null = tra đơn).
  const r1 = postSaleReplyGuard("Dạ bên em đang có combo nem hải sản ưu đãi cho chị nè.", "đơn chị tới đâu rồi em");
  assert.deepEqual([r1.text, r1.emptied], ["", true], "hỏi trạng thái + tin chỉ mời mua ⇒ lời mời không tới khách");
  assert.equal(postSaleFallbackText("đơn chị tới đâu rồi em", null), null, "hỏi trạng thái mà chưa có kết quả tra ⇒ KHÔNG câu chung, nơi gọi phải tra đơn");
  assert.equal(postSaleFallbackText("đơn chị tới đâu rồi em", "Dạ đơn #A1 của mình: Shop đã nhận đơn ạ."), "Dạ đơn #A1 của mình: Shop đã nhận đơn ạ.");
  const r2 = postSaleReplyGuard("Chị có muốn lấy thêm combo nem không ạ?", "ok em cảm ơn nha");
  assert.deepEqual([r2.text, r2.emptied], ["", true], "khách cảm ơn + tin chỉ mời mua ⇒ lời mời không tới khách");
  assert.equal(postSaleFallbackText("ok em cảm ơn nha", null), POST_SALE_THANKS_TEXT);
  assert.equal(postSaleFallbackText("hàng giao rồi nhé em", null), POST_SALE_NEUTRAL_TEXT);
  // Review PR #878 vòng 3: câu MỘT HƠI «trả lời, rồi mời» nối bằng dấu phẩy ⇒ chỉ bỏ VẾ mời, câu trả lời vẫn tới khách.
  assert.deepEqual(postSaleReplyGuard("Dạ có ạ, bên em xuất hoá đơn được, mình muốn lấy thêm gì không ạ?", "shop có xuất hoá đơn không"), { text: "Dạ có ạ, bên em xuất hoá đơn được.", dropped: ["UPSELL"] }, "hoá đơn: giữ vế trả lời");
  assert.deepEqual(postSaleReplyGuard("Dạ shop ở 12 Lê Lợi Q1, chị ghé mua thêm nhé.", "shop ở đâu vậy em"), { text: "Dạ shop ở 12 Lê Lợi Q1.", dropped: ["UPSELL"] }, "địa chỉ shop: giữ vế trả lời");
  assert.deepEqual(postSaleReplyGuard("Dạ bên em đang có combo nem hải sản ưu đãi cho chị nè, chị lấy thêm không ạ?", "shop có xuất hoá đơn đỏ không em"), { text: "", dropped: ["UPSELL"], emptied: true }, "mọi vế đều là lời mời ⇒ vẫn rỗng");
  assert.deepEqual(postSaleReplyGuard("Dạ chị ơi, bên em có combo nem hải sản, chị thử không ạ?"), { text: "", dropped: ["UPSELL"], emptied: true }, "chỉ còn tiếng đệm «Dạ chị ơi» ⇒ rỗng, vế hỏi ngay sau vế mời cũng bỏ");
  for (const q of ["shop có xuất hoá đơn không", "shop ở đâu vậy em", "giá bao nhiêu", "vậy hả"]) assert.equal(asksQuestion(q), true, `câu hỏi: ${q}`);
  for (const q of ["ok em cảm ơn nha", "hàng giao rồi nhé em", "không cần đâu em", "ok chốt em"]) assert.equal(asksQuestion(q), false, `không phải câu hỏi: ${q}`);
  for (const t of [POST_SALE_THANKS_TEXT, POST_SALE_NEUTRAL_TEXT]) assert.deepEqual(postSaleDropsIn(t), [], `câu thay không bị chính bộ lọc chặn: ${t}`);
  assert.equal(orderStatusSayOf(JSON.stringify({ orders: [{ order_code: "#A1", status: "Shop đã nhận đơn — chưa có thông tin vận chuyển.", needs_staff: false }] })), "Dạ đơn #A1 của mình: Shop đã nhận đơn — chưa có thông tin vận chuyển ạ.");
  assert.equal(orderStatusSayOf(JSON.stringify({ orders: [], delivery_answer: { kind: "DIRECT", say: "Dạ đơn của mình dự kiến giao ngày mai ạ." } })), "Dạ đơn của mình dự kiến giao ngày mai ạ.");
  assert.equal(orderStatusSayOf(JSON.stringify({ orders: [] })), null, "không có đơn ⇒ không bịa câu trạng thái");
  assert.equal(orderStatusSayOf("không phải JSON"), null);
  assert.deepEqual(postSaleDropsIn("Mình lấy thêm 1 hộp nem hải sản không ạ?"), ["UPSELL"], "câu mẫu chỉ là lời mời vẫn bị chặn ở công cụ");
  // Lời hứa mốc giờ: «ghi nhận» ở vế trước không miễn cho vế sau hứa «mai 9h shipper giao».
  assert.deepEqual(deliveryPromiseIn("Dạ em ghi nhận, mai 9h shipper giao tới chị nhé."), ["Dạ em ghi nhận, mai 9h shipper giao tới chị nhé."]);
  console.log("  ✓ #871 review PR #878: đổi nơi giao / người nhận (chỗ làm · công ty · tỉnh / quận · em gái · tên viết hoa) luôn để câu hỏi đi qua · câu hỏi giá sau số lượng không thành món · «lấy 2kg, tuần sau giao» là đơn + mong muốn ngày giao · hậu mãi không bỏ câu kể / câu trả lời; tin chỉ toàn lời mời không tới khách, câu thay là trạng thái / cảm ơn / câu trung tính · «ghi nhận» không miễn lời hứa giờ · SĐT không vào ghi chú");
}

/** Sản phẩm thật của ca (chả cá thu 1kg + nem hải sản hộp 10 cái) — tạo một lần cho tổ chức thử. */
async function seedProducts(ctx: Omit<GoldenHookCtx, "conversationId">): Promise<void> {
  const db = await getDb();
  const admin = await ctx.admin();
  const add = async (name: string, code: string, size: string, price: number) => {
    if (ctx.ids.has(code)) return;
    const r = await createProductCore(admin, { name, code, unit: "hộp", retailPrice: price, cost: null, variants: [{ sku: code, size, color: "", retailPrice: price, cost: null, selling: true }] });
    assert.ok(r.ok, JSON.stringify(r));
    for (const v of await db.select({ id: schema.productVariants.id, sku: schema.productVariants.sku }).from(schema.productVariants).where(eq(schema.productVariants.productId, r.id))) (ctx.ids as Map<string, string>).set(v.sku, v.id);
  };
  await add("Chả cá thu", "CCT-1KG", "1kg", 280_000);
  await add("Nem hải sản", "NEM-HS", "Hộp 10 cái", 120_000);
}

/** Câu mẫu «giao hàng» của shop (khớp chữ «giao»), bật câu mẫu, tắt AI đọc hiểu (khớp chữ là đủ — không cần lời gọi model thứ hai). */
async function seedDeliveryQuickReply(): Promise<void> {
  const db = await getDb();
  const qr = schema.salesChatQuickReplies;
  const [row] = await db.select({ id: qr.id }).from(qr).where(eq(qr.title, "Giao hàng tận nơi")).limit(1);
  if (!row) await db.insert(qr).values({ title: "Giao hàng tận nơi", triggers: ["giao", "giao hàng"], answer: QR_TEXT, active: true });
  await setSettingJson(QUICK_REPLY_SETTING_KEY, { enabled: true, aiMatch: false, upsellReplyId: null, autoLearn: false, autoActivate: false });
}

const NGOC_ITEMS = ({ v }: { v: (sku: string) => string }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }, { variant_id: v("NEM-HS"), quantity: 1 }] })];

const GOLDEN: GoldenCase[] = [
  {
    key: "p871-ngoc-nguyen",
    title: "Ca «Ngọc Nguyễn»: mua 1kg → SĐT + địa chỉ một bong bóng → hẹn 9h sáng mai → thêm 10 cái nem ⇒ không hỏi lại, không hứa giờ, đơn đủ hai món + ghi chú giờ giao, lượt lặp không sinh đơn thứ hai",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Ship gò vấp bn? Mình muốn mua 1 kg", ai: [() => [say("Dạ shop có giao Gò Vấp ạ. Mình cho em xin SĐT + địa chỉ nhận hàng để em lên đơn 1kg chả cá thu nhé.")]] },
      // Lượt 17:30 như production: model lưu khách rồi muốn «xác nhận lại địa chỉ» thay vì lên đơn ⇒ hàng rào bỏ câu hỏi.
      { say: NGOC_BUBBLE, ai: [() => [tool("create_customer", { name: "Ngọc Nguyễn", phone: NGOC_PHONE, address: NGOC_ADDR })], () => [say(WARD_RECONFIRM)]] },
      // 17:31: câu mẫu «giao» KHÔNG được gửi; model hứa mốc + xin lại SĐT / địa chỉ ⇒ cả hai bị thay.
      { say: "Giao sáng mai khoảng 9h", ai: [() => [say(`Dạ sáng mai 9h bên em giao tới cho mình nhé. ${QR_TEXT}`)]] },
      // 17:32: thêm món — model (đọc khối «thông tin nhận hàng đã có») lên đơn đủ hai món; câu xác nhận lại phường viết kèm vẫn bị bỏ.
      { say: "Lấy 10 cái nem hải sản", ai: [(c) => [say(WARD_RECONFIRM), ...NGOC_ITEMS(c)], () => [say("Dạ đơn của mình gồm 1kg chả cá thu và 1 hộp nem hải sản (10 cái), em gửi tóm tắt để mình xem ạ.")]] },
      // Lượt LẶP (gói tin trùng lọt lớp nhận tin): model gọi lại lên đơn ⇒ vẫn MỘT đơn.
      { say: "Lấy 10 cái nem hải sản", ai: [(c) => NGOC_ITEMS(c), () => []] },
    ],
  },
  {
    key: "p871-nguyen-ha",
    title: "Ca «Nguyễn Hà»: đơn 280.000 ₫ đã chốt ⇒ hỏi trạng thái trả lời từ đơn thật, không xin chốt lại, không hỏi lại địa chỉ, không mời mua; «mua tiếp lần sau» không thành đơn",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: `Chị lấy 1kg chả cá thu nhé, Nguyễn Hà ${HA_PHONE}, ${HA_ADDR}`,
        ai: [() => [tool("create_customer", { name: "Nguyễn Hà", phone: HA_PHONE, address: HA_ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Dạ đơn của mình 1kg chả cá thu. Mình lấy thêm gì không, không thì em giao luôn ạ?")]],
      },
      { say: "ok chốt em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt em" })], () => [say("Dạ em lên đơn cho mình rồi ạ, shop giao sớm cho mình nha.")]] },
      {
        say: "đơn chị tới đâu rồi em?",
        ai: [
          () => [tool("get_order_status", {})],
          ({ results }) => {
            const orders = (results[0]?.orders ?? []) as { status?: string }[];
            const status = orders[0]?.status ?? "Shop đã nhận đơn của mình";
            return [say(`Dạ ${status.replace(/\.$/, "")} ạ. Chị xác nhận lại đơn giúp em nhé? Chị cho em xin lại địa chỉ nhận hàng nhé. Mình lấy thêm 1 hộp nem hải sản không ạ?`)];
          },
        ],
      },
      { say: "ok em, mua tiếp lần sau nhé", ai: [({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("NEM-HS"), quantity: 1 }] })], () => [say("Dạ em cảm ơn chị, chị dùng ngon nha. Bên em đang có combo nem hải sản ưu đãi cho chị nè.")]] },
    ],
  },
  {
    key: "p871-only-upsell",
    title: "Review PR #878 vòng 2: sau chốt, tin model CHỈ là lời mời ⇒ không tới khách; hỏi trạng thái vẫn nhận câu trạng thái (từ get_order_status của lượt, hoặc máy chủ tự tra), cảm ơn nhận câu cảm ơn",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: `Chị lấy 1kg chả cá thu nhé, Nguyễn Hà ${HA_PHONE}, ${HA_ADDR}`, ai: [() => [tool("create_customer", { name: "Nguyễn Hà", phone: HA_PHONE, address: HA_ADDR })], ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CCT-1KG"), quantity: 1 }] })], () => [say("Dạ đơn của mình 1kg chả cá thu ạ.")]] },
      { say: "ok chốt em", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt em" })], () => [say("Dạ em lên đơn cho mình rồi ạ.")]] },
      // Model tra đơn rồi chỉ viết lời mời ⇒ câu trạng thái từ kết quả công cụ của lượt.
      { say: "đơn chị tới đâu rồi em", ai: [() => [tool("get_order_status", {})], () => [say("Dạ bên em đang có combo nem hải sản ưu đãi cho chị nè.")]] },
      { say: "ok em cảm ơn nha", ai: [() => [say("Chị có muốn lấy thêm combo nem không ạ?")]] },
      // Model KHÔNG tra đơn, chỉ viết lời mời ⇒ máy chủ tự tra.
      { say: "đơn chị gửi chưa em", ai: [() => [say("Mình lấy thêm 1 hộp nem hải sản không ạ?")]] },
      // Review PR #878 vòng 3: câu trả lời nối lời mời bằng dấu phẩy ⇒ khách nhận đúng vế trả lời.
      { say: "shop có xuất hoá đơn không", ai: [() => [say("Dạ có ạ, bên em xuất hoá đơn được, mình muốn lấy thêm gì không ạ?")]] },
      { say: "shop ở đâu vậy em", ai: [() => [say("Dạ shop ở 12 Lê Lợi Q1, chị ghé mua thêm nhé.")]] },
      // Khách hỏi câu khác trạng thái mà tin model CHỈ là lời mời ⇒ không câu trung tính bỏ lơ câu hỏi — chuyển người.
      { say: "shop có xuất hoá đơn đỏ không em", ai: [() => [say("Dạ bên em đang có combo nem hải sản ưu đãi cho chị nè, chị lấy thêm không ạ?")]] },
    ],
  },
];

export async function testP0871ContactMemoryGolden(): Promise<void> {
  const seen = new Set<string>();
  await runGoldenCases(GOLDEN, {
    orgSuffix: "-p871",
    beforeCase: async (c, ctx) => {
      await seedProducts(ctx);
      if (c.key === "p871-ngoc-nguyen") await seedDeliveryQuickReply();
    },
    afterCase: async (c, ctx, t) => {
      seen.add(c.key);
      const shown = t.turns.map((x) => x.shown.join(" | "));
      const db = await getDb();
      const [cv] = await db.select({ state: schema.salesChatConversations.state, orderId: schema.salesChatConversations.orderId, draftOrderId: schema.salesChatConversations.draftOrderId }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, ctx.conversationId));
      const st = cv.state as ChatState;
      const orders = await db.select({ id: schema.orders.id, note: schema.orders.note, stage: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.salesConversationId, ctx.conversationId));
      if (c.key === "p871-ngoc-nguyen") {
        // 17:30 — câu xác nhận lại phường bị bỏ, khách nhận câu ghi nhận.
        assert.equal(shown[1], ADDRESS_KNOWN_TEXT, `lượt địa chỉ: ${shown[1]}`);
        // 17:31 — câu mẫu khớp chữ «giao» (máy vẫn khớp được) nhưng KHÔNG tới khách; không xin lại SĐT / địa chỉ; không hứa 9h.
        assert.equal((await quickReplyByKeyword("Giao sáng mai khoảng 9h", { ordering: false, cfg: { shippingFee: null } })).kind, "ANSWER", "câu mẫu vẫn khớp chữ — chỉ engine chặn nó");
        assert.ok(t.turns[2].rounds.length > 0, "lượt hẹn giờ đi đường AI, không đi câu mẫu");
        assert.ok(!shown[2].includes("xin SĐT") && !/địa chỉ chính xác/.test(shown[2]), `không xin lại SĐT + địa chỉ: ${shown[2]}`);
        assert.ok(!/sáng mai 9h bên em giao/.test(shown[2]) && shown[2].includes(SCHEDULE_NOTED_TEXT), `không hứa mốc, có câu ghi nhận: ${shown[2]}`);
        const p2 = t.prompts[t.turns[2].rounds[0]?.prompt ?? -1] ?? "";
        assert.ok(/THÔNG TIN NHẬN HÀNG ĐÃ CÓ/.test(p2), "lời nhắc lượt hẹn giờ: thông tin nhận hàng đã có, lên đơn ngay");
        // 17:32 — không xác nhận lại phường; đơn đủ hai món: 1kg chả cá + 1 hộp nem 10 cái (10 cái = 1 hộp).
        assert.ok(!/xác nhận lại địa chỉ/.test(shown[3]) && !shown[3].includes(ADDRESS_KNOWN_TEXT), `không xác nhận lại phường, không chen «đã ghi nhận địa chỉ»: ${shown[3]}`);
        assert.equal(orders.length, 1, "MỘT đơn — kể cả lượt lặp gọi lại lên đơn");
        assert.deepEqual(t.turns[4].shown, [], `lượt lặp, đơn không đổi ⇒ không đọc lại tóm tắt: ${shown[4]}`);
        const skuOf = new Map([...ctx.ids.entries()].map(([sku, id]) => [id, sku]));
        const items = await db.select({ variantId: schema.orderItems.variantId, quantity: schema.orderItems.quantity }).from(schema.orderItems).where(eq(schema.orderItems.orderId, orders[0].id));
        assert.deepEqual(items.map((i) => [skuOf.get(String(i.variantId)) ?? String(i.variantId), i.quantity]).sort(), [["CCT-1KG", 1], ["NEM-HS", 1]], "1kg chả cá thu GIỮ NGUYÊN + 10 cái nem = 1 hộp 10 cái");
        assert.ok(/Khách hẹn giờ giao/.test(orders[0].note ?? "") && /Giao sáng mai khoảng 9h/.test(orders[0].note ?? ""), `ghi chú giờ giao trên đơn: ${orders[0].note}`);
        assert.ok(!(orders[0].note ?? "").includes(NGOC_PHONE), "ghi chú không chép SĐT");
        assert.equal(st.deliveryPref?.text, "Giao sáng mai khoảng 9h");
        assert.equal(st.customer?.phone, NGOC_PHONE, "SĐT giữ nguyên qua các lượt đổi chủ đề");
        assert.ok(t.turns.every((x) => x.status !== "HANDOFF"), "không chuyển người");
        return;
      }
      if (c.key === "p871-only-upsell") {
        assert.ok(st.confirmed, "đơn đã chốt");
        for (const i of [2, 3, 4]) assert.ok(shown[i].length > 0 && !/combo|ưu đãi|lấy thêm/.test(shown[i]), `lượt ${i}: không lời mời nào tới khách, không im — ${shown[i]}`);
        const statusOf = (i: number) => ((t.turns[i].rounds[0]?.results?.[0] as { orders?: { status?: string }[] } | undefined)?.orders?.[0]?.status ?? "").replace(/[.!\s]+$/u, "");
        const s2 = statusOf(2);
        assert.ok(s2 && shown[2].includes(s2), `hỏi trạng thái (model đã tra): câu trạng thái thật «${s2}» — ${shown[2]}`);
        assert.equal(shown[3], POST_SALE_THANKS_TEXT, `cảm ơn ⇒ câu cảm ơn — ${shown[3]}`);
        assert.ok(/^Dạ đơn .+ của mình: /.test(shown[4]) && shown[4].includes(s2), `hỏi trạng thái (model không tra): máy chủ tự tra — ${shown[4]}`);
        assert.equal(shown[5], "Dạ có ạ, bên em xuất hoá đơn được.", `hoá đơn: chỉ bỏ vế mời — ${shown[5]}`);
        assert.equal(shown[6], "Dạ shop ở 12 Lê Lợi Q1.", `địa chỉ shop: chỉ bỏ vế mời — ${shown[6]}`);
        assert.ok(!/combo|ưu đãi|lấy thêm/.test(shown[7]) && shown[7] !== POST_SALE_NEUTRAL_TEXT, `câu hỏi + tin chỉ mời ⇒ không lời mời, không câu trung tính — ${shown[7]}`);
        assert.equal(t.turns[7].status, "HANDOFF", "câu hỏi khác trạng thái mà AI chỉ mời mua ⇒ chuyển người");
        assert.equal(orders.length, 1);
        assert.ok(t.turns.slice(0, 7).every((x) => x.status !== "HANDOFF"), "không chuyển người ở các lượt trước");
        return;
      }
      // «Nguyễn Hà»
      assert.ok(st.confirmed, "đơn đã chốt");
      assert.equal(orders.length, 1, "«mua tiếp lần sau» không mở đơn thứ hai");
      assert.ok(t.turns[2].rounds[0]?.tools.some((x) => x.name === "get_order_status"), "trạng thái lấy từ đơn thật");
      assert.ok(shown[2].length > 0 && !/xác nhận lại đơn|xin lại địa chỉ|lấy thêm/.test(shown[2]), `hỏi trạng thái: chỉ câu trạng thái — ${shown[2]}`);
      assert.ok(!/combo|ưu đãi/.test(shown[3]) && /cảm ơn/.test(shown[3]), `«lần sau»: cảm ơn, không mời mua — ${shown[3]}`);
      const futureTry = t.turns[3].rounds[0]?.results?.[0] as { error?: string } | undefined;
      assert.ok(futureTry && /LẦN SAU/.test(futureTry.error ?? ""), `công cụ từ chối đơn «lần sau»: ${JSON.stringify(futureTry)}`);
      assert.ok(t.turns.every((x) => x.status !== "HANDOFF"), "không chuyển người vì «lần sau»");
    },
  });
  assert.deepEqual([...seen].sort(), GOLDEN.map((c) => c.key).sort());
  console.log("  ✓ #871 hội thoại vàng: «Ngọc Nguyễn» — câu mẫu «giao» bị chặn, không hỏi lại SĐT / địa chỉ / phường ở lượt hẹn 9h và lượt thêm nem, không hứa giờ, đơn 1kg chả cá + 1 hộp nem (10 cái) mang ghi chú giờ giao, lượt lặp vẫn một đơn · «Nguyễn Hà» — sau chốt trạng thái từ get_order_status, không xin chốt lại / hỏi lại địa chỉ / mời mua, «lần sau» không thành đơn · tin model chỉ là lời mời ⇒ không tới khách, hỏi trạng thái vẫn nhận câu trạng thái (kể cả khi model không tra — máy chủ tự tra)");
}

// ─── GÓI TIN WEBHOOK TRÙNG — ĐƯỜNG FANPAGE THẬT (receiveFanpageEvent → processFanpageThread → engine), Pancake + AI giả ───

const DUP_ORG = "p871-dup";
const DUP_ADMIN = "chu@p871-dup.local";
const DUP_PAGE = "8710000001";

async function cleanupDupOrg(): Promise<void> {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, DUP_ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, DUP_ORG));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, DUP_ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: DUP_ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

/**
 * Khách gửi MỘT tin đủ món + SĐT + địa chỉ; Pancake bắn webhook HAI lần cùng mã tin. Lần hai: không vào hàng chờ, không gọi AI, không gửi
 * câu nào, không đơn thứ hai. Mốc đi theo đồng hồ thật (luật 50/65).
 */
async function testDuplicateWebhook(): Promise<void> {
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-p871-trung-0123456789abcdefghijklmnopqrstuvwxyz";
  await cleanupDupOrg();
  await provisionOrganization({ code: DUP_ORG, name: "Shop thử tin trùng", plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: DUP_ADMIN, name: "Chủ shop", password: "TinTrung@2026!" }, source: "TEST", actor: null });
  try {
    await withOrganization(DUP_ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, DUP_ADMIN) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: DUP_ORG, name: DUP_ORG, isHome: false }, modules: [...(await getEnabledModules(DUP_ORG))] };
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, enabled: true });
      const r = await createProductCore(admin, { name: "Chả cá thu", code: "D-CCT", unit: "gói", retailPrice: 280_000, cost: null, variants: [{ sku: "D-CCT-1KG", size: "1kg", color: "", retailPrice: 280_000, cost: null, selling: true }] });
      assert.ok(r.ok, JSON.stringify(r));
      const variant = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, r.id) });
      assert.ok(variant);
      const posts: string[] = [];
      const pancakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        let body: unknown = { success: true };
        if (url.includes("/conversations?")) body = { success: true, conversations: [{ id: "c1" }] };
        else if (init?.method === "POST") {
          posts.push(String(init.body));
          body = { success: true, id: `m-bot-${posts.length}` };
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: DUP_PAGE }, secrets: { pageAccessToken: "pancake_page_token_p871_0123456789abcdef" } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: pancakeFetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));
      // Model giả: lưu khách → lên đơn → một câu. Đếm số lần được gọi.
      const steps: AiBlock[][] = [
        [{ type: "tool_use", id: "d-1", name: "create_customer", input: { name: "Nguyễn Hà", phone: "0900000873", address: HA_ADDR } }],
        [{ type: "tool_use", id: "d-2", name: "create_draft_order", input: { items: [{ variant_id: variant.id, quantity: 1 }] } }],
        [{ type: "text", text: "Dạ đơn của mình 1kg chả cá thu, mình xem giúp em ạ." }],
      ];
      let calls = 0;
      const provider: AiProvider = {
        name: "fake",
        model: "claude-sonnet-5",
        schemaDialect: "anthropic",
        async complete(): Promise<AiResponse> {
          const content = steps[calls] ?? [];
          calls += 1;
          return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
        },
      };
      setSalesChatProviderForTests(() => provider);
      const text = `Chị lấy 1kg chả cá thu nhé, Nguyễn Hà 0900000873, ${HA_ADDR}`;
      const ev = () => parsePancakeWebhook({ event_type: "messaging", page_id: DUP_PAGE, data: { conversation: { id: "d-t1", type: "INBOX" }, message: { id: "d-m1", type: "INBOX", message: text, from: { id: "cust-d-t1", name: "Nguyễn Hà" } } } })!;
      const later = () => new Date(Date.now() + 31_000);
      assert.ok((await receiveFanpageEvent(ev())).queued, "gói tin đầu vào hàng chờ");
      const first = await processFanpageThread(DUP_PAGE, "d-t1", { fetch: pancakeFetch, now: later });
      assert.ok(first.processed === 1 && !first.error, JSON.stringify(first));
      const callsAfterFirst = calls;
      const postsAfterFirst = posts.length;
      assert.ok(callsAfterFirst >= 2 && postsAfterFirst >= 1, `lượt đầu: AI ${callsAfterFirst} lời gọi, gửi ${postsAfterFirst} tin`);
      // Gói tin TRÙNG (Pancake thử lại cùng mã tin).
      const dup = await receiveFanpageEvent(ev());
      assert.equal(dup.queued, false, `gói tin trùng không vào hàng chờ: ${dup.reason}`);
      await processFanpageThread(DUP_PAGE, "d-t1", { fetch: pancakeFetch, now: later });
      assert.equal(calls, callsAfterFirst, "gói tin trùng: không gọi AI lần nữa");
      assert.equal(posts.length, postsAfterFirst, "gói tin trùng: không gửi câu nào lần nữa");
      const inbound = await db.select({ id: schema.salesChatInbound.id }).from(schema.salesChatInbound).where(eq(schema.salesChatInbound.messageId, "d-m1"));
      assert.equal(inbound.length, 1, "một dòng tin khách");
      const orders = await db.select({ id: schema.orders.id }).from(schema.orders);
      assert.equal(orders.length, 1, "một đơn");
    });
  } finally {
    setSalesChatProviderForTests(null);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupDupOrg();
  }
  console.log("  ✓ #871 gói tin webhook trùng (đường fanpage thật): lần hai không vào hàng chờ, không gọi AI, không gửi câu nào, vẫn MỘT đơn");
}

/** Điểm vào cho `sync-fixtures.test.ts`. */
export async function testP0871ContactMemory(): Promise<void> {
  testPure();
  testReviewBlockers();
  await testP0871ContactMemoryGolden();
  await testDuplicateWebhook();
}
