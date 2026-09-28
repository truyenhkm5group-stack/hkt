import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  VIDEO_SCALE_CONFIG_KEY,
  humanProviderError,
  isContentBlock,
  isPhotoScene,
  jobStepState,
  normalizeVideoScaleConfig,
  variantReserveUsd,
} from "@/lib/constants/video-scale";
import { storeCreativeImage } from "@/lib/creative/images";
import { listRunProgress } from "@/lib/queries/video-scale";
import { ffmpegVersion, photoMotionArgs, runTool } from "@/lib/video-scale/ffmpeg";
import { runVideoScaleTick, switchSceneToPhoto, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { ProviderError, type VideoProvider } from "@/lib/video-scale/providers/types";
import { enqueueJob } from "@/lib/video-scale/queue";

/**
 * ═══════════ VIDEO SCALE — TIẾN TRÌNH + CẢNH ẢNH ĐỘNG (MIỄN PHÍ) ═══════════
 *
 * Thuần: cảnh nào là ảnh động · tiền giữ chỗ chỉ tính cảnh AI · nhận ra bộ lọc nội dung · câu lỗi tiếng người · trạng thái bước.
 * CSDL + ffmpeg thật: cảnh ảnh động dựng ra MP4 9:16 có tiếng, tiền 0 (số thật) · Google chặn LÚC HỎI (HTTP 400, đo 28/09/2026
 * trên production) ⇒ việc hỏng NGAY với câu tiếng Việt, không treo "Chờ nhà cung cấp" · đổi cảnh ấy sang ảnh động ⇒ xong, không
 * gọi nhà cung cấp lần nào nữa · màn hình tiến trình đọc đúng từng bước.
 */

export function testVideoScaleProgressPure() {
  assert.equal(isPhotoScene({ provider: "OMNI", aiScenes: null, sceneIndex: 1, requestMode: undefined }), false, "null = mọi cảnh AI");
  assert.equal(isPhotoScene({ provider: "OMNI", aiScenes: 1, sceneIndex: 0, requestMode: undefined }), false);
  assert.equal(isPhotoScene({ provider: "OMNI", aiScenes: 1, sceneIndex: 1, requestMode: undefined }), true, "cảnh sau cảnh AI cuối ⇒ ảnh động");
  assert.equal(isPhotoScene({ provider: "VEO", aiScenes: 0, sceneIndex: 0, requestMode: undefined }), true, "0 = toàn ảnh động");
  assert.equal(isPhotoScene({ provider: "OMNI", aiScenes: null, sceneIndex: 0, requestMode: "PHOTO" }), true, "người đã đổi riêng cảnh này");
  assert.equal(isPhotoScene({ provider: "FAKE", aiScenes: 0, sceneIndex: 0, requestMode: undefined }), false, "bộ sinh giả giữ nhánh cũ");

  const base = normalizeVideoScaleConfig({ provider: "OMNI", scenesPerVariant: 2, clipSeconds: 8 });
  assert.equal(base.aiScenes, null);
  assert.equal(variantReserveUsd(base), 2.028, "2 cảnh AI × 10 giây giữ chỗ × 0,1014");
  assert.equal(variantReserveUsd({ ...base, aiScenes: 1 }), 1.014, "1 cảnh AI");
  assert.equal(variantReserveUsd({ ...base, aiScenes: 0 }), 0, "toàn ảnh động = 0 USD (số thật)");
  assert.equal(normalizeVideoScaleConfig({ aiScenes: 9 }).aiScenes, 3, "kẹp vào trần cảnh");
  assert.equal(normalizeVideoScaleConfig({ aiScenes: "" }).aiScenes, null);

  const blocked = "Omni từ chối trả trạng thái clip (HTTP 400): Request blocked due to prohibited content guidelines. Please modify your input and retry..";
  assert.ok(isContentBlock(blocked));
  assert.ok(!isContentBlock("Omni từ chối tạo clip (HTTP 400): API key not valid."));
  const human = humanProviderError(blocked);
  assert.ok(human.startsWith("Google CHẶN") && human.includes("Dùng ảnh động (miễn phí)") && human.includes("prohibited"), human);
  assert.equal(humanProviderError(human), human, "không bọc hai lần");

  const now = new Date("2026-09-28T08:45:00Z");
  const j = { status: "WAITING", providerRef: "interactions/x", lockedUntil: null, nextRunAt: now, updatedAt: now, error: "", provider: "OMNI" };
  assert.equal(jobStepState(j, now).label, "Đang tạo trên Google");
  assert.equal(jobStepState({ ...j, providerRef: "" }, now).label, "Chờ lượt");
  assert.equal(jobStepState({ ...j, status: "FAILED", error: blocked }, now).label, "Bị Google chặn (chính sách nội dung)");
  assert.equal(jobStepState({ ...j, status: "SUCCEEDED", provider: "PHOTO" }, now).label, "Xong (ảnh động)");

  const args = photoMotionArgs("in.jpg", 6, 720, 1280, "out.mp4", 2);
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.ok(fc.includes("boxblur") && fc.includes("overlay") && fc.includes("zoompan") && fc.includes("s=720x1280"), fc);
  assert.ok(args.includes("anullsrc=r=48000:cl=stereo"), "âm câm 48 kHz cho Reels");
  assert.equal(args[args.indexOf("-t") + 1], "6");

  console.log("✓ Video Scale tiến trình (thuần): cảnh ảnh động · giữ chỗ chỉ cảnh AI · nhận ra bộ lọc nội dung · câu lỗi tiếng người · trạng thái bước");
}

const P = "vsprog-test-";

async function cleanup(db: Db) {
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, ids));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, ids));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testVideoScaleProgressDb(db: Db) {
  const ff = await ffmpegVersion();
  if (!ff) {
    console.log("  · CHƯA ĐO ĐƯỢC: máy này không có ffmpeg — cảnh ảnh động không dựng thử được (image Docker kiểm ffmpeg lúc dựng).");
    return;
  }
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  const tmp = await mkdtemp(path.join(tmpdir(), "vsprog-"));
  await cleanup(db);
  try {
    const png = path.join(tmp, "src.png");
    const mk = await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=600x800:rate=1", "-frames:v", "1", png], { timeoutMs: 30_000 });
    assert.equal(mk.code, 0, mk.stderr);
    await db.insert(schema.products).values({ id: `${P}p`, name: "Đầm tiến trình" });
    const img = await storeCreativeImage(db, new Uint8Array(await readFile(png)));
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}p`, imageId: img.id, title: "ảnh thật" });
    const cfg = { enabled: true, provider: "OMNI", model: "gemini-omni-1.1-flash", clipSeconds: 4, scenesPerVariant: 2, aiScenes: 1, dailyUsdCap: 5, dailyClipCap: 40, providerConcurrency: 3 };
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify(cfg) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}photo`], status: "PRODUCING", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 1, configSnapshot: cfg })
      .returning({ id: schema.videoScaleRuns.id });
    const [v] = await db
      .insert(schema.videoScaleVariants)
      .values({ runId: run.id, productId: `${P}p`, seq: 1, angle: "OCCASION", angleVocabVersion: 1, script: { angle: "OCCASION", hook: "Đi tiệc", scenes: [{ prompt: "p0", overlay: "a", voiceover: "" }, { prompt: "p1", overlay: "b", voiceover: "" }], cta: "Nhắn shop" }, sourceId: `${P}photo`, status: "SCRIPTED" })
      .returning({ id: schema.videoScaleVariants.id });
    for (const i of [0, 1]) await enqueueJob(db, { kind: "CLIP", key: `${P}clip:${v.id}:${i}`, runId: run.id, variantId: v.id, sceneIndex: i, isTest: false });

    // Nhà cung cấp GIẢ: nhận lời tạo, rồi TỪ CHỐI LƯỢT HỎI bằng lỗi vĩnh viễn — đúng hình dạng Omni trả trên production.
    let starts = 0;
    let polls = 0;
    const provider: VideoProvider = {
      id: "OMNI",
      start: async () => {
        starts += 1;
        return { ref: "interactions/i1" };
      },
      poll: async () => {
        polls += 1;
        throw new ProviderError("Omni từ chối trả trạng thái clip (HTTP 400): Request blocked due to prohibited content guidelines. Please modify your input and retry..", "PERMANENT");
      },
      download: async () => new Uint8Array(),
    };
    const deps: VideoScaleDeps = { provider: () => provider, ffmpegVersion: async () => ff };
    const J = schema.videoScaleJobs;
    const tick = async () => {
      await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(J.runId, run.id));
      await runVideoScaleTick(db, { deps, budgetMs: 60_000 });
    };
    const jobs = () => db.select().from(J).where(eq(J.runId, run.id));

    await tick(); // cảnh 1: gửi AI · cảnh 2: ảnh động dựng ngay
    let js = await jobs();
    const s0 = js.find((j) => j.sceneIndex === 0);
    const s1 = js.find((j) => j.sceneIndex === 1);
    assert.equal(starts, 1, "chỉ cảnh 1 gọi nhà cung cấp");
    assert.equal(s1?.status, "SUCCEEDED", `cảnh ảnh động xong ngay: ${s1?.error}`);
    assert.equal(s1?.costUsd, 0, "ảnh động: 0 USD là số thật");
    assert.equal(s1?.provider, "PHOTO");
    const [asset] = await db.select().from(schema.videoScaleAssets).where(eq(schema.videoScaleAssets.id, s1?.outputAssetId as string));
    assert.equal(asset.width, 720);
    assert.equal(asset.height, 1280, "khung 9:16 dù ảnh gốc 3:4");
    assert.equal(s0?.status, "WAITING");

    await tick(); // hỏi cảnh 1 ⇒ Google chặn ⇒ HỎNG NGAY
    js = await jobs();
    const f0 = js.find((j) => j.sceneIndex === 0);
    assert.equal(polls, 1);
    assert.equal(f0?.status, "FAILED", "bị chặn lúc hỏi ⇒ hỏng NGAY, không treo tới hết hạn");
    assert.ok(f0?.error.startsWith("Google CHẶN"), f0?.error);
    assert.equal(f0?.providerRef, "", "bỏ mã thao tác đã chết");
    const [vf] = await db.select().from(schema.videoScaleVariants).where(eq(schema.videoScaleVariants.id, v.id));
    assert.equal(vf.status, "FAILED");

    const progress = (await listRunProgress(db, 20)).find((r) => r.id === run.id);
    assert.ok(progress);
    assert.equal(progress.variants[0].jobs.filter((j) => j.kind === "CLIP").length, 2);
    assert.equal(progress.costUsd, 0, "chỉ việc đã chốt tiền mới cộng vào 'đã chi'");

    // Lối ra: đổi cảnh bị chặn sang ảnh động ⇒ dựng xong, KHÔNG gọi nhà cung cấp lần nào nữa.
    const r = await switchSceneToPhoto(db, f0?.id as string);
    assert.ok(r.ok, r.ok ? "" : r.error);
    await tick();
    js = await jobs();
    assert.equal(js.find((j) => j.sceneIndex === 0)?.status, "SUCCEEDED");
    assert.equal(js.find((j) => j.sceneIndex === 0)?.provider, "PHOTO");
    assert.equal(starts, 1, "không gửi lại AI");
    const [vr] = await db.select().from(schema.videoScaleVariants).where(eq(schema.videoScaleVariants.id, v.id));
    assert.ok(["GENERATING", "RENDERING"].includes(vr.status), vr.status);
    assert.equal((await switchSceneToPhoto(db, js.find((j) => j.sceneIndex === 1)?.id as string)).ok, false, "cảnh đã xong thì không đổi");

    console.log("✓ Video Scale tiến trình (CSDL + ffmpeg thật): cảnh ảnh động 720×1280 · 0 USD thật · bị chặn lúc hỏi ⇒ hỏng NGAY kèm câu tiếng Việt · đổi sang ảnh động không gọi AI lại · màn hình đọc đúng bước");
  } finally {
    await cleanup(db);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
