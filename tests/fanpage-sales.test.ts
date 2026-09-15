/**
 * HỒ SƠ BÁN HÀNG THEO FANPAGE — khoá những luật mà sai là BÁN NHẦM MẶT HÀNG.
 *
 * Luật quan trọng nhất ở đây chỉ có một câu: hội thoại đến từ nguồn TEST KHÔNG BAO GIỜ được rơi về
 * mẫu thắng của page. Rơi về nghĩa là tư vấn khách một mẫu, rồi lên đơn một mẫu khác.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { classifyConversationSource, snapshotClassification } from "@/lib/ai-workforce/agents/sales/classify-source";
import { resolveProduct } from "@/lib/ai-workforce/agents/sales/resolve-product";
import { POLICY_BY_SOURCE, TEST_REPLY_DEFAULTS } from "@/lib/constants/fanpage-sales";
import { runShadowBenchmark } from "@/lib/queries/shadow-benchmark";
import { generateTestReply, testIntentOf } from "@/lib/ai-workforce/agents/sales/generate-test";
import { discoverKnowledgeGaps, loadTestKnowledge, loadWinKnowledge } from "@/lib/queries/sales-knowledge";
import { checkSellability } from "@/lib/queries/sellability";
import { extractColor, extractMeasurements, extractSize } from "@/lib/ai-workforce/agents/sales/extract-slots";
import { EMPTY_SALES_POLICY, policyAnswerable, type SalesPolicy } from "@/lib/constants/sales-policy";
import { computeCapabilities, winPermissions } from "@/lib/constants/sales-capabilities";
import { SIZE_RULES_KEY, type SizeRule } from "@/lib/constants/size-engine";
import { setSettingJson } from "@/lib/settings";
import { answerFromKnowledge, winIntentOf } from "@/lib/ai-workforce/agents/sales/answer-win";
import { extractTestSignals, recordTestSignal } from "@/lib/ai-workforce/agents/sales/test-signals";

const PAGE = "page-fanpage-test";

async function hoiThoai(db: Db, externalId: string) {
  const [c] = await db
    .insert(schema.salesConversations)
    .values({ pageId: PAGE, externalId, customerName: "Khách" })
    .returning();
  return c;
}

export async function testFanpageSales(db: Db) {
  // ── danh mục: mẫu thắng + một mẫu khác ──
  const [win] = await db.insert(schema.products).values({ id: "fp-win", name: "Đầm Q004", customId: "Q004", isHidden: false, isRemoved: false }).returning();
  await db.insert(schema.products).values({ id: "fp-other", name: "Đầm Q017", customId: "Q017", isHidden: false, isRemoved: false });
  await db.insert(schema.productVariants).values({ id: "fp-v1", productId: win.id, size: "M", color: "Đen", retailPrice: 499_000, isRemoved: false });

  const [hoSo] = await db
    .insert(schema.fanpageSalesProfiles)
    .values({ pancakePageId: PAGE, name: "Trang thử", aiMode: "SHADOW", activeProductId: win.id, unitPrice: 499_000, shippingFee: 25_000, version: 1 })
    .returning();

  // ═════════ 1. ĐƯỜNG BÌNH THƯỜNG: không quảng cáo nào, vẫn biết đang bán gì ═════════
  //
  // Đây là điểm đảo ngược so với bản trước: mẫu hàng KHÔNG phải suy ra từ chữ khách.
  const ht1 = await hoiThoai(db, "fp-ht-1");
  const pl1 = await classifyConversationSource({ conversationId: ht1.id, pancakePageId: PAGE }, db);
  assert.equal(pl1.sourceType, "WIN");
  assert.equal(pl1.activeProductId, win.id);
  assert.equal(pl1.classificationSource, "FANPAGE_DEFAULT");
  assert.equal(pl1.policy, "WIN_SALES");
  assert.equal(pl1.handoff, null);

  const kq1 = await resolveProduct({ conversationId: ht1.id, pageId: PAGE, text: "còn hàng không ạ", classification: pl1 }, db);
  assert.equal(kq1.productId, win.id, "câu khách không có gì để khớp, nhưng page đã nói đang bán mẫu nào");
  assert.equal(kq1.source, "FANPAGE_ACTIVE_PRODUCT");

  // ═════════ 2. NGUỒN TEST ĐÈ MẶC ĐỊNH — và KHÔNG rơi về mẫu thắng ═════════
  const [test1] = await db
    .insert(schema.testProductProfiles)
    .values({ testCode: "TEST-2026-091", name: "Đầm test cổ lệch đỏ đô", pancakePageId: PAGE, price: 499_000, colors: ["đỏ đô", "đen"], status: "RUNNING" })
    .returning();
  await db.insert(schema.salesSourceRules).values({ pancakePageId: PAGE, sourceKind: "AD", sourceId: "ad-test-1", sourceType: "TEST", testProductId: test1.id });

  const ht2 = await hoiThoai(db, "fp-ht-2");
  await db.insert(schema.salesMessages).values({ conversationId: ht2.id, externalId: "m-t1", text: "bao nhiêu em", fromPage: false, senderType: "CUSTOMER", adId: "ad-test-1", sentAt: new Date() });
  const pl2 = await classifyConversationSource({ conversationId: ht2.id, pancakePageId: PAGE }, db);
  assert.equal(pl2.sourceType, "TEST", "luật nguồn phải ĐÈ mặc định của page");
  assert.equal(pl2.testProductId, test1.id);
  assert.equal(pl2.activeProductId, null, "hội thoại TEST không được mang mẫu thắng");
  assert.equal(pl2.policy, "TEST_SALES");

  const kq2 = await resolveProduct({ conversationId: ht2.id, pageId: PAGE, text: "bao nhiêu em", classification: pl2 }, db);
  assert.equal(kq2.productId, null, "KHÔNG BAO GIỜ trả mẫu thắng cho hội thoại hàng test");
  assert.ok(/TEST/.test(kq2.evidence));

  // ═════════ 3. HUMAN_ONLY: máy đứng ngoài ═════════
  await db.insert(schema.salesSourceRules).values({ pancakePageId: PAGE, sourceKind: "POST", sourceId: "post-human", sourceType: "HUMAN_ONLY" });
  const ht3 = await hoiThoai(db, "fp-ht-3");
  await db.insert(schema.salesMessages).values({ conversationId: ht3.id, externalId: "m-h1", text: "alo", fromPage: false, senderType: "CUSTOMER", postUrl: "post-human", sentAt: new Date() });
  const pl3 = await classifyConversationSource({ conversationId: ht3.id, pancakePageId: PAGE }, db);
  assert.equal(pl3.sourceType, "HUMAN_ONLY");
  assert.equal(pl3.handoff, "SOURCE_HUMAN_ONLY");
  assert.equal(POLICY_BY_SOURCE[pl3.sourceType], "HUMAN");

  // ═════════ 4. ẢNH CHỤP BẤT BIẾN — đổi mẫu thắng KHÔNG viết lại quá khứ ═════════
  //
  // Đây là lý do cột ảnh chụp tồn tại. Khách đã được tư vấn Q004 thì cuộc ấy thuộc Q004, dù hôm
  // sau page chuyển sang Q017.
  assert.equal(await snapshotClassification(ht1.id, pl1, db), true);
  await db.update(schema.fanpageSalesProfiles).set({ activeProductId: "fp-other", version: 2 }).where(eq(schema.fanpageSalesProfiles.id, hoSo.id));

  const plCu = await classifyConversationSource({ conversationId: ht1.id, pancakePageId: PAGE }, db);
  assert.equal(plCu.classificationSource, "SNAPSHOT");
  assert.equal(plCu.activeProductId, win.id, "hội thoại CŨ phải giữ Q004 sau khi page đổi sang Q017");
  assert.equal(plCu.salesProfileVersion, 1, "giữ số bản hồ sơ LÚC CHỤP, không phải số hiện tại");

  const htMoi = await hoiThoai(db, "fp-ht-4");
  const plMoi = await classifyConversationSource({ conversationId: htMoi.id, pancakePageId: PAGE }, db);
  assert.equal(plMoi.activeProductId, "fp-other", "hội thoại MỚI dùng mẫu mới");

  // ĐỔI GIÁ CŨNG KHÔNG VIẾT LẠI QUÁ KHỨ. Khách đã được báo 499k thì cuộc ấy thuộc mức 499k —
  // đọc bảng giá hôm nay để giải thích một câu nói hôm qua là viết lại quá khứ, y hệt với mã hàng.
  await db.update(schema.fanpageSalesProfiles).set({ unitPrice: 599_000, version: 3 }).where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
  const plGiaCu = await classifyConversationSource({ conversationId: ht1.id, pancakePageId: PAGE }, db);
  assert.equal(plGiaCu.offer?.unitPrice, 499_000, "hội thoại CŨ giữ giá LÚC CHỤP, không đọc bảng giá hiện hành");
  const plGiaMoi = await classifyConversationSource({ conversationId: htMoi.id, pancakePageId: PAGE }, db);
  assert.equal(plGiaMoi.offer?.unitPrice, 599_000, "hội thoại MỚI dùng giá mới");
  await db.update(schema.fanpageSalesProfiles).set({ unitPrice: 499_000 }).where(eq(schema.fanpageSalesProfiles.id, hoSo.id));

  // Chụp lần hai KHÔNG được ghi đè lần đầu.
  assert.equal(await snapshotClassification(ht1.id, plMoi, db), false, "ảnh chụp phải bất biến");
  const [vanCu] = await db.select({ p: schema.salesConversations.activeProductId }).from(schema.salesConversations).where(eq(schema.salesConversations.id, ht1.id));
  assert.equal(vanCu.p, win.id);

  // ═════════ 5. PAGE CHƯA KHAI MẪU ⇒ CHUYỂN NGƯỜI, không đoán ═════════
  const [trong] = await db.insert(schema.fanpageSalesProfiles).values({ pancakePageId: "page-trong", name: "Chưa khai", activeProductId: null }).returning();
  const [htTrong] = await db.insert(schema.salesConversations).values({ pageId: "page-trong", externalId: "fp-ht-5", customerName: "K" }).returning();
  const plTrong = await classifyConversationSource({ conversationId: htTrong.id, pancakePageId: "page-trong" }, db);
  assert.equal(plTrong.sourceType, "UNKNOWN");
  assert.equal(plTrong.handoff, "UNKNOWN_PRODUCT_CONTEXT");
  assert.ok(trong.id);

  // ═════════ 5b. HAI NGHĨA CỦA "CHƯA BIẾT" — một cái dừng, một cái đi tiếp ═════════
  //
  // Chưa biết vì CHỨNG CỨ MÂU THUẪN thì phải DỪNG: đi tiếp xuống tầng khớp chữ là cửa sau để mẫu
  // thắng của page lọt vào đúng cuộc mà ta vừa kết luận là không biết đang bán gì.
  const htMau = await hoiThoai(db, "fp-ht-6");
  await db.insert(schema.salesSourceRules).values({ pancakePageId: PAGE, sourceKind: "AD", sourceId: "ad-win-x", sourceType: "WIN", productId: win.id });
  await db.insert(schema.salesMessages).values([
    { conversationId: htMau.id, externalId: "m-x1", text: "Q004 còn không", fromPage: false, senderType: "CUSTOMER", adId: "ad-win-x", sentAt: new Date() },
    { conversationId: htMau.id, externalId: "m-x2", text: "mẫu kia nữa", fromPage: false, senderType: "CUSTOMER", adId: "ad-test-1", sentAt: new Date() },
  ]);
  const plMau = await classifyConversationSource({ conversationId: htMau.id, pancakePageId: PAGE }, db);
  assert.equal(plMau.sourceType, "UNKNOWN", "hai luật nguồn KHÁC LOẠI trong một cuộc ⇒ chưa biết");
  const kqMau = await resolveProduct({ conversationId: htMau.id, pageId: PAGE, text: "Q004 còn không", classification: plMau }, db);
  assert.equal(kqMau.productId, null, "dù khách gõ đúng mã Q004, chứng cứ nguồn mâu thuẫn vẫn phải DỪNG — không có cửa sau");

  // Chưa biết vì page CHƯA KHAI GÌ thì các tầng suy luận cũ vẫn được chạy: chúng không thể tự
  // dựng ra mẫu thắng, vì page chưa khai mẫu thắng nào.
  const [htTrong2] = await db.insert(schema.salesConversations).values({ pageId: "page-khong-ho-so", externalId: "fp-ht-7", customerName: "K" }).returning();
  const plTrong2 = await classifyConversationSource({ conversationId: htTrong2.id, pancakePageId: "page-khong-ho-so" }, db);
  assert.equal(plTrong2.classificationSource, "NONE");
  const kqTrong2 = await resolveProduct({ conversationId: htTrong2.id, pageId: "page-khong-ho-so", text: "cho em hỏi Q017", classification: plTrong2 }, db);
  assert.equal(kqTrong2.source, "EXPLICIT_CODE", "page chưa có hồ sơ thì tầng mã hàng gõ thẳng vẫn phải chạy");

  // ═════════ 6. QUYỀN MẶC ĐỊNH CỦA HÀNG TEST AN TOÀN HƠN HÀNG THẮNG ═════════
  assert.equal(TEST_REPLY_DEFAULTS.aiReplyEnabled, true, "máy VẪN trả lời khách hàng test");
  assert.equal(TEST_REPLY_DEFAULTS.allowAutoOrderCreate, false, "nhưng KHÔNG được tự lên đơn khi mẫu chưa có mã hàng");
  assert.equal(TEST_REPLY_DEFAULTS.allowConfirmOrder, false);
  const [tp] = await db.select().from(schema.testProductProfiles).where(eq(schema.testProductProfiles.id, test1.id));
  assert.equal(tp.aiReplyEnabled, true);
  assert.equal(tp.allowAutoOrderCreate, false, "mặc định CSDL phải trùng mặc định hằng số");

  // ═════════ 7. CHẠY THỬ NGẦM: con số PHẢI BẰNG 0 ═════════
  //
  // Đây là con số duy nhất trên màn hình mà khác 0 nghĩa là hỏng thật: hội thoại TEST bị phép giải
  // trả về một mã hàng ERP, tức là đã rơi về mã WIN của page.
  const bm = await runShadowBenchmark(PAGE);
  assert.equal(bm.testFellBackToWin, 0, "TEST bị xử như WIN phải bằng 0");
  assert.ok(bm.byType.TEST >= 1, "mẻ thử phải có ít nhất một hội thoại TEST để con số trên có nghĩa");
  assert.ok(bm.byType.HUMAN_ONLY >= 1);
  assert.equal(bm.testResolved, bm.byType.TEST, "mọi hội thoại TEST phải gắn được hồ sơ mẫu test");

  // Chạy lại KHÔNG được đổi gì — nút này bấm lại sau mỗi lần sửa cấu hình.
  const bm2 = await runShadowBenchmark(PAGE);
  assert.deepEqual(bm2.byType, bm.byType, "chạy thử ngầm phải chỉ đọc, hai lượt ra cùng kết quả");

  // ═════════ 8. CÂU TRẢ LỜI CHO HÀNG TEST KHÔNG ĐƯỢC MƯỢN DỮ LIỆU MÃ WIN ═════════
  //
  // Mẫu test chưa khai gì cả — đúng cảnh thật lúc mới dựng. Máy phải nói "chưa có" và chuyển
  // người, chứ không được lấy giá 499.000đ hay bảng số đo của Q004 ra dùng.
  const thieuHet = {
    testCode: "TEST-2026-999", name: "Đầm test đỏ đô", price: null, colors: [] as string[],
    material: "", shippingPolicy: "", hasSizeProfile: false, approvedFacts: [] as string[],
    policy: { ...TEST_REPLY_DEFAULTS } as { [K in keyof typeof TEST_REPLY_DEFAULTS]: boolean },
  };

  const giaTest = generateTestReply(testIntentOf("Bao nhiêu em?"), thieuHet);
  assert.equal(giaTest.action, "HANDOFF", "chưa khai giá thì KHÔNG được báo giá");
  assert.deepEqual(giaTest.missing, ["giá test"]);
  assert.ok(!/499|Q004/.test(giaTest.text), "câu trả lời không được mang giá hay mã của hàng thắng");

  const mauTest = generateTestReply(testIntentOf("Có màu gì?"), thieuHet);
  assert.equal(mauTest.action, "HANDOFF");
  assert.deepEqual(mauTest.missing, ["màu"]);

  const sizeTest = generateTestReply(testIntentOf("50kg mặc size gì?"), thieuHet);
  assert.equal(sizeTest.action, "HANDOFF", "không có bảng số đo riêng thì chuyển người");
  assert.deepEqual(sizeTest.missing, ["bảng số đo của mẫu test"]);
  assert.ok(/chưa có bảng số đo/.test(sizeTest.text), "phải nói thẳng là chưa có, không vòng vo");

  // Khách muốn mua mà mẫu chưa lên đơn được ⇒ chuyển người, KHÔNG đổi sang mã WIN cho xong đơn.
  const muonMua = generateTestReply(testIntentOf("chốt cho em 1 cái"), thieuHet);
  assert.equal(muonMua.handoffReason, "TEST_READY_TO_BUY");

  // Khai đủ thì máy trả lời được — và con số phải là con số của CHÍNH mẫu test.
  const daKhai = { ...thieuHet, price: 399_000, colors: ["đỏ đô", "đen"] };
  const giaDu = generateTestReply(testIntentOf("Bao nhiêu em?"), daKhai);
  assert.equal(giaDu.action, "ASK");
  assert.ok(giaDu.text.includes("399"), "phải báo giá của mẫu test");
  assert.ok(!giaDu.text.includes("499"), "và tuyệt đối không phải giá của mã WIN");

  // ═════════ 9. CỔNG NĂNG LỰC — máy được làm gì là do DỮ LIỆU quyết, không do một cờ bật/tắt ═════════
  //
  // Hồ sơ lúc này mới có giá + phí ship. Máy phải báo giá được NGAY, và vẫn im về size cho tới khi
  // có bảng số đo. Gộp hai chuyện ấy vào một công tắc là buộc người vận hành chọn giữa hai điều
  // đều sai: bật khi hồ sơ còn trống, hoặc tắt hẳn cả việc nó thừa sức làm.
  // Khối 4 đã chuyển page sang Q017 để chứng minh ảnh chụp bất biến; giờ trả lại Q004 — đúng cảnh
  // thật của page đang chạy. Hội thoại cũ vẫn giữ nguyên ảnh chụp của chúng, đó là toàn bộ ý.
  await db.update(schema.fanpageSalesProfiles).set({ activeProductId: win.id, version: 4 }).where(eq(schema.fanpageSalesProfiles.id, hoSo.id));

  const bd1 = await loadWinKnowledge(PAGE, db);
  assert.ok(bd1, "page đã có hồ sơ thì phải đọc được dữ kiện");
  assert.equal(bd1.capabilities.CAN_QUOTE_PRICE.on, true, "có giá ⇒ báo giá được");
  assert.equal(bd1.capabilities.CAN_QUOTE_SHIPPING.on, true);
  assert.equal(bd1.capabilities.CAN_ADVISE_SIZE.status, "MISSING_DATA", "chưa có bảng số đo ⇒ TUYỆT ĐỐI không tư vấn size");
  assert.deepEqual(bd1.capabilities.CAN_ADVISE_SIZE.missing, ["bảng số đo"], "tắt thì phải NÓI RA thiếu gì — đó là việc phải làm, không phải lời từ chối");
  assert.equal(bd1.capabilities.CAN_EXPLAIN_COD.on, false, "chưa khai COD ⇒ không giải thích COD");
  assert.equal(bd1.ready, false, "thiếu màu + ba chính sách thì chưa READY");
  assert.ok(bd1.missing.includes("chính sách COD"));

  // BA MỨC, KHÔNG PHẢI HAI. Lên đơn có ĐỦ DỮ LIỆU (đã có mã hàng + giá) nhưng bị chặn cứng cấp
  // máy chủ — gộp nó vào "thiếu dữ liệu" là bảo người vận hành đi khai một thứ đã khai rồi.
  assert.equal(bd1.capabilities.CAN_CREATE_ORDER.status, "BLOCKED_BY_PERMISSION");
  assert.deepEqual(bd1.capabilities.CAN_CREATE_ORDER.missing, [], "dữ liệu KHÔNG thiếu — mã hàng và giá đều có");
  assert.ok(bd1.capabilities.CAN_CREATE_ORDER.blockedBy.includes("AI_ALLOW_ORDER_CREATE"), "phải nói RÕ khoá nào đang chặn");

  // QUYỀN KHÔNG BAO GIỜ THAY DỮ LIỆU: mở hết quyền mà chưa có bảng số đo thì size vẫn tắt.
  const mo = computeCapabilities(bd1.knowledge, winPermissions("AUTO", true));
  assert.equal(mo.CAN_CREATE_ORDER.status, "READY", "mở khoá thì lên đơn sẵn sàng");
  assert.equal(mo.CAN_ADVISE_SIZE.status, "MISSING_DATA", "nhưng size VẪN tắt — quyền không đẻ ra dữ liệu");

  // Khai đủ ⇒ READY bật lên. Không có bước nào khác, không cờ nào phải bấm thêm.
  await db
    .update(schema.fanpageSalesProfiles)
    .set({
      availableColors: ["Đỏ", "Nâu", "Đen"], material: "Rayon co giãn 4 chiều",
      codPolicy: "Có COD", inspectionPolicy: "Được kiểm hàng trước khi thanh toán",
      deliveryEstimate: "2–4 ngày", knowledgeVersion: 2,
    })
    .where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
  const bd2 = await loadWinKnowledge(PAGE, db);
  assert.equal(bd2?.ready, true, "khai đủ sáu ô bắt buộc thì READY — không cần bấm thêm cờ nào");
  assert.equal(bd2?.capabilities.CAN_ADVISE_SIZE.on, false, "nhưng size VẪN tắt: READY không kéo theo quyền đoán size");
  assert.ok((bd2?.completeness ?? 0) > (bd1.completeness ?? 0));

  // ═════════ 10. MÂU THUẪN VỚI ERP: BÁO, KHÔNG ÂM THẦM ĐÈ ═════════
  //
  // Giá kênh khác giá ERP là chuyện hợp lệ. Máy tự chọn một bên là chỗ mà sáu tháng sau không ai
  // biết con số thật là số nào — nên nó in ra CẢ HAI và để người quyết.
  const giaKhop = bd2?.conflicts.find((c) => c.field === "Giá bán");
  assert.equal(giaKhop?.kind, "CORROBORATED", "499k khai = 499k giá bán lẻ ERP ⇒ hai nguồn ĐỒNG Ý, và điều đó cũng phải in ra");
  const mauLech = bd2?.conflicts.find((c) => c.field === "Màu");
  assert.equal(mauLech?.kind, "CONFLICT", "khai bán Đỏ/Nâu mà ERP chỉ có mẫu mã màu Đen ⇒ máy sẽ hứa màu không tồn tại");
  assert.ok(mauLech?.note.includes("Đỏ"), "phải nói RÕ màu nào đang thừa, không chỉ nói 'có lệch'");
  const [saraKhac] = await db.select({ p: schema.fanpageSalesProfiles.unitPrice }).from(schema.fanpageSalesProfiles).where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
  assert.equal(saraKhac.p, 499_000, "báo mâu thuẫn KHÔNG được sửa dữ liệu bên nào");

  // ═════════ 11. CÙNG CỔNG ẤY ÁP CHO HÀNG TEST — khác NGUỒN DỮ LIỆU, không khác LUẬT ═════════
  //
  // Viết hai bộ luật song song là mở đường cho chúng trôi khỏi nhau, rồi một hôm hàng test được
  // phép làm điều hàng thắng không được.
  await db
    .update(schema.testProductProfiles)
    .set({ price: 399_000, colors: ["đỏ đô"], codPolicy: "Có COD", inspectionPolicy: "Được kiểm hàng", deliveryEstimate: "2–4 ngày", shippingFee: 25_000 })
    .where(eq(schema.testProductProfiles.id, test1.id));
  const bdT = await loadTestKnowledge(test1.id, db);
  assert.ok(bdT);
  assert.equal(bdT.kind, "TEST");
  assert.equal(bdT.knowledge.unitPrice, 399_000, "giá của CHÍNH mẫu test");
  assert.equal(bdT.capabilities.CAN_QUOTE_PRICE.on, true);
  assert.equal(bdT.capabilities.CAN_ADVISE_SIZE.on, false, "mẫu test chưa có bảng số đo ⇒ vẫn không đoán size");
  assert.equal(bdT.capabilities.CAN_CREATE_ORDER.status, "MISSING_DATA", "chưa có mã hàng ERP ⇒ thiếu DỮ LIỆU, không phải bị chặn quyền");
  assert.equal(bdT.knowledge.exchangeAnswerable, false, "mẫu test CHƯA khai đổi trả — và KHÔNG mượn của mã WIN");
  assert.equal(bdT.capabilities.CAN_EXPLAIN_EXCHANGE.status, "MISSING_DATA");

  // ═════════ 12. ĐI TÌM DỮ LIỆU CÒN THIẾU — và nói thật cái nào ERP không thể có ═════════
  const lo = await discoverKnowledgeGaps(PAGE, db);
  const loSize = lo.find((g) => g.field === "Bảng số đo");
  assert.equal(loSize?.verdict, "PARTIAL", "ERP biết mẫu có size NÀO, nhưng không biết ai mặc vừa — hai chuyện khác nhau");
  assert.equal(loSize?.code, "SIZE_PROFILE_MISSING");
  assert.ok(loSize?.found.includes("M"), "phải nói ra ERP đang có nhãn size nào");
  assert.ok(/KHÔNG suy từ nhãn size/.test(loSize?.todo ?? ""), "và nói thẳng là không được suy ra bảng số đo từ đó");
  const loDoiTra = lo.find((g) => g.field === "Chính sách đổi trả");
  assert.equal(loDoiTra?.verdict, "NOT_IN_ERP", "chính sách đổi trả là quyết định kinh doanh, không có ở đâu trong hệ thống");
  assert.equal(loDoiTra?.code, "POLICY_MISSING");
  const loTon = lo.find((g) => g.field === "Tồn kho theo mẫu mã");
  assert.equal(loTon?.code, "STOCK_UNKNOWN", "mẫu mã chưa có phiếu nhập ⇒ CHƯA BIẾT tồn (luật 10), máy không được hứa còn hàng");
  assert.ok(/không dùng remain_quantity/i.test(loTon?.lookedAt ?? ""), "phải ghi rõ đã đi hỏi sổ kho chứ không hỏi Pancake");

  // ═════════ 13. TRẢ LỜI CHỈ BẰNG DỮ KIỆN — và nói được nó lấy số ở đâu ═════════
  //
  // Đây là cái mốc để đối chiếu khi mô hình thật bật lên: mô hình được đổi cách nói, KHÔNG được
  // thêm một con số nào. Phân biệt được vì mọi con số đều đi kèm chỗ nó được lấy ra.
  const chinhSach: SalesPolicy = {
    ...EMPTY_SALES_POLICY,
    exchange: {
      ...EMPTY_SALES_POLICY.exchange,
      SIZE: { allowed: true, days: 3, conditions: "còn nguyên tem", shipPayer: "CUSTOMER" },
      COLOR: { allowed: false, days: null, conditions: "", shipPayer: "UNSET" },
    },
  };
  await db
    .update(schema.fanpageSalesProfiles)
    .set({
      comboPricing: [{ quantity: 2, price: 849_000, freeShipping: true }],
      exchangePolicyJson: chinhSach,
      approvedFactsJson: [{ category: "FAQ", text: "Bên em bán hàng có sẵn, không đặt trước", approvedBy: "chu@shop.vn", approvedAt: new Date().toISOString() }],
    })
    .where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
  const bdKT = (await loadWinKnowledge(PAGE, db))!;
  const kt = bdKT.knowledge;
  const quyen = bdKT.permissions;
  const boi = { policy: bdKT.policy, facts: bdKT.facts };

  // ĐỘNG TỪ MUA + KHÔNG HỎI GIÁ ⇒ khách đang CHỐT. Hai câu dưới chỉ khác nhau ở chỗ ấy, và đọc
  // nhầm câu thứ hai thành câu hỏi giá là báo giá cho người vừa nói họ mua rồi.
  assert.equal(winIntentOf("mua 2 cái bao nhiêu ạ"), "COMBO", "có hỏi giá ⇒ là câu hỏi giá combo");
  assert.equal(winIntentOf("chốt cho chị 2 cái"), "BUY", "không hỏi giá ⇒ là chốt đơn, KHÔNG phải hỏi combo");
  assert.equal(winIntentOf("chị lấy đỏ size L"), "BUY", "chọn mẫu mã cũng là chốt");
  // "CÒN KHÔNG" là câu hỏi TỒN, dù trong câu có chữ "size" hay tên màu.
  assert.equal(winIntentOf("màu đỏ size L còn không?"), "STOCK", "hỏi hàng, không xin tư vấn size");
  assert.equal(winIntentOf("50kg mặc size gì?"), "SIZE");
  assert.equal(winIntentOf("eo 74 thì mặc size gì?"), "SIZE");
  assert.equal(winIntentOf("không vừa có đổi được không?"), "EXCHANGE");
  const tlGia = answerFromKnowledge(winIntentOf("Bao nhiêu tiền vậy shop?"), kt, quyen, boi);
  assert.equal(tlGia.action, "ANSWER");
  assert.ok(tlGia.text.includes("499.000"), "phải là con số ĐÃ KHAI");
  assert.ok(tlGia.text.includes("849.000"), "và chào luôn combo vì đã có giá combo thật");
  assert.deepEqual(tlGia.provenance.map((x) => x.source), ["fanpage_sales_profiles.unit_price", "fanpage_sales_profiles.shipping_fee", "fanpage_sales_profiles.combo_pricing"], "mỗi con số phải chỉ được ra ô nó lấy từ đâu");

  // SIZE: vẫn chưa có bảng số đo ⇒ chuyển người, dù mọi ô khác đã đầy.
  const tlSize = answerFromKnowledge(winIntentOf("em cao 1m58 nặng 50kg mặc size nào"), kt, quyen, boi);
  assert.equal(tlSize.action, "HANDOFF");
  assert.equal(tlSize.humanReview, true);
  assert.deepEqual(tlSize.missing, ["bảng số đo"]);
  assert.deepEqual(tlSize.provenance, [], "né thì KHÔNG được kèm dữ kiện nào — không có gì để chống lưng cho một câu không trả lời");

  // CÒN HÀNG KHÔNG: tồn kho đi theo phiếu kho (luật 10), sổ bán hàng không biết ⇒ không hứa.
  const tlCon = answerFromKnowledge(winIntentOf("còn hàng không shop"), kt, quyen, boi);
  assert.equal(tlCon.action, "HANDOFF");
  assert.deepEqual(tlCon.missing, ["tồn kho thực tế"], "sổ dữ kiện bán hàng KHÔNG biết tồn — trả lời 'còn ạ' từ đây là hứa bằng thứ không đo");

  // CÂU NGOÀI KỊCH BẢN: chỉ được nói lại câu ĐÃ DUYỆT.
  const tlLa = answerFromKnowledge(winIntentOf("shop ở đâu thế"), kt, quyen, boi);
  assert.ok(tlLa.provenance[0]?.source.startsWith("fanpage_sales_profiles.approved_facts_json"), "câu ngoài kịch bản phải truy được về sổ câu đã duyệt");
  assert.ok(tlLa.provenance[0]?.source.includes("chu@shop.vn"), "và về AI đã duyệt nó — đó là thứ phân biệt một dữ kiện với một câu gõ vội");
  const tlLa2 = answerFromKnowledge(winIntentOf("shop ở đâu thế"), kt, quyen, { policy: bdKT.policy, facts: [] });
  assert.equal(tlLa2.action, "HANDOFF", "hết câu đã duyệt thì chuyển người, KHÔNG ghép tạm vài dữ kiện rời thành câu nghe như biết");

  // Cùng hàm ấy áp cho mẫu TEST, và nhãn nguồn phải nói đúng BẢNG nào.
  const bdTest = (await loadTestKnowledge(test1.id, db))!;
  const tlTest = answerFromKnowledge("PRICE", bdTest.knowledge, bdTest.permissions, { origin: "TEST_PRODUCT" });
  assert.ok(tlTest.text.includes("399.000"), "giá của chính mẫu test");
  assert.ok(!tlTest.text.includes("499.000"), "TUYỆT ĐỐI không phải giá mã WIN");
  assert.equal(tlTest.provenance[0]?.source, "test_product_profiles.unit_price");

  // ═════════ 14. TÍN HIỆU THỊ TRƯỜNG: chỉ ghi điều THẤY, và chỉ NÂNG ═════════
  //
  // `null` là CHƯA THẤY, không phải "không". Tin thứ hai chỉ nói được điều nó thấy, không nói được
  // điều nó không thấy — nên nó không bao giờ hạ một cờ tin thứ nhất đã dựng lên.
  const th1 = extractTestSignals("mẫu này bao nhiêu tiền vậy shop, đẹp quá");
  assert.equal(th1.askedPrice, true);
  assert.equal(th1.likedDesign, true);
  assert.equal(th1.sizeQuestion, undefined, "không hỏi size thì để TRỐNG, không ghi false");

  const th2 = extractTestSignals("em cao 1m58 nặng 50kg, lấy màu đen size M");
  assert.equal(th2.heightCm, 158);
  assert.equal(th2.weightKg, 50);
  assert.equal(th2.requestedColor, "đen");
  assert.equal(th2.requestedSize, "M");
  assert.equal(extractTestSignals("cho em xin 50 cái ảnh").weightKg, undefined, "một con số trơ trọi KHÔNG được đoán là cân nặng");

  const htTh = await hoiThoai(db, "fp-ht-signal");
  await recordTestSignal({ conversationId: htTh.id, testProductId: test1.id, runId: null, text: "bao nhiêu vậy shop" }, db);
  await recordTestSignal({ conversationId: htTh.id, testProductId: test1.id, runId: null, text: "cho em màu đỏ đô nhé" }, db);
  const [th] = await db.select().from(schema.testMarketSignals).where(eq(schema.testMarketSignals.conversationId, htTh.id));
  assert.equal(th.askedPrice, true, "tin sau KHÔNG được xoá điều tin trước đã quan sát được");
  assert.equal(th.requestedColor, "đỏ đô");
  assert.equal(th.sizeQuestion, null, "chưa quan sát được thì vẫn là CHƯA BIẾT, không phải false");

  // ═════════ 15. BẢNG SỐ ĐO ĐI QUA MÁY GỢI Ý SIZE CỦA ERP, KHÔNG PHẢI BẢN THỨ HAI ═════════
  //
  // ERP đã có máy gợi ý size có phiên bản, có phạm vi, có mã AMBIGUOUS/OUT_OF_RANGE. 0088 từng
  // dựng một bảng số đo thứ hai và 0091 đã gỡ: hai bảng là hai câu trả lời khác nhau cho "khách
  // này mặc size gì", và cái sai lộ ra ở một kiện hàng không vừa chứ không lộ ra ở màn hình.
  const bang: SizeRule = {
    version: "q004-2026-09",
    scope: "PRODUCT",
    key: "Q004",
    fabricStretch: "HIGH",
    // Các khoảng CHỒNG LẤN nhau, đúng như bảng size thật — và đó là lý do phải có nhánh
    // AMBIGUOUS: người ở vùng giao nhau thì bảng không kết luận được, phải hỏi thích ôm hay rộng.
    rows: [
      { size: "M", heightCm: [150, 158], weightKg: [42, 52] },
      { size: "L", heightCm: [155, 163], weightKg: [50, 58] },
      { size: "XL", heightCm: [158, 168], weightKg: [57, 66] },
    ],
  };
  await setSettingJson(SIZE_RULES_KEY, { version: "2026-09", rules: [bang] });

  const bdSize = (await loadWinKnowledge(PAGE, db))!;
  assert.equal(bdSize.knowledge.sizeRuleCount, 3, "bảng đọc từ settings[ai.sizeRules], không từ một bảng riêng");
  assert.equal(bdSize.sizeRuleVersion, "q004-2026-09");
  assert.equal(bdSize.capabilities.CAN_ADVISE_SIZE.status, "READY", "có bảng ⇒ tư vấn size mở ra");

  const ctxSize = { sizeRule: bang, policy: bdSize.policy, facts: bdSize.facts };
  // Đủ số đo, đúng một size khớp ⇒ trả lời được, và nói rõ nó tra ở đâu.
  const sz1 = answerFromKnowledge("SIZE", bdSize.knowledge, bdSize.permissions, { ...ctxSize, body: extractMeasurements("em cao 1m55 nặng 45kg") });
  assert.equal(sz1.action, "ANSWER");
  assert.ok(sz1.text.includes("size M"), `phải ra M, thực tế: ${sz1.text}`);
  assert.ok(sz1.provenance.some((x) => x.source.includes("ai.sizeRules")), "phải chỉ ra bảng nào đã tra");

  // THIẾU SỐ ĐO ⇒ HỎI, và chỉ hỏi ĐÚNG chiều bảng thật sự dùng.
  const sz2 = answerFromKnowledge("SIZE", bdSize.knowledge, bdSize.permissions, { ...ctxSize, body: extractMeasurements("eo em 74 thì mặc size gì") });
  assert.equal(sz2.action, "ASK", "bảng này tra theo cao/nặng, khách mới cho vòng eo ⇒ hỏi thêm");
  assert.ok(/chiều cao/.test(sz2.text) && /cân nặng/.test(sz2.text));
  assert.ok(!/vòng ngực|vòng mông/.test(sz2.text), "KHÔNG đòi cho đủ bộ số đo — bảng không dùng ba vòng");

  // RƠI VÀO HAI SIZE ⇒ CHUYỂN NGƯỜI, không chọn bừa cái nào.
  const sz3 = answerFromKnowledge("SIZE", bdSize.knowledge, bdSize.permissions, { ...ctxSize, body: { heightCm: 157, weightKg: 51 } });
  assert.equal(sz3.action, "HANDOFF");
  assert.ok(sz3.provenance.some((x) => x.value.includes("AMBIGUOUS")), "phải ghi lại là vì rơi vào nhiều size");
  assert.ok(!/size M|size L/.test(sz3.text), "tuyệt đối không nói ra một size khi chưa kết luận được");

  // NGOÀI BẢNG ⇒ CHUYỂN NGƯỜI. Bịa một size ở đây là gửi đi một kiện hàng không vừa.
  const sz4 = answerFromKnowledge("SIZE", bdSize.knowledge, bdSize.permissions, { ...ctxSize, body: { heightCm: 175, weightKg: 85 } });
  assert.equal(sz4.action, "HANDOFF");
  assert.ok(sz4.provenance.some((x) => x.value.includes("OUT_OF_RANGE")));

  // BẢNG SỐ ĐO CỦA Q004 KHÔNG ĐƯỢC RÒ SANG MẪU TEST. Bảng khai ở phạm vi PRODUCT với khoá là mã
  // hàng; mẫu test tra bằng MÃ TẠM ở phạm vi FAMILY, nên hai bên không thể chạm vào nhau. Đây là
  // chỗ dễ rò nhất của cả mô hình: đúng bảng, sai mẫu, và khách vẫn nhận được một con số nghe
  // rất tự tin.
  const bdTestSize = (await loadTestKnowledge(test1.id, db))!;
  assert.equal(bdTestSize.knowledge.sizeRuleCount, 0, "mẫu test KHÔNG thấy bảng số đo của Q004");
  assert.equal(bdTestSize.sizeRuleVersion, "", "và không mang bản của bảng ấy");
  assert.equal(bdTestSize.capabilities.CAN_ADVISE_SIZE.status, "MISSING_DATA", "nên tư vấn size vẫn tắt cho mẫu test");

  // ═════════ 16. BÓC SỐ ĐO: CHỈ NHẬN DẠNG VIẾT RÕ RÀNG ═════════
  assert.deepEqual(extractMeasurements("cao 1m58 nặng 50kg"), { heightCm: 158, weightKg: 50 });
  assert.deepEqual(extractMeasurements("eo 74"), { waistCm: 74 }, "có chữ 'eo' thì mới biết 74 là vòng eo");
  assert.deepEqual(extractMeasurements("cho em 74 cái"), {}, "một con số trơ trọi KHÔNG được đoán là số đo nào");
  assert.equal(extractColor("cho chị màu đỏ đô nhé", ["Đỏ", "Đỏ đô", "Đen"]), "Đỏ đô", "chuỗi dài khớp trước — 'đỏ đô' không bị cắt thành 'đỏ'");
  assert.equal(extractColor("màu hồng có không", ["Đỏ", "Đen"]), "", "màu shop KHÔNG bán thì không nhận bừa");
  assert.equal(extractSize("lấy size L", ["M", "L"]), "L");
  assert.equal(extractSize("em cao 1m58", ["M", "L"]), "", "chữ 'm' trong '1m58' KHÔNG phải size M");

  // ═════════ 17. CÒN BÁN ≠ CÒN HÀNG — và gộp hai câu là chỗ sai đắt nhất ═════════
  //
  // fp-v1 (M/Đen) chưa có phiếu nhập nào ⇒ tồn là THIẾU DỮ LIỆU (luật 10), không phải 0.
  const sl1 = await checkSellability({ productId: win.id }, db);
  assert.equal(sl1.verdict, "UNKNOWN", "chưa có phiếu nhập ⇒ CHƯA BIẾT còn hàng, không phải hết hàng");
  assert.equal(sl1.needsHuman, true);
  assert.deepEqual(sl1.listedColors, ["Đen"], "nhưng ĐANG BÁN màu nào thì ERP luôn trả lời được");

  const tlCon2 = answerFromKnowledge("STOCK", bdSize.knowledge, bdSize.permissions, { ...ctxSize, sellability: sl1 });
  assert.equal(tlCon2.action, "HANDOFF");
  assert.ok(!/còn hàng/.test(tlCon2.text), "TUYỆT ĐỐI không hứa 'còn hàng' khi tồn chưa biết");
  assert.ok(/đang bán màu Đen/.test(tlCon2.text), "nhưng vẫn nói được cái BIẾT — đó là phần có ích của một câu chưa trả lời được");

  // KHÔNG HỎI LẠI THỨ KHÁCH VỪA NÓI. Khách viết "đen size M còn không" mà máy đáp "chị cho em xin
  // size" thì nó tự khai là không đọc câu của khách — ấn tượng đầu tiên khách có về cả con máy.
  const slDu = await checkSellability({ productId: win.id, color: "Đen", size: "M" }, db);
  const tlDu = answerFromKnowledge("STOCK", bdSize.knowledge, bdSize.permissions, { ...ctxSize, sellability: slDu });
  assert.ok(!/cho em xin size|cho em xin màu/.test(tlDu.text), `khách đã nói đủ màu+size, không được hỏi lại: ${tlDu.text}`);
  assert.ok(/Đen/.test(tlDu.text) && /M/.test(tlDu.text), "và phải nhắc lại đúng thứ khách chọn");

  // TỒN ÂM: sổ kho tự mâu thuẫn (xuất nhiều hơn nhập). "Hết hàng" nghe an toàn hơn "còn hàng"
  // nhưng vẫn là một khẳng định dựng trên dữ liệu đã hỏng — và nó làm mất một đơn có thật.
  await db.insert(schema.stockReceipts).values({ id: "fp-r1", kind: "RECEIPT", receivedAt: new Date(), note: "kiểm thử" });
  await db.insert(schema.stockReceiptItems).values({ id: "fp-ri1", receiptId: "fp-r1", variantId: "fp-v1", quantity: 1, unitCost: 0 });
  const slAm = await checkSellability({ productId: win.id }, db);
  assert.equal(slAm.verdict, "SELLABLE", "có phiếu nhập 1 cái, chưa xuất cái nào ⇒ còn hàng");
  await db.update(schema.stockReceiptItems).set({ quantity: -5 }).where(eq(schema.stockReceiptItems.id, "fp-ri1"));
  const slAm2 = await checkSellability({ productId: win.id }, db);
  assert.equal(slAm2.verdict, "UNKNOWN", "tồn ÂM là sổ tự mâu thuẫn ⇒ CHƯA BIẾT, không kết luận hết hàng");
  assert.ok(/mâu thuẫn/.test(slAm2.evidence), "và nói rõ vì sao chưa biết");
  await db.delete(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.id, "fp-ri1"));
  await db.delete(schema.stockReceipts).where(eq(schema.stockReceipts.id, "fp-r1"));

  // Tổ hợp shop KHÔNG chào bán ⇒ trả lời được ngay, không cần tới sổ kho.
  const sl2 = await checkSellability({ productId: win.id, color: "Hồng" }, db);
  assert.equal(sl2.verdict, "NOT_SELLING");
  const tlCon3 = answerFromKnowledge("STOCK", bdSize.knowledge, bdSize.permissions, { ...ctxSize, sellability: sl2 });
  assert.equal(tlCon3.action, "ASK", "biết chắc là không có thì nói luôn, rồi mời khách chọn màu đang bán");

  // ═════════ 18. CHÍNH SÁCH ĐỔI TRẢ TRẢ LỜI THEO TỪNG NHÁNH ═════════
  assert.equal(policyAnswerable(EMPTY_SALES_POLICY), false, "chưa khai nhánh nào thì KHÔNG trả lời được");
  assert.equal(policyAnswerable({ ...EMPTY_SALES_POLICY, exchange: { ...EMPTY_SALES_POLICY.exchange, SIZE: { allowed: false, days: null, conditions: "", shipPayer: "UNSET" } } }), true,
    "'bên em KHÔNG nhận đổi' là một câu trả lời ĐẦY ĐỦ — khác hẳn chưa khai");
  const tlDoi = answerFromKnowledge("EXCHANGE", bdSize.knowledge, bdSize.permissions, ctxSize);
  assert.equal(tlDoi.action, "ANSWER");
  assert.ok(/3 ngày/.test(tlDoi.text) && /nguyên tem/.test(tlDoi.text), "dựng câu từ chính các ô đã khai");
  assert.ok(/chưa hỗ trợ/.test(tlDoi.text), "nhánh đổi màu khai là KHÔNG — và máy nói ra điều đó");

  // ═════════ 19. BỐN SỐ HIỆU, BỐN ĐƯỜNG ĐỔI — hội thoại cũ không bị viết lại ở đường nào ═════════
  //
  // Bốn thứ có thể đổi độc lập: GIÁ · MÃ WIN · BẢNG SỐ ĐO · CHÍNH SÁCH. Gộp chúng vào một số thì
  // sáu tháng sau không trả lời được "lúc ấy khách được báo giá nào, hứa đổi trả thế nào".
  const htV = await hoiThoai(db, "fp-ht-version");
  const plV = await classifyConversationSource({ conversationId: htV.id, pancakePageId: PAGE }, db);
  await snapshotClassification(htV.id, plV, db);
  const [chupV] = await db.select().from(schema.salesConversations).where(eq(schema.salesConversations.id, htV.id));
  assert.equal(chupV.sizeRuleVersion, "q004-2026-09", "chụp BẢN BẢNG SỐ ĐO lúc ấy");
  assert.equal(chupV.policyVersion, 1, "và bản CHÍNH SÁCH lúc ấy");

  // ① đổi GIÁ · ② đổi MÃ WIN · ③ đổi BẢNG SỐ ĐO · ④ đổi CHÍNH SÁCH — cả bốn cùng lúc.
  await db.update(schema.fanpageSalesProfiles)
    .set({ unitPrice: 599_000, activeProductId: "fp-other", version: 9, policyVersion: 7,
           exchangePolicyJson: { ...chinhSach, exchange: { ...chinhSach.exchange, SIZE: { allowed: true, days: 30, conditions: "", shipPayer: "SHOP" } } } })
    .where(eq(schema.fanpageSalesProfiles.id, hoSo.id));
  await setSettingJson(SIZE_RULES_KEY, { version: "2026-10", rules: [{ ...bang, version: "q004-2026-10", rows: [{ size: "L", heightCm: [150, 170], weightKg: [40, 70] }] }] });

  const plSau = await classifyConversationSource({ conversationId: htV.id, pancakePageId: PAGE }, db);
  assert.equal(plSau.classificationSource, "SNAPSHOT");
  assert.equal(plSau.offer?.unitPrice, 499_000, "① GIÁ: hội thoại cũ giữ 499k");
  assert.equal(plSau.activeProductId, win.id, "② MÃ WIN: hội thoại cũ vẫn Q004");
  assert.equal(plSau.sizeRuleVersion, "q004-2026-09", "③ BẢNG SỐ ĐO: giữ bản cũ, không nhảy sang bản tháng 10");
  assert.equal(plSau.policyVersion, 1, "④ CHÍNH SÁCH: giữ bản 1, khách KHÔNG bị đổi cam kết từ 3 ngày sang 30 ngày");

  // Hội thoại MỚI thì dùng mọi thứ mới — bất biến là của quá khứ, không phải của cấu hình.
  const htV2 = await hoiThoai(db, "fp-ht-version-2");
  const plV2 = await classifyConversationSource({ conversationId: htV2.id, pancakePageId: PAGE }, db);
  assert.equal(plV2.offer?.unitPrice, 599_000);
  assert.equal(plV2.policyVersion, 7);

  // ═════════ 20. MƯỜI HAI CÂU KHÁCH HAY HỎI — chạy hết, không câu nào được bịa ═════════
  //
  // Đây là cái mốc để đối chiếu khi bật mô hình thật: cùng dữ liệu thì cùng những câu này. Mô hình
  // được đổi cách nói, KHÔNG được đổi cột `capability`, `missing`, hay danh sách nguồn.
  const MUOI_HAI = [
    "Bao nhiêu em?", "Mua 2 cái bao nhiêu?", "Ship bao nhiêu?", "Có màu gì?",
    "50kg mặc size gì?", "Eo 74 thì mặc size gì?", "Màu đỏ size L còn không?",
    "Có được kiểm hàng không?", "Bao lâu nhận được?", "Không vừa có đổi được không?",
    "Chị lấy đỏ size L", "Chốt cho chị 2 cái",
  ];
  const ctx12 = { sizeRule: bang, policy: bdSize.policy, facts: bdSize.facts };
  for (const q of MUOI_HAI) {
    const tl = answerFromKnowledge(winIntentOf(q), bdSize.knowledge, bdSize.permissions, {
      ...ctx12,
      body: extractMeasurements(q),
      sellability: await checkSellability({ productId: win.id, color: extractColor(q, bdSize.knowledge.colors), size: extractSize(q, ["M", "L", "XL"]) }, db),
    });
    // MỘT LUẬT CHO CẢ MƯỜI HAI CÂU: trả lời được thì phải chỉ ra nguồn; né thì phải nói thiếu gì.
    // Một câu vừa không có nguồn vừa không nói thiếu gì là một câu máy tự nghĩ ra.
    if (tl.action === "HANDOFF") {
      assert.ok(tl.missing.length || tl.blockedBy, `"${q}": né mà không nói thiếu gì / chặn gì`);
    } else {
      assert.ok(tl.provenance.length, `"${q}": trả lời mà không chỉ được nguồn — đó là câu bịa`);
    }
    // KHÔNG câu nào được nói một con số ngoài những gì đã khai.
    const soTrongCau = (tl.text.match(/[0-9][0-9.]{2,}/g) ?? []).filter((x) => !/^1m/.test(x));
    for (const so of soTrongCau) {
      assert.ok(
        tl.provenance.some((pv) => pv.value.includes(so)) || /ngày/.test(tl.text),
        `"${q}": câu trả lời mang số ${so} nhưng không nguồn nào khai nó — ${tl.text}`,
      );
    }
  }

  console.log("  ✓ hồ sơ fanpage: mẫu thắng mặc định · TEST đè · ảnh chụp bất biến (mã + GIÁ) · cổng năng lực theo dữ liệu · mâu thuẫn ERP thì báo không đè · size đi qua máy gợi ý size của ERP · còn bán ≠ còn hàng · bốn số hiệu bốn đường đổi");
}
