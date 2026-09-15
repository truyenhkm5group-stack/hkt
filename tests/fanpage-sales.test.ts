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

  console.log("  ✓ hồ sơ fanpage: mẫu thắng mặc định · TEST đè · ảnh chụp bất biến · chưa khai thì chuyển người");
}
