import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DEFAULT_CREATIVE_CONFIG, INSTANT_PUBLISH, MANUAL_GEN, MANUAL_GEN_RUN, MANUAL_SLOT_BASE, NAMING_TEMPLATE_KEY, estimateImageUsd, parseGenes, usdToVndRounded, type CreativeLoopConfig } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { approvalDigest, batchTicket, verifyBatchTicket } from "@/lib/creative/approval";
import type { VariantCaptioner } from "@/lib/creative/caption";
import { imageSpendToday, manualGenSpendToday } from "@/lib/creative/generate";
import { storeCreativeImage } from "@/lib/creative/images";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import { manualTargetDay } from "@/lib/creative/manual";
import { drawManualGen, instantWindow, manualGenGenes, manualGenPrompt, manualGenRunCount, pickName, promoteManualGenImage, publishManualGenImageInstant, reviewManualGenImage, startManualGen } from "@/lib/creative/manual-gen";
import { adsetDefaultName, agePart, assignBatchNames, ddMm, defaultNames, genderPart, geoPart, refreshNamingTemplate, saveVariantNamesCore, type NamingContext } from "@/lib/creative/naming";
import { batchApprovalContent, isLegacyStructure, nextStep, publishNames, type CreativeWriter } from "@/lib/creative/publish";
import { batchWindow } from "@/lib/creative/schedule";
import { applyVariantSelectionCore, planSelection } from "@/lib/creative/selection";
import { testCampaignFields, type TemplateAd } from "@/lib/integrations/facebook/ads-write";
import type { ImageEditClient, ImageEditInputImage } from "@/lib/integrations/openai/images";

/**
 * ═══════════ VÒNG MẪU — GEN TAY · TÊN CHIẾN DỊCH · TÍCH CHỌN BÀI · MỖI BÀI MỘT CHIẾN DỊCH (§5i) ═══════════
 *
 * Khoá:
 *  (a) HÀM THUẦN: 10 bộ gen đủ sáu khoá, khác nhau, tất định · câu lệnh (ý tưởng người ƯU TIÊN CAO NHẤT, đứng
 *      đầu + nhắc lại cuối; ảnh tải lên) · số ảnh một lần bấm kẹp min…max · khung giờ "Đăng camp" · ba khuôn tên
 *      (kể cả mã lạ, thiếu tên TKQC) · chọn tên khi số thứ tự dự kiến đã cũ · kế hoạch chọn bài · trường tạo chiến dịch.
 *  (b) GEN TAY trên PGlite với máy vẽ GIẢ (0 lời gọi mạng): nguồn không an toàn bị chặn · 10 ảnh mặc định ·
 *      KHÔNG còn trần ảnh / ngày (cấu hình trần 0 USD vẫn vẽ) · sổ chi ảnh của LÔ không đếm gen tay, tiền gen tay
 *      đo riêng · số ảnh người chọn + ảnh tải lên đi kèm ảnh sản phẩm thật · ảnh "đang vẽ" quá hạn không vẽ lại ·
 *      duyệt ⇒ viết câu chữ theo ảnh · loại · vào lô đúng ngày với tên đúng số thứ tự.
 *  (f) ĐĂNG CAMP (máy ghi Facebook GIẢ): cổng tắt ⇒ không ghi gì · hẹn giờ ⇒ lô INSTANT riêng, duyệt bởi người
 *      bấm, nhóm mang start_time = giờ hẹn · chạy ngay ⇒ lô INSTANT thứ hai CÙNG ngày · hỏng khi chưa gửi gì ⇒ ảnh
 *      về "Đã duyệt", bấm lại được.
 *  (c) TÍCH CHỌN: loại nhiều bài ⇒ không còn trong digest · giữ ⇒ khôi phục + loại phần còn lại.
 *  (d) SỬA TÊN: đổi digest ⇒ phiếu cũ vô hiệu; lô đã duyệt thì không sửa được.
 *  (e) Lượt vòng mẫu VẼ NỐT ảnh gen tay.
 *
 * Mốc thời gian: phần chi ảnh đi theo đồng hồ THẬT (sổ chi ảnh đếm theo `created_at = now()` của CSDL), phần
 * lô dùng ngày lô XA trong tương lai dựng từ chính hàm lịch — không ghim ngày tuyệt đối (AGENTS.md mục 50).
 */

const P = "cmg-";

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, (tag >> 16) & 0xff, 9, 9, 1, 2, 3]);
}

const TARGETING = { geo_locations: { countries: ["VN"] }, age_min: 18, age_max: 65 };

export function testCreativeManualGenPure() {
  // ── Gen: 10 bộ, đủ sáu khoá, khác nhau, tất định ──
  const g1 = manualGenGenes("lượt-1");
  assert.equal(g1.length, MANUAL_GEN.imagesPerRun, `mỗi lần bấm đúng ${MANUAL_GEN.imagesPerRun} ảnh`);
  assert.ok(g1.every((g) => parseGenes(g) !== null), "mọi ảnh mang ĐỦ sáu gen trong từ vựng đóng");
  assert.equal(new Set(g1.map((g) => `${g.scene}|${g.composition}`)).size, g1.length, "10 ảnh = 10 tổ hợp bối cảnh × bố cục khác nhau");
  assert.ok(g1.every((g) => g.textOverlay === "NONE"), "ảnh gen tay không in chữ / giá lên ảnh");
  assert.ok(g1.every((g) => g.model !== "NONE" || g.scene === "FLATLAY"), "không người mẫu chỉ khi trải phẳng");
  assert.deepEqual(manualGenGenes("lượt-1"), g1, "tất định theo id lượt");

  const pr = manualGenPrompt({ idea: "đi biển Đà Nẵng", genes: g1[0], productName: "Đầm linen", hasOwnAd: false });
  assert.ok(pr.includes("đi biển Đà Nẵng") && pr.includes("Đầm linen") && pr.includes("keep the product EXACTLY"), "câu lệnh = ý tưởng người + giữ nguyên sản phẩm");
  assert.ok(!pr.includes("OWN previous ads"), "không có quảng cáo cũ thì không nhắc");
  assert.ok(manualGenPrompt({ idea: "", genes: g1[0], productName: "x", hasOwnAd: true }).includes("OWN previous ads"));
  // Chủ shop 26/09/2026: "câu lệnh không được áp dụng" — ý tưởng từng đứng GIỮA kèm lời dặn "trừ khi mâu thuẫn với
  // luật bên dưới", mà bên dưới là sáu chỉ thị gen mệnh lệnh. Nay: dòng ĐẦU, nhắc lại ở dòng CUỐI, gen lùi thành mặc định.
  const dong = pr.split("\n");
  assert.ok(dong[0].startsWith("TOP PRIORITY") && dong[0].includes("đi biển Đà Nẵng"), "ý tưởng người là dòng ĐẦU, ưu tiên cao nhất");
  assert.ok(dong[dong.length - 1].includes("đi biển Đà Nẵng"), "và được nhắc lại ở dòng CUỐI");
  assert.ok(!pr.includes("unless it conflicts"), "không còn lời dặn khiến ý tưởng luôn thua chỉ thị gen");
  const iMacDinh = dong.findIndex((l) => l.startsWith("Default directions"));
  assert.ok(iMacDinh > 0 && iMacDinh < dong.findIndex((l) => l.startsWith("IMPORTANT: keep the product")), "sáu chỉ thị gen đứng SAU nhãn 'mặc định'");
  const khongYTuong = manualGenPrompt({ idea: "  ", genes: g1[0], productName: "x", hasOwnAd: false });
  assert.ok(!khongYTuong.includes("TOP PRIORITY") && !khongYTuong.includes("Default directions"), "không có ý tưởng ⇒ không có khối ưu tiên");
  assert.ok(manualGenPrompt({ idea: "", genes: g1[0], productName: "x", hasOwnAd: false, uploadCount: 2 }).includes("2 attached images were uploaded by the shop owner"), "ảnh tải lên được nhắc trong câu lệnh");

  // ── Số ảnh một lần bấm: người chọn, kẹp min…max (không còn trần ảnh / ngày) ──
  assert.equal(manualGenRunCount(undefined), MANUAL_GEN.imagesPerRun, "không chọn ⇒ mặc định");
  assert.equal(manualGenRunCount(0), MANUAL_GEN_RUN.minImagesPerRun);
  assert.equal(manualGenRunCount(999), MANUAL_GEN_RUN.maxImagesPerRun, "gõ nhầm số lớn ⇒ kẹp ở trần MỘT LẦN BẤM");
  assert.equal(manualGenRunCount(7.4), 7);
  assert.equal(manualGenRunCount(Number.NaN), MANUAL_GEN.imagesPerRun);

  // ── Tiền quy đổi: CHƯA BIẾT giữ nguyên CHƯA BIẾT ──
  assert.equal(usdToVndRounded(0.04, 25_500), 1020);
  assert.equal(usdToVndRounded(null, 25_500), null, "ảnh không có giá ⇒ null, không thành 0 đồng");
  assert.equal(usdToVndRounded(0, 25_500), 0, "0 thật vẫn là 0");

  // ── Khung giờ "Đăng camp" (thuần) ──
  const t0 = new Date("2031-05-05T03:00:00Z");
  const ngay = instantWindow(t0, null, { testDays: 1 });
  assert.ok(ngay.ok && !ngay.scheduled && ngay.startAt.getTime() === t0.getTime() + INSTANT_PUBLISH.leadSeconds * 1000, "chạy ngay = sau lúc bấm leadSeconds giây");
  assert.ok(ngay.ok && ngay.endAt.getTime() - ngay.startAt.getTime() === 86_400_000, "dài testDays ngày — Facebook tự dừng ở end_time");
  assert.ok(ngay.ok && ngay.batchDay === vnDay(ngay.startAt));
  const hen = instantWindow(t0, new Date(t0.getTime() + 3 * 3_600_000), { testDays: 5 });
  assert.ok(hen.ok && hen.scheduled && hen.startAt.getTime() === t0.getTime() + 3 * 3_600_000, "hẹn giờ ⇒ đúng giờ hẹn");
  assert.ok(hen.ok && hen.endAt.getTime() - hen.startAt.getTime() === 86_400_000, "testDays kẹp theo trần cứng");
  const sat = instantWindow(t0, new Date(t0.getTime() + 60_000), { testDays: 1 });
  assert.ok(!sat.ok && sat.error.includes("ít nhất"), "hẹn quá sát giờ ⇒ từ chối, bảo dùng Chạy ngay");
  assert.ok(!instantWindow(t0, new Date(t0.getTime() + (INSTANT_PUBLISH.maxScheduleDays + 1) * 86_400_000), { testDays: 1 }).ok, "hẹn quá xa ⇒ từ chối");
  assert.ok(!instantWindow(t0, new Date(Number.NaN), { testDays: 1 }).ok);

  // ── Ba khuôn tên ──
  assert.equal(ddMm("2026-09-25"), "25/09");
  const tpl = { optimizationGoal: "CONVERSATIONS", targeting: TARGETING, bidStrategy: "LOWEST_COST_WITHOUT_CAP" };
  assert.deepEqual(adsetDefaultName(tpl), { name: "MESS_VN_18-65+_All_autobid", problems: [] });
  assert.equal(adsetDefaultName({ ...tpl, bidStrategy: "COST_CAP" }).name.endsWith("_costcap"), true);
  assert.equal(adsetDefaultName({ ...tpl, bidStrategy: "LOWEST_COST_WITH_BID_CAP" }).name.endsWith("_bidcap"), true);
  // Mã lạ ⇒ in NGUYÊN mã, không đoán.
  assert.equal(adsetDefaultName({ optimizationGoal: "SOME_NEW_GOAL", targeting: { ...TARGETING, genders: [9] }, bidStrategy: "LOWEST_COST_WITH_MIN_ROAS" }).name, "SOME_NEW_GOAL_VN_18-65+_9_LOWEST_COST_WITH_MIN_ROAS");
  // Thiếu ⇒ "?" và nói ra.
  const thieu = adsetDefaultName({ optimizationGoal: null, targeting: null, bidStrategy: null });
  assert.equal(thieu.name, "?_?_?_All_?");
  assert.equal(thieu.problems.length, 4);
  assert.equal(genderPart({ genders: [2] }).text, "Nữ");
  assert.equal(genderPart({ genders: [1, 2] }).text, "All");
  assert.equal(agePart({ age_min: 22, age_max: 40 }).text, "22-40");
  assert.equal(geoPart({ geo_locations: { regions: [{ key: "1", name: "Hà Nội" }], cities: [{ key: "2", name: "Đà Nẵng" }] } }).text, "Hà Nội+Đà Nẵng");

  const ctx: NamingContext = { accountName: "QUAN_TA", pageName: "Phương Anh Fashion", adset: adsetDefaultName(tpl) };
  const d = defaultNames(ctx, "2026-09-25", 12);
  assert.equal(d.campaign, "QUAN_TA_25/09_TEST_Phương Anh Fashion_12", "khuôn chiến dịch đúng ví dụ của chủ shop");
  assert.equal(d.adset, "MESS_VN_18-65+_All_autobid");
  assert.equal(d.ad, "Phương Anh Fashion_ảnh_12_TXT");
  assert.deepEqual(d.problems, []);
  assert.equal(defaultNames(ctx, "2026-09-25", 3, "VIDEO").ad, "Phương Anh Fashion_video_3_TXT", "hàm đặt tên nhận loại media");
  const khongTk = defaultNames({ ...ctx, accountName: null }, "2026-09-25", 12);
  assert.equal(khongTk.campaign, "25/09_TEST_Phương Anh Fashion_12", "thiếu tên TKQC ⇒ để trống phần ấy");
  assert.ok(khongTk.problems.some((p) => p.includes("tài khoản quảng cáo")), "và NÓI RA");
  assert.equal(defaultNames({ ...ctx, adset: null }, "2026-09-25", 1).adset, "", "chưa đọc được nhóm mẫu ⇒ tên nhóm trống (đăng với tên cũ), không đoán");

  // Chọn tên khi số thứ tự dự kiến đã cũ.
  assert.equal(pickName("", "A_2", "A_1"), "A_2", "để trống ⇒ mặc định với số THẬT");
  assert.equal(pickName("A_1", "A_2", "A_1"), "A_2", "giữ nguyên mặc định cũ ⇒ mặc định với số THẬT");
  assert.equal(pickName("Tên tôi đặt", "A_2", "A_1"), "Tên tôi đặt", "người đã sửa ⇒ đúng chữ người gõ");

  // ── Chọn bài ──
  const vs = [
    { id: "a", status: "GENERATED", restorable: true },
    { id: "b", status: "GENERATED", restorable: true },
    { id: "c", status: "REJECTED", restorable: true },
    { id: "d", status: "REJECTED", restorable: false },
  ];
  assert.deepEqual(planSelection(vs, ["a", "c"], "REJECT_SELECTED"), { reject: ["a"], restore: [] });
  assert.deepEqual(planSelection(vs, ["a", "c", "d"], "KEEP_SELECTED"), { reject: ["b"], restore: ["c"] }, "giữ ⇒ khôi phục bài có ảnh, loại phần còn lại");

  // ── Mỗi bài một chiến dịch: trường tạo chiến dịch + bước kế tiếp ──
  const camp = { objective: "OUTCOME_ENGAGEMENT", buyingType: "AUCTION", specialAdCategories: [], dailyBudgetMinor: null, lifetimeBudgetMinor: null };
  assert.deepEqual(testCampaignFields("C1", camp), { name: "C1", objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", special_ad_categories: "[]", buying_type: "AUCTION" }, "chiến dịch riêng LUÔN tạo TẮT, KHÔNG mang ngân sách");
  assert.throws(() => testCampaignFields("C1", { ...camp, dailyBudgetMinor: 100 }), /CBO/, "chiến dịch mẫu CBO ⇒ không tạo");
  assert.throws(() => testCampaignFields("C1", { ...camp, objective: null }), /mục tiêu/);
  assert.throws(() => testCampaignFields("C1", { ...camp, specialAdCategories: null }), /special_ad_categories/);
  const ids = { fbImageHash: "h", fbCreativeId: "c", fbCampaignId: null as string | null, fbAdsetId: null as string | null, fbAdId: null as string | null };
  assert.equal(nextStep(ids), "CREATE_CAMPAIGN");
  assert.equal(nextStep({ ...ids, fbCampaignId: "k" }), "CREATE_ADSET");
  assert.equal(nextStep({ ...ids, fbCampaignId: "k", fbAdsetId: "a", fbAdId: "d" }), "ACTIVATE_CAMPAIGN");
  assert.equal(nextStep({ ...ids, fbAdsetId: "a-cu" }), "CREATE_AD", "mẫu đăng dở theo cấu trúc CŨ đi tiếp đường cũ");
  assert.equal(isLegacyStructure({ fbAdsetId: "a", fbCampaignId: null }), true);
  assert.deepEqual(publishNames("2026-09-25", { slot: 3, campaignName: "", adsetName: "N", adName: "" }), { creative: "VM 2026-09-25 #3", campaign: "VM 2026-09-25 #3", adset: "N", ad: "VM 2026-09-25 #3" }, "tên rỗng ⇒ tên cũ");

  console.log("  ✓ Gen tay (thuần): 10 bộ gen đủ sáu khoá, khác nhau · ý tưởng người đứng đầu + nhắc lại cuối · số ảnh kẹp min…max · khung giờ Đăng camp · tiền CHƯA BIẾT giữ null · ba khuôn tên (mã lạ in nguyên, thiếu TKQC để trống + nói ra) · chọn bài · chiến dịch riêng tạo TẮT, CBO bị từ chối");
}

// ═══════════════════════════ PGLITE ═══════════════════════════

const TEMPLATE_AD = "9990001";

function cfgOf(over: Partial<CreativeLoopConfig> = {}): CreativeLoopConfig {
  return { ...DEFAULT_CREATIVE_CONFIG, enabled: false, pageId: `${P}page`, adAccountId: "8880001", testCampaignId: "7770001", templateAdId: TEMPLATE_AD, imageModel: "gpt-image-2", imageQuality: "low", imageSize: "1024x1024", ...over };
}

async function cleanup(db: Db, days: string[], extraBatchIds: string[] = []) {
  const gens = await db.select({ id: schema.creativeManualGens.id }).from(schema.creativeManualGens).where(like(schema.creativeManualGens.createdByName, `${P}%`));
  const genIds = gens.map((g) => g.id);
  if (genIds.length) {
    await db.delete(schema.creativeManualGenImages).where(inArray(schema.creativeManualGenImages.genId, genIds));
    await db.delete(schema.creativeManualGens).where(inArray(schema.creativeManualGens.id, genIds));
  }
  const batches = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(inArray(schema.creativeBatches.batchDay, days));
  const ids = [...batches.map((b) => b.id), ...extraBatchIds];
  if (ids.length) {
    await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.batchId, ids));
    // Camp đăng lẻ đang LIVE được lượt vòng mẫu (bước e) chấm như mọi mẫu đã đăng ⇒ có phán quyết cần dọn.
    const vIds = (await db.select({ id: schema.creativeVariants.id }).from(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids))).map((v) => v.id);
    if (vIds.length) await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, vIds));
    await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids));
    await db.delete(schema.creativeBatches).where(inArray(schema.creativeBatches.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
  await db.delete(schema.fanpages).where(eq(schema.fanpages.externalPageId, `${P}page`));
  await db.delete(schema.adSpends).where(eq(schema.adSpends.accountId, "8880001"));
}

export async function testCreativeManualGenDb(db: Db) {
  const actor = { id: `${P}u`, name: `${P}Chủ shop` };
  const instantIds: string[] = [];
  // Lô đích XA trong tương lai, mốc dựng từ chính hàm lịch.
  const farDay = shiftDay(vnDay(new Date()), 90);
  const farNow = new Date(batchWindow(farDay, DEFAULT_CREATIVE_CONFIG).approvalDeadline.getTime() - 6 * 3_600_000);
  const targetDay = manualTargetDay(farNow, DEFAULT_CREATIVE_CONFIG);
  const [prevTpl] = await db.select().from(schema.settings).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY));
  await cleanup(db, [targetDay]);

  let imageCalls = 0;
  const seen: ImageEditInputImage["kind"][][] = [];
  let costEach = 0.01;
  const imageClient: ImageEditClient = async (input) => {
    imageCalls += 1;
    seen.push(input.images.map((i) => i.kind));
    return { bytes: fakeJpeg(50_000 + imageCalls), contentType: "image/jpeg", usage: null, costUsd: costEach };
  };
  const caption: VariantCaptioner = async () => ({ ok: true, headline: "Đầm linen đi biển", primaryText: "Mặc mát cả ngày — nhắn shop tư vấn size.", options: [], seen: "đầm trắng bãi biển", model: "fake-caption", costUsd: null, attempts: 1, priceStripped: false });

  try {
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: actor.name, passwordHash: "x", role: "ADMIN" });
    await db.insert(schema.products).values([
      { id: `${P}prod`, name: "Đầm linen thử" },
      { id: `${P}khac`, name: "Áo khác" },
    ]);
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, retailPrice: 350_000, retailPriceAfterDiscount: 299_000 });
    const photo = await storeCreativeImage(db, fakeJpeg(1));
    const own = await storeCreativeImage(db, fakeJpeg(2));
    await db.insert(schema.creativeSources).values([
      { id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}prod`, imageId: photo.id, title: "ảnh thật" },
      { id: `${P}own`, kind: "OWN_AD", productId: `${P}prod`, imageId: own.id, fbAdId: `${P}ad-cu`, title: "QC cũ thắng" },
      { id: `${P}own-khac`, kind: "OWN_AD", productId: `${P}khac`, imageId: own.id, fbAdId: `${P}ad-khac`, title: "QC mã khác" },
      { id: `${P}spy`, kind: "SPY", productId: `${P}prod`, imageId: own.id, title: "đối thủ" },
    ]);
    // Bối cảnh đặt tên: tên TKQC (sổ chi tiêu đã đồng bộ) · tên fanpage · cài đặt nhóm mẫu đã đọc.
    await db.insert(schema.fanpages).values({ externalPageId: `${P}page`, name: "Phương Anh Fashion" });
    await db.insert(schema.adSpends).values({ platform: "facebook", spend: 1000, spendDate: new Date(), accountId: "8880001", accountName: "QUAN_TA" });

    const now = new Date();

    // ── (b1) Nguồn không an toàn điểm ảnh ⇒ chặn, không ghi gì ──
    const cfg0 = cfgOf();
    const spy = await startManualGen(db, { productPhotoSourceId: `${P}spy`, ownAdSourceId: null, idea: "" }, cfg0, actor);
    assert.ok(!spy.ok && spy.error.includes("ẢNH SẢN PHẨM THẬT"), "ảnh spy không làm gốc được");
    const lech = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}own-khac`, idea: "" }, cfg0, actor);
    assert.ok(!lech.ok && lech.error.includes("ĐÚNG mã"), "quảng cáo cũ của MÃ KHÁC bị chặn");
    const spyRef = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}spy`, idea: "" }, cfg0, actor);
    assert.ok(!spyRef.ok, "ảnh spy không làm tham chiếu được");

    // ── (b2) 10 ẢNH MẶC ĐỊNH, KHÔNG CÒN TRẦN — cấu hình trần 0 USD vẫn vẽ đủ ──
    const unit = estimateImageUsd(cfg0.imageModel, cfg0.imageQuality, cfg0.imageSize);
    const cfgKhongTran = cfgOf({ imageDailyCapUsd: 0 });
    const [lo0, tay0] = await Promise.all([imageSpendToday(db, new Date(), unit), manualGenSpendToday(db, new Date())]);
    costEach = unit;
    const s1 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}own`, idea: "đi biển Đà Nẵng" }, cfgKhongTran, actor);
    assert.ok(s1.ok && s1.allowed === MANUAL_GEN.imagesPerRun && s1.requested === MANUAL_GEN.imagesPerRun, "không chọn số ⇒ đủ 10 ảnh, trần 0 USD không chặn (gen tay không còn trần)");
    const rows1 = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1.genId));
    assert.equal(rows1.length, 10);
    assert.ok(rows1.every((r) => r.status === "PLANNED" && r.prompt.startsWith("TOP PRIORITY") && r.prompt.includes("đi biển Đà Nẵng")), "ý tưởng người đứng đầu câu lệnh của MỌI ảnh");
    assert.equal(imageCalls, 0, "bấm Gen KHÔNG gọi máy vẽ — việc vẽ chạy sau phản hồi");

    const d1 = await drawManualGen(db, { genId: s1.genId, imageClient });
    assert.equal(d1.drawn, 10, "vẽ đủ 10 ảnh");
    assert.equal(imageCalls, 10);
    assert.ok(seen.every((k) => k[0] === "PRODUCT_PHOTO" && k.includes("OWN_VARIANT")), "máy vẽ nhận ảnh sản phẩm thật + quảng cáo cũ CÙNG mã (qua gatherPixels)");
    const [lo1, tay1] = await Promise.all([imageSpendToday(db, new Date(), unit), manualGenSpendToday(db, new Date())]);
    assert.equal(lo1.images, lo0.images, "sổ chi ảnh của LÔ không đếm gen tay — gen tay không ăn vào chỗ của lô");
    assert.equal(tay1.images - tay0.images, 10, "tiền gen tay đo riêng: đủ 10 ảnh");
    assert.ok(Math.abs(tay1.usd - tay0.usd - 10 * unit) < 1e-6, "tiền theo giá máy vẽ trả về");
    // Chạy lại: không ảnh nào vẽ hai lần.
    assert.equal((await drawManualGen(db, { genId: s1.genId, imageClient })).drawn, 0);

    // ── (b3) SỐ ẢNH NGƯỜI CHỌN + ẢNH TẢI LÊN đi kèm ảnh sản phẩm thật ──
    const s2 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "dáng như ảnh tôi tải", count: 3, uploads: [fakeJpeg(7_001)] }, cfgKhongTran, actor);
    assert.ok(s2.ok && s2.requested === 3, "người chọn 3 ảnh ⇒ đúng 3 ảnh");
    const [run2] = await db.select().from(schema.creativeManualGens).where(eq(schema.creativeManualGens.id, s2.ok ? s2.genId : ""));
    assert.equal(run2.uploadImageIds.length, 1, "ảnh tải lên được lưu cùng lượt (đường ghi điền id, không nhận từ trình duyệt)");
    const rows2 = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, run2.id));
    assert.equal(rows2.length, 3);
    assert.ok(rows2.every((r) => r.prompt.includes("uploaded by the shop owner")), "câu lệnh nói máy vẽ cách dùng ảnh tải lên");
    const seen0 = seen.length;
    costEach = 0.02;
    assert.equal((await drawManualGen(db, { genId: run2.id, imageClient })).drawn, 3);
    assert.ok(seen.slice(seen0).every((k) => k.length === 2 && k[0] === "PRODUCT_PHOTO" && k[1] === "OWN_VARIANT"), "ảnh sản phẩm thật ĐỨNG ĐẦU, ảnh tải lên đi kèm (ranh giới 3 giữ nguyên)");
    const drawn2 = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, run2.id));
    assert.ok(drawn2.every((r) => r.costUsd === "0.020000"), "tiền THẬT từng ảnh được ghi");
    const s3 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "", uploads: Array.from({ length: MANUAL_GEN_RUN.maxUploads + 1 }, (_, i) => fakeJpeg(8_000 + i)) }, cfgKhongTran, actor);
    assert.ok(!s3.ok && s3.error.includes(`tối đa ${MANUAL_GEN_RUN.maxUploads}`), "quá số ảnh tải lên ⇒ từ chối, không ghi lượt");
    const s3b = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "", uploads: [new Uint8Array([1, 2, 3])] }, cfgKhongTran, actor);
    assert.ok(!s3b.ok && s3b.error.includes("Ảnh tải lên #1"), "ảnh tải lên hỏng ⇒ dừng trước khi ghi lượt");

    // ── (b4) Ảnh "đang vẽ" quá hạn ⇒ lỗi, KHÔNG vẽ lại ──
    const [treo] = rows1;
    await db
      .update(schema.creativeManualGenImages)
      .set({ status: "DRAWING", claimedAt: new Date(now.getTime() - (MANUAL_GEN.staleDrawMinutes + 5) * 60_000) })
      .where(eq(schema.creativeManualGenImages.id, treo.id));
    const before4 = imageCalls;
    const d4 = await drawManualGen(db, { genId: s1.genId, imageClient });
    assert.equal(d4.stale, 1);
    assert.equal(imageCalls, before4, "không vẽ lại ảnh đứt giữa chừng");
    const [treo2] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, treo.id));
    assert.equal(treo2.status, "GEN_FAILED");

    // ── (b5) DUYỆT ⇒ máy viết câu chữ theo ảnh; LOẠI ⇒ ra khỏi lô ──
    const ready = (await db.select().from(schema.creativeManualGenImages).where(and(eq(schema.creativeManualGenImages.genId, s1.genId), eq(schema.creativeManualGenImages.status, "GENERATED")))).sort((a, b) => a.seq - b.seq);
    assert.ok(ready.length >= 5);
    const ok1 = await reviewManualGenImage(db, { imageId: ready[0].id, decision: "APPROVE", reason: "" }, actor, now, { caption });
    assert.ok(ok1.ok && ok1.status === "APPROVED" && ok1.caption?.ok, "duyệt ⇒ máy viết câu chữ theo ảnh");
    const [a1] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, ready[0].id));
    assert.equal(a1.headline, "Đầm linen đi biển");
    assert.equal(a1.reviewedByUserId, actor.id, "quy kết bằng khoá tài khoản (mục 34)");
    const rej = await reviewManualGenImage(db, { imageId: ready[1].id, decision: "REJECT", reason: "mặt người mẫu lạ" }, actor, now, { caption });
    assert.ok(rej.ok && rej.status === "REJECTED");
    const khongDua = await promoteManualGenImage(db, { imageId: ready[1].id, headline: "x", primaryText: "y", names: { campaign: "", adset: "", ad: "" }, predictedSeq: null }, cfgOf(), actor, farNow);
    assert.ok(!khongDua.ok, "ảnh bị loại không vào lô được");
    for (const r of ready.slice(2, 5)) await reviewManualGenImage(db, { imageId: r.id, decision: "APPROVE", reason: "" }, actor, now, { caption });

    // ── (b6) VÀO LÔ ĐÚNG NGÀY, TÊN ĐÚNG SỐ THỨ TỰ ──
    // Nhóm mẫu đã đọc (đệm của bước đọc chỉ-GET) ⇒ tên nhóm theo cài đặt thật.
    let reads = 0;
    const tplAd: TemplateAd = {
      adId: TEMPLATE_AD,
      campaignId: "7770001",
      accountId: "8880001",
      campaign: { objective: "OUTCOME_ENGAGEMENT", buyingType: "AUCTION", specialAdCategories: [], dailyBudgetMinor: null, lifetimeBudgetMinor: null },
      adset: { targeting: { ...TARGETING, genders: [2] }, optimizationGoal: "CONVERSATIONS", billingEvent: "IMPRESSIONS", bidStrategy: "COST_CAP", bidAmount: null, promotedObject: null, destinationType: null, attributionSpec: null },
      objectStorySpec: null,
      hasAssetFeed: false,
    };
    const reader = async () => {
      reads += 1;
      return tplAd;
    };
    await refreshNamingTemplate(db, cfgOf(), now, reader);
    await refreshNamingTemplate(db, cfgOf(), new Date(now.getTime() + 60_000), reader);
    assert.equal(reads, 1, "đệm cài đặt nhóm mẫu: không đọc Facebook lại trong hạn đệm");

    const cfgLo = cfgOf();
    const ngay = ddMm(targetDay);
    const p1 = await promoteManualGenImage(db, { imageId: ready[0].id, headline: a1.headline, primaryText: a1.primaryText, names: { campaign: `QUAN_TA_${ngay}_TEST_Phương Anh Fashion_1`, adset: "", ad: "" }, predictedSeq: 1 }, cfgLo, actor, farNow);
    assert.ok(p1.ok, p1.ok ? "" : p1.error);
    assert.equal(p1.batchDay, targetDay, "vào lô gần nhất còn hạn duyệt (cùng hàm với mẫu tự làm)");
    assert.equal(p1.slot, MANUAL_SLOT_BASE + 1, "dải ô của mẫu người đưa vào");
    assert.deepEqual(p1.names, { campaign: `QUAN_TA_${ngay}_TEST_Phương Anh Fashion_1`, adset: "MESS_VN_18-65+_Nữ_costcap", ad: "Phương Anh Fashion_ảnh_1_TXT" }, "ba tên theo khuôn, nhóm lấy từ cài đặt THẬT của nhóm mẫu");
    const [v1] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, p1.variantId));
    assert.equal(v1.mode, "MANUAL");
    assert.equal(v1.status, "GENERATED");
    assert.equal(v1.nameSeq, 1);
    assert.equal(v1.productPhotoSourceId, `${P}photo`);
    assert.equal(v1.inspirationSourceId, `${P}own`);
    assert.ok(parseGenes(v1.genes), "mẫu vào lô mang đủ sáu gen ⇒ máy học được");
    assert.equal(v1.imageId, a1.imageId, "dùng ĐÚNG ảnh đã duyệt, không lưu bản thứ hai");
    const [a1b] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, ready[0].id));
    assert.equal(a1b.status, "PROMOTED");
    assert.equal(a1b.variantId, v1.id);
    const lai = await promoteManualGenImage(db, { imageId: ready[0].id, headline: "a", primaryText: "b", names: { campaign: "", adset: "", ad: "" }, predictedSeq: null }, cfgLo, actor, farNow);
    assert.ok(!lai.ok, "một ảnh không vào lô hai lần");

    // Số thứ tự dự kiến đã CŨ (màn hình dựng với số 1) và người giữ nguyên tên mặc định ⇒ tên đi theo số THẬT.
    const p2 = await promoteManualGenImage(db, { imageId: ready[2].id, headline: "Tiêu đề 2", primaryText: "Nội dung 2", names: { campaign: `QUAN_TA_${ngay}_TEST_Phương Anh Fashion_1`, adset: "", ad: "Phương Anh Fashion_ảnh_1_TXT" }, predictedSeq: 1 }, cfgLo, actor, farNow);
    assert.ok(p2.ok && p2.nameSeq === 2);
    assert.equal(p2.ok && p2.names.campaign, `QUAN_TA_${ngay}_TEST_Phương Anh Fashion_2`, "không trùng số thứ tự trong ngày đăng");
    assert.equal(p2.ok && p2.names.ad, "Phương Anh Fashion_ảnh_2_TXT");
    // Người sửa tên ⇒ đúng chữ người gõ.
    const p3 = await promoteManualGenImage(db, { imageId: ready[3].id, headline: "", primaryText: "Nội dung 3", names: { campaign: "Chiến dịch tôi đặt", adset: "Nhóm tôi đặt", ad: "QC tôi đặt" }, predictedSeq: 3 }, cfgLo, actor, farNow);
    assert.ok(p3.ok);
    assert.deepEqual(p3.ok && p3.names, { campaign: "Chiến dịch tôi đặt", adset: "Nhóm tôi đặt", ad: "QC tôi đặt" });

    // Mẫu không có tên (vd lô dựng trước bản này) ⇒ lượt đặt tên điền theo khuôn, không đè tên người đã sửa.
    const [lo] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, targetDay));
    await db.update(schema.creativeVariants).set({ nameSeq: null, campaignName: "", adsetName: "", adName: "" }).where(eq(schema.creativeVariants.id, p1.variantId));
    const named = await assignBatchNames(db, lo.id, farNow);
    assert.equal(named.named, 1, "chỉ mẫu còn trống tên được đặt");
    const [v1n] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, p1.variantId));
    assert.equal(v1n.nameSeq, 4, "số thứ tự mới nối tiếp, không trùng số đã cấp");
    assert.equal(v1n.campaignName, `QUAN_TA_${ngay}_TEST_Phương Anh Fashion_4`);
    const [v3n] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, p3.ok ? p3.variantId : ""));
    assert.equal(v3n.campaignName, "Chiến dịch tôi đặt", "tên người đã sửa không bị đè");

    // ── (f) ĐĂNG CAMP — máy ghi Facebook GIẢ ──
    const fbCalls: string[] = [];
    const adsetTimes: { start: Date; end: Date; name: string }[] = [];
    let n = 0;
    const tplPub: TemplateAd = { ...tplAd, adset: { ...tplAd.adset, promotedObject: { page_id: `${P}page` } }, objectStorySpec: { page_id: `${P}page`, link_data: { link: "https://m.me/x", call_to_action: { type: "MESSAGE_PAGE" } } } };
    let templateFails = false;
    const fbGia: CreativeWriter = {
      readTemplateAd: async () => {
        fbCalls.push("readTemplateAd");
        if (templateFails) throw new Error("Facebook: lỗi giả khi đọc mẩu mẫu");
        return tplPub;
      },
      uploadAdImage: async () => (fbCalls.push("uploadAdImage"), `hash-${++n}`),
      createAdCreative: async () => (fbCalls.push("createAdCreative"), { id: `cr-${++n}`, effectiveObjectStoryId: `post-${n}` }),
      createTestCampaign: async () => (fbCalls.push("createTestCampaign"), `camp-${++n}`),
      createTestAdset: async (_a, i) => {
        fbCalls.push("createTestAdset");
        adsetTimes.push({ start: i.startTime, end: i.endTime, name: i.name });
        return `adset-${++n}`;
      },
      createAd: async () => (fbCalls.push("createAd"), `ad-${++n}`),
      activateTestCampaign: async () => {
        fbCalls.push("activateTestCampaign");
      },
      pauseAdset: async () => {
        fbCalls.push("pauseAdset");
      },
      extendAdset: async () => {
        fbCalls.push("extendAdset");
      },
    };
    const khongKeo = async () => ({ killed: false, source: "UNSET" as const, reason: null, by: null, at: null });
    const ON = { hardEnabled: true, mode: "COPILOT" as const };
    const cam = [ready[4], ready[5], ready[6]];
    for (const r of cam) await reviewManualGenImage(db, { imageId: r.id, decision: "APPROVE", reason: "" }, actor, now, { caption });
    const camInput = (imageId: string, scheduleAt: Date | null) => ({ imageId, headline: "Đầm đi biển", primaryText: "Nhắn shop để được tư vấn size.", names: { campaign: "", adset: "", ad: "" }, predictedSeq: null, scheduleAt });

    // (f1) Đường ghi tắt ⇒ không dựng lô, không gọi Facebook, ảnh vẫn "Đã duyệt".
    const t1 = new Date();
    const tat = await publishManualGenImageInstant(db, camInput(cam[0].id, null), cfgOf(), actor, t1, { writer: fbGia, env: { hardEnabled: false, mode: "COPILOT" }, killSwitch: khongKeo });
    assert.ok(!tat.ok && tat.error.includes("Chưa đăng được"), "cổng tắt ⇒ từ chối có lý do");
    assert.equal(fbCalls.length, 0, "cổng tắt ⇒ 0 lời gọi Facebook");
    assert.equal((await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.kind, "INSTANT"))).length, 0, "không để lại lô rỗng");
    const keo = await publishManualGenImageInstant(db, camInput(cam[0].id, null), cfgOf(), actor, t1, { writer: fbGia, env: ON, killSwitch: async () => ({ killed: true, source: "ENGAGED" as const, reason: "đang soát", by: null, at: null }) });
    assert.ok(!keo.ok && fbCalls.length === 0, "công tắc khẩn đang kéo ⇒ không đăng");

    // (f2) Hẹn giờ ⇒ lô INSTANT riêng, người bấm là lượt duyệt, nhóm mang start_time = giờ hẹn.
    const henLuc = new Date(t1.getTime() + 3 * 3_600_000);
    const c1 = await publishManualGenImageInstant(db, camInput(cam[0].id, henLuc), cfgOf(), actor, t1, { writer: fbGia, env: ON, killSwitch: khongKeo });
    assert.ok(c1.ok, c1.ok ? "" : c1.error);
    assert.equal(c1.ok && c1.outcome, "SCHEDULED", c1.ok ? c1.detail : "");
    const [bc1] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, c1.ok ? c1.batchId : ""));
    instantIds.push(bc1.id);
    assert.equal(bc1.kind, "INSTANT");
    assert.equal(bc1.status, "PUBLISHED");
    assert.equal(bc1.approvedByUserId, actor.id, "người bấm Đăng camp là người duyệt (khoá tài khoản — mục 34)");
    assert.ok(bc1.approvalDigest.length > 0);
    assert.equal(bc1.startAt.getTime(), henLuc.getTime());
    assert.deepEqual(fbCalls, ["readTemplateAd", "uploadAdImage", "createAdCreative", "createTestCampaign", "createTestAdset", "createAd", "activateTestCampaign"], "đi ĐÚNG sáu bước của đường đăng lô");
    assert.equal(adsetTimes[0].start.getTime(), henLuc.getTime(), "Facebook giữ lịch: start_time = giờ hẹn");
    assert.equal(adsetTimes[0].end.getTime(), henLuc.getTime() + 86_400_000, "end_time — Facebook tự dừng");
    const [vc1] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, c1.ok ? c1.variantId : ""));
    assert.equal(vc1.status, "LIVE");
    assert.equal(vc1.committedBudgetVnd, cfgOf().budgetPerVariantVnd);
    const [ic1] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, cam[0].id));
    assert.equal(ic1.status, "PROMOTED");
    const lai2 = await publishManualGenImageInstant(db, camInput(cam[0].id, null), cfgOf(), actor, t1, { writer: fbGia, env: ON, killSwitch: khongKeo });
    assert.ok(!lai2.ok, "một ảnh không đăng hai lần");

    // (f3) Chạy ngay ⇒ lô INSTANT THỨ HAI cùng ngày (chỉ mục duy nhất chỉ khoá lô hằng ngày), bắt đầu sau leadSeconds.
    fbCalls.length = 0;
    const t2 = new Date();
    const c2 = await publishManualGenImageInstant(db, camInput(cam[1].id, null), cfgOf(), actor, t2, { writer: fbGia, env: ON, killSwitch: khongKeo });
    assert.ok(c2.ok && c2.outcome === "LIVE", c2.ok ? c2.detail : c2.error);
    if (c2.ok) instantIds.push(c2.batchId);
    assert.equal(adsetTimes[1].start.getTime(), t2.getTime() + INSTANT_PUBLISH.leadSeconds * 1000, "chạy ngay = sau lúc bấm leadSeconds giây");
    assert.ok(c1.ok && c2.ok && c2.nameSeq > c1.nameSeq || (c1.ok && c2.ok && c1.batchDay !== c2.batchDay), "số thứ tự theo NGÀY — hai bài lẻ cùng ngày không trùng tên");

    // (f4) Hỏng khi CHƯA gửi gì lên Facebook ⇒ ảnh về "Đã duyệt", lô FAILED có lý do, bấm lại được.
    fbCalls.length = 0;
    templateFails = true;
    const c3 = await publishManualGenImageInstant(db, camInput(cam[2].id, null), cfgOf(), actor, new Date(), { writer: fbGia, env: ON, killSwitch: khongKeo });
    assert.ok(c3.ok && c3.outcome === "FAILED" && c3.detail.includes("Đã duyệt"), c3.ok ? c3.detail : c3.error);
    if (c3.ok) instantIds.push(c3.batchId);
    assert.deepEqual(fbCalls, ["readTemplateAd"], "chỉ lượt ĐỌC — không một lời gọi ghi nào");
    const [ic3] = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.id, cam[2].id));
    assert.equal(ic3.status, "APPROVED", "ảnh trả về 'Đã duyệt'");
    assert.equal(ic3.variantId, null);
    const [bc3] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, c3.ok ? c3.batchId : ""));
    assert.equal(bc3.status, "FAILED");
    templateFails = false;
    const c3b = await publishManualGenImageInstant(db, camInput(cam[2].id, null), cfgOf(), actor, new Date(), { writer: fbGia, env: ON, killSwitch: khongKeo });
    assert.ok(c3b.ok && c3b.outcome === "LIVE", "bấm lại sau khi sửa ⇒ đăng được");
    if (c3b.ok) instantIds.push(c3b.batchId);

    // ── (d) SỬA TÊN ⇒ DIGEST ĐỔI ⇒ PHIẾU CŨ VÔ HIỆU; lô đã duyệt thì không sửa được ──
    const dg0 = approvalDigest(await batchApprovalContent(db, lo));
    const ticket = batchTicket(actor.id, lo.id, dg0);
    const sua = await saveVariantNamesCore(db, { variantId: p1.variantId, campaignName: "Tên mới", adsetName: v1n.adsetName, adName: v1n.adName }, farNow);
    assert.ok(sua.ok && sua.changed);
    const dg1 = approvalDigest(await batchApprovalContent(db, lo));
    assert.notEqual(dg1, dg0, "tên nằm trong digest");
    assert.equal(verifyBatchTicket(ticket, actor.id, lo.id, dg1), false, "sửa tên sau khi mở hộp duyệt ⇒ phiếu cũ vô hiệu");

    // ── (c) TÍCH CHỌN: loại nhiều bài ⇒ ra khỏi digest; giữ ⇒ khôi phục + loại phần còn lại ──
    const bai = [p1.variantId, p2.ok ? p2.variantId : "", p3.ok ? p3.variantId : ""];
    const loai = await applyVariantSelectionCore(db, { batchId: lo.id, variantIds: [bai[0], bai[1]], mode: "REJECT_SELECTED", reason: "không ưng" }, { id: actor.id }, farNow);
    assert.ok(loai.ok && loai.rejected.length === 2 && loai.kept === 1);
    const noiDung = await batchApprovalContent(db, lo);
    assert.deepEqual(noiDung.variants.map((v) => v.id), [bai[2]], "bài bị loại KHÔNG còn trong phiếu duyệt ⇒ không đăng, không tiêu tiền");
    const giu = await applyVariantSelectionCore(db, { batchId: lo.id, variantIds: [bai[0]], mode: "KEEP_SELECTED", reason: "" }, { id: actor.id }, farNow);
    assert.ok(giu.ok && giu.restored.length === 1 && giu.rejected.length === 1 && giu.kept === 1);
    assert.deepEqual((await batchApprovalContent(db, lo)).variants.map((v) => v.id), [bai[0]], "giữ ⇒ đúng tập bài đã chọn nằm trong digest");
    const khacLo = await applyVariantSelectionCore(db, { batchId: lo.id, variantIds: ["khong-co"], mode: "REJECT_SELECTED", reason: "" }, { id: actor.id }, farNow);
    assert.ok(!khacLo.ok, "bài không thuộc lô bị từ chối");

    // Lô đã duyệt ⇒ không sửa tên, không chọn / loại được nữa.
    await db.update(schema.creativeBatches).set({ status: "APPROVED", approvedAt: farNow, approvalDigest: approvalDigest(await batchApprovalContent(db, lo)) }).where(eq(schema.creativeBatches.id, lo.id));
    const sauDuyet = await saveVariantNamesCore(db, { variantId: p1.variantId, campaignName: "Đổi sau duyệt", adsetName: "", adName: "" }, farNow);
    assert.ok(!sauDuyet.ok, "lô đã duyệt ⇒ không sửa tên được");
    const chonSauDuyet = await applyVariantSelectionCore(db, { batchId: lo.id, variantIds: [bai[0]], mode: "REJECT_SELECTED", reason: "" }, { id: actor.id }, farNow);
    assert.ok(!chonSauDuyet.ok);

    // ── (e) LƯỢT VÒNG MẪU VẼ NỐT ảnh gen tay còn chờ ──
    costEach = unit;
    const s4 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "", count: 3 }, cfgKhongTran, actor);
    assert.ok(s4.ok && s4.requested === 3);
    const before5 = imageCalls;
    const fb = new Proxy({} as CreativeWriter, {
      get: () => async () => {
        throw new Error("không gọi Facebook trong kiểm thử");
      },
    });
    const tick = await runCreativeLoopTick(db, new Date(), { notify: async () => undefined, write: { writer: fb, env: { hardEnabled: false, mode: "OFF" } }, evaluate: { writeNarrative: null }, namingReader: null, manualGen: { imageClient, genId: s4.ok ? s4.genId : "" } });
    assert.equal(tick.manualGen?.drawn, 3, "lượt vòng mẫu vẽ nốt ảnh gen tay");
    assert.equal(imageCalls - before5, 3);
  } finally {
    await cleanup(db, [targetDay], instantIds);
    if (prevTpl) await db.update(schema.settings).set({ value: prevTpl.value }).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY));
  }
  console.log("  ✓ Gen tay (PGlite, máy vẽ giả): nguồn spy / mã khác bị chặn · 10 ảnh mặc định, không còn trần · sổ chi ảnh của lô không đếm gen tay · số ảnh người chọn + ảnh tải lên đi kèm ảnh thật · Đăng camp: cổng tắt không ghi gì, hẹn giờ / chạy ngay thành lô INSTANT riêng, hỏng khi chưa gửi thì ảnh về Đã duyệt · ảnh đứt không vẽ lại · duyệt ⇒ câu chữ theo ảnh · vào lô đúng ngày, tên đúng số thứ tự · tích loại / giữ đổi digest · sửa tên ⇒ phiếu vô hiệu · vòng mẫu vẽ nốt");
}
