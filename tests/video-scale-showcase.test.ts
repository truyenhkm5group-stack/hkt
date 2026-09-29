import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { VIDEO_QC_CHECKS, VIDEO_SCALE_CONFIG_KEY, effectiveRender, normalizeRenderOptions, normalizeVideoScaleConfig } from "@/lib/constants/video-scale";
import { SHOWCASE, normalizeShowcase, productColorsFrom, showcaseLabel, showcaseSeconds, variantColor } from "@/lib/constants/video-scale-colors";
import { storeCreativeImage } from "@/lib/creative/images";
import { ensureColorPhotos, listProductColors, showcaseProblem } from "@/lib/video-scale/colors";
import { ffmpegVersion, resolveFontFile, runTool } from "@/lib/video-scale/ffmpeg";
import { rerenderVideoVariant, runVideoScaleTick, type VideoScaleDeps } from "@/lib/video-scale/pipeline";
import { enqueueJob } from "@/lib/video-scale/queue";

/**
 * ═══════════ VIDEO SCALE — CLIP MỞ ĐẦU + ĐOẠN BẢNG MÀU (chủ shop 29/09/2026) ═══════════
 *
 * Thuần: màu đọc từ cột `color` rồi thuộc tính "Màu" · gộp màu không phân biệt hoa thường, ảnh đầu tiên có thật · mẫu mã xoá /
 * ẩn không tính · bảng màu lạ bị bỏ, tối đa 6 · video không khai ⇒ theo lượt, khai `[]` ⇒ tắt.
 * CSDL + ffmpeg thật: nhập ảnh màu một lần (lần hai dùng lại, không tải lại) · màu không ảnh / không có ⇒ nói ra · ảnh của mã khác
 * bị chặn · video = 2 cảnh mở đầu + 2 màu ⇒ đúng độ dài, việc dựng ghi mốc hết đoạn mở đầu, QC chỉ cắt khung TRƯỚC mốc ấy ·
 * sửa video tắt bảng màu ⇒ video ngắn lại đúng đoạn bảng màu.
 */

export function testVideoScaleShowcasePure() {
  assert.equal(variantColor("  Đỏ  đô ", null), "Đỏ đô");
  assert.equal(variantColor("", [{ name: "Size", value: "M" }, { name: "Màu", value: "Xanh rêu" }]), "Xanh rêu");
  assert.equal(variantColor("", [{ name: "Color", value: "Black" }]), "Black");
  assert.equal(variantColor("", [{ name: "Size", value: "M" }]), "", "không có màu ⇒ rỗng, không đoán");
  assert.equal(variantColor(null, "rác"), "");

  const colors = productColorsFrom([
    { color: "Đỏ", attributes: null, images: [] },
    { color: "đỏ", attributes: null, images: ["https://x/do.jpg", "https://x/do2.jpg"] },
    { color: "", attributes: [{ name: "Màu", value: "Đen" }], images: ["ftp://sai", "https://x/den.jpg"] },
    { color: "Trắng", attributes: null, images: ["https://x/trang.jpg"], isRemoved: true },
    { color: "Be", attributes: null, images: ["https://x/be.jpg"], isHidden: true },
    { color: "Xanh", attributes: null, images: null },
  ]);
  assert.deepEqual(colors, [
    { color: "Đỏ", imageUrl: "https://x/do.jpg", variants: 2 },
    { color: "Đen", imageUrl: "https://x/den.jpg", variants: 1 },
    { color: "Xanh", imageUrl: null, variants: 1 },
  ]);

  assert.equal(normalizeShowcase("x"), undefined);
  assert.deepEqual(normalizeShowcase([]), []);
  assert.deepEqual(normalizeShowcase([{ sourceId: "a1", color: " Đỏ " }, { sourceId: "a1", color: "Đen" }, { sourceId: "../x", color: "Be" }, { sourceId: "b2", color: "" }, 7]), [{ sourceId: "a1", color: "Đỏ" }]);
  assert.equal(normalizeShowcase(Array.from({ length: 9 }, (_, i) => ({ sourceId: `s${i}`, color: `M${i}` })))?.length, SHOWCASE.maxColors);
  assert.equal(showcaseLabel(" Đỏ đô "), "Màu Đỏ đô");
  assert.equal(showcaseSeconds(3), 5.4);

  const snap = normalizeVideoScaleConfig({});
  const run = [{ sourceId: "a1", color: "Đỏ" }];
  assert.deepEqual(effectiveRender(snap, null, {}, run).showcase, run, "video không khai ⇒ theo lượt");
  assert.deepEqual(effectiveRender(snap, null, normalizeRenderOptions({ showcase: [] }), run).showcase, [], "khai [] ⇒ tắt");
  assert.deepEqual(effectiveRender(snap, null, {}).showcase, [], "lượt cũ không có bảng màu");
  console.log("✓ Video Scale bảng màu (thuần): màu từ cột / thuộc tính, gộp đúng, bỏ mẫu mã xoá / ẩn · bảng màu lạ bị bỏ · theo lượt / tắt");
}

const P = "vsshow-test-";

async function cleanup(db: Db) {
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, ids));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, ids));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
  }
  await db.delete(schema.creativeSources).where(like(schema.creativeSources.productId, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testVideoScaleShowcaseDb(db: Db) {
  const ff = await ffmpegVersion();
  if (!ff) {
    console.log("  · CHƯA ĐO ĐƯỢC: máy này không có ffmpeg — đoạn bảng màu không dựng thử được (image Docker kiểm ffmpeg lúc dựng).");
    return;
  }
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  const tmp = await mkdtemp(path.join(tmpdir(), "vsshow-"));
  await cleanup(db);
  try {
    const mk = async (name: string, color: string) => {
      const f = path.join(tmp, `${name}.png`);
      assert.equal((await runTool("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=c=${color}:size=480x600`, "-frames:v", "1", f], { timeoutMs: 30_000 })).code, 0);
      return new Uint8Array(await readFile(f));
    };
    const pngRed = await mk("red", "red");
    const pngBlack = await mk("black", "black");
    const pngMain = await mk("main", "white");

    await db.insert(schema.users).values({ id: `${P}u`, email: `${P}u@t.local`, name: "Người thử", passwordHash: "x", role: "ADMIN" });
    const actor = { id: `${P}u`, label: "Người thử" };
    await db.insert(schema.products).values([
      { id: `${P}p`, name: "Đầm bảng màu" },
      { id: `${P}other`, name: "Mã khác" },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}v1`, productId: `${P}p`, color: "Đỏ", size: "M", images: ["https://img.test/red.png"], retailPrice: 399_000, retailPriceAfterDiscount: 399_000 },
      { id: `${P}v2`, productId: `${P}p`, color: "", size: "L", attributes: [{ name: "Màu", value: "Đen" }], images: ["https://img.test/black.png"], retailPrice: 399_000, retailPriceAfterDiscount: 399_000 },
      { id: `${P}v3`, productId: `${P}p`, color: "Be", size: "S", images: [], retailPrice: 399_000, retailPriceAfterDiscount: 399_000 },
    ]);
    const main = await storeCreativeImage(db, pngMain);
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}p`, imageId: main.id, title: "ảnh thật" });
    const foreign = await storeCreativeImage(db, pngRed);
    await db.insert(schema.creativeSources).values({ id: `${P}foreign`, kind: "PRODUCT_PHOTO", productId: `${P}other`, imageId: foreign.id, title: "mã khác" });

    // Nhập ảnh màu (tải giả, không gọi mạng).
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return new Response(url.includes("red") ? pngRed : pngBlack, { status: 200 });
    }) as unknown as typeof fetch;
    const opts = await listProductColors(db, `${P}p`);
    assert.deepEqual(opts.map((o) => [o.color, o.imageUrl !== null, o.sourceId]), [["Đỏ", true, null], ["Đen", true, null], ["Be", false, null]]);
    const e1 = await ensureColorPhotos(db, `${P}p`, ["Đỏ", "đen", "Be", "Tím"], { id: actor.id, name: actor.label }, { fetchImpl });
    assert.deepEqual(e1.items.map((x) => x.color), ["Đỏ", "Đen"], "theo thứ tự người chọn, tên màu theo ERP");
    assert.deepEqual(e1.failed.map((x) => x.color), ["Be", "Tím"], "không ảnh / không có màu ⇒ nói ra");
    assert.equal(fetched.length, 2);
    const e2 = await ensureColorPhotos(db, `${P}p`, ["Đỏ", "Đen"], { id: actor.id, name: actor.label }, { fetchImpl });
    assert.deepEqual(e2.items, e1.items, "lần hai dùng lại nguồn cũ");
    assert.equal(fetched.length, 2, "không tải lại");
    assert.ok(await showcaseProblem(db, `${P}p`, [{ sourceId: `${P}foreign`, color: "Đỏ" }]), "ảnh của mã khác bị chặn");
    assert.equal(await showcaseProblem(db, `${P}p`, e1.items), null);

    // Lượt: 2 cảnh ảnh động mở đầu (4 giây) + bảng màu 2 màu.
    const cfg = { enabled: true, provider: "OMNI", clipSeconds: 4, scenesPerVariant: 2, aiScenes: 0, voiceover: false, burnSubtitles: false, dailyUsdCap: 1 };
    await db.insert(schema.settings).values({ key: VIDEO_SCALE_CONFIG_KEY, value: JSON.stringify(cfg) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(cfg) } });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}photo`], status: "PRODUCING", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 1, configSnapshot: cfg, showcase: e1.items as unknown as Record<string, unknown>[] })
      .returning({ id: schema.videoScaleRuns.id });
    const script = { angle: "OCCASION", hook: "Đi tiệc là nổi", scenes: [{ prompt: "p0", overlay: "Dáng suông", voiceover: "" }, { prompt: "p1", overlay: "Tôn dáng", voiceover: "" }], cta: "Nhắn shop ngay" };
    const [v] = await db.insert(schema.videoScaleVariants).values({ runId: run.id, productId: `${P}p`, seq: 1, angle: "OCCASION", angleVocabVersion: 1, script, sourceId: `${P}photo`, status: "SCRIPTED" }).returning({ id: schema.videoScaleVariants.id });
    for (const i of [0, 1]) await enqueueJob(db, { kind: "CLIP", key: `${P}clip:${v.id}:${i}`, runId: run.id, variantId: v.id, sceneIndex: i, isTest: false });

    const font = (await resolveFontFile()) ?? (await resolveFontFile("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")) ?? (await resolveFontFile("C:/Windows/Fonts/arialbd.ttf")) ?? "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf";
    // Màu trung bình (1×1 điểm ảnh) của từng khung QC nhận được: đoạn mở đầu là ảnh TRẮNG, bảng màu là ĐỎ / ĐEN.
    const qcRgb: number[][] = [];
    const deps: VideoScaleDeps = {
      provider: () => {
        throw new Error("không được gọi máy sinh clip");
      },
      ffmpegVersion: async () => ff,
      fontFile: async () => font,
      visual: async (_db, input) => {
        for (const [k, fr] of input.frames.entries()) {
          const f = path.join(tmp, `qc${k}.jpg`);
          await writeFile(f, fr);
          const r = await runTool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", f, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeoutMs: 30_000 });
          qcRgb.push([...r.stdout.subarray(0, 3)]);
        }
        return { ran: true, checks: VIDEO_QC_CHECKS.map((check) => ({ check, result: "PASS" as const, note: "khớp" })), summary: "khớp", model: "qc-thử", costUsd: 0.002 };
      },
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
    assert.equal(row.status, "REVIEW", `dựng xong: ${row.error} ${JSON.stringify(row.qc).slice(0, 300)}`);
    assert.ok(row.durationMs !== null && Math.abs(row.durationMs - 11_600) < 300, `độ dài 2×4 + 2×1,8 = 11,6 giây — nhận ${row.durationMs} ms`);
    const [rj] = await db.select().from(J).where(and(eq(J.variantId, v.id), eq(J.kind, "RENDER"), eq(J.outputAssetId, row.finalAssetId as string)));
    const res = rj.result as { introSec?: number; showcase?: number; plannedSec?: number };
    assert.equal(res.showcase, 2);
    assert.equal(res.introSec, 8, "mốc hết đoạn mở đầu");
    assert.ok(Math.abs((res.plannedSec ?? 0) - 11.6) < 0.1, `độ dài bộ dựng ~11,6 giây — nhận ${res.plannedSec}`);
    assert.ok(qcRgb.length > 0, "QC hình ảnh vẫn chạy trên đoạn mở đầu");
    assert.ok(qcRgb.every(([r, g, b]) => r > 120 && g > 120 && b > 120), `QC chỉ cắt khung đoạn mở đầu (trắng), không khung đỏ / đen của bảng màu: ${JSON.stringify(qcRgb)}`);

    // Sửa video: tắt bảng màu ⇒ video ngắn lại đúng đoạn ấy.
    const off = await rerenderVideoVariant(db, v.id, { hook: script.hook, cta: script.cta, scenes: script.scenes.map((s) => ({ overlay: s.overlay, voiceover: "" })), options: { showcase: [] } }, actor);
    assert.ok(off.ok, off.ok ? "" : off.error);
    const badEdit = await rerenderVideoVariant(db, v.id, { hook: script.hook, cta: script.cta, scenes: script.scenes.map((s) => ({ overlay: s.overlay, voiceover: "" })), options: { showcase: [{ sourceId: `${P}foreign`, color: "Đỏ" }] } }, actor);
    assert.ok(!badEdit.ok, "không nhận ảnh bảng màu của mã khác");
    await tick();
    [row] = await db.select().from(V).where(eq(V.id, v.id));
    assert.equal(row.status, "REVIEW", row.error);
    assert.ok(row.durationMs !== null && Math.abs(row.durationMs - 8000) < 300, `tắt bảng màu ⇒ 8 giây — nhận ${row.durationMs} ms`);

    console.log("✓ Video Scale bảng màu (CSDL + ffmpeg thật): nhập ảnh màu một lần, màu thiếu ảnh nói ra, ảnh mã khác bị chặn · 2 cảnh + 2 màu = 11,6 giây, QC chỉ đoạn mở đầu · tắt bảng màu ⇒ 8 giây");
  } finally {
    await cleanup(db);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (prevCfg) await db.insert(schema.settings).values(prevCfg).onConflictDoUpdate({ target: schema.settings.key, set: { value: prevCfg.value } });
    else await db.delete(schema.settings).where(eq(schema.settings.key, VIDEO_SCALE_CONFIG_KEY));
  }
}
