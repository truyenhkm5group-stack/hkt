import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  VIDEO_AUTOMATION_KEY,
  VIDEO_SCALE_CONFIG_KEY,
  composeCaption,
  effectivePublishMode,
  parseVideoAutomation,
  scheduleProblem,
  type CaptionOption,
} from "@/lib/constants/video-scale";
import { IntegrationError } from "@/lib/integrations/http";
import { finishReelFields, parseReelStatus, type ReelStatus } from "@/lib/integrations/facebook/ads-write";
import { captionProblems, finalCaptionProblems } from "@/lib/video-scale/caption";
import { approveVideoVariant, runVideoScaleTick, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { publishGate, reelErrorKind, reelFinishAccepted, requestReelPost, type ReelApi } from "@/lib/video-scale/publish";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — CONTENT + ĐĂNG REEL (PR 2) ═══════════
 *
 * Thuần: chế độ đăng mặc định an toàn · công tắc dừng mọi tự động FAIL-CLOSED · hẹn giờ theo luật Facebook · content qua
 * cùng bộ kiểm khẳng định với kịch bản · hình dạng bước đăng / đọc trạng thái Reel · phân loại lỗi.
 *
 * CSDL (cửa Facebook GIẢ, không gọi mạng): chưa gán fanpage ⇒ không đăng · đăng một lần thì bài thứ hai bị từ chối ·
 * mất phản hồi ở bước ĐĂNG ⇒ lượt sau HỎI trước, không đăng lần hai · dừng khẩn cấp chặn · dữ liệu thử không đăng · fanpage
 * tự đăng + trần bài / ngày · đổi fanpage của mã giữa chừng ⇒ không đăng lên fanpage cũ.
 */

const P = "vsr-test-";
const PAGE = "910000000000001";
const PAGE2 = "910000000000002";

export function testVideoScaleReelPure() {
  assert.equal(effectivePublishMode(null, null), "MANUAL_REVIEW", "fanpage chưa cấu hình ⇒ chờ người");
  assert.equal(effectivePublishMode({ publishMode: "AUTO_PUBLISH" }, { publishMode: null }), "AUTO_PUBLISH");
  assert.equal(effectivePublishMode({ publishMode: "AUTO_PUBLISH" }, { publishMode: "MANUAL_REVIEW" }), "MANUAL_REVIEW", "mã ép chờ người thắng fanpage tự đăng");
  assert.equal(effectivePublishMode({ publishMode: "MANUAL_REVIEW" }, null), "MANUAL_REVIEW");

  assert.equal(parseVideoAutomation({ ok: true, value: null }).paused, false, "chưa ai kéo = chạy");
  assert.equal(parseVideoAutomation({ ok: true, value: '{"paused":false}' }).paused, false);
  assert.equal(parseVideoAutomation({ ok: true, value: '{"paused":true,"reason":"x"}' }).paused, true);
  assert.equal(parseVideoAutomation({ ok: true, value: '{"paused":"false"}' }).paused, true, "chuỗi \"false\" không phải false ⇒ coi như DỪNG");
  assert.equal(parseVideoAutomation({ ok: true, value: "{hỏng" }).paused, true, "JSON hỏng ⇒ DỪNG");
  assert.equal(parseVideoAutomation({ ok: false, error: "db" }).paused, true, "đọc lỗi ⇒ DỪNG");

  const now = new Date("2026-09-27T10:00:00Z");
  assert.equal(scheduleProblem(null, now), null, "đăng ngay");
  assert.ok(scheduleProblem(new Date(now.getTime() + 5 * 60_000), now), "hẹn dưới 10 phút bị chặn");
  assert.equal(scheduleProblem(new Date(now.getTime() + 60 * 60_000), now), null);
  assert.ok(scheduleProblem(new Date(now.getTime() + 30 * 86_400_000), now), "hẹn quá 29 ngày bị chặn");

  const facts = { name: "Đầm suông", priceVnd: 499_000, sizes: ["M", "L"], colors: ["Đen"], policyLines: [] as string[] };
  const good: CaptionOption = { hook: "Dáng suông che bắp tay", body: "Mặc đi làm hay đi chơi đều xinh. Size M, L.", cta: "Nhắn shop tư vấn size", hashtags: ["damsuong", "thoitrangnu"] };
  assert.deepEqual(captionProblems(good, facts), []);
  assert.ok(composeCaption(good).includes("#damsuong #thoitrangnu"));
  const bad = captionProblems({ ...good, body: "Chất lụa, freeship, chỉ 399k", hashtags: ["ok", "có dấu cách"] }, facts).join(" | ");
  for (const n of ["lụa", "freeship", "399k", "có dấu cách"]) assert.ok(bad.includes(n), `phải bắt "${n}": ${bad}`);
  assert.ok(finalCaptionProblems("Giá chỉ 399.000đ", facts).length > 0, "content người sửa tay cũng qua bộ kiểm giá");
  assert.deepEqual(finalCaptionProblems("Đầm đen xinh, nhắn shop nhé", facts), []);

  assert.deepEqual(finishReelFields({ videoId: "v1", description: "d", publishAt: null }), { upload_phase: "finish", video_id: "v1", video_state: "PUBLISHED", description: "d" });
  const sch = finishReelFields({ videoId: "v1", description: "d", publishAt: new Date("2026-09-28T01:00:00Z") });
  assert.equal(sch.video_state, "SCHEDULED");
  assert.equal(sch.scheduled_publish_time, String(Math.floor(Date.parse("2026-09-28T01:00:00Z") / 1000)), "giờ hẹn là UNIX giây");

  const done = parseReelStatus({ status: { video_status: "ready", uploading_phase: { status: "complete" }, processing_phase: { status: "complete" }, publishing_phase: { status: "complete", publish_status: "published", publish_time: "2026-09-27T10:05:00+0000" } }, permalink_url: "/reel/123" });
  assert.equal(done.publishStatus, "published");
  assert.equal(done.permalink, "https://www.facebook.com/reel/123", "permalink tương đối được ghép tên miền");
  assert.equal(parseReelStatus({ status: { video_status: "error", processing_phase: { status: "error", error: { message: "định dạng lỗi" } } } }).error, "định dạng lỗi");
  assert.equal(reelFinishAccepted({ ...done, publishStatus: "", publishing: "not_started" }), false);
  assert.equal(reelFinishAccepted({ ...done, publishStatus: "", publishing: "in_progress" }), true, "Facebook đã nhận bước đăng ⇒ không gửi lại");

  assert.equal(reelErrorKind(new IntegrationError("Facebook: đường ghi quảng cáo đang đóng — x", 403)), "BLOCKED");
  assert.equal(reelErrorKind(new IntegrationError("Facebook: bị từ chối", 400)), "PERMANENT");
  assert.equal(reelErrorKind(new IntegrationError("Facebook: quá thời gian", 502, true)), "TRANSIENT");

  console.log("✓ Video Scale Reel (thuần): mặc định chờ người · công tắc dừng fail-closed · hẹn giờ theo luật Facebook · content qua cùng bộ kiểm · bước đăng / trạng thái · phân loại lỗi");
}

// ───────────────────────────── CSDL ─────────────────────────────

type FakeFb = { starts: number; uploads: number; finishes: number; statusCalls: number; finishThrowsOnce: boolean; accepted: Set<string> };

function fakeReel(st: FakeFb): ReelApi {
  const stat = (videoId: string, published: boolean): ReelStatus => ({
    videoStatus: "ready",
    uploading: "complete",
    processing: "complete",
    publishing: published ? "complete" : st.accepted.has(videoId) ? "in_progress" : "not_started",
    publishStatus: published ? "published" : "",
    publishTime: published ? new Date().toISOString() : null,
    error: null,
    permalink: published ? `https://www.facebook.com/reel/${videoId}` : "",
  });
  return {
    async start() {
      st.starts += 1;
      return { videoId: `77${st.starts}` };
    },
    async upload() {
      st.uploads += 1;
    },
    async finish(_pageId, input) {
      st.finishes += 1;
      st.accepted.add(input.videoId);
      if (st.finishThrowsOnce) {
        st.finishThrowsOnce = false;
        // Facebook ĐÃ nhận, phản hồi rơi mất.
        throw new IntegrationError("Facebook: không thể kết nối (socket hang up)", 502, true);
      }
    },
    async status(_pageId, videoId) {
      st.statusCalls += 1;
      // Hỏi lần đầu sau khi nhận: đang đăng; từ lần hai: đã đăng.
      return stat(videoId, st.statusCalls > 1 && st.accepted.has(videoId));
    },
  };
}

async function cleanup(db: Db) {
  const vs = await db.select({ id: schema.videoScaleVariants.id }).from(schema.videoScaleVariants).where(like(schema.videoScaleVariants.productId, `${P}%`));
  const vIds = vs.map((v) => v.id);
  if (vIds.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.variantId, vIds));
    await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.id, vIds));
  }
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  if (runs.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, runs.map((r) => r.id)));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, runs.map((r) => r.id)));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, runs.map((r) => r.id)));
  }
  await db.delete(schema.videoScaleSkus).where(like(schema.videoScaleSkus.productId, `${P}%`));
  await db.delete(schema.videoScalePages).where(inArray(schema.videoScalePages.pageId, [PAGE, PAGE2]));
  await db.delete(schema.fanpages).where(inArray(schema.fanpages.externalPageId, [PAGE, PAGE2]));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

/** Một biến thể CHỜ DUYỆT có bản hoàn chỉnh — dựng thẳng, không cần ffmpeg (luồng đăng chỉ đọc byte + độ dài). */
async function reviewVariant(db: Db, runId: string, seq: number, isTest = false): Promise<string> {
  const asset = await storeAsset(db, { kind: "FINAL", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, seq]), contentType: "video/mp4", runId, isTest });
  const [v] = await db
    .insert(schema.videoScaleVariants)
    .values({ runId, productId: `${P}prod`, seq, angle: "OCCASION", angleVocabVersion: 1, script: { angle: "OCCASION", hook: "h", scenes: [], cta: "c" }, sourceId: "x", status: "REVIEW", qcVerdict: "PASS", finalAssetId: asset.id, durationMs: 16_000, isTest })
    .returning({ id: schema.videoScaleVariants.id });
  return v.id;
}

export async function testVideoScaleReelDb(db: Db) {
  const [prevAuto] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY));
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  await cleanup(db);
  try {
    await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY));
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify({ enabled: true, dailyUsdCap: 5 }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ enabled: true, dailyUsdCap: 5 }) } });
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người đăng", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Người đăng" };
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm suông thử" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, retailPrice: 499_000, retailPriceAfterDiscount: 499_000, color: "Đen", size: "M" });
    await db.insert(schema.fanpages).values([
      { externalPageId: PAGE, name: "Page thử" },
      { externalPageId: PAGE2, name: "Page thử 2" },
    ]);
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}prod`, sourceIds: ["x"], status: "REVIEW", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 3, configSnapshot: {} })
      .returning({ id: schema.videoScaleRuns.id });
    const v1 = await reviewVariant(db, run.id, 1);
    const v2 = await reviewVariant(db, run.id, 2);
    const vTest = await reviewVariant(db, run.id, 3, true);

    const fb: FakeFb = { starts: 0, uploads: 0, finishes: 0, statusCalls: 0, finishThrowsOnce: false, accepted: new Set() };
    let captionCalls = 0;
    const deps: VideoScaleDeps = {
      reel: fakeReel(fb),
      captionWriter: async () => {
        captionCalls += 1;
        return { ok: true, options: [{ hook: "Dáng suông tôn dáng", body: "Mặc đi làm đi chơi đều xinh.", cta: "Nhắn shop chọn size", hashtags: ["damsuong", "damdep"] }], dropped: [], model: "fake", costUsd: 0.001 };
      },
    };
    const tick = async () => {
      await db.update(schema.videoScaleJobs).set({ nextRunAt: new Date(Date.now() - 1000) }).where(inArray(schema.videoScaleJobs.status, ["QUEUED", "WAITING"]));
      await runVideoScaleTick(db, { deps, budgetMs: 20_000 });
    };

    // Duyệt ⇒ máy viết content; mã CHƯA gán fanpage ⇒ không đăng được.
    assert.ok((await approveVideoVariant(db, v1, actor, "ok")).ok);
    await tick();
    assert.equal(captionCalls, 1, "duyệt video ⇒ một lượt viết content");
    const [c1] = await db.select().from(schema.videoScaleVariants).where(eq(schema.videoScaleVariants.id, v1));
    assert.equal(c1.captionState, "DRAFTED");
    assert.ok(c1.caption.includes("#damsuong"));
    const noPage = await requestReelPost(db, { variantId: v1, caption: c1.caption, publishAt: null }, actor);
    assert.ok(!noPage.ok && noPage.error.includes("FANPAGE"), "chưa gán fanpage ⇒ không đăng");

    // Gán fanpage ⇒ người đăng; lượt ĐĂNG mất phản hồi ⇒ lượt sau HỎI trước, không đăng lần hai.
    await db.insert(schema.videoScaleSkus).values({ productId: `${P}prod`, pageId: PAGE });
    const wrongPrice = await requestReelPost(db, { variantId: v1, caption: "Chỉ 399k thôi", publishAt: null }, actor);
    assert.ok(!wrongPrice.ok && wrongPrice.error.includes("399k"), "content sai giá ⇒ không đăng");
    fb.finishThrowsOnce = true;
    const r1 = await requestReelPost(db, { variantId: v1, caption: c1.caption, publishAt: null }, actor);
    assert.ok(r1.ok, r1.ok ? "" : r1.error);
    for (let i = 0; i < 5; i += 1) await tick();
    const [post1] = await db.select().from(schema.videoScalePosts).where(eq(schema.videoScalePosts.variantId, v1));
    assert.equal(post1.status, "PUBLISHED", `bài phải lên: ${post1.status} ${post1.error}`);
    assert.equal(fb.finishes, 1, "bước ĐĂNG chỉ gửi MỘT lần dù lượt đầu mất phản hồi");
    assert.ok(post1.permalink.includes("/reel/"));
    assert.equal(post1.authorizedByUserId, actor.id);
    const again = await requestReelPost(db, { variantId: v1, caption: c1.caption, publishAt: null }, actor);
    assert.ok(!again.ok && again.error.includes("không đăng lần hai"), "một video không thành hai bài trên cùng fanpage");

    // Dữ liệu thử không bao giờ đăng.
    await db.update(schema.videoScaleVariants).set({ status: "APPROVED", reviewedAt: new Date(), reviewedByUserId: actor.id }).where(eq(schema.videoScaleVariants.id, vTest));
    const t = await publishGate(db, vTest, null);
    assert.ok(!t.ok && t.reason.includes("DỮ LIỆU THỬ"));

    // Dừng khẩn cấp toàn module ⇒ chặn; hỏng JSON cũng chặn (fail-closed).
    await db.insert(schema.settings).values({ key: VIDEO_AUTOMATION_KEY, value: "{hỏng" });
    assert.ok((await approveVideoVariant(db, v2, actor, "ok")).ok);
    const paused = await requestReelPost(db, { variantId: v2, caption: "Đầm đen xinh, nhắn shop", publishAt: null }, actor);
    assert.ok(!paused.ok && paused.error.includes("DỪNG"), "công tắc hỏng ⇒ coi như đang dừng");
    await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY));

    // Fanpage tự đăng + trần 1 bài / ngày: video 2 được máy tự đăng (lượt viết content của nó chạy lúc này).
    await db.insert(schema.videoScalePages).values({ pageId: PAGE, publishMode: "AUTO_PUBLISH", maxPostsPerDay: 1 });
    for (let i = 0; i < 4; i += 1) await tick();
    const [auto2] = await db.select().from(schema.videoScalePosts).where(eq(schema.videoScalePosts.variantId, v2));
    assert.ok(auto2 && auto2.auto && auto2.authorizedByUserId === null, "fanpage tự đăng ⇒ máy tạo bài, không mang tên người");
    assert.equal(auto2.status, "PUBLISHED", `bài tự đăng phải lên: ${auto2.status} ${auto2.error}`);

    // Trần 1 bài tự đăng / ngày: video thứ tư được duyệt ⇒ máy tạo bài nhưng việc đăng ĐỨNG CHỜ tới 0 giờ.
    const v4 = await reviewVariant(db, run.id, 4);
    assert.ok((await approveVideoVariant(db, v4, actor, "ok")).ok);
    const startsBeforeQuota = fb.starts;
    for (let i = 0; i < 3; i += 1) await tick();
    const [auto4] = await db.select().from(schema.videoScalePosts).where(eq(schema.videoScalePosts.variantId, v4));
    assert.ok(auto4 && auto4.status === "QUEUED", "bài vượt trần vẫn nằm chờ, không mất");
    const [quotaJob] = await db.select().from(schema.videoScaleJobs).where(eq(schema.videoScaleJobs.postId, auto4.id));
    assert.equal(quotaJob.status, "BLOCKED");
    assert.ok(quotaJob.error.includes("đủ 1 bài"), quotaJob.error);
    assert.equal(fb.starts, startsBeforeQuota, "vượt trần bài / ngày ⇒ không một lời gọi Facebook nào");

    // Người bấm đăng, rồi mã ĐỔI fanpage trước khi việc đăng chạy ⇒ bài hỏng có lý do, không lên fanpage cũ.
    await db.update(schema.videoScalePages).set({ publishMode: "MANUAL_REVIEW" }).where(eq(schema.videoScalePages.pageId, PAGE));
    const v5 = await reviewVariant(db, run.id, 5);
    assert.ok((await approveVideoVariant(db, v5, actor, "ok")).ok);
    const r5 = await requestReelPost(db, { variantId: v5, caption: "Đầm đen xinh, nhắn shop chọn size", publishAt: null }, actor);
    assert.ok(r5.ok, r5.ok ? "" : r5.error);
    await db.update(schema.videoScaleSkus).set({ pageId: PAGE2 }).where(eq(schema.videoScaleSkus.productId, `${P}prod`));
    const startsBeforeSwitch = fb.starts;
    await tick();
    const [p5] = await db.select().from(schema.videoScalePosts).where(eq(schema.videoScalePosts.variantId, v5));
    assert.equal(p5.status, "FAILED", "đổi mapping giữa chừng ⇒ không đăng lên fanpage cũ");
    assert.ok(p5.error.includes("đã đổi"), p5.error);
    assert.equal(fb.starts, startsBeforeSwitch, "không một lời gọi Facebook nào cho bài lên fanpage cũ");

    console.log("✓ Video Scale Reel (CSDL): chưa gán fanpage ⇒ không đăng · content sai giá bị chặn · mất phản hồi bước ĐĂNG ⇒ hỏi trước, đăng đúng 1 lần · không hai bài / fanpage · dữ liệu thử không đăng · dừng khẩn cấp fail-closed · fanpage tự đăng không mang tên người · trần bài / ngày giữ bài chờ · đổi fanpage giữa chừng không đăng lên fanpage cũ");
  } finally {
    await cleanup(db);
    await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_AUTOMATION_KEY));
    if (prevAuto) await db.insert(schema.settings).values(prevAuto);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
