import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DEFAULT_SUB_STYLE, DEFAULT_TEXT_STYLE, MODEST_STYLE_NOTE, VIDEO_QC_CHECKS, VIDEO_SCALE_CONFIG_KEY, effectiveRender, normalizeRenderOptions, normalizeVideoScaleConfig, renderJobKey, softenScenePrompt } from "@/lib/constants/video-scale";
import { veoPrompt } from "@/lib/video-scale/script";
import { storeCreativeImage } from "@/lib/creative/images";
import { buildRenderArgs, ffmpegVersion, lineChars, resolveFontFile, runTool, wrapText } from "@/lib/video-scale/ffmpeg";
import { cloneVideoVariant, rerenderVideoVariant, runVideoScaleTick, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { enqueueJob } from "@/lib/video-scale/queue";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — SỬA VIDEO (DỰNG LẠI TỪ CLIP ĐÃ CÓ) ═══════════
 *
 * Thuần: tuỳ chọn dựng (giá trị lạ bị bỏ, `musicId = null` = không nhạc) · thứ tự ưu tiên video ⊕ lượt · khoá việc dựng theo lần
 * sửa (lần 0 giữ khoá cũ) · chữ trên hình KHÔNG tràn khung (đo 28/09/2026: bản cũ cắt hai mép) · tắt chữ ⇒ không vẽ chữ.
 * CSDL + ffmpeg thật: sửa chữ + bật giọng đọc + chọn nhạc ⇒ chỉ tạo giọng cho cảnh CÓ lời, dựng lại ra bản MỚI, quay lại chờ duyệt,
 * không gọi máy sinh clip · sửa lần hai không đổi lời ⇒ không tạo giọng lại · chữ nói chất liệu ⇒ từ chối · video đã lên Reel ⇒ từ chối.
 */

export function testVideoScaleEditPure() {
  assert.deepEqual(normalizeRenderOptions({ musicId: null, voice: "nope", musicVolume: 9, showText: false, junk: 1 }), { musicId: null, showText: false }, "giá trị lạ bị bỏ; null = không nhạc");
  const snap = normalizeVideoScaleConfig({ voiceover: false, voice: "marin", burnSubtitles: true });
  const base = effectiveRender(snap, "m1", {});
  assert.deepEqual(
    base,
    { musicId: "m1", musicVolume: 0.18, voiceover: false, voice: "marin", burnSubtitles: true, keepNativeAudio: true, showText: true, text: DEFAULT_TEXT_STYLE, sub: DEFAULT_SUB_STYLE, transition: "NONE", filter: "NONE", sceneOrder: null, voiceAssetId: null, showcase: [] },
    "không sửa ⇒ theo lượt",
  );
  const ed = effectiveRender(snap, "m1", { musicId: null, voiceover: true, voice: "cedar", burnSubtitles: false });
  assert.equal(ed.musicId, null, "video bỏ nhạc dù lượt có nhạc");
  assert.equal(ed.voiceover, true);
  assert.equal(ed.voice, "cedar");
  assert.equal(renderJobKey("v1", 0), "render:v1", "lần 0 giữ khoá cũ — việc đã có không bị xếp lại");
  assert.equal(renderJobKey("v1", 2), "render:v1:r2");

  // Chữ không tràn: mỗi dòng ≤ số ký tự vừa khung.
  const per = lineChars(720, 46);
  assert.ok(per <= 22 && per >= 18, `cỡ 46 trên 720 px: ${per} ký tự`);
  const long = "Một chiếc đầm tạo điểm nhấn vòng eo thật tinh tế";
  for (const line of wrapText(long, per, 2).split("\n")) assert.ok(line.length <= per + 1, `dòng "${line}" dài hơn ${per}`);
  const plan = (showText: boolean) =>
    buildRenderArgs({
      clips: [{ file: "a.mp4", durationSec: 8, hasAudio: true }],
      scenes: [{ overlay: long, subtitle: "Lời đọc", voice: null }],
      hook: "Móc câu",
      cta: "Nhắn shop",
      music: null,
      keepNativeAudio: true,
      burnSubtitles: true,
      showText,
      width: 720,
      height: 1280,
      fontFile: "/f.ttf",
      output: "o.mp4",
    });
  const on = plan(true);
  assert.ok(on.textFiles.some((t) => t.name === "hook.txt") && on.textFiles.some((t) => t.name === "cta.txt"));
  assert.ok(!on.args[on.args.indexOf("-filter_complex") + 1].includes("h*0.12"), "móc câu không còn ở mép trên (đè lên mặt người mẫu)");
  const off = plan(false);
  assert.deepEqual(off.textFiles.map((t) => t.name), ["sub0.txt"], "tắt chữ ⇒ chỉ còn phụ đề");

  // Câu lệnh cảnh nói về CHIẾC VÁY, không nói về cơ thể — đo 28/09/2026: Omni chặn cảnh "tạo điểm nhấn vòng eo".
  const soft = softenScenePrompt("Model turns to show her slim waist, curves and bare legs in a tight sexy dress");
  assert.ok(!/\b(waist|curves|bare|legs|tight|sexy)\b/i.test(soft.replace(/waistline/gi, "")), soft);
  assert.ok(soft.includes("fitted waistline") && soft.includes("elegant"), soft);
  assert.ok(veoPrompt("slow turn").includes(MODEST_STYLE_NOTE), "câu lệnh gửi máy sinh video luôn kèm lời dặn trang nhã");

  console.log("✓ Video Scale sửa video (thuần): tuỳ chọn dựng · video ⊕ lượt · khoá theo lần sửa · chữ không tràn khung · tắt chữ");
}

const P = "vsedit-test-";

async function cleanup(db: Db) {
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, ids));
    const vIds = (await db.select({ id: schema.videoScaleVariants.id }).from(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids))).map((v) => v.id);
    if (vIds.length) await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
  }
  await db.delete(schema.videoScaleMusic).where(like(schema.videoScaleMusic.title, `${P}%`));
  if (ids.length) {
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, ids));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testVideoScaleEditDb(db: Db) {
  const ff = await ffmpegVersion();
  if (!ff) {
    console.log("  · CHƯA ĐO ĐƯỢC: máy này không có ffmpeg — dựng lại video không chạy thử được (image Docker kiểm ffmpeg lúc dựng).");
    return;
  }
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  const tmp = await mkdtemp(path.join(tmpdir(), "vsedit-"));
  await cleanup(db);
  try {
    const png = path.join(tmp, "src.png");
    assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=600x800:rate=1", "-frames:v", "1", png], { timeoutMs: 30_000 })).code, 0);
    const voiceFile = path.join(tmp, "v.m4a");
    assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", voiceFile], { timeoutMs: 30_000 })).code, 0);
    const voiceBytes = new Uint8Array(await readFile(voiceFile));

    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người sửa", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Người sửa" };
    await db.insert(schema.products).values({ id: `${P}p`, name: "Đầm sửa video" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}p`, retailPrice: 499_000, retailPriceAfterDiscount: 499_000, color: "Đỏ", size: "M" });
    const img = await storeCreativeImage(db, new Uint8Array(await readFile(png)));
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}p`, imageId: img.id, title: "ảnh thật" });
    const cfg = { enabled: true, provider: "OMNI", clipSeconds: 4, scenesPerVariant: 2, aiScenes: 0, voiceover: false, burnSubtitles: false, dailyUsdCap: 1 };
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify(cfg) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}photo`], status: "PRODUCING", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 1, configSnapshot: cfg })
      .returning({ id: schema.videoScaleRuns.id });
    const script = { angle: "OCCASION", hook: "Đi tiệc là nổi", scenes: [{ prompt: "p0", overlay: "Dáng suông tôn eo", voiceover: "" }, { prompt: "p1", overlay: "Màu đỏ sang", voiceover: "" }], cta: "Nhắn shop ngay" };
    const [v] = await db.insert(schema.videoScaleVariants).values({ runId: run.id, productId: `${P}p`, seq: 1, angle: "OCCASION", angleVocabVersion: 1, script, sourceId: `${P}photo`, status: "SCRIPTED" }).returning({ id: schema.videoScaleVariants.id });
    for (const i of [0, 1]) await enqueueJob(db, { kind: "CLIP", key: `${P}clip:${v.id}:${i}`, runId: run.id, variantId: v.id, sceneIndex: i, isTest: false });

    let providerCalls = 0;
    const ttsCalls: { text: string; voice: string }[] = [];
    const font = (await resolveFontFile()) ?? (await resolveFontFile("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")) ?? (await resolveFontFile("C:/Windows/Fonts/arialbd.ttf")) ?? "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf";
    const deps: VideoScaleDeps = {
      provider: () => {
        providerCalls += 1;
        throw new Error("không được gọi máy sinh clip khi sửa video");
      },
      ffmpegVersion: async () => ff,
      fontFile: async () => font,
      tts: async (_db, input) => {
        ttsCalls.push({ text: input.text, voice: input.voice });
        return voiceBytes;
      },
      visual: async () => ({ ran: true, checks: VIDEO_QC_CHECKS.map((check) => ({ check, result: "PASS" as const, note: "khớp" })), summary: "khớp", model: "qc-thử", costUsd: 0.002 }),
    };
    const J = schema.videoScaleJobs;
    const V = schema.videoScaleVariants;
    const tick = async () => {
      for (let i = 0; i < 4; i += 1) {
        await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(J.runId, run.id));
        await runVideoScaleTick(db, { deps, budgetMs: 60_000 });
      }
    };
    await tick();
    let [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "REVIEW", `bản đầu dựng xong: ${row.error}`);
    const firstFinal = row.finalAssetId;

    // Nhạc CÓ QUYỀN trong thư viện.
    const musicAsset = await storeAsset(db, { kind: "MUSIC", bytes: voiceBytes, contentType: "audio/mp4", runId: null });
    const [m] = await db.insert(schema.videoScaleMusic).values({ title: `${P}nhạc`, licenseNote: "Nhạc tự làm, có quyền dùng", assetId: musicAsset.id }).returning({ id: schema.videoScaleMusic.id });

    // Chữ nói chất liệu ⇒ từ chối (cùng bộ kiểm của kịch bản).
    const bad = await rerenderVideoVariant(db, v.id, { hook: "Đầm lụa cao cấp", cta: script.cta, scenes: script.scenes.map((s) => ({ overlay: s.overlay, voiceover: "" })), options: {} }, actor);
    assert.ok(!bad.ok && bad.error.includes("Chữ chưa qua kiểm"), bad.ok ? "" : bad.error);

    // Sửa: móc câu mới, bật giọng đọc (lời chỉ ở cảnh 1), chọn nhạc, tắt phụ đề.
    const edit = { hook: "Mặc đi tiệc là được khen", cta: "Nhắn shop giữ size", scenes: [{ overlay: "Tôn dáng, gọn eo", voiceover: "Đầm đỏ tôn dáng, đi tiệc là nổi." }, { overlay: "", voiceover: "" }], options: { voiceover: true, voice: "cedar", musicId: m.id, musicVolume: 0.12, burnSubtitles: false } };
    const r1 = await rerenderVideoVariant(db, v.id, edit, actor);
    assert.ok(r1.ok, r1.ok ? "" : r1.error);
    if (r1.ok) assert.equal(r1.tts, 1, "chỉ cảnh CÓ lời mới tạo giọng đọc");
    [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "GENERATING");
    assert.equal(row.renderRev, 1);
    assert.equal(row.reviewedAt, null, "bản cũ đã duyệt / chưa duyệt đều phải duyệt lại");
    await tick();
    [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "REVIEW", `dựng lại xong ⇒ chờ duyệt: ${row.error}`);
    assert.notEqual(row.finalAssetId, firstFinal, "bản hoàn chỉnh MỚI");
    assert.equal((row.script as { hook: string }).hook, "Mặc đi tiệc là được khen");
    assert.deepEqual(ttsCalls, [{ text: "Đầm đỏ tôn dáng, đi tiệc là nổi.", voice: "cedar" }]);
    assert.equal(providerCalls, 0, "sửa video không gọi máy sinh clip");
    const keys = (await db.select({ key: J.idempotencyKey, kind: J.kind }).from(J).where(eq(J.variantId, v.id))).map((x) => x.key);
    assert.ok(keys.includes(`render:${v.id}`) && keys.includes(`render:${v.id}:r1`), "mỗi lần dựng là một việc riêng");

    // Sửa lần hai KHÔNG đổi lời ⇒ không tạo giọng lại.
    const r2 = await rerenderVideoVariant(db, v.id, { ...edit, cta: "Nhắn shop" }, actor);
    assert.ok(r2.ok && r2.tts === 0, r2.ok ? `tts ${r2.tts}` : r2.error);
    await tick();
    assert.equal(ttsCalls.length, 1);

    // Nhân bản: video MỚI từ đúng các clip đã trả tiền — không gọi máy sinh clip, tiền clip 0, video gốc giữ nguyên.
    const finalBeforeClone = (await db.select().from(V).where(eq(V.id, v.id)))[0].finalAssetId;
    const c1 = await cloneVideoVariant(db, v.id, { ...edit, hook: "Bản nhân: đi làm cũng đẹp", scenes: [{ overlay: "Thanh lịch", voiceover: "" }, { overlay: "", voiceover: "" }], options: { voiceover: false, musicId: null } }, actor);
    assert.ok(c1.ok, c1.ok ? "" : c1.error);
    if (c1.ok) {
      assert.equal(c1.tts, 0);
      await tick();
      const [cv] = await db.select().from(V).where(eq(V.id, c1.variantId));
      assert.equal(cv.status, "REVIEW", `bản nhân dựng xong: ${cv.error}`);
      assert.equal(cv.seq, 2);
      assert.notEqual(cv.finalAssetId, finalBeforeClone);
      const cloneClips = await db.select().from(J).where(eq(J.variantId, c1.variantId));
      assert.ok(cloneClips.filter((x) => x.kind === "CLIP").every((x) => x.costUsd === 0), "clip dùng chung, tiền không cộng hai lần");
      assert.equal((await db.select().from(V).where(eq(V.id, v.id)))[0].finalAssetId, finalBeforeClone, "video gốc giữ nguyên");
      assert.equal(providerCalls, 0, "nhân bản không gọi máy sinh clip");
    }
    const bad2 = await cloneVideoVariant(db, v.id, { ...edit, hook: "Đầm lụa" }, actor);
    assert.ok(!bad2.ok, "chữ nói chất liệu ⇒ từ chối, không để lại video rác");
    assert.equal((await db.select().from(V).where(eq(V.runId, run.id))).length, 2);

    // Đã lên Reel ⇒ không sửa đè.
    await db.insert(schema.videoScalePosts).values({ variantId: v.id, productId: `${P}p`, pageId: "9200000000999", status: "PUBLISHED", caption: "x", fbVideoId: "1", publishedAt: new Date() });
    const r3 = await rerenderVideoVariant(db, v.id, edit, actor);
    assert.ok(!r3.ok && r3.error.includes("Reel"), r3.ok ? "" : r3.error);

    console.log("✓ Video Scale sửa video (CSDL + ffmpeg thật): dựng lại ra bản mới, quay lại chờ duyệt · giọng đọc chỉ cho cảnh có lời, không tạo lại khi lời không đổi · không gọi máy sinh clip · nhân bản dùng lại clip, tiền clip 0, gốc giữ nguyên · chữ nói chất liệu ⇒ từ chối · đã lên Reel ⇒ từ chối");
  } finally {
    await cleanup(db);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
