import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { OPTIMIZER_STATE_KEY, VIDEO_AUTOMATION_KEY, actionForVerdict, nextScaledBudget, normalizeVideoScaleConfig } from "@/lib/constants/video-scale";
import { addDays, vnStartOfDay } from "@/lib/format";
import { parseAdVideoInsights, parseReelInsights, type TemplateAd } from "@/lib/integrations/facebook/ads-write";
import type { AdsApi, AdsDeps } from "@/lib/video-scale/ads";
import { angleStatsFor, freshEnoughToScale, lessonSummary, lessonsFor, maybeOptimize, runOptimize, type OptimizeDeps } from "@/lib/video-scale/optimize";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — ĐO LƯỜNG + VÒNG TỐI ƯU (PR 4) ═══════════
 *
 * Thuần: phán quyết → hành động (tắt chỉ khi thua; tăng chỉ khi mã bật tự tăng + đã khai ngưỡng đơn + đủ đơn) · bước tăng
 * làm tròn nghìn, kẹp 30% và trần mỗi quảng cáo · số chi phải mới tới hôm qua · đọc số đo Meta (vắng ⇒ null, không 0) ·
 * câu bài học chỉ in số đã đếm · cấu hình chưa khai ngưỡng đơn ⇒ null.
 *
 * CSDL (cửa Facebook GIẢ): quảng cáo thua theo luật tắt ⇒ máy TẮT · quảng cáo tốt ⇒ chỉ ĐỀ NGHỊ khi chưa khai ngưỡng, TĂNG
 * đúng một lần khi đủ điều kiện, chạy lại không tăng lần hai · số đo video Meta vào bảng riêng, số Reel chụp tối đa một lần
 * / 6 giờ · bài học + sổ góc đếm đúng · vòng tự động tạo đúng một vòng mới · nhịp 55 phút.
 */

const P = "vso-test-";
const PAGE = "920000000000077";
const ACC = "730000000000077";

export function testVideoScaleOptimizePure() {
  const a = (verdict: string, over: Partial<Parameters<typeof actionForVerdict>[0]> = {}) =>
    actionForVerdict({ verdict, adActive: true, autoScale: true, minOrders: 2, bookedOrders: 3, ...over });
  assert.equal(a("KILL"), "PAUSE");
  assert.equal(a("LOSE"), "PAUSE");
  assert.equal(a("KILL", { adActive: false }), "NONE", "đã tắt thì không làm gì");
  assert.equal(a("PROMISING"), "SCALE");
  assert.equal(a("WIN"), "SCALE");
  assert.equal(a("PROMISING", { autoScale: false }), "RECOMMEND_SCALE", "mã chưa bật tự tăng ⇒ chỉ đề nghị");
  assert.equal(a("PROMISING", { minOrders: null }), "RECOMMEND_SCALE", "chưa khai ngưỡng đơn ⇒ chỉ đề nghị");
  assert.equal(a("PROMISING", { bookedOrders: 1 }), "RECOMMEND_SCALE", "chưa đủ đơn ⇒ chỉ đề nghị");
  for (const v of ["PENDING", "RUNNING", "AWAITING_ORDERS", "UNJUDGED"]) assert.equal(a(v), "NONE", `${v}: chưa kết luận ⇒ không làm gì`);

  assert.equal(nextScaledBudget(100_000, 0.2), 120_000);
  assert.equal(nextScaledBudget(123_456, 0.2), 148_000, "làm tròn xuống nghìn đồng");
  assert.equal(nextScaledBudget(100_000, 0.9), 130_000, "bước kẹp 30%");
  assert.equal(nextScaledBudget(450_000, 0.2), 500_000, "không vượt trần mỗi quảng cáo");

  const today = "2026-09-27";
  assert.ok(freshEnoughToScale("2026-09-26", today));
  assert.ok(freshEnoughToScale("2026-09-27", today));
  assert.ok(!freshEnoughToScale("2026-09-25", today), "số chi cũ hơn hôm qua ⇒ không tự tăng");
  assert.ok(!freshEnoughToScale(null, today), "chưa có số chi ⇒ không tự tăng");

  const days = parseAdVideoInsights({
    data: [
      { date_start: "2026-09-26", video_play_actions: [{ action_type: "video_view", value: "1200" }], video_thruplay_watched_actions: [{ action_type: "video_view", value: "300" }], video_p100_watched_actions: [{ action_type: "video_view", value: "90" }] },
      { date_start: "sai", video_play_actions: [{ value: "1" }] },
    ],
  });
  assert.equal(days.length, 1, "dòng không có ngày hợp lệ bị bỏ");
  assert.deepEqual(days[0], { day: "2026-09-26", videoPlays: 1200, thruplays: 300, p25: null, p50: null, p75: null, p100: 90 }, "chỉ số Meta không trả ⇒ null, không 0");
  const reel = parseReelInsights({
    data: [
      { name: "blue_reels_play_count", values: [{ value: 5400 }] },
      { name: "post_video_likes_by_reaction_type", values: [{ value: { REACTION_LIKE: 40, REACTION_LOVE: 5 } }] },
      { name: "post_video_social_actions", values: [{ value: { COMMENT: 7 } }] },
    ],
  });
  assert.deepEqual(reel, { plays: 5400, reach: null, reactions: 45, comments: 7, shares: null });

  const s = lessonSummary({ angle: "OCCASION", hook: "Đi tiệc là nổi", verdict: "PROMISING", metrics: { spendVnd: 300_000, bookedOrders: 3, deliveredOrders: 1 }, thruplays: null });
  assert.ok(s.includes("Đi tiệc là nổi") && s.includes("3 đơn chốt") && s.includes("100.000đ"), s);
  assert.ok(!s.includes("ThruPlay"), "không có số Meta ⇒ không in");
  assert.ok(lessonSummary({ angle: "OCCASION", hook: "h", verdict: "KILL", metrics: { spendVnd: null, bookedOrders: 0 }, thruplays: 12 }).includes("chi —"), "chi CHƯA BIẾT in —, không 0đ");

  const cfg = normalizeVideoScaleConfig({});
  assert.equal(cfg.autoScaleMinOrders, null, "mặc định CHƯA KHAI ngưỡng đơn ⇒ máy không tự tăng");
  assert.equal(normalizeVideoScaleConfig({ autoScaleMinOrders: 0 }).autoScaleMinOrders, null);
  assert.equal(normalizeVideoScaleConfig({ autoScaleMinOrders: "3" }).autoScaleMinOrders, 3);
  assert.equal(normalizeVideoScaleConfig({ optimizeWindowDays: 99 }).optimizeWindowDays, 14);
  assert.equal(normalizeVideoScaleConfig({ scaleStepPct: 0.9 }).scaleStepPct, 0.2, "bước ngoài khoảng ⇒ mặc định");

  console.log("✓ Video Scale tối ưu (thuần): phán quyết → hành động · bước tăng kẹp 30% + trần · số chi phải tới hôm qua · số đo Meta vắng ⇒ null · bài học chỉ in số đã đếm");
}

// ───────────────────────────── CSDL ─────────────────────────────

type Calls = { pauses: string[]; budgets: number[]; adVideo: number; reel: number; runs: number };

function fakeAds(c: Calls): AdsApi {
  let budget = 100_000;
  const never = async (): Promise<never> => {
    throw new Error("không được gọi trong bài kiểm này");
  };
  return {
    readTemplate: never as unknown as (id: string) => Promise<TemplateAd>,
    currency: async () => "VND",
    uploadVideo: never,
    videoStatus: never,
    uploadImage: never,
    createCreative: never,
    createCampaign: never,
    createAdset: never,
    createAd: never,
    activate: never,
    pause: async (id) => void c.pauses.push(id),
    setBudget: async (_id, minor) => {
      c.budgets.push(minor);
      budget = minor;
    },
    readAdset: async () => ({ dailyBudgetVnd: budget, status: "ACTIVE", effectiveStatus: "ACTIVE" }),
  };
}

async function cleanup(db: Db) {
  const vs = await db.select({ id: schema.videoScaleVariants.id }).from(schema.videoScaleVariants).where(like(schema.videoScaleVariants.productId, `${P}%`));
  const vIds = vs.map((v) => v.id);
  if (vIds.length) {
    const ads = await db.select({ id: schema.videoScaleAds.id }).from(schema.videoScaleAds).where(inArray(schema.videoScaleAds.variantId, vIds));
    if (ads.length) await db.delete(schema.videoScaleAdActions).where(inArray(schema.videoScaleAdActions.adId, ads.map((a) => a.id)));
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.variantId, vIds));
    await db.delete(schema.videoScaleAds).where(inArray(schema.videoScaleAds.variantId, vIds));
    await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleLessons).where(inArray(schema.videoScaleLessons.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.id, vIds));
  }
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  if (runs.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, runs.map((r) => r.id)));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, runs.map((r) => r.id)));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, runs.map((r) => r.id)));
  }
  await db.delete(schema.videoScaleSkus).where(like(schema.videoScaleSkus.productId, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.adId, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.fanpages).where(eq(schema.fanpages.externalPageId, PAGE));
  await db.delete(schema.productModels).where(like(schema.productModels.code, "VSOTEST%"));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testVideoScaleOptimizeDb(db: Db) {
  const keys = [CREATIVE_CONFIG_KEY, VIDEO_AUTOMATION_KEY, OPTIMIZER_STATE_KEY];
  const prev = await db.select().from(schema.settings).where(inArray(schema.settings.key, keys));
  await cleanup(db);
  const setSetting = (key: string, value: unknown) => db.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
  const now = new Date();
  const today = vnDay(now);
  const yesterday = addDays(today, -1);
  const activatedAt = new Date(now.getTime() - 5 * 86_400_000);
  try {
    await db.delete(schema.settings).where(inArray(schema.settings.key, [VIDEO_AUTOMATION_KEY, OPTIMIZER_STATE_KEY]));
    await setSetting(CREATIVE_CONFIG_KEY, {
      killRules: [{ metric: "ctr", op: "lt", value: 0.5, minSpendVnd: 100_000, label: "CTR dưới 0,5%" }],
      keepRules: [{ metric: "orders", op: "gte", value: 2, minSpendVnd: 50_000, label: "Từ 2 đơn" }],
      winOrdersAbove: 100,
      verdictSettleHours: 24,
    });
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người duyệt", passwordHash: "x", role: "ADMIN" });
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm thử tối ưu", customId: "Q778" });
    await db.insert(schema.productModels).values({ code: "VSOTEST1", productId: `${P}prod`, lifecycleState: "WINNER", registeredBy: "USER" });
    await db.insert(schema.fanpages).values({ externalPageId: PAGE, name: "Page tối ưu thử" });
    await db.insert(schema.videoScaleSkus).values({ productId: `${P}prod`, pageId: PAGE, adAccountId: ACC, adsMode: "PUBLISH_PAUSED", dailyBudgetPerAdVnd: 100_000, skuDailyCapVnd: 400_000, autoScale: true, autoNextRound: true, adsModeByUserId: `${P}u`, adsModeBy: "Người duyệt" });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}prod`, sourceIds: ["src-1"], status: "DONE", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 2, configSnapshot: {}, brief: "đi tiệc", createdAt: new Date(now.getTime() - 6 * 86_400_000) })
      .returning({ id: schema.videoScaleRuns.id });

    const ad = async (seq: number, angle: string, hook: string) => {
      const final = await storeAsset(db, { kind: "FINAL", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, seq]), contentType: "video/mp4", runId: run.id });
      const [v] = await db
        .insert(schema.videoScaleVariants)
        .values({ runId: run.id, productId: `${P}prod`, seq, angle, angleVocabVersion: 1, script: { angle, hook, scenes: [], cta: "c" }, sourceId: "src-1", status: "APPROVED", qcVerdict: "PASS", finalAssetId: final.id, durationMs: 16_000, reviewedAt: new Date(), reviewedByUserId: `${P}u` })
        .returning({ id: schema.videoScaleVariants.id });
      const [post] = await db.insert(schema.videoScalePosts).values({ variantId: v.id, productId: `${P}prod`, pageId: PAGE, status: "PUBLISHED", caption: "Đầm xinh", fbVideoId: `56${seq}`, publishedAt: activatedAt }).returning({ id: schema.videoScalePosts.id });
      const fbAd = `${P}ad-${seq}`;
      const [a] = await db
        .insert(schema.videoScaleAds)
        .values({
          variantId: v.id,
          productId: `${P}prod`,
          postId: post.id,
          pageId: PAGE,
          adAccountId: ACC,
          mode: "PUBLISH_PAUSED",
          status: "ACTIVE",
          dailyBudgetVnd: 100_000,
          campaignName: `VS_Q778_V${seq}`,
          adsetName: `VS_Q778_V${seq}_A`,
          adName: `VS_Q778_V${seq}_A_VIDEO`,
          message: "Đầm xinh",
          templateAdId: "120000000000077",
          fbCampaignId: `77${seq}`,
          fbAdsetId: `88${seq}`,
          fbAdId: fbAd,
          activatedAt,
          activatedBy: "Người duyệt",
        })
        .returning();
      return { variantId: v.id, ad: a, fbAd, postId: post.id };
    };
    const loser = await ad(1, "FABRIC_FLOW", "Vải rơi mềm");
    const winner = await ad(2, "OCCASION", "Đi tiệc là nổi");

    const spend = (adId: string, day: string, amount: number, impressions: number, clicks: number) =>
      db.insert(schema.adSpends).values({ platform: "FACEBOOK", campaign: "VS_Q778", campaignId: "vs-camp", grain: "AD", adId, adsetId: "x", spend: amount, impressions, clicks, messages: 0, spendDate: vnStartOfDay(day), createdBy: "test" });
    await spend(loser.fbAd, yesterday, 200_000, 20_000, 20); // CTR 0,1% ⇒ luật tắt
    await spend(winner.fbAd, yesterday, 150_000, 10_000, 200); // CTR 2%
    for (const i of [1, 2, 3]) {
      await db.insert(schema.orders).values({ id: `${P}o${i}`, stage: "SHIPPED" as never, adId: winner.fbAd, cod: 400_000, totalPriceAfterDiscount: 400_000, prepaid: 0, insertedAt: new Date(activatedAt.getTime() + i * 3_600_000) });
    }

    const calls: Calls = { pauses: [], budgets: [], adVideo: 0, reel: 0, runs: 0 };
    const adsDeps: AdsDeps = { ads: fakeAds(calls), adsWriteClosed: () => null, signUrl: () => "https://x" };
    const deps: OptimizeDeps = {
      adsDeps,
      insights: {
        adVideo: async (_id, since, until) => {
          calls.adVideo += 1;
          assert.ok(since <= until);
          return [{ day: yesterday, videoPlays: 900, thruplays: 210, p25: 500, p50: null, p75: null, p100: 60 }];
        },
        reel: async () => {
          calls.reel += 1;
          return { plays: 5000, reach: 3200, reactions: 40, comments: 6, shares: null };
        },
      },
      createRun: async (d, input) => {
        calls.runs += 1;
        assert.deepEqual(input.sourceIds, ["src-1"], "vòng tự động dùng lại ảnh gốc của vòng trước");
        assert.deepEqual(input.angles, [], "để bộ chọn góc (đọc sổ học) chọn");
        const [r] = await d.insert(schema.videoScaleRuns).values({ productId: input.productId, sourceIds: input.sourceIds, status: "SCRIPTING", promptVersion: 1, angleVocabVersion: 1, variantsRequested: input.variants, configSnapshot: {} }).returning({ id: schema.videoScaleRuns.id });
        return { ok: true, runId: r.id };
      },
    };
    const base = { enabled: true, adsGlobalDailyCapVnd: 1_000_000, adTemplateAdId: "120000000000077", optimizeWindowDays: 3 };

    // Lượt 1 — chưa khai ngưỡng đơn: kẻ thua bị TẮT, kẻ thắng chỉ được ĐỀ NGHỊ.
    const cfg1 = normalizeVideoScaleConfig(base);
    const r1 = await maybeOptimize(db, cfg1, deps, now);
    assert.ok(r1, "lượt đầu phải chạy");
    assert.deepEqual(r1?.errors, []);
    assert.deepEqual(calls.pauses, [loser.ad.fbCampaignId], "luật tắt ⇒ máy tắt đúng chiến dịch của kẻ thua");
    assert.equal(calls.budgets.length, 0, "chưa khai ngưỡng đơn ⇒ KHÔNG tự tăng");
    const verdicts = await db.select().from(schema.videoScaleVerdicts).where(inArray(schema.videoScaleVerdicts.adId, [loser.ad.id, winner.ad.id]));
    const vOf = (id: string) => verdicts.find((v) => v.adId === id);
    assert.equal(vOf(loser.ad.id)?.verdict, "KILL");
    assert.ok(vOf(loser.ad.id)?.actionResult.startsWith("APPLIED"), vOf(loser.ad.id)?.actionResult);
    assert.equal(vOf(winner.ad.id)?.verdict, "PROMISING");
    assert.equal(vOf(winner.ad.id)?.action, "RECOMMEND_SCALE");
    assert.equal((vOf(winner.ad.id)?.metrics as Record<string, unknown>).bookedOrders, 3, "đơn chốt qua ORDER_AD_ID");
    const [la] = await db.select().from(schema.videoScaleAds).where(eq(schema.videoScaleAds.id, loser.ad.id));
    assert.equal(la.status, "PAUSED");
    assert.equal(await maybeOptimize(db, cfg1, deps, new Date(now.getTime() + 10 * 60_000)), null, "nhịp 55 phút: lượt sau 10 phút không chạy");

    // Số đo Meta vào bảng riêng; Reel chụp một lần.
    const am = await db.select().from(schema.videoScaleAdMetrics).where(eq(schema.videoScaleAdMetrics.adId, winner.ad.id));
    assert.equal(am.length, 1);
    assert.equal(am[0].thruplays, 210);
    assert.equal(am[0].p50, null, "Meta không trả ⇒ null");
    assert.equal(calls.reel, 2, "hai bài Reel, mỗi bài một ảnh chụp");

    // Bài học + sổ góc.
    const lessons = await db.select().from(schema.videoScaleLessons).where(eq(schema.videoScaleLessons.productId, `${P}prod`));
    assert.equal(lessons.filter((l) => l.source === "AD").length, 2);
    assert.equal(lessons.find((l) => l.variantId === winner.variantId)?.success, true);
    assert.equal(lessons.find((l) => l.variantId === loser.variantId)?.success, false);
    assert.ok(lessons.find((l) => l.variantId === winner.variantId)?.summary.includes("210 ThruPlay (Meta)"));
    const stats = await angleStatsFor(db, `${P}prod`);
    const occ = stats.find((s) => s.angle === "OCCASION");
    assert.ok(occ && occ.success >= 1, JSON.stringify(stats));
    assert.ok((await lessonsFor(db, `${P}prod`)).some((x) => x.includes("Đi tiệc là nổi")));

    // Vòng tự động: đúng MỘT vòng mới (đã có bài học quảng cáo, không vòng nào đang chạy, hôm nay chưa có vòng).
    assert.equal(r1?.runsCreated, 1);
    assert.equal(calls.runs, 1);

    // Lượt 2 — khai ngưỡng 2 đơn: tăng 100.000 → 120.000 đúng một lần.
    const cfg2 = normalizeVideoScaleConfig({ ...base, autoScaleMinOrders: 2 });
    const r2 = await runOptimize(db, cfg2, deps, now);
    assert.deepEqual(calls.budgets, [120_000], "tăng đúng một bước 20%");
    assert.equal(r2.scaled, 1);
    assert.equal(calls.reel, 2, "Reel đã chụp trong 6 giờ ⇒ không hỏi lại");
    assert.equal(calls.runs, 1, "vòng trước còn đang chạy ⇒ không tạo thêm");
    const r3 = await runOptimize(db, cfg2, deps, now);
    assert.deepEqual(calls.budgets, [120_000], "chạy lại trong ngày KHÔNG tăng lần hai");
    assert.equal(r3.scaled, 0);
    assert.equal(calls.pauses.length, 1, "kẻ thua đã tắt thì không tắt lại");
    const [wv] = await db.select().from(schema.videoScaleVerdicts).where(eq(schema.videoScaleVerdicts.adId, winner.ad.id));
    assert.ok(wv.actionResult.startsWith("APPLIED"), wv.actionResult);

    // Ba ngày sau, KHÔNG có dòng chi mới (đồng bộ trễ) ⇒ chi mấy ngày gần nhất CHƯA BIẾT ⇒ chỉ đề nghị.
    const r35 = await runOptimize(db, cfg2, deps, new Date(now.getTime() + 3 * 86_400_000));
    assert.equal(r35.scaled, 0);
    assert.deepEqual(calls.budgets, [120_000], "số chi cũ ⇒ không tự tăng");
    const stale = await db.select().from(schema.videoScaleVerdicts).where(eq(schema.videoScaleVerdicts.adId, winner.ad.id));
    const staleRow = stale.find((x) => x.day === vnDay(new Date(now.getTime() + 3 * 86_400_000)));
    assert.equal(staleRow?.action, "RECOMMEND_SCALE");
    assert.ok(staleRow?.reasons.some((r) => r.includes("chưa tới hôm qua")), JSON.stringify(staleRow?.reasons));

    // Dừng mọi tự động ⇒ tốt cũng chỉ đề nghị (ngày mai).
    await setSetting(VIDEO_AUTOMATION_KEY, { paused: true, reason: "thử", by: "t", at: now.toISOString() });
    const tomorrow = new Date(now.getTime() + 86_400_000);
    await spend(winner.fbAd, today, 150_000, 10_000, 200);
    const r4 = await runOptimize(db, cfg2, deps, tomorrow);
    assert.equal(r4.scaled, 0);
    assert.deepEqual(calls.budgets, [120_000], "dừng tự động ⇒ không tăng");

    console.log("✓ Video Scale tối ưu (CSDL): luật tắt ⇒ máy tắt · chưa khai ngưỡng ⇒ chỉ đề nghị · đủ điều kiện ⇒ tăng đúng một lần · số đo Meta tách bảng, null giữ null · bài học + sổ góc · vòng tự động đúng một vòng · số chi cũ chỉ đề nghị · dừng tự động chặn tăng");
  } finally {
    await cleanup(db);
    await db.delete(schema.settings).where(inArray(schema.settings.key, keys));
    for (const row of prev) await db.insert(schema.settings).values(row);
  }
}
