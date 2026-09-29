import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { nextVideoScaleStep, type NextStepInput } from "@/lib/constants/video-scale-next";
import { loadVideoScaleCounts } from "@/lib/queries/video-scale";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ VIDEO SCALE — UX "VIỆC TIẾP THEO" (chủ shop 29/09/2026) ═══════════
 *
 * Thuần: đúng MỘT việc theo thứ tự ưu tiên (dừng khẩn cấp → cấu hình chặn → việc bị chặn → chờ duyệt → đã duyệt chưa đăng →
 * đang tạo → thiếu mã / ảnh → tạo mới), mỗi việc trỏ đúng tab.
 * CSDL: "đã duyệt, chưa đăng" không đếm video DỮ LIỆU THỬ và video đã có bài Reel đang chờ / đã đăng, nhưng VẪN đếm video
 * có bài hỏng / đã huỷ (đó là việc phải đăng lại).
 */

const BASE: NextStepInput = { paused: false, blockers: [], blockedJobs: 0, failedJobs24h: 0, review: 0, activeJobs: 0, approvedUnposted: 0, winProducts: 3, winWithPhotos: 2 };

export function testVideoScaleUxPure() {
  const at = (x: Partial<NextStepInput>) => nextVideoScaleStep({ ...BASE, ...x });
  const all: Partial<NextStepInput> = { paused: true, blockers: ["Chưa bật"], blockedJobs: 2, review: 3, approvedUnposted: 4, activeJobs: 5 };
  // Bỏ dần từng điều kiện từ trên xuống ⇒ việc kế tiếp lộ ra đúng thứ tự.
  const order: [keyof NextStepInput, string][] = [
    ["paused", "dang-reel"],
    ["blockers", "cau-hinh"],
    ["blockedJobs", "hang-doi"],
    ["review", "duyet"],
    ["approvedUnposted", "dang-reel"],
    ["activeJobs", "hang-doi"],
  ];
  const cur: Partial<NextStepInput> = { ...all };
  for (const [k, tab] of order) {
    assert.equal(at(cur).tab, tab, `ưu tiên tại ${k}`);
    (cur as Record<string, unknown>)[k] = k === "paused" ? false : k === "blockers" ? [] : 0;
  }
  assert.equal(at(cur).title, "Sẵn sàng tạo video mới");
  assert.equal(at({ winProducts: 0, winWithPhotos: 0 }).title, "Chưa có mã win nào");
  assert.equal(at({ winWithPhotos: 0 }).tone, "warn");
  assert.equal(at({ review: 3 }).title, "3 video chờ duyệt");
  assert.ok(at({ blockers: ["A", "B", "C"] }).detail.includes("(+2 lý do khác)"));
  assert.equal(at({ activeJobs: 2 }).tone, "wait", "đang tạo = chỉ cần đợi, không phải việc");
  console.log("✓ Video Scale UX (thuần): một việc tiếp theo đúng thứ tự ưu tiên, trỏ đúng tab");
}

const P = "vsux-test-";

async function cleanup(db: Db) {
  const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
  const ids = runs.map((r) => r.id);
  if (ids.length) {
    const vIds = (await db.select({ id: schema.videoScaleVariants.id }).from(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids))).map((v) => v.id);
    if (vIds.length) await db.delete(schema.videoScalePosts).where(inArray(schema.videoScalePosts.variantId, vIds));
    await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
    await db.delete(schema.videoScaleAssets).where(inArray(schema.videoScaleAssets.runId, ids));
    await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
  }
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testVideoScaleUxDb(db: Db) {
  await cleanup(db);
  try {
    const before = (await loadVideoScaleCounts(db)).approvedUnposted;
    await db.insert(schema.products).values({ id: `${P}p`, name: "Đầm UX" });
    const [run] = await db
      .insert(schema.videoScaleRuns)
      .values({ productId: `${P}p`, sourceIds: [`${P}src`], status: "REVIEW", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 5, configSnapshot: {} })
      .returning({ id: schema.videoScaleRuns.id });
    // Video ĐÃ DUYỆT phải có bản hoàn chỉnh + QC + mốc duyệt (ràng buộc video_scale_variants_approve_check).
    const final = await storeAsset(db, { kind: "FINAL", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), contentType: "video/mp4", runId: run.id });
    const mk = async (seq: number, isTest = false) =>
      (
        await db
          .insert(schema.videoScaleVariants)
          .values({ runId: run.id, productId: `${P}p`, seq, angle: "OCCASION", angleVocabVersion: 1, script: {}, sourceId: `${P}src`, status: "APPROVED", qcVerdict: "PASS", finalAssetId: final.id, reviewedAt: new Date(), isTest })
          .returning({ id: schema.videoScaleVariants.id })
      )[0].id;
    const plain = await mk(1);
    const published = await mk(2);
    const failed = await mk(3);
    await mk(4, true);
    await db.insert(schema.videoScalePosts).values([
      { variantId: published, productId: `${P}p`, pageId: "9200000000001", status: "PUBLISHED", caption: "x", fbVideoId: "1", publishedAt: new Date() },
      { variantId: failed, productId: `${P}p`, pageId: "9200000000001", status: "FAILED", caption: "x" },
    ]);
    const after = (await loadVideoScaleCounts(db)).approvedUnposted;
    assert.equal(after - before, 2, `chỉ video thật chưa có bài sống (thường + bài hỏng) — nhận ${after - before}`);
    assert.ok(plain);
    console.log("✓ Video Scale UX (CSDL): đã duyệt chưa đăng bỏ video thử + video có bài đang sống, giữ video có bài hỏng");
  } finally {
    await cleanup(db);
  }
}
