import assert from "node:assert/strict";
import { like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { MUSIC_GEN_MAX_PER_DAY, MUSIC_MOOD_KEYS, generateMusicLibrary, lyriaAudioBase64, lyriaPrompt } from "@/lib/video-scale/music-gen";

/**
 * ═══════════ VIDEO SCALE — NHẠC NỀN GỐC (LYRIA) ═══════════
 *
 * Thuần: lời nhắc luôn KHÔNG LỜI + không bắt chước bài / ca sĩ · đọc âm thanh ở cả hai dạng phản hồi tài liệu nêu.
 * CSDL + cửa mạng GIẢ: tạo ⇒ vào thư viện kèm ghi chú nguồn + quyền · "chỉ phong cách chưa có" không nhân đôi · một phong cách hỏng
 * không chặn phong cách khác · thiếu khoá ⇒ dừng, không tạo gì · trần số bản / ngày.
 */

export function testVideoScaleMusicPure() {
  assert.equal(MUSIC_MOOD_KEYS.length, 8);
  for (const m of MUSIC_MOOD_KEYS) {
    const p = lyriaPrompt(m);
    assert.ok(p.includes("Instrumental only, no vocals") && p.includes("do not imitate any existing song or artist"), p);
  }
  assert.equal(lyriaAudioBase64({ steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: "lời" }, { type: "audio", data: "QUJD", mime_type: "audio/mpeg" }] }] }), "QUJD");
  assert.equal(lyriaAudioBase64({ steps: [{ model_output_step: { content: [{ audio_content: { data: "WFla" } }] } }] }), "WFla", "dạng model_output_step.audio_content");
  assert.equal(lyriaAudioBase64({ steps: [{ type: "model_output", content: [{ type: "text", text: "x" }] }] }), null);
  console.log("✓ Video Scale nhạc AI (thuần): lời nhắc không lời · không bắt chước · đọc âm thanh hai dạng phản hồi");
}

const TAG = "vsmusic-test";

export async function testVideoScaleMusicDb(db: Db) {
  const M = schema.videoScaleMusic;
  const clean = async () => {
    const rows = await db.select({ id: M.id, assetId: M.assetId }).from(M).where(like(M.uploadedBy, `${TAG}%`));
    if (rows.length) {
      await db.delete(M).where(like(M.uploadedBy, `${TAG}%`));
      for (const r of rows) await db.delete(schema.videoScaleAssets).where(like(schema.videoScaleAssets.id, r.assetId));
    }
  };
  await clean();
  try {
    const mp3 = Buffer.from(new Uint8Array(4000).fill(7)).toString("base64");
    let calls = 0;
    const ok = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: mp3 }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const actor = { id: null, label: `${TAG} máy` };

    const r1 = await generateMusicLibrary(db, { moods: ["TIKTOK_UPBEAT", "CHIC_FASHION"], onlyMissing: true }, actor, { apiKey: "k", fetchImpl: ok });
    assert.equal(r1.created.length, 2);
    assert.ok(Math.abs(r1.costUsd - 0.08) < 1e-9);
    const rows = await db.select().from(M).where(like(M.uploadedBy, `${TAG}%`));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.licenseNote.startsWith("Nhạc gốc tạo bằng Google Lyria") && r.licenseNote.includes("không bắt chước")), "ghi chú nguồn + quyền");
    assert.ok(rows.some((r) => r.title === "Sôi động kiểu TikTok · AI"));

    const r2 = await generateMusicLibrary(db, { moods: ["TIKTOK_UPBEAT", "LOFI_CHILL"], onlyMissing: true }, actor, { apiKey: "k", fetchImpl: ok });
    assert.deepEqual(r2.created.map((c) => c.mood), ["LOFI_CHILL"], "phong cách đã có không tạo lại");
    assert.equal(calls, 3);

    // Một phong cách bị từ chối không chặn phong cách sau.
    let n = 0;
    const mixed = (async () => {
      n += 1;
      return n === 1 ? new Response(JSON.stringify({ error: { message: "blocked" } }), { status: 400 }) : new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", data: mp3 }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r3 = await generateMusicLibrary(db, { moods: ["ROMANTIC", "RNB_SMOOTH"], onlyMissing: false }, actor, { apiKey: "k", fetchImpl: mixed });
    assert.equal(r3.created.length, 1);
    assert.equal(r3.skipped[0].mood, "ROMANTIC");

    // Thiếu khoá ⇒ dừng ngay, không tạo gì.
    const r4 = await generateMusicLibrary(db, { moods: ["SALE_HYPE", "SUMMER_TROPICAL"], onlyMissing: false }, actor, { apiKey: "" });
    assert.equal(r4.created.length, 0);
    assert.equal(r4.skipped.length, 1, "BLOCKED dừng vòng lặp");

    // Trần số bản / ngày (đếm cả bản đã tạo hôm nay).
    const many = Array.from({ length: MUSIC_GEN_MAX_PER_DAY }, () => "SALE_HYPE" as const);
    const r5 = await generateMusicLibrary(db, { moods: many, onlyMissing: false }, actor, { apiKey: "k", fetchImpl: ok });
    assert.ok(r5.created.length <= MUSIC_GEN_MAX_PER_DAY - 4 && r5.skipped.some((s) => s.reason.includes("chạm trần")), JSON.stringify(r5.skipped.slice(0, 2)));

    console.log("✓ Video Scale nhạc AI (CSDL, cửa mạng giả): vào thư viện kèm nguồn + quyền · không nhân đôi · hỏng một không chặn cả bộ · thiếu khoá dừng · trần / ngày");
  } finally {
    await clean();
  }
}
