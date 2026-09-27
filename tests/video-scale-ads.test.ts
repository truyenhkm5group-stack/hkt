import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY } from "@/lib/constants/creative-loop";
import { VIDEO_AUTOMATION_KEY, VIDEO_SCALE_CONFIG_KEY, gateVideoAd, normalizeVideoScaleConfig, videoAdNames, type VideoAdGateInput } from "@/lib/constants/video-scale";
import type { TemplateAd } from "@/lib/integrations/facebook/ads-write";
import { adsetForPage, buildVideoStorySpec, signedAssetUrl, verifyAssetSignature } from "@/lib/video-scale/ad-spec";
import { activateVideoAd, planVideoAd, queuePauseAds, setVideoAdBudget, type AdsApi, type AdsDeps } from "@/lib/video-scale/ads";
import { runVideoScaleTick, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — QUẢNG CÁO META + HẠN MỨC (PR 3) ═══════════
 *
 * Thuần: cổng `gateVideoAd` (bảng chân lý + THỨ TỰ chốt; tắt luôn được) · tên chiến dịch mang mã, không TEST · bài quảng
 * cáo video chép nút kêu gọi của mẩu mẫu, không đoán · link ký tên hết hạn / sai chữ ký ⇒ từ chối.
 *
 * CSDL (cửa Facebook GIẢ): dựng TẮT rồi mới bật · bật chịu trần mã / toàn module · tăng ngân sách ≤ 30% và một lần / ngày ·
 * dấu "đang gửi" bước chiến dịch không gửi lại · dừng khẩn cấp theo mã tắt quảng cáo đang chạy · không luật tắt ⇒ không bật ·
 * mọi lượt vào sổ, kể cả lượt bị chặn.
 */

const P = "vsa-test-";
const PAGE = "920000000000001";
const ACC = "730000000000001";

function base(over: Partial<VideoAdGateInput> = {}): VideoAdGateInput {
  return {
    action: "ACTIVATE",
    writeClosed: null,
    automationPaused: false,
    skuPaused: false,
    pagePaused: false,
    variant: { approved: true, isTest: false, qcFailed: false },
    reelPublished: true,
    mappingOk: true,
    adAccountId: ACC,
    templateAdId: "120000000000001",
    killRules: 2,
    onFacebook: true,
    budgetVnd: 100_000,
    currentBudgetVnd: 100_000,
    budgetChangesToday: 0,
    caps: { perAdVnd: 200_000, skuVnd: 300_000, globalVnd: 1_000_000 },
    activeSkuVnd: 0,
    activeGlobalVnd: 0,
    ...over,
  };
}

export function testVideoScaleAdsPure() {
  assert.deepEqual(gateVideoAd(base()), { allow: true });
  const truth: [string, Partial<VideoAdGateInput>, string][] = [
    ["đường ghi đóng", { writeClosed: "ADS_WRITE_ENABLED tắt" }, "WRITE_CLOSED"],
    ["dừng toàn module", { automationPaused: true }, "AUTOMATION_PAUSED"],
    ["dừng mã", { skuPaused: true }, "SKU_PAUSED"],
    ["dừng fanpage", { pagePaused: true }, "PAGE_PAUSED"],
    ["dữ liệu thử", { variant: { approved: true, isTest: true, qcFailed: false } }, "TEST_DATA"],
    ["chưa duyệt", { variant: { approved: false, isTest: false, qcFailed: false } }, "NOT_APPROVED"],
    ["QC loại", { variant: { approved: true, isTest: false, qcFailed: true } }, "QC_FAILED"],
    ["Reel chưa đăng", { reelPublished: false }, "REEL_NOT_PUBLISHED"],
    ["đổi fanpage", { mappingOk: false }, "MAPPING_CHANGED"],
    ["chưa gán tài khoản", { adAccountId: null }, "NO_AD_ACCOUNT"],
    ["chưa khai mẩu mẫu", { templateAdId: null }, "NO_TEMPLATE"],
    ["chưa dựng", { onFacebook: false }, "NOT_ON_FACEBOOK"],
    ["không luật tắt", { killRules: 0 }, "NO_KILL_RULES"],
    ["chưa khai trần mã", { caps: { perAdVnd: 200_000, skuVnd: null, globalVnd: 1_000_000 } }, "NO_BUDGET"],
    ["chưa khai trần toàn module", { caps: { perAdVnd: 200_000, skuVnd: 300_000, globalVnd: null } }, "NO_BUDGET"],
    ["dưới sàn", { budgetVnd: 10_000 }, "BELOW_MIN_BUDGET"],
    ["vượt trần mỗi quảng cáo (cấu hình)", { budgetVnd: 250_000 }, "OVER_AD_CAP"],
    ["vượt trần cứng mỗi quảng cáo", { budgetVnd: 600_000, caps: { perAdVnd: 900_000, skuVnd: 2_000_000, globalVnd: 5_000_000 } }, "OVER_AD_CAP"],
    ["vượt trần mã", { activeSkuVnd: 250_000 }, "OVER_SKU_CAP"],
    ["vượt trần toàn module", { activeGlobalVnd: 950_000 }, "OVER_GLOBAL_CAP"],
  ];
  for (const [name, over, denial] of truth) {
    const g = gateVideoAd(base(over));
    assert.ok(!g.allow && g.denial === denial, `${name}: phải chặn ${denial}, thấy ${JSON.stringify(g)}`);
  }
  // Thứ tự chốt: đường ghi đóng đứng TRƯỚC mọi thứ khác.
  const many = gateVideoAd(base({ writeClosed: "x", automationPaused: true, killRules: 0, activeSkuVnd: 999_999 }));
  assert.ok(!many.allow && many.denial === "WRITE_CLOSED");
  // Tắt LUÔN được — kể cả khi mọi công tắc đang kéo.
  assert.deepEqual(gateVideoAd(base({ action: "PAUSE", writeClosed: "x", automationPaused: true, skuPaused: true, killRules: 0 })), { allow: true });
  // Dựng (TẮT) không cần luật tắt / ngân sách — chưa tiêu gì.
  assert.deepEqual(gateVideoAd(base({ action: "CREATE", killRules: 0, onFacebook: false, caps: { perAdVnd: null, skuVnd: null, globalVnd: null } })), { allow: true });
  // Đổi ngân sách: +30% tối đa, một lần / ngày, phải đọc được ngân sách hiện tại.
  assert.deepEqual(gateVideoAd(base({ action: "SET_BUDGET", currentBudgetVnd: 100_000, budgetVnd: 130_000 })), { allow: true });
  const step = gateVideoAd(base({ action: "SET_BUDGET", currentBudgetVnd: 100_000, budgetVnd: 140_000 }));
  assert.ok(!step.allow && step.denial === "STEP_TOO_BIG");
  const twice = gateVideoAd(base({ action: "SET_BUDGET", budgetChangesToday: 1, budgetVnd: 110_000 }));
  assert.ok(!twice.allow && twice.denial === "RATE_LIMIT");
  const unread = gateVideoAd(base({ action: "SET_BUDGET", currentBudgetVnd: null, budgetVnd: 110_000 }));
  assert.ok(!unread.allow && unread.denial === "STEP_TOO_BIG", "không đọc được ngân sách hiện tại ⇒ không đổi");

  const names = videoAdNames({ code: "Q005", day: "2026-09-27", pageLabel: "Hải An Fashion", seq: 2, angle: "OCCASION" });
  assert.ok(names.campaign.startsWith("VS_Q005_260927_HaiAnFashion_V2"), names.campaign);
  assert.ok(!/test/i.test(names.campaign + names.adset + names.ad), "tên không mang chữ TEST (TEST = chi phí test, không quy về mã)");

  const cfg = normalizeVideoScaleConfig({ adsGlobalDailyCapVnd: 99_000_000, adTemplateAdId: "abc" });
  assert.equal(cfg.adsGlobalDailyCapVnd, 5_000_000, "trần toàn module kẹp vào trần cứng");
  assert.equal(cfg.adTemplateAdId, "", "id mẩu mẫu không phải số ⇒ bỏ");
  assert.equal(normalizeVideoScaleConfig({ adsGlobalDailyCapVnd: 0 }).adsGlobalDailyCapVnd, null, "0 ⇒ CHƯA KHAI");

  // Bài quảng cáo video: chép nút kêu gọi của mẩu mẫu; fanpage khác ⇒ bỏ Instagram của fanpage kia.
  const tpl: Pick<TemplateAd, "objectStorySpec" | "assetFeedSpec"> = {
    objectStorySpec: { page_id: "999", instagram_user_id: "ig1", link_data: { link: "https://fb.com/messenger_doc/", message: "cũ", image_hash: "h", call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }, page_welcome_message: { type: "VISUAL_EDITOR" } } },
    assetFeedSpec: null,
  };
  const spec = buildVideoStorySpec(tpl, { pageId: PAGE, videoId: "v1", imageHash: "ih", message: "Đầm xinh", title: "Đầm" });
  assert.ok(spec.ok);
  if (spec.ok) {
    const vd = spec.spec.video_data as Record<string, unknown>;
    assert.equal(spec.spec.page_id, PAGE, "fanpage đứng tên = fanpage được duyệt của mã");
    assert.equal(spec.spec.instagram_user_id, undefined, "fanpage khác mẩu mẫu ⇒ bỏ Instagram của fanpage kia");
    assert.equal(spec.spec.link_data, undefined, "bài cũ của mẩu mẫu không đi theo");
    assert.deepEqual(vd.call_to_action, { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } });
    assert.equal(vd.video_id, "v1");
    assert.ok(vd.page_welcome_message, "lời chào tin nhắn của mẩu mẫu được chép");
  }
  assert.ok(!buildVideoStorySpec({ objectStorySpec: { page_id: PAGE, link_data: { link: "x" } }, assetFeedSpec: null }, { pageId: PAGE, videoId: "v", imageHash: "i", message: "m", title: "" }).ok, "mẩu mẫu không có nút ⇒ không đoán");
  assert.ok(!buildVideoStorySpec({ objectStorySpec: {}, assetFeedSpec: { call_to_action_types: ["SHOP_NOW", "LEARN_MORE"] } }, { pageId: PAGE, videoId: "v", imageHash: "i", message: "m", title: "" }).ok, "hai nút kêu gọi ⇒ không chọn thay người");
  assert.equal(adsetForPage({ targeting: {}, optimizationGoal: "X", billingEvent: "Y", bidStrategy: null, bidAmount: null, promotedObject: { page_id: "999" }, destinationType: null, attributionSpec: null }, PAGE).promotedObject?.page_id, PAGE, "tin nhắn về fanpage của mã");

  // Link ký tên.
  const now = new Date("2026-09-27T10:00:00Z");
  const url = new URL(signedAssetUrl("https://erp.example.vn", "khoa-bi-mat", "tep-1", now));
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  assert.ok(verifyAssetSignature("khoa-bi-mat", "tep-1", exp, sig, now));
  assert.ok(!verifyAssetSignature("khoa-bi-mat", "tep-2", exp, sig, now), "chữ ký gắn với đúng tệp");
  assert.ok(!verifyAssetSignature("khoa-khac", "tep-1", exp, sig, now), "sai khoá ⇒ từ chối");
  assert.ok(!verifyAssetSignature("khoa-bi-mat", "tep-1", exp, sig, new Date(now.getTime() + 2 * 3_600_000)), "hết hạn ⇒ từ chối");
  const far = String(Math.floor(now.getTime() / 1000) + 10 * 3600);
  assert.ok(!verifyAssetSignature("khoa-bi-mat", "tep-1", far, sig, now), "hạn xa quá 2 giờ ⇒ từ chối");

  console.log("✓ Video Scale quảng cáo (thuần): cổng 20 ca + thứ tự chốt · tắt luôn được · +30%/1 lần ngày · tên mang mã không TEST · bài video chép nút mẩu mẫu · link ký tên");
}

// ───────────────────────────── CSDL ─────────────────────────────

type Calls = { campaigns: number; adsets: number; ads: number; activates: string[]; pauses: string[]; budgets: number[]; videoPolls: number; uploads: number };

function fakeAds(c: Calls): AdsApi {
  const template: TemplateAd = {
    adId: "120000000000001",
    campaignId: "1",
    accountId: ACC,
    campaign: { objective: "OUTCOME_ENGAGEMENT", buyingType: "AUCTION", specialAdCategories: [], dailyBudgetMinor: null, lifetimeBudgetMinor: null },
    adset: { targeting: { geo_locations: { countries: ["VN"] } }, optimizationGoal: "CONVERSATIONS", billingEvent: "IMPRESSIONS", bidStrategy: null, bidAmount: null, promotedObject: { page_id: "999" }, destinationType: "MESSENGER", attributionSpec: null },
    objectStorySpec: { page_id: "999", link_data: { link: "https://fb.com/messenger_doc/", call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } } } },
    hasAssetFeed: false,
    assetFeedSpec: null,
  };
  let budget = 100_000;
  return {
    readTemplate: async () => template,
    currency: async () => "VND",
    uploadVideo: async () => {
      c.uploads += 1;
      return "5550001";
    },
    videoStatus: async () => {
      c.videoPolls += 1;
      return { status: c.videoPolls > 1 ? "ready" : "processing", error: null };
    },
    uploadImage: async () => "hash1",
    createCreative: async () => ({ id: "6660001" }),
    createCampaign: async () => {
      c.campaigns += 1;
      return `77700${c.campaigns}`;
    },
    createAdset: async (_a, i) => {
      c.adsets += 1;
      budget = i.dailyBudgetMinor;
      return `88800${c.adsets}`;
    },
    createAd: async () => {
      c.ads += 1;
      return `99900${c.ads}`;
    },
    activate: async (id) => void c.activates.push(id),
    pause: async (id) => void c.pauses.push(id),
    setBudget: async (_id, minor) => {
      c.budgets.push(minor);
      budget = minor;
    },
    readAdset: async () => ({ dailyBudgetVnd: budget, status: "ACTIVE", effectiveStatus: "ACTIVE" }),
  };
}

async function cleanup(db: Db) {
  const vs = await db.select({ id: schema.videoScaleVariants.id, runId: schema.videoScaleVariants.runId }).from(schema.videoScaleVariants).where(like(schema.videoScaleVariants.productId, `${P}%`));
  const vIds = vs.map((v) => v.id);
  if (vIds.length) {
    const ads = await db.select({ id: schema.videoScaleAds.id }).from(schema.videoScaleAds).where(inArray(schema.videoScaleAds.variantId, vIds));
    if (ads.length) await db.delete(schema.videoScaleAdActions).where(inArray(schema.videoScaleAdActions.adId, ads.map((a) => a.id)));
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.variantId, vIds));
    await db.delete(schema.videoScaleAds).where(inArray(schema.videoScaleAds.variantId, vIds));
    await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.id, vIds));
  }
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  if (runs.length) {
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, runs.map((r) => r.id)));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, runs.map((r) => r.id)));
  }
  await db.delete(schema.videoScaleSkus).where(like(schema.videoScaleSkus.productId, `${P}%`));
  await db.delete(schema.fanpages).where(eq(schema.fanpages.externalPageId, PAGE));
  await db.delete(schema.productModels).where(like(schema.productModels.code, "VSATEST%"));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function publishedVariant(db: Db, runId: string, seq: number, userId: string): Promise<string> {
  const final = await storeAsset(db, { kind: "FINAL", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, seq]), contentType: "video/mp4", runId });
  const thumb = await storeAsset(db, { kind: "THUMBNAIL", bytes: new Uint8Array([0xff, 0xd8, 0xff, seq]), contentType: "image/jpeg", runId });
  const [v] = await db
    .insert(schema.videoScaleVariants)
    .values({ runId, productId: `${P}prod`, seq, angle: "OCCASION", angleVocabVersion: 1, script: { angle: "OCCASION", hook: "h", scenes: [], cta: "c" }, sourceId: "x", status: "APPROVED", qcVerdict: "PASS", finalAssetId: final.id, thumbnailAssetId: thumb.id, durationMs: 16_000, reviewedAt: new Date(), reviewedByUserId: userId })
    .returning({ id: schema.videoScaleVariants.id });
  await db.insert(schema.videoScalePosts).values({ variantId: v.id, productId: `${P}prod`, pageId: PAGE, status: "PUBLISHED", caption: "Đầm xinh — nhắn shop", fbVideoId: `55${seq}`, publishedAt: new Date() });
  return v.id;
}

export async function testVideoScaleAdsDb(db: Db) {
  const keys = [VIDEO_SCALE_CONFIG_KEY, CREATIVE_CONFIG_KEY, VIDEO_AUTOMATION_KEY];
  const prev = await db.select().from(schema.settings).where(inArray(schema.settings.key, keys));
  await cleanup(db);
  const setSetting = (key: string, value: unknown) => db.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
  try {
    await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY));
    await setSetting(VIDEO_SCALE_CONFIG_KEY, { enabled: true, dailyUsdCap: 5, adsGlobalDailyCapVnd: 150_000, adTemplateAdId: "120000000000001" });
    await setSetting(CREATIVE_CONFIG_KEY, { killRules: [{ metric: "ctr", op: "lt", value: 0.005, minSpendVnd: 100_000, label: "CTR thấp" }] });
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người chi tiền", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Người chi tiền" };
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm thử quảng cáo", customId: "Q777" });
    await db.insert(schema.productModels).values({ code: "VSATEST1", productId: `${P}prod`, lifecycleState: "WINNER", registeredBy: "USER" });
    await db.insert(schema.fanpages).values({ externalPageId: PAGE, name: "Page QC thử" });
    const [run] = await db.insert(schema.videoScaleRuns).values({ productId: `${P}prod`, sourceIds: ["x"], status: "DONE", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 3, configSnapshot: {} }).returning({ id: schema.videoScaleRuns.id });
    const v1 = await publishedVariant(db, run.id, 1, actor.id);
    const v2 = await publishedVariant(db, run.id, 2, actor.id);
    await db.insert(schema.videoScaleSkus).values({ productId: `${P}prod`, pageId: PAGE, adAccountId: ACC, adsMode: "PUBLISH_PAUSED", dailyBudgetPerAdVnd: 100_000, skuDailyCapVnd: 150_000, adsModeByUserId: actor.id, adsModeBy: actor.label });

    const calls: Calls = { campaigns: 0, adsets: 0, ads: 0, activates: [], pauses: [], budgets: [], videoPolls: 0, uploads: 0 };
    const adsDeps: AdsDeps = { ads: fakeAds(calls), adsWriteClosed: () => null, signUrl: (id) => `https://erp.example.vn/api/video-scale/public/${id}?exp=1&sig=x` };
    const deps: VideoScaleDeps = { adsDeps };
    const cfg = normalizeVideoScaleConfig({ enabled: true, adsGlobalDailyCapVnd: 150_000, adTemplateAdId: "120000000000001" });
    const tick = async () => {
      await db.update(schema.videoScaleJobs).set({ nextRunAt: new Date(Date.now() - 1000) }).where(inArray(schema.videoScaleJobs.status, ["QUEUED", "WAITING"]));
      await runVideoScaleTick(db, { deps, budgetMs: 20_000 });
    };

    // Chế độ "dựng, TẮT": dựng đủ ba cấp, KHÔNG bật.
    const p1 = await planVideoAd(db, v1, cfg, null);
    assert.ok(p1.adId, p1.note);
    for (let i = 0; i < 3; i += 1) await tick();
    let [a1] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, p1.adId as string));
    assert.equal(a1.status, "PAUSED", `dựng xong phải TẮT: ${a1.status} ${a1.error}`);
    assert.equal(calls.campaigns + calls.adsets + calls.ads, 3);
    assert.equal(calls.activates.length, 0, "PUBLISH_PAUSED không bao giờ tự bật");
    assert.ok(a1.campaignName.includes("Q777") || a1.campaignName.includes("VSATEST1"), "tên chiến dịch mang mã");
    assert.ok((await planVideoAd(db, v1, cfg, null)).adId === null, "một video một quảng cáo / tài khoản");

    // Người bật ⇒ chạy; sổ ghi APPLIED.
    const act = await activateVideoAd(db, a1.id, actor, cfg, adsDeps);
    assert.ok(act.ok, act.ok ? "" : act.error);
    [a1] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, a1.id));
    assert.equal(a1.status, "ACTIVE");

    // Tự bật (AUTO_LAUNCH) cho video 2: trần MÃ 150.000 < 100.000 đang chạy + 100.000 ⇒ dựng nhưng KHÔNG bật, sổ ghi bị chặn.
    await db.update(schema.videoScaleSkus).set({ adsMode: "AUTO_LAUNCH" }).where(eq(schema.videoScaleSkus.productId, `${P}prod`));
    const p2 = await planVideoAd(db, v2, cfg, null);
    for (let i = 0; i < 3; i += 1) await tick();
    const [a2] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, p2.adId as string));
    assert.equal(a2.status, "PAUSED", "vượt trần mã ⇒ dựng xong vẫn TẮT");
    assert.ok(a2.error.includes("trần mã"), a2.error);
    assert.equal(calls.activates.length, 1, "không lời bật nào cho quảng cáo vượt trần");
    const denied = await db.select().from(schema.videoScaleAdActions).where(eq(schema.videoScaleAdActions.adId, a2.id));
    assert.ok(denied.some((x) => x.action === "ACTIVATE" && x.outcome === "DENIED" && x.denial === "OVER_SKU_CAP"), "lượt bị chặn vẫn vào sổ");

    // Nới trần mã nhưng trần TOÀN MODULE 150.000 vẫn chặn.
    await db.update(schema.videoScaleSkus).set({ skuDailyCapVnd: 400_000 }).where(eq(schema.videoScaleSkus.productId, `${P}prod`));
    const g2 = await activateVideoAd(db, a2.id, actor, cfg, adsDeps);
    assert.ok(!g2.ok && g2.error.includes("Toàn module"), g2.ok ? "" : g2.error);

    // Không luật tắt ⇒ không bật.
    await setSetting(CREATIVE_CONFIG_KEY, { killRules: [] });
    const cfgBig = normalizeVideoScaleConfig({ enabled: true, adsGlobalDailyCapVnd: 1_000_000, adTemplateAdId: "120000000000001" });
    const noRule = await activateVideoAd(db, a2.id, actor, cfgBig, adsDeps);
    assert.ok(!noRule.ok && noRule.error.includes("luật TẮT"), noRule.ok ? "" : noRule.error);
    await setSetting(CREATIVE_CONFIG_KEY, { killRules: [{ metric: "ctr", op: "lt", value: 0.005, minSpendVnd: 100_000 }] });

    // Tăng ngân sách: +40% bị chặn, +25% được, lần thứ hai trong ngày bị chặn.
    const big = await setVideoAdBudget(db, a1.id, 140_000, actor, cfgBig, adsDeps);
    assert.ok(!big.ok && big.error.includes("30%"), big.ok ? "" : big.error);
    const ok = await setVideoAdBudget(db, a1.id, 125_000, actor, cfgBig, adsDeps);
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    assert.deepEqual(calls.budgets, [125_000], "VND hệ số 1");
    const again = await setVideoAdBudget(db, a1.id, 130_000, actor, cfgBig, adsDeps);
    assert.ok(!again.ok && again.error.includes("hôm nay"));

    // Dấu "đang gửi" ở bước CHIẾN DỊCH mà không có id ⇒ không gửi lại.
    const v3 = await publishedVariant(db, run.id, 3, actor.id);
    await db.update(schema.videoScaleSkus).set({ adsMode: "PUBLISH_PAUSED" }).where(eq(schema.videoScaleSkus.productId, `${P}prod`));
    const p3 = await planVideoAd(db, v3, cfgBig, null);
    await db.update(schema.videoScaleAds).set({ pendingStep: "CAMPAIGN", pendingAt: new Date(), fbVideoId: "5550009", fbImageHash: "h", fbCreativeId: "6660009" }).where(eq(schema.videoScaleAds.id, p3.adId as string));
    const campaignsBefore = calls.campaigns;
    await tick();
    const [a3] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, p3.adId as string));
    assert.equal(calls.campaigns, campaignsBefore, "không tạo chiến dịch lần hai");
    assert.equal(a3.status, "FAILED");
    assert.ok(a3.error.includes("Ads Manager"), a3.error);

    // Dừng khẩn cấp theo MÃ ⇒ tắt quảng cáo đang chạy — kể cả khi đường ghi đang đóng (tắt luôn được).
    adsDeps.adsWriteClosed = () => "đóng để thử";
    const n = await queuePauseAds(db, { productId: `${P}prod` }, "thử dừng khẩn cấp");
    assert.equal(n, 1);
    await tick();
    [a1] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, a1.id));
    assert.equal(a1.status, "PAUSED");
    assert.deepEqual(calls.pauses, [a1.fbCampaignId]);
    assert.ok(a1.stopReason.includes("dừng khẩn cấp"));

    // Video thử không bao giờ thành quảng cáo.
    await db.update(schema.videoScaleVariants).set({ isTest: true }).where(eq(schema.videoScaleVariants.id, v2));
    assert.equal((await planVideoAd(db, v2, cfgBig, null)).adId, null);

    console.log("✓ Video Scale quảng cáo (CSDL): dựng TẮT rồi mới bật · tự bật chịu trần mã / toàn module · không luật tắt không bật · +30% / 1 lần ngày · dấu đang gửi không tạo chiến dịch lần hai · dừng khẩn cấp tắt được cả khi đường ghi đóng · sổ ghi cả lượt bị chặn");
  } finally {
    await cleanup(db);
    await db.delete(schema.settings).where(inArray(schema.settings.key, keys));
    for (const row of prev) await db.insert(schema.settings).values(row);
  }
}
