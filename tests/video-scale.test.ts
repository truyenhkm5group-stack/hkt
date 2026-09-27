import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  VIDEO_QC_CHECKS,
  VIDEO_SCALE_CONFIG_KEY,
  VIDEO_SCALE_HARD_LIMITS,
  clipCostUsd,
  fakeProviderAllowed,
  jaccard,
  normalizeVideoScaleConfig,
  retryDelayMs,
  scriptTokens,
  type VideoScript,
} from "@/lib/constants/video-scale";
import { storeCreativeImage } from "@/lib/creative/images";
import { buildRenderArgs, fakeClipArgs, ffmpegVersion, filterPath, parseProbe, qcFrameTimes, runTool, wrapText } from "@/lib/video-scale/ffmpeg";
import { planAngles, nearDuplicate } from "@/lib/video-scale/plan";
import { approveVideoVariant, createVideoRun, rejectVideoVariant, retryVideoJob, runVideoScaleTick, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { assertVideoPixelSafe, httpErrorKind, ProviderError, type ClipRequest, type PollResult, type VideoProvider } from "@/lib/video-scale/providers/types";
import { parseVeoOperation, veoRequestBody } from "@/lib/video-scale/providers/veo";
import { combineQc, technicalQc, visualVerdict, type VisualCheck } from "@/lib/video-scale/qc";
import { enqueueJob } from "@/lib/video-scale/queue";
import { batchProblems, scriptProblems, stripWrongPrices, veoPrompt, VEO_KEEP_PRODUCT } from "@/lib/video-scale/script";

/**
 * ═══════════ VIDEO SCALE — KIỂM THỬ ═══════════
 *
 * Phần THUẦN khoá: trần cấu hình chỉ làm hẹp · giá theo bảng · góc bán không nói điều không có dữ liệu · kịch bản không bịa
 * giá / size / màu / chất liệu / khuyến mãi · Veo nhận đúng hình dạng yêu cầu · QC không bao giờ ĐẠT khi không kiểm được.
 *
 * Phần CSDL chạy cả hàng đợi trên bộ giả (không gọi mạng): trần tiền ngày chặn clip thứ ba · lỗi không rõ đã tạo chưa
 * (`AMBIGUOUS`) KHÔNG tự gửi lại · dấu "đang gửi" còn lại sau khi tiến trình chết KHÔNG gửi lại · khoá chống trùng ·
 * video QC loại không duyệt được (kể cả sửa thẳng CSDL) · tự duyệt chỉ khi QC ĐẠT.
 *
 * Hậu kỳ và QC gọi ffmpeg THẬT. Máy không có ffmpeg ⇒ in "CHƯA ĐO ĐƯỢC" cho phần đó (AGENTS.md mục 65) — nền triển khai
 * (image Docker) có bước kiểm ffmpeg ngay lúc dựng nên thiếu ở đó là ĐỎ.
 */

const P = "vs-test-";

export function testVideoScalePure() {
  // ── Cấu hình: chỉ LÀM HẸP; trần chưa khai là null, không phải 0 ──
  const c0 = normalizeVideoScaleConfig({});
  assert.equal(c0.enabled, false, "mặc định TẮT");
  assert.equal(c0.dailyUsdCap, null, "chưa khai trần ⇒ null (không sinh), không phải 0");
  const c1 = normalizeVideoScaleConfig({ dailyUsdCap: 9999, scenesPerVariant: 99, providerConcurrency: 99, dailyClipCap: 99999, resolution: "1080p", clipSeconds: 4 });
  assert.equal(c1.dailyUsdCap, VIDEO_SCALE_HARD_LIMITS.maxVideoUsdPerDay, "trần cấu hình kẹp vào trần cứng");
  assert.equal(c1.scenesPerVariant, VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant);
  assert.equal(c1.providerConcurrency, VIDEO_SCALE_HARD_LIMITS.maxProviderConcurrency);
  assert.equal(c1.clipSeconds, 8, "1080p bắt buộc 8 giây (luật Veo)");
  assert.equal(normalizeVideoScaleConfig({ dailyUsdCap: 0 }).dailyUsdCap, null, "trần 0 / âm ⇒ CHƯA KHAI");
  assert.equal(normalizeVideoScaleConfig({ provider: "SORA" }).provider, "VEO", "nhà cung cấp lạ ⇒ VEO, không nhận tên tự do");
  assert.deepEqual(normalizeVideoScaleConfig({ policyLines: ["  Mua 2 freeship  ", "", 3, "a", "b", "c", "d", "e"] }).policyLines, ["Mua 2 freeship", "a", "b", "c", "d"], "tối đa 5 câu chính sách, bỏ dòng rỗng / không phải chữ");

  // ── Giá theo bảng công bố ──
  assert.equal(clipCostUsd("veo-3.1-fast-generate-preview", "720p", 8), 0.8);
  assert.equal(clipCostUsd("veo-3.1-generate-preview", "720p", 4), 1.6);
  assert.equal(clipCostUsd("veo-9-khong-co", "720p", 8), null, "model lạ ⇒ giá CHƯA BIẾT ⇒ không sinh");
  assert.ok(retryDelayMs(1) < retryDelayMs(2) && retryDelayMs(10) === 30 * 60_000, "lùi dần có trần 30 phút");
  assert.equal(fakeProviderAllowed("production", "1"), false, "bộ sinh giả KHÔNG BAO GIỜ chạy trên production");
  assert.equal(fakeProviderAllowed("development", "0"), false);
  assert.equal(fakeProviderAllowed("test", "1"), true);

  // ── Chọn góc: người chỉ định trước, góc thiếu dữ liệu bị bỏ có lý do, không lặp, tất định ──
  const facts = { priceKnown: false, colorCount: 1 };
  const plan = planAngles({ n: 4, requested: ["PRICE_VALUE", "OCCASION", "LẠ", "OCCASION"], stats: [], facts, seed: "s1" });
  assert.equal(plan.angles[0], "OCCASION", "góc người chỉ định (dùng được) đứng đầu");
  assert.ok(!plan.angles.includes("PRICE_VALUE"), "không có giá ⇒ không góc Giá tốt");
  assert.ok(!plan.angles.includes("COLOR_OPTIONS"), "một màu ⇒ không góc Nhiều màu");
  assert.equal(new Set(plan.angles).size, plan.angles.length, "không lặp góc khi còn góc khác");
  assert.equal(plan.angles.length, 4);
  assert.deepEqual(plan.dropped.map((d) => d.angle).sort(), ["LẠ", "PRICE_VALUE"]);
  assert.deepEqual(planAngles({ n: 4, requested: [], stats: [], facts, seed: "s1" }).angles, planAngles({ n: 4, requested: [], stats: [], facts, seed: "s1" }).angles, "tất định theo hạt giống");
  // Sổ học: góc thắng nhiều được ưu tiên rõ rệt.
  const stats = [
    { angle: "FABRIC_FLOW" as const, tried: 40, success: 38 },
    { angle: "OCCASION" as const, tried: 40, success: 1 },
  ];
  let firstIsWinner = 0;
  for (let i = 0; i < 40; i += 1) if (planAngles({ n: 1, requested: [], stats, facts, seed: `h${i}` }).angles[0] === "FABRIC_FLOW") firstIsWinner += 1;
  assert.ok(firstIsWinner >= 20, `góc thắng 38/40 phải được chọn nhiều (thấy ${firstIsWinner}/40)`);

  // ── Kịch bản: không bịa ──
  const f = { name: "Đầm suông Q005", priceVnd: 499_000, sizes: ["M", "L", "XL"], colors: ["Đen", "Be"], policyLines: [] as string[] };
  const good: VideoScript = {
    angle: "COVERS_FLAWS",
    hook: "Bắp tay to vẫn tự tin!",
    scenes: [
      { prompt: "model turns slowly", overlay: "Tay lỡ che bắp tay", voiceover: "Dáng suông tay lỡ, che bắp tay khéo." },
      { prompt: "model walks", overlay: "Chỉ 499k", voiceover: "Có size M đến XL, màu đen và be." },
    ],
    cta: "Nhắn shop chọn size",
  };
  assert.deepEqual(scriptProblems(good, { angle: "COVERS_FLAWS", scenes: 2 }, f), [], "kịch bản đúng sự thật không có lỗi");
  const bad: VideoScript = {
    ...good,
    hook: "Lụa cao cấp giảm giá sốc",
    scenes: [
      { prompt: "x", overlay: "Chỉ 399k", voiceover: "Có size S cho bạn nhỏ" },
      { prompt: "y", overlay: "Màu hồng xinh", voiceover: "Freeship toàn quốc" },
    ],
  };
  const pb = scriptProblems(bad, { angle: "COVERS_FLAWS", scenes: 2 }, f).join(" | ");
  for (const needle of ["399k", "size S", "lụa", "giảm giá", "hồng", "freeship"]) assert.ok(pb.toLowerCase().includes(needle.toLowerCase()), `phải bắt "${needle}" — thấy: ${pb}`);
  assert.equal(
    scriptProblems({ ...good, scenes: [good.scenes[0], { prompt: "y", overlay: "Freeship khi mua 2", voiceover: "" }] }, { angle: "COVERS_FLAWS", scenes: 2 }, { ...f, policyLines: ["Mua 2 sản phẩm freeship toàn quốc"] }).length,
    0,
    "khuyến mãi CÓ trong chính sách đã khai thì được nói",
  );
  assert.ok(scriptProblems(good, { angle: "COVERS_FLAWS", scenes: 2 }, { ...f, priceVnd: null }).some((p) => p.includes("499k")), "giá chưa rõ ⇒ mọi con số giá đều sai");
  assert.ok(!stripWrongPrices(bad, 499_000).scenes[0].overlay.includes("399"), "gỡ giá sai");
  assert.ok(scriptProblems(good, { angle: "OCCASION", scenes: 3 }, f).length >= 2, "sai góc / sai số cảnh bị bắt");
  // Chống lặp: hai kịch bản gần như y hệt.
  const dup = batchProblems([good, { ...good }], { angles: ["COVERS_FLAWS", "COVERS_FLAWS"], scenes: 2, facts: { ...f, productId: "p", code: "Q005", styleSummary: "", sourceSummary: "" }, existing: [] });
  assert.ok(dup.some((p) => p.includes("gần giống")), "kịch bản thứ hai gần giống kịch bản thứ nhất ⇒ bắt");
  assert.equal(jaccard(scriptTokens(good), scriptTokens(good)), 1);
  assert.equal(nearDuplicate(scriptTokens(good), [new Set(["khac", "han"])]), null);
  assert.ok(veoPrompt("model walks").endsWith(VEO_KEEP_PRODUCT), "câu giữ sản phẩm + cấm chữ do MÃ gắn, không nhờ LLM nhớ");

  // ── Veo: hình dạng yêu cầu + đọc thao tác ──
  const req: ClipRequest = { model: "veo-3.1-fast-generate-preview", prompt: "p", negativePrompt: "text", image: { kind: "PRODUCT_PHOTO", bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }, seconds: 6, resolution: "720p" };
  const body = veoRequestBody(req) as { instances: { image: { inlineData: { mimeType: string; data: string } } }[]; parameters: Record<string, unknown> };
  assert.equal(body.parameters.aspectRatio, "9:16");
  assert.equal(body.parameters.personGeneration, "allow_adult", "image-to-video chỉ nhận allow_adult");
  assert.equal(body.parameters.durationSeconds, "6");
  assert.equal(body.instances[0].image.inlineData.data, "AQID");
  assert.equal((veoRequestBody({ ...req, resolution: "1080p" }) as { parameters: Record<string, unknown> }).parameters.durationSeconds, "8");
  assert.deepEqual(parseVeoOperation({ name: "x" }), { state: "RUNNING" });
  assert.deepEqual(parseVeoOperation({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/f" } }] } } }), { state: "DONE", videoUri: "https://generativelanguage.googleapis.com/f" });
  const rai = parseVeoOperation({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["person"] } } });
  assert.ok(rai.state === "FAILED" && rai.kind === "PERMANENT", "bộ lọc an toàn ⇒ không thử lại");
  const unavail = parseVeoOperation({ done: true, error: { code: 14, message: "unavailable" } }) as Extract<PollResult, { state: "FAILED" }>;
  assert.equal(unavail.kind, "TRANSIENT");
  assert.equal(httpErrorKind(429), "TRANSIENT");
  assert.equal(httpErrorKind(400), "PERMANENT");
  assert.throws(() => assertVideoPixelSafe({ kind: "OWN_AD", bytes: new Uint8Array([1]) }), /chỉ ảnh sản phẩm thật/, "ranh giới 1 kiểm LÚC CHẠY");
  assert.throws(() => assertVideoPixelSafe({ kind: "SPY", bytes: new Uint8Array([1]) }));

  // ── QC: không bao giờ ĐẠT khi không kiểm được ──
  const probe = parseProbe(
    JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 720, height: 1280, avg_frame_rate: "30/1" },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
      ],
      format: { duration: "16.02" },
    }),
  );
  const tech = technicalQc(probe, { width: 720, height: 1280, durationSec: 16, bytes: 1000 });
  assert.equal(tech.verdict, "PASS", tech.problems.join("; "));
  assert.equal(technicalQc({ ...probe, audioSampleRate: 44100 }, { width: 720, height: 1280, durationSec: 16, bytes: 1 }).verdict, "FAIL", "Reels cần 48 kHz");
  assert.equal(technicalQc({ ...probe, durationSec: 2 }, { width: 720, height: 1280, durationSec: 2, bytes: 1 }).verdict, "FAIL", "Reels cần ≥ 3 giây");
  const allPass: VisualCheck[] = VIDEO_QC_CHECKS.map((check) => ({ check, result: "PASS", note: "" }));
  assert.equal(visualVerdict(allPass), "PASS");
  assert.equal(visualVerdict(allPass.slice(1)), "FLAG", "thiếu một điểm ⇒ nghi ngờ, không đạt");
  assert.equal(visualVerdict([...allPass.slice(1), { check: "COLOR", result: "FAIL", note: "đổi màu" }]), "FAIL");
  assert.equal(combineQc(tech, { ran: false, reason: "không có khoá" }), "FLAG", "QC hình ảnh không chạy được ⇒ tối đa FLAG");
  assert.equal(combineQc({ ...tech, verdict: "FAIL" }, { ran: true, checks: allPass, summary: "", model: "m", costUsd: null }), "FAIL");

  // ── Hậu kỳ: chữ đi qua TỆP, không nhúng vào bộ lọc; giọng đọc đặt đúng mốc ──
  const plan2 = buildRenderArgs({
    clips: [
      { file: "a.mp4", durationSec: 8, hasAudio: true },
      { file: "b.mp4", durationSec: 8, hasAudio: false },
    ],
    scenes: [
      { overlay: "Giá: 499k 'hot' 100%", subtitle: "Câu 1", voice: { file: "v0.mp3", durationSec: 9 } },
      { overlay: "Cảnh 2", subtitle: "Câu 2", voice: null },
    ],
    hook: "Móc câu",
    cta: "Nhắn shop",
    music: { file: "m.mp3", volume: 0.18 },
    keepNativeAudio: true,
    burnSubtitles: true,
    width: 720,
    height: 1280,
    fontFile: "C:\\Windows\\Fonts\\arial.ttf",
    output: "out.mp4",
  });
  const fc = plan2.args[plan2.args.indexOf("-filter_complex") + 1];
  assert.ok(!fc.includes("499k") && !fc.includes("100%"), "chữ của người / mô hình KHÔNG nằm trong chuỗi bộ lọc");
  assert.ok(plan2.textFiles.some((t) => t.content.includes("499k 'hot' 100%")), "chữ nằm nguyên trong tệp");
  assert.ok(fc.includes("expansion=none"), "tắt khai triển %{…} của drawtext");
  assert.ok(fc.includes("anullsrc") && fc.includes("adelay=0|0") && fc.includes("atempo="), "clip không tiếng có âm câm; giọng đọc cảnh 1 ở mốc 0, dài hơn cảnh thì tăng tốc");
  assert.ok(plan2.args.includes("-stream_loop"), "nhạc lặp tới hết video");
  assert.equal(plan2.totalSec, 16);
  assert.equal(filterPath("C:\\Windows\\Fonts\\arial.ttf"), "'C\\:/Windows/Fonts/arial.ttf'");
  assert.throws(() => filterPath("/tmp/a'b.ttf"));
  assert.equal(wrapText("một hai ba bốn năm sáu bảy", 8, 2), "một hai\nba bốn…");
  assert.deepEqual(qcFrameTimes(0), []);
  assert.equal(qcFrameTimes(16).length, 4);

  console.log("✓ Video Scale (thuần): cấu hình chỉ làm hẹp · giá theo bảng · góc bán · kịch bản không bịa · Veo · QC · hậu kỳ");
}

// ───────────────────────────── CSDL ─────────────────────────────

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, 9, 9, 1, 2, 3]);
}

type FakeProviderState = { starts: number; polls: number; mode: "OK" | "AMBIGUOUS"; clip: Uint8Array };

function fakeProvider(st: FakeProviderState): VideoProvider {
  return {
    id: "VEO",
    async start() {
      st.starts += 1;
      if (st.mode === "AMBIGUOUS") throw new ProviderError("mất mạng giữa lời gọi tạo", "AMBIGUOUS");
      return { ref: `models/veo-3.1-fast-generate-preview/operations/op${st.starts}` };
    },
    async poll() {
      st.polls += 1;
      // Lượt hỏi đầu tiên của mỗi clip: còn chạy.
      return st.polls % 2 === 1 ? { state: "RUNNING" } : { state: "DONE", videoUri: "https://generativelanguage.googleapis.com/v" };
    },
    async download() {
      return st.clip;
    },
  };
}

function script(angle: VideoScript["angle"], n: number): VideoScript {
  return { angle, hook: `Móc câu ${angle} số ${n}`, scenes: [0, 1].map((i) => ({ prompt: `move ${i}`, overlay: `Chữ ${angle} ${i}`, voiceover: "" })), cta: "Nhắn shop" };
}

async function cleanup(db: Db) {
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    // Thứ tự theo khoá ngoại, KHÔNG gỡ `final_asset_id` bằng UPDATE — CHECK duyệt (đúng) chặn biến thể ĐÃ DUYỆT mất bản hoàn chỉnh.
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, ids));
    const vIds = (await db.select({ id: schema.videoScaleVariants.id }).from(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids))).map((v) => v.id);
    if (vIds.length) await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, ids));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
  }
  await db.delete(schema.videoScaleJobs).where(like(schema.videoScaleJobs.idempotencyKey, `${P}%`));
  await db.delete(schema.videoScaleSkus).where(like(schema.videoScaleSkus.productId, `${P}%`));
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.code, "VSTEST%"));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testVideoScaleDb(db: Db) {
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  await cleanup(db);
  const ff = await ffmpegVersion();
  const tmp = await mkdtemp(path.join(tmpdir(), "vs-test-"));
  try {
    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Chủ shop thử", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Chủ shop thử" };
    await db.insert(schema.products).values([
      { id: `${P}win`, name: "Đầm suông thử" },
      { id: `${P}lose`, name: "Áo chưa thắng" },
    ]);
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}win`, retailPrice: 499_000, retailPriceAfterDiscount: 499_000, color: "Đen", size: "M" });
    await db.insert(schema.productModels).values([
      { code: "VSTEST1", productId: `${P}win`, lifecycleState: "WINNER", registeredBy: "USER" },
      { code: "VSTEST2", productId: `${P}lose`, lifecycleState: "ADS_TESTING", registeredBy: "USER" },
    ]);
    const img = await storeCreativeImage(db, fakeJpeg(1));
    await db.insert(schema.creativeSources).values([
      { id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}win`, imageId: img.id, title: "ảnh thật" },
      { id: `${P}spy`, kind: "SPY", productId: `${P}win`, imageId: img.id, title: "đối thủ" },
      { id: `${P}photo-lose`, kind: "PRODUCT_PHOTO", productId: `${P}lose`, imageId: img.id, title: "ảnh" },
    ]);
    // 2 biến thể × 2 cảnh × 4 giây × 0,10 USD/giây = 0,40 USD/clip. Trần 1,00 USD ⇒ đúng HAI clip được gửi.
    const cfg = { enabled: true, provider: "VEO", model: "veo-3.1-fast-generate-preview", resolution: "720p", clipSeconds: 4, scenesPerVariant: 2, dailyUsdCap: 1.0, dailyClipCap: 40, providerConcurrency: 3, voiceover: false, burnSubtitles: true, keepNativeAudio: true, outputHeight: 1280 };
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify(cfg) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });

    // ── Tạo lượt: chỉ mã win, chỉ ảnh sản phẩm thật của đúng mã ──
    const notWin = await createVideoRun(db, { productId: `${P}lose`, sourceIds: [`${P}photo-lose`], variants: 2, angles: [], brief: "", musicId: null }, actor);
    assert.ok(!notWin.ok && notWin.error.includes("Thắng test"), "mã chưa khai thắng ⇒ từ chối");
    const spy = await createVideoRun(db, { productId: `${P}win`, sourceIds: [`${P}spy`], variants: 2, angles: [], brief: "", musicId: null }, actor);
    assert.ok(!spy.ok && spy.error.includes("ẢNH SẢN PHẨM THẬT"), "ảnh SPY không làm ảnh gốc");
    const run = await createVideoRun(db, { productId: `${P}win`, sourceIds: [`${P}photo`], variants: 2, angles: ["FLATTERING_FIT", "OCCASION"], brief: "", musicId: null }, actor);
    assert.ok(run.ok, run.ok ? "" : run.error);
    const runId = run.ok ? run.runId : "";

    // Clip giả: một mp4 thật khi có ffmpeg (để hậu kỳ + QC chạy thật), không thì vài byte (dừng ở hậu kỳ).
    let clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    if (ff) {
      const png = path.join(tmp, "src.png");
      const mk = await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=1", "-frames:v", "1", png], { timeoutMs: 30_000 });
      assert.equal(mk.code, 0, mk.stderr);
      const out = path.join(tmp, "clip.mp4");
      const r = await runTool("ffmpeg", fakeClipArgs(png, 4, 720, 1280, out), { timeoutMs: 120_000 });
      assert.equal(r.code, 0, r.stderr);
      clip = new Uint8Array(await readFile(out));
    }
    const st: FakeProviderState = { starts: 0, polls: 0, mode: "OK", clip };
    let writerCalls = 0;
    const visualChecks: VisualCheck[] = VIDEO_QC_CHECKS.map((check) => ({ check, result: "PASS", note: "khớp" }));
    const deps: VideoScaleDeps = {
      provider: () => fakeProvider(st),
      scriptWriter: async (_db, input) => {
        writerCalls += 1;
        return { ok: true, scripts: input.angles.map((a, i) => script(a, i)), dropped: [], model: "fake-writer", costUsd: 0.01 };
      },
      visual: async () => ({ ran: true, checks: visualChecks, summary: "khớp ảnh gốc", model: "fake-qc", costUsd: 0.002 }),
      ffmpegVersion: async () => ff,
    };
    const J = schema.videoScaleJobs;
    const V = schema.videoScaleVariants;
    const jobsOf = () => db.select().from(J).where(eq(J.runId, runId));

    // Lượt 1: viết kịch bản ⇒ 2 biến thể, 4 việc CLIP. Hai clip đầu được gửi, clip thứ 3 & 4 chạm trần 1 USD.
    await runVideoScaleTick(db, { deps, budgetMs: 20_000 });
    assert.equal(writerCalls, 1);
    const vs = await db.select().from(V).where(eq(V.runId, runId));
    assert.equal(vs.length, 2, "hai biến thể");
    let jobs = await jobsOf();
    const clips = jobs.filter((j) => j.kind === "CLIP");
    assert.equal(clips.length, 4, "mỗi cảnh một việc CLIP");
    assert.equal(st.starts, 2, "chỉ HAI lời gọi tạo — clip thứ ba vượt trần 1,00 USD");
    const blocked = clips.filter((j) => j.status === "BLOCKED");
    assert.equal(blocked.length, 2);
    assert.ok(blocked.every((j) => j.error.includes("Chạm trần")), blocked.map((j) => j.error).join(" | "));
    assert.ok(clips.filter((j) => j.reservedUsd !== null).every((j) => Math.abs((j.reservedUsd ?? 0) - 0.4) < 1e-9), "mỗi clip giữ chỗ 0,40 USD trước lời gọi tạo");

    // Khoá chống trùng: xếp lại đúng khoá ⇒ không thêm dòng.
    const k = clips[0].idempotencyKey;
    await enqueueJob(db, { kind: "CLIP", key: k, runId, variantId: clips[0].variantId, sceneIndex: 0, isTest: false });
    assert.equal((await db.select().from(J).where(eq(J.idempotencyKey, k))).length, 1, "khoá chống trùng");

    // Nới trần + giả "qua nửa đêm" cho hai việc bị chặn ⇒ lượt sau gửi nốt.
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify({ ...cfg, dailyUsdCap: 5 }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ ...cfg, dailyUsdCap: 5 }) } });
    await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(inArray(J.id, blocked.map((b) => b.id)));
    // Hỏi Veo (lượt hỏi đầu còn RUNNING) — cho đến hết việc.
    for (let i = 0; i < 12; i += 1) {
      await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(inArray(J.status, ["WAITING", "QUEUED"]));
      await runVideoScaleTick(db, { deps, budgetMs: 60_000 });
    }
    assert.equal(st.starts, 4, "đủ bốn clip, không clip nào gửi hai lần");
    jobs = await jobsOf();
    assert.ok(jobs.filter((j) => j.kind === "CLIP").every((j) => j.status === "SUCCEEDED" && j.costUsd === 0.4 && j.costBasis === "ESTIMATED"), "clip xong ghi tiền ƯỚC TÍNH theo bảng");

    if (ff) {
      const after = await db.select().from(V).where(eq(V.runId, runId));
      assert.ok(after.every((v) => v.status === "REVIEW" && v.qcVerdict === "PASS" && v.finalAssetId), `hậu kỳ + QC thật đưa cả hai tới CHỜ DUYỆT: ${after.map((v) => `${v.status}/${v.qcVerdict}/${v.error}`).join(", ")}`);
      const [a] = after;
      const q = a.qc as { technical: { verdict: string; problems: string[] } };
      assert.equal(q.technical.verdict, "PASS", q.technical.problems.join("; "));
      // Duyệt một, loại một (loại bắt buộc lý do).
      assert.ok(!(await rejectVideoVariant(db, after[1].id, actor, "x")).ok, "loại không lý do ⇒ từ chối");
      assert.ok((await approveVideoVariant(db, a.id, actor, "đẹp")).ok);
      assert.ok((await rejectVideoVariant(db, after[1].id, actor, "sai màu cổ áo")).ok);
      const [runRow] = await db.select().from(schema.videoScaleRuns).where(eq(schema.videoScaleRuns.id, runId));
      assert.equal(runRow.status, "DONE");
      // Ranh giới 4 ở CSDL: một video QC LOẠI không thể thành ĐÃ DUYỆT, kể cả sửa thẳng.
      await db.update(V).set({ status: "QC_FAILED", qcVerdict: "FAIL" }).where(eq(V.id, after[1].id));
      await assert.rejects(db.update(V).set({ status: "APPROVED", reviewedAt: new Date() }).where(eq(V.id, after[1].id)), "CHECK chặn duyệt video QC loại");
      assert.ok(!(await approveVideoVariant(db, after[1].id, actor, "")).ok);
      // Máy tự duyệt chỉ khi QC ĐẠT và không có người.
      await assert.rejects(db.update(V).set({ autoApproved: true, qcVerdict: "FLAG" }).where(eq(V.id, a.id)), "CHECK chặn tự duyệt video nghi ngờ");
    } else {
      console.log("  · CHƯA ĐO ĐƯỢC: máy này không có ffmpeg — hậu kỳ + QC thật không chạy (image Docker kiểm ffmpeg lúc dựng).");
    }

    // ── AMBIGUOUS: lời gọi tạo không có phản hồi ⇒ KHÔNG tự gửi lại; chỉ người bấm thử lại ──
    const k2 = `${P}amb`;
    const [v0] = await db.select().from(V).where(eq(V.runId, runId)).limit(1);
    const ambId = await enqueueJob(db, { kind: "CLIP", key: k2, runId, variantId: v0.id, sceneIndex: 0, isTest: false });
    await db.update(V).set({ status: "GENERATING" }).where(eq(V.id, v0.id)).catch(() => undefined);
    st.mode = "AMBIGUOUS";
    const startsBefore = st.starts;
    await runVideoScaleTick(db, { deps, budgetMs: 10_000 });
    let [amb] = await db.select().from(J).where(eq(J.id, ambId));
    assert.equal(st.starts, startsBefore + 1);
    assert.equal(amb.status, "FAILED");
    assert.equal(amb.errorKind, "AMBIGUOUS");
    assert.ok(amb.reservedUsd !== null, "tiền giữ chỗ VẪN tính (có thể đã bị tính tiền)");
    await db.update(J).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(J.id, ambId));
    await runVideoScaleTick(db, { deps, budgetMs: 10_000 });
    assert.equal(st.starts, startsBefore + 1, "việc AMBIGUOUS không bao giờ tự gửi lại");
    assert.ok((await retryVideoJob(db, ambId)).ok, "người bấm thử lại được");
    [amb] = await db.select().from(J).where(eq(J.id, ambId));
    assert.equal(amb.status, "QUEUED");

    // ── Dấu "đang gửi" còn lại sau khi tiến trình chết ⇒ không gửi lại ──
    st.mode = "OK";
    await db.update(J).set({ status: "RUNNING", providerPendingAt: new Date(Date.now() - 600_000), providerRef: "", lockedUntil: new Date(Date.now() - 1000), attempts: 1 }).where(eq(J.id, ambId));
    const s2 = st.starts;
    await runVideoScaleTick(db, { deps, budgetMs: 10_000 });
    [amb] = await db.select().from(J).where(eq(J.id, ambId));
    assert.equal(st.starts, s2, "gặp dấu đang gửi mà không có mã thao tác ⇒ không gọi tạo");
    assert.equal(amb.errorKind, "AMBIGUOUS");

    console.log(`✓ Video Scale (CSDL): chỉ mã win + ảnh thật · trần tiền ngày · khoá chống trùng · AMBIGUOUS không tự gửi lại · ${ff ? "hậu kỳ + QC thật · duyệt/loại · CHECK chặn duyệt video QC loại" : "hậu kỳ CHƯA ĐO ĐƯỢC"}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await cleanup(db);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
