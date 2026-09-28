import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  DEFAULT_SUB_STYLE,
  DEFAULT_TEXT_STYLE,
  TEXT_BOXES,
  TEXT_COLORS,
  TEXT_Y_MAX,
  TEXT_Y_MIN,
  VIDEO_COLOR_FILTERS,
  VIDEO_QC_CHECKS,
  VIDEO_SCALE_CONFIG_KEY,
  VIDEO_TRANSITIONS,
  effectiveRender,
  normalizeRenderOptions,
  normalizeSceneOrder,
  normalizeTextStyle,
  normalizeVideoScaleConfig,
} from "@/lib/constants/video-scale";
import { storeCreativeImage } from "@/lib/creative/images";
import { buildRenderArgs, ffmpegVersion, resolveFontFile, runTool } from "@/lib/video-scale/ffmpeg";
import { rerenderVideoVariant, runVideoScaleTick, storeVideoVoice, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { enqueueJob } from "@/lib/video-scale/queue";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — TRÌNH SỬA VIDEO CHUYÊN SÂU ═══════════
 *
 * Thuần: kiểu chữ / chuyển cảnh / bộ lọc từ nguồn không tin được (khoá lạ bị bỏ, vị trí kẹp khoảng) · thứ tự cảnh (trùng / ngoài
 * khoảng ⇒ bỏ) · bộ dựng: chuyển cảnh `xfade` đặt ĐÚNG mốc (Σ độ dài trước − i·D) và video ngắn đi (n−1)·D · bộ lọc màu chèn
 * trước chữ (chữ không bị đổi màu) · kiểu chữ ra đúng font / màu / nền / vị trí · giọng tự thu vào bộ trộn · chuỗi bộ lọc trong
 * bảng hằng không chứa ký tự lạ (không bao giờ nhận chuỗi của người).
 * CSDL + ffmpeg thật: đổi cảnh bằng ảnh + bỏ cảnh + đảo thứ tự + chuyển cảnh + lọc màu + kiểu chữ + giọng tự thu ⇒ dựng ra bản
 * mới đúng độ dài, QC kỹ thuật đạt, KHÔNG gọi máy sinh clip, KHÔNG tạo giọng AI · thứ tự sai / giọng của lượt khác / ảnh của mã
 * khác ⇒ từ chối.
 */

export function testVideoScaleEditorPure() {
  // Kiểu chữ: khoá lạ bị bỏ, vị trí kẹp khoảng cho phép.
  assert.deepEqual(normalizeTextStyle({ font: "COMIC", size: "L", color: "YELLOW", box: "BRAND", y: 2, junk: 1 }), { size: "L", color: "YELLOW", box: "BRAND", y: TEXT_Y_MAX });
  assert.equal(normalizeTextStyle({ y: -1 })?.y, TEXT_Y_MIN);
  assert.equal(normalizeTextStyle({ font: "x" }), undefined, "không còn khoá hợp lệ ⇒ không có kiểu riêng");
  assert.equal(normalizeTextStyle("SANS"), undefined);

  // Thứ tự cảnh.
  assert.deepEqual(normalizeSceneOrder([2, 0]), [2, 0]);
  assert.equal(normalizeSceneOrder([0, 0]), undefined, "trùng cảnh ⇒ bỏ");
  assert.equal(normalizeSceneOrder([0, 3], 3), undefined, "ngoài khoảng ⇒ bỏ");
  assert.equal(normalizeSceneOrder([]), undefined, "rỗng ⇒ thứ tự gốc (không bao giờ video 0 cảnh)");
  assert.equal(normalizeSceneOrder([0.5]), undefined);

  const opts = normalizeRenderOptions({ transition: "FADE", filter: "BW", text: { color: "PINK" }, sub: { y: 0.7 }, sceneOrder: [1, 0], voiceAssetId: "abcdef12-3456", junk: "x" });
  assert.deepEqual(opts, { transition: "FADE", filter: "BW", text: { color: "PINK" }, sub: { y: 0.7 }, sceneOrder: [1, 0], voiceAssetId: "abcdef12-3456" });
  assert.deepEqual(normalizeRenderOptions({ transition: "SPIN", filter: "x;rm -rf", voiceAssetId: "../etc" }), {}, "giá trị lạ bị bỏ hết");
  assert.deepEqual(normalizeRenderOptions({ voiceAssetId: null }), { voiceAssetId: null });

  const snap = normalizeVideoScaleConfig({});
  const eff = effectiveRender(snap, null, opts);
  assert.deepEqual(eff.text, { ...DEFAULT_TEXT_STYLE, color: "PINK" }, "kiểu riêng đè lên mặc định");
  assert.deepEqual(eff.sub, { ...DEFAULT_SUB_STYLE, y: 0.7 });
  const plain = effectiveRender(snap, null, {});
  assert.equal(plain.transition, "NONE");
  assert.equal(plain.filter, "NONE");
  assert.equal(plain.sceneOrder, null);
  assert.equal(plain.voiceAssetId, null);

  // Bảng hằng đi thẳng vào chuỗi bộ lọc ffmpeg — chỉ ký tự an toàn.
  for (const f of Object.values(VIDEO_COLOR_FILTERS)) assert.match(f.ff, /^[a-z0-9=.:,_-]*$/, f.ff);
  for (const t of Object.values(VIDEO_TRANSITIONS)) if (t.xfade) assert.match(t.xfade, /^[a-z]+$/, t.xfade);
  for (const c of Object.values(TEXT_COLORS)) assert.match(c.hex, /^[0-9A-F]{6}$/, c.hex);
  for (const b of Object.values(TEXT_BOXES)) if (b.color) assert.match(b.color, /^(black|white|0x[0-9A-F]{6})@0\.\d+$/, b.color);

  const base = {
    scenes: [
      { overlay: "Cảnh một", subtitle: "Lời một", voice: null },
      { overlay: "Cảnh hai", subtitle: "Lời hai", voice: null },
      { overlay: "Cảnh ba", subtitle: "Lời ba", voice: null },
    ],
    hook: "Móc câu",
    cta: "Nhắn shop",
    music: null,
    keepNativeAudio: true,
    burnSubtitles: true,
    width: 720,
    height: 1280,
    fontFile: "/f/DejaVuSans-Bold.ttf",
    output: "o.mp4",
  };
  const clips = [0, 1, 2].map((i) => ({ file: `c${i}.mp4`, durationSec: 4, hasAudio: true }));

  // Cắt thẳng: nối bằng concat, mốc cảnh cộng dồn.
  const cut = buildRenderArgs({ ...base, clips });
  const cutGraph = cut.args[cut.args.indexOf("-filter_complex") + 1];
  assert.ok(cutGraph.includes("concat=n=3") && !cutGraph.includes("xfade"), cutGraph);
  assert.deepEqual(cut.sceneStarts, [0, 4, 8]);
  assert.equal(cut.totalSec, 12);
  assert.ok(cut.args.includes("veryfast"), "bản chính thức: preset veryfast");

  // Chuyển cảnh 0,4 giây: cảnh i bắt đầu ở Σ trước − i·D; video ngắn đi 2 × 0,4.
  const fade = buildRenderArgs({
    ...base,
    clips,
    transition: { xfade: "fade", seconds: 0.4 },
    colorFilter: VIDEO_COLOR_FILTERS.BW.ff,
    textStyle: { fontFile: "/f/DejaVuSerif-Bold.ttf", sizeK: 1.2, colorHex: "FFE14D", boxColor: "0xE8541E@0.88", y: 0.3 },
    subStyle: { fontFile: "/f/DejaVuSans.ttf", sizeK: 1, colorHex: "111111", boxColor: null, y: 0.7 },
    voiceTrack: { file: "voice.m4a", durationSec: 20 },
    preset: "ultrafast",
  });
  const g = fade.args[fade.args.indexOf("-filter_complex") + 1];
  assert.deepEqual(fade.sceneStarts, [0, 3.6, 7.2]);
  assert.equal(fade.totalSec, 11.2);
  assert.ok(g.includes("xfade=transition=fade:duration=0.4:offset=3.6") && g.includes("xfade=transition=fade:duration=0.4:offset=7.2"), g);
  assert.equal(g.split("acrossfade=").length - 1, 2, "âm thanh đan chéo ở đúng 2 chỗ nối");
  assert.ok(!g.includes("concat="), "có chuyển cảnh thì không concat");
  assert.ok(g.includes("[vc]hue=s=0[vg]") && g.includes("[vg]drawtext="), "lọc màu TRƯỚC khi vẽ chữ — chữ giữ đúng màu đã chọn");
  assert.ok(g.includes("fontcolor=0xFFE14D") && g.includes("boxcolor=0xE8541E@0.88") && g.includes("y=h*0.3"), "kiểu chữ trên hình");
  assert.ok(g.includes("DejaVuSerif-Bold.ttf") && g.includes("DejaVuSans.ttf"), "mỗi kiểu một font");
  assert.ok(g.includes("fontcolor=0x111111") && g.includes("bordercolor=white@0.85") && g.includes("y=h*0.7"), "phụ đề chữ tối ⇒ viền sáng, đúng vị trí");
  const sizes = (g.match(/fontsize=\d+/g) ?? []).join(" ");
  for (const s of ["fontsize=62", "fontsize=55", "fontsize=70", "fontsize=36"]) assert.ok(sizes.includes(s), `cỡ Lớn = 1,2 × (móc câu 52 · chữ cảnh 46 · CTA 58), phụ đề cỡ Vừa 36 — có: ${sizes}`);
  assert.ok(fade.args.includes("voice.m4a") && g.includes("[vt]") && g.includes("atrim=duration=11.2"), "giọng tự thu cắt theo độ dài video");
  assert.ok(fade.args.includes("ultrafast"));
  assert.equal(fade.args[fade.args.indexOf("-t") + 1], "11.2");

  // Cảnh ngắn: chuyển cảnh không ăn quá 1/3 cảnh.
  const short = buildRenderArgs({ ...base, scenes: base.scenes.slice(0, 2), clips: [0, 1].map((i) => ({ file: `c${i}.mp4`, durationSec: 0.6, hasAudio: false })), transition: { xfade: "fade", seconds: 0.4 } });
  assert.equal(short.totalSec, 1, "D = min(0,4; 0,6/3) = 0,2 ⇒ 1,2 − 0,2");

  console.log("✓ Video Scale trình sửa (thuần): kiểu chữ / thứ tự cảnh từ nguồn lạ bị bỏ · chuyển cảnh đúng mốc, video ngắn đi (n−1)·D · lọc màu trước chữ · font / màu / nền / vị trí · giọng tự thu · bảng hằng chỉ ký tự an toàn");
}

const P = "vsed2-test-";

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
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testVideoScaleEditorDb(db: Db) {
  const ff = await ffmpegVersion();
  if (!ff) {
    console.log("  · CHƯA ĐO ĐƯỢC: máy này không có ffmpeg — trình sửa video chuyên sâu không chạy thử được (image Docker kiểm ffmpeg lúc dựng).");
    return;
  }
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  const tmp = await mkdtemp(path.join(tmpdir(), "vsed2-"));
  await cleanup(db);
  try {
    const png = path.join(tmp, "a.png");
    const png2 = path.join(tmp, "b.png");
    assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=600x800:rate=1", "-frames:v", "1", png], { timeoutMs: 30_000 })).code, 0);
    assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:size=600x800:rate=1", "-frames:v", "1", png2], { timeoutMs: 30_000 })).code, 0);
    const voiceFile = path.join(tmp, "v.m4a");
    assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "aac", voiceFile], { timeoutMs: 30_000 })).code, 0);
    const voiceBytes = new Uint8Array(await readFile(voiceFile));

    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người sửa", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Người sửa" };
    await db.insert(schema.products).values([
      { id: `${P}p`, name: "Đầm sửa sâu" },
      { id: `${P}other`, name: "Mã khác" },
    ]);
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}p`, retailPrice: 499_000, retailPriceAfterDiscount: 499_000, color: "Đỏ", size: "M" });
    const img = await storeCreativeImage(db, new Uint8Array(await readFile(png)));
    const img2 = await storeCreativeImage(db, new Uint8Array(await readFile(png2)));
    await db.insert(schema.creativeSources).values([
      { id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}p`, imageId: img.id, title: "ảnh thật" },
      { id: `${P}photo2`, kind: "PRODUCT_PHOTO", productId: `${P}p`, imageId: img2.id, title: "ảnh thật 2" },
      { id: `${P}foreign`, kind: "PRODUCT_PHOTO", productId: `${P}other`, imageId: img2.id, title: "ảnh mã khác" },
    ]);
    const cfg = { enabled: true, provider: "OMNI", clipSeconds: 4, scenesPerVariant: 3, aiScenes: 0, voiceover: false, burnSubtitles: false, dailyUsdCap: 1 };
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify(cfg) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}photo`], status: "PRODUCING", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 1, configSnapshot: cfg })
      .returning({ id: schema.videoScaleRuns.id });
    const [otherRun] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}photo`], status: "DONE", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 1, configSnapshot: cfg })
      .returning({ id: schema.videoScaleRuns.id });
    const script = {
      angle: "OCCASION",
      hook: "Đi tiệc là nổi",
      scenes: [
        { prompt: "p0", overlay: "Dáng suông", voiceover: "Lời cảnh một" },
        { prompt: "p1", overlay: "Màu đỏ sang", voiceover: "" },
        { prompt: "p2", overlay: "Tôn dáng", voiceover: "Lời cảnh ba" },
      ],
      cta: "Nhắn shop ngay",
    };
    const [v] = await db.insert(schema.videoScaleVariants).values({ runId: run.id, productId: `${P}p`, seq: 1, angle: "OCCASION", angleVocabVersion: 1, script, sourceId: `${P}photo`, status: "SCRIPTED" }).returning({ id: schema.videoScaleVariants.id });
    for (const i of [0, 1, 2]) await enqueueJob(db, { kind: "CLIP", key: `${P}clip:${v.id}:${i}`, runId: run.id, variantId: v.id, sceneIndex: i, isTest: false });

    let providerCalls = 0;
    let ttsCalls = 0;
    const font = (await resolveFontFile()) ?? (await resolveFontFile("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")) ?? (await resolveFontFile("C:/Windows/Fonts/arialbd.ttf")) ?? "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf";
    const deps: VideoScaleDeps = {
      provider: () => {
        providerCalls += 1;
        throw new Error("không được gọi máy sinh clip khi sửa video");
      },
      ffmpegVersion: async () => ff,
      fontFile: async () => font,
      tts: async () => {
        ttsCalls += 1;
        return voiceBytes;
      },
      visual: async () => ({ ran: true, checks: VIDEO_QC_CHECKS.map((check) => ({ check, result: "PASS" as const, note: "khớp" })), summary: "khớp", model: "qc-thử", costUsd: 0.002 }),
    };
    const J = schema.videoScaleJobs;
    const V = schema.videoScaleVariants;
    const tick = async () => {
      for (let i = 0; i < 5; i += 1) {
        await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(J.runId, run.id));
        await runVideoScaleTick(db, { deps, budgetMs: 90_000 });
      }
    };
    await tick();
    let [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "REVIEW", `bản đầu dựng xong: ${row.error}`);
    const firstFinal = row.finalAssetId;

    const texts = { hook: script.hook, cta: script.cta, scenes: script.scenes.map((s) => ({ overlay: s.overlay, voiceover: s.voiceover })) };

    // Giọng tự thu: lưu được cho video này; tệp của lượt KHÁC thì không dùng được.
    const tiny = await storeVideoVoice(db, v.id, { bytes: new Uint8Array(10), contentType: "audio/mp4" });
    assert.ok(!tiny.ok, "tệp rỗng ⇒ từ chối");
    const voice = await storeVideoVoice(db, v.id, { bytes: voiceBytes, contentType: "audio/mp4" });
    assert.ok(voice.ok, voice.ok ? "" : voice.error);
    const foreignVoice = await storeAsset(db, { kind: "VOICE", bytes: voiceBytes, contentType: "audio/mp4", runId: otherRun.id });
    const badVoice = await rerenderVideoVariant(db, v.id, { ...texts, options: { voiceAssetId: foreignVoice.id } }, actor);
    assert.ok(!badVoice.ok && badVoice.error.includes("giọng tự thu"), badVoice.ok ? "" : badVoice.error);

    // Thứ tự cảnh ngoài khoảng ⇒ từ chối; ảnh của mã khác ⇒ từ chối.
    const badOrder = await rerenderVideoVariant(db, v.id, { ...texts, options: { sceneOrder: [0, 3] } }, actor);
    assert.ok(!badOrder.ok && badOrder.error.includes("Thứ tự cảnh"), badOrder.ok ? "" : badOrder.error);
    const badPhoto = await rerenderVideoVariant(db, v.id, { ...texts, options: {}, replacePhotos: [{ scene: 1, sourceId: `${P}foreign` }] }, actor);
    assert.ok(!badPhoto.ok && badPhoto.error.includes("không phải ảnh sản phẩm"), badPhoto.ok ? "" : badPhoto.error);
    assert.equal((await db.select().from(V).where(eq(V.id, v.id)))[0].renderRev, 0, "lượt sửa bị từ chối không đổi gì");

    // Sửa sâu: bỏ cảnh 2, đảo thứ tự (cảnh 3 lên đầu), đổi cảnh 3 bằng ảnh khác, mờ dần, đen trắng, chữ vàng nền cam ở 30%,
    // phụ đề bật ở 70%, giọng tự thu (bật giọng AI cũng KHÔNG tạo giọng AI).
    const ok = await rerenderVideoVariant(
      db,
      v.id,
      {
        ...texts,
        options: { voiceover: true, burnSubtitles: true, transition: "FADE", filter: "BW", text: { color: "YELLOW", box: "BRAND", y: 0.3, font: "SERIF_BOLD" }, sub: { y: 0.7 }, sceneOrder: [2, 0], voiceAssetId: voice.ok ? voice.assetId : null },
        replacePhotos: [{ scene: 2, sourceId: `${P}photo2` }],
      },
      actor,
    );
    assert.ok(ok.ok, ok.ok ? "" : ok.error);
    if (ok.ok) assert.equal(ok.tts, 0, "giọng tự thu thay giọng AI — không tạo đoạn nào");
    [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "GENERATING", "đổi cảnh ⇒ dựng cảnh ảnh động trước");
    await tick();
    [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "REVIEW", `dựng lại xong: ${row.error} · QC ${JSON.stringify(row.qc).slice(0, 300)}`);
    assert.notEqual(row.finalAssetId, firstFinal);
    assert.notEqual(row.qcVerdict, "FAIL");
    assert.equal(providerCalls, 0, "không gọi máy sinh clip");
    assert.equal(ttsCalls, 0, "không tạo giọng AI");

    const photoJobs = await db.select().from(J).where(and(eq(J.variantId, v.id), eq(J.kind, "CLIP"), eq(J.sceneIndex, 2)));
    const replaced = photoJobs.find((j) => (j.request as { sourceId?: string }).sourceId === `${P}photo2`);
    assert.ok(replaced && replaced.status === "SUCCEEDED" && replaced.costUsd === 0, `cảnh 3 dựng lại từ ảnh đã chọn, 0 đồng: ${JSON.stringify(photoJobs.map((j) => [j.status, j.request]))}`);

    // Độ dài: 2 cảnh × 4 giây − 1 chỗ nối 0,4 giây ≈ 7,6 giây; QC so với ĐÚNG con số bộ dựng đã tính.
    assert.ok(row.durationMs !== null && Math.abs(row.durationMs - 7600) < 300, `độ dài ${row.durationMs} ms`);
    const [rj] = await db.select().from(J).where(and(eq(J.variantId, v.id), eq(J.kind, "RENDER"), eq(J.outputAssetId, row.finalAssetId as string)));
    assert.equal((rj.result as { plannedSec?: number }).plannedSec, 7.6);

    console.log("✓ Video Scale trình sửa (CSDL + ffmpeg thật): đổi cảnh bằng ảnh + bỏ cảnh + đảo thứ tự + mờ dần + đen trắng + kiểu chữ + giọng tự thu ⇒ bản mới 7,6 giây, QC đúng độ dài · 0 clip AI · 0 giọng AI · thứ tự sai / giọng lượt khác / ảnh mã khác ⇒ từ chối");
  } finally {
    await cleanup(db);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
