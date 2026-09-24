import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_HARD_LIMITS, DEFAULT_CREATIVE_CONFIG, MANUAL_GEN, MANUAL_SLOT_BASE, NAMING_TEMPLATE_KEY, estimateImageUsd, parseGenes, type CreativeLoopConfig } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { approvalDigest, batchTicket, verifyBatchTicket } from "@/lib/creative/approval";
import type { VariantCaptioner } from "@/lib/creative/caption";
import { imageSpendToday, reservedImageSpend } from "@/lib/creative/generate";
import { storeCreativeImage } from "@/lib/creative/images";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import { manualTargetDay } from "@/lib/creative/manual";
import { drawManualGen, manualGenCapacity, manualGenGenes, manualGenPrompt, pickName, promoteManualGenImage, reviewManualGenImage, startManualGen } from "@/lib/creative/manual-gen";
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
 *  (a) HÀM THUẦN: 10 bộ gen đủ sáu khoá, khác nhau, tất định · câu lệnh · trần ảnh · ba khuôn tên (kể cả mã
 *      lạ, thiếu tên TKQC) · chọn tên khi số thứ tự dự kiến đã cũ · kế hoạch chọn bài · trường tạo chiến dịch.
 *  (b) GEN TAY trên PGlite với máy vẽ GIẢ (0 lời gọi mạng): nguồn không an toàn bị chặn · 10 ảnh / lần ·
 *      vượt trần chi ảnh ⇒ vẽ được bao nhiêu báo bấy nhiêu · trần đếm CHUNG sổ với lô · ảnh "đang vẽ" quá hạn
 *      không vẽ lại · duyệt ⇒ viết câu chữ theo ảnh · loại · vào lô đúng ngày với tên đúng số thứ tự.
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

  // ── Trần ảnh (thuần) ──
  const base = { want: 10, spentImages: 0, spentUsd: 0, reservedImages: 0, reservedUsd: 0, unitUsd: 0.1, capUsd: 2, maxImages: CREATIVE_HARD_LIMITS.maxImagesPerDay };
  assert.deepEqual(manualGenCapacity(base), { allowed: 10, reason: null });
  const usd = manualGenCapacity({ ...base, spentUsd: 1.65 });
  assert.equal(usd.allowed, 3, "còn 0,35 USD ÷ 0,1 = 3 ảnh");
  assert.match(usd.reason ?? "", /USD/);
  const dem = manualGenCapacity({ ...base, spentImages: CREATIVE_HARD_LIMITS.maxImagesPerDay - 4 });
  assert.equal(dem.allowed, 4);
  assert.match(dem.reason ?? "", /ảnh sinh \/ ngày/);
  assert.equal(manualGenCapacity({ ...base, spentUsd: 2 }).allowed, 0, "hết trần ⇒ 0, không âm");
  assert.equal(manualGenCapacity({ ...base, reservedUsd: 1.95 }).allowed, 0, "phần đang giữ chỗ (Batch / đang vẽ) cũng tính");

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

  console.log("  ✓ Gen tay (thuần): 10 bộ gen đủ sáu khoá, khác nhau · trần ảnh USD / số ảnh / giữ chỗ · ba khuôn tên (mã lạ in nguyên, thiếu TKQC để trống + nói ra) · chọn bài · chiến dịch riêng tạo TẮT, CBO bị từ chối");
}

// ═══════════════════════════ PGLITE ═══════════════════════════

const TEMPLATE_AD = "9990001";

function cfgOf(over: Partial<CreativeLoopConfig> = {}): CreativeLoopConfig {
  return { ...DEFAULT_CREATIVE_CONFIG, enabled: false, pageId: `${P}page`, adAccountId: "8880001", testCampaignId: "7770001", templateAdId: TEMPLATE_AD, imageModel: "gpt-image-2", imageQuality: "low", imageSize: "1024x1024", ...over };
}

async function cleanup(db: Db, days: string[]) {
  const gens = await db.select({ id: schema.creativeManualGens.id }).from(schema.creativeManualGens).where(like(schema.creativeManualGens.createdByName, `${P}%`));
  const genIds = gens.map((g) => g.id);
  if (genIds.length) {
    await db.delete(schema.creativeManualGenImages).where(inArray(schema.creativeManualGenImages.genId, genIds));
    await db.delete(schema.creativeManualGens).where(inArray(schema.creativeManualGens.id, genIds));
  }
  const batches = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(inArray(schema.creativeBatches.batchDay, days));
  const ids = batches.map((b) => b.id);
  if (ids.length) {
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
    const spy = await startManualGen(db, { productPhotoSourceId: `${P}spy`, ownAdSourceId: null, idea: "" }, cfg0, actor, now);
    assert.ok(!spy.ok && spy.error.includes("ẢNH SẢN PHẨM THẬT"), "ảnh spy không làm gốc được");
    const lech = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}own-khac`, idea: "" }, cfg0, actor, now);
    assert.ok(!lech.ok && lech.error.includes("ĐÚNG mã"), "quảng cáo cũ của MÃ KHÁC bị chặn");
    const spyRef = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}spy`, idea: "" }, cfg0, actor, now);
    assert.ok(!spyRef.ok, "ảnh spy không làm tham chiếu được");

    // ── (b2) 10 ẢNH MỖI LẦN BẤM — trần đủ ⇒ đủ 10 ──
    const unit = estimateImageUsd(cfg0.imageModel, cfg0.imageQuality, cfg0.imageSize);
    const baseline = async () => {
      const [s, r] = await Promise.all([imageSpendToday(db, new Date(), unit), reservedImageSpend(db, new Date())]);
      return { images: s.images + r.images, usd: s.usd + r.usd };
    };
    const b0 = await baseline();
    assert.ok(b0.images + MANUAL_GEN.imagesPerRun <= CREATIVE_HARD_LIMITS.maxImagesPerDay && b0.usd + 10.5 * unit <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, `tiền đề: sổ chi ảnh hôm nay còn chỗ cho 10 ảnh (đang ${b0.images} ảnh, ${b0.usd} USD)`);
    const cfgDu = cfgOf({ imageDailyCapUsd: Math.min(CREATIVE_HARD_LIMITS.maxImageUsdPerDay, b0.usd + 10.5 * unit) });
    costEach = unit;
    const s1 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: `${P}own`, idea: "đi biển Đà Nẵng" }, cfgDu, actor, now);
    assert.ok(s1.ok && s1.allowed === MANUAL_GEN.imagesPerRun && s1.requested === MANUAL_GEN.imagesPerRun, "trần đủ ⇒ xin đủ 10 ảnh");
    const rows1 = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s1.genId));
    assert.equal(rows1.length, 10);
    assert.ok(rows1.every((r) => r.status === "PLANNED" && r.prompt.includes("đi biển Đà Nẵng")));
    assert.equal(imageCalls, 0, "bấm Gen KHÔNG gọi máy vẽ — việc vẽ chạy sau phản hồi");

    const d1 = await drawManualGen(db, { genId: s1.genId, imageClient, config: cfgDu });
    assert.equal(d1.drawn, 10, "vẽ đủ 10 ảnh");
    assert.equal(imageCalls, 10);
    assert.ok(seen.every((k) => k[0] === "PRODUCT_PHOTO" && k.includes("OWN_VARIANT")), "máy vẽ nhận ảnh sản phẩm thật + quảng cáo cũ CÙNG mã (qua gatherPixels)");
    const after1 = await baseline();
    assert.equal(after1.images - b0.images, 10, "10 ảnh gen tay vào CÙNG sổ chi ảnh / ngày với lô");
    assert.ok(Math.abs(after1.usd - b0.usd - 10 * unit) < 1e-6, "chi phí ghi theo giá máy vẽ trả về");
    // Chạy lại: không ảnh nào vẽ hai lần.
    assert.equal((await drawManualGen(db, { genId: s1.genId, imageClient, config: cfgDu })).drawn, 0);

    // ── (b3) VƯỢT TRẦN: lúc bấm còn 3 ảnh; giữa chừng giá thật đắt gấp đôi ⇒ vẽ được 2, báo đúng ──
    const b1 = await baseline();
    const cfgHep = cfgOf({ imageDailyCapUsd: b1.usd + 3.5 * unit });
    const s2 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "" }, cfgHep, actor, now);
    assert.ok(s2.ok && s2.allowed === 3 && (s2.reason ?? "").includes("USD"), `vượt trần ⇒ chỉ xin 3/10, có lý do (nhận ${s2.ok ? s2.allowed : "lỗi"})`);
    const rows2 = await db.select().from(schema.creativeManualGenImages).where(eq(schema.creativeManualGenImages.genId, s2.ok ? s2.genId : ""));
    assert.equal(rows2.filter((r) => r.status === "GEN_FAILED" && r.error.includes("USD")).length, 7, "7 ảnh vượt trần ghi lỗi kèm lý do ngay lúc bấm");
    costEach = 2 * unit;
    const before2 = imageCalls;
    const d2 = await drawManualGen(db, { genId: s2.ok ? s2.genId : "", imageClient, config: cfgHep });
    assert.equal(imageCalls - before2, 2, "giá thật đắt hơn ước tính ⇒ ảnh thứ ba bị chặn TRƯỚC khi gọi máy vẽ");
    assert.equal(d2.drawn, 2);
    assert.equal(d2.capped, 1);
    // Hết trần hẳn ⇒ bấm Gen bị từ chối có lý do, không ghi lượt nào.
    const s3 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "" }, cfgHep, actor, now);
    assert.ok(!s3.ok && s3.error.includes("USD"), "hết trần ⇒ từ chối có lý do");

    // ── (b4) Ảnh "đang vẽ" quá hạn ⇒ lỗi, KHÔNG vẽ lại ──
    const [treo] = rows1;
    await db
      .update(schema.creativeManualGenImages)
      .set({ status: "DRAWING", claimedAt: new Date(now.getTime() - (MANUAL_GEN.staleDrawMinutes + 5) * 60_000) })
      .where(eq(schema.creativeManualGenImages.id, treo.id));
    const before4 = imageCalls;
    const d4 = await drawManualGen(db, { genId: s1.genId, imageClient, config: cfgDu });
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
    const b2 = await baseline();
    const cfgTick = cfgOf({ imageDailyCapUsd: Math.min(CREATIVE_HARD_LIMITS.maxImageUsdPerDay, b2.usd + 3.5 * unit) });
    costEach = unit;
    const s4 = await startManualGen(db, { productPhotoSourceId: `${P}photo`, ownAdSourceId: null, idea: "" }, cfgTick, actor, new Date());
    assert.ok(s4.ok && s4.allowed === 3);
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
    await cleanup(db, [targetDay]);
    if (prevTpl) await db.update(schema.settings).set({ value: prevTpl.value }).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, NAMING_TEMPLATE_KEY));
  }
  console.log("  ✓ Gen tay (PGlite, máy vẽ giả): nguồn spy / mã khác bị chặn · 10 ảnh mỗi lần bấm · vượt trần ⇒ vẽ được bao nhiêu báo bấy nhiêu · sổ chi ảnh CHUNG với lô · ảnh đứt không vẽ lại · duyệt ⇒ câu chữ theo ảnh · vào lô đúng ngày, tên đúng số thứ tự · tích loại / giữ đổi digest · sửa tên ⇒ phiếu vô hiệu · vòng mẫu vẽ nốt");
}
