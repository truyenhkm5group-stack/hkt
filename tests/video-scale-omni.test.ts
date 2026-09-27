import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { OMNI_MAX_CLIP_SECONDS, billedSecondsFor, clipCostUsd, normalizeVideoScaleConfig, providerOfModel, reserveSecondsFor } from "@/lib/constants/video-scale";
import { modelComparison } from "@/lib/queries/video-scale";
import { OmniProvider, omniPromptText, omniRequestBody, parseOmniInteraction } from "@/lib/video-scale/providers/omni";
import { ProviderError, type ClipRequest } from "@/lib/video-scale/providers/types";

/**
 * ═══════════ VIDEO SCALE — GEMINI OMNI FLASH ═══════════
 *
 * Thuần: cấu hình (model phải thuộc nhà cung cấp, Omni ép 720p vì 1080p chưa có giá chính thức) · giữ chỗ 10 giây, ghi tiền
 * theo độ dài đo được · thân yêu cầu Interactions API (ảnh + chữ, 9:16, chạy nền, lưu) · đọc trạng thái (chạy / xong / hỏng).
 * Cửa mạng GIẢ: tạo → hỏi → tải qua Files API (PROCESSING là tạm thời, không mất clip) · mất phản hồi lời gọi tạo ⇒ AMBIGUOUS ·
 * không gửi khoá tới URI lạ. CSDL: bảng so sánh model đọc model từ ẢNH CHỤP cấu hình của lượt, bỏ dữ liệu thử.
 */

const req: ClipRequest = {
  model: "gemini-omni-1.1-flash",
  prompt: "Model xoay người chậm dưới nắng",
  negativePrompt: "chữ lạ, logo",
  image: { kind: "PRODUCT_PHOTO", bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]), contentType: "image/jpeg" },
  seconds: 6,
  resolution: "720p",
};

export function testVideoScaleOmniPure() {
  const omni = normalizeVideoScaleConfig({ provider: "OMNI", model: "veo-3.1-fast-generate-preview", resolution: "1080p", clipSeconds: 6 });
  assert.equal(omni.provider, "OMNI");
  assert.equal(omni.model, "gemini-omni-1.1-flash", "model Veo không được gửi sang Omni");
  assert.equal(omni.resolution, "720p", "Omni: 1080p chưa có giá chính thức ⇒ ép 720p");
  assert.equal(omni.clipSeconds, 6, "Omni không bị luật 1080p = 8 giây của Veo");
  const veo = normalizeVideoScaleConfig({ provider: "VEO", model: "gemini-omni-1.1-flash" });
  assert.equal(providerOfModel(veo.model), "VEO", "model Omni không được gửi sang Veo");
  assert.equal(normalizeVideoScaleConfig({ provider: "SORA" }).provider, "VEO");

  assert.equal(reserveSecondsFor("OMNI", 6), OMNI_MAX_CLIP_SECONDS, "Omni tự quyết 3–10 giây ⇒ giữ chỗ theo 10");
  assert.equal(reserveSecondsFor("VEO", 6), 6);
  assert.equal(billedSecondsFor("OMNI", 6, 7.5), 7.5, "ghi tiền theo độ dài thật");
  assert.equal(billedSecondsFor("OMNI", 6, null), OMNI_MAX_CLIP_SECONDS, "không đo được ⇒ ước tính phía CAO");
  assert.equal(billedSecondsFor("VEO", 6, 7.5), 6);
  assert.equal(clipCostUsd("gemini-omni-1.1-flash", "720p", 10), 1.014);
  assert.equal(clipCostUsd("gemini-omni-1.1-flash", "1080p", 10), null, "1080p chưa có giá ⇒ CHƯA BIẾT ⇒ không sinh");

  const body = omniRequestBody(req);
  assert.equal(body.model, "gemini-omni-1.1-flash");
  assert.equal(body.background, true, "chạy nền: trả id ngay, không giữ kết nối tới khi xong");
  assert.equal(body.store, true, "chạy nền cần lưu interaction");
  assert.deepEqual(body.response_format, { type: "video", aspect_ratio: "9:16", resolution: "720p", delivery: "uri" });
  const input = body.input as { type: string; mime_type?: string; text?: string }[];
  assert.equal(input[0].type, "image");
  assert.equal(input[0].mime_type, "image/jpeg");
  assert.equal(input[1].type, "text");
  const text = omniPromptText(req);
  assert.ok(text.includes("OPENING FRAME") && text.includes("about 6 seconds") && text.includes("Do not show: chữ lạ, logo"), text);

  assert.deepEqual(parseOmniInteraction({ status: "in_progress" }, "a"), { state: "RUNNING" });
  assert.deepEqual(parseOmniInteraction({ status: "queued" }, "a"), { state: "RUNNING" });
  assert.deepEqual(
    parseOmniInteraction({ status: "completed", steps: [{ type: "user_input", content: [] }, { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc" }] }] }, "a"),
    { state: "DONE", videoUri: "https://generativelanguage.googleapis.com/v1beta/files/abc" },
  );
  assert.deepEqual(parseOmniInteraction({ status: "completed", steps: [{ type: "model_output", content: [{ type: "video", data: "AAAA" }] }] }, "x1"), { state: "DONE", videoUri: "interaction:x1" }, "trả thẳng base64 ⇒ đọc lại interaction lúc tải");
  const blocked = parseOmniInteraction({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }] }, "a");
  assert.ok(blocked.state === "FAILED" && blocked.kind === "PERMANENT", "xong mà không có video ⇒ hỏng vĩnh viễn, không thử lại mù");
  const quota = parseOmniInteraction({ status: "failed", error: { message: "Resource exhausted: quota" } }, "a");
  assert.ok(quota.state === "FAILED" && quota.kind === "TRANSIENT");
  const safety = parseOmniInteraction({ status: "failed", error: { message: "blocked by safety policy" } }, "a");
  assert.ok(safety.state === "FAILED" && safety.kind === "PERMANENT");

  console.log("✓ Video Scale Omni (thuần): model thuộc đúng nhà cung cấp · Omni 720p · giữ chỗ 10 giây, ghi tiền theo độ dài thật · thân Interactions API · trạng thái");
}

type Call = { url: string; method: string; key: string | null };

function fakeFetch(calls: Call[], script: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", key: headers.get("x-goog-api-key") });
    for (const [k, make] of Object.entries(script)) if (url.includes(k)) return make();
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

export async function testVideoScaleOmniFlow() {
  const calls: Call[] = [];
  let fileState = "PROCESSING";
  const p = new OmniProvider({
    apiKey: "khoa-thu",
    fetchImpl: fakeFetch(calls, {
      "/files/f1:download": () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200 }),
      "/files/f1": () => json({ state: fileState }),
      "/interactions/i1": () => json({ id: "i1", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", uri: "https://generativelanguage.googleapis.com/v1beta/files/f1" }] }] }),
      "/interactions": () => json({ id: "i1", status: "in_progress" }),
    }),
  });
  const { ref } = await p.start(req);
  assert.equal(ref, "interactions/i1");
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/v1beta/interactions"));
  assert.equal(calls[0].key, "khoa-thu", "khoá chỉ đi trong tiêu đề");
  assert.ok(!calls[0].url.includes("khoa-thu"), "khoá KHÔNG nằm trên URL");
  const polled = await p.poll(ref);
  assert.equal(polled.state, "DONE");
  if (polled.state !== "DONE") return;
  await assert.rejects(p.download(polled.videoUri), (e: unknown) => e instanceof ProviderError && e.kind === "TRANSIENT", "tệp còn PROCESSING ⇒ tạm thời, hàng đợi hỏi lại — không mất clip đã trả tiền");
  fileState = "ACTIVE";
  const bytes = await p.download(polled.videoUri);
  assert.equal(bytes.byteLength, 8);
  await assert.rejects(p.download("https://evil.example.com/v1beta/files/f1"), (e: unknown) => e instanceof ProviderError && e.kind === "PERMANENT", "URI lạ ⇒ không gửi khoá");

  const lost = new OmniProvider({
    apiKey: "k",
    fetchImpl: (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch,
  });
  await assert.rejects(lost.start(req), (e: unknown) => e instanceof ProviderError && e.kind === "AMBIGUOUS", "mất phản hồi lời gọi TẠO ⇒ có thể đã tính tiền ⇒ không tự gửi lại");
  const refused = new OmniProvider({ apiKey: "k", fetchImpl: (async () => json({ error: { message: "API key not valid" } }, 400)) as typeof fetch });
  await assert.rejects(refused.start(req), (e: unknown) => e instanceof ProviderError && e.kind === "PERMANENT");
  const noKey = new OmniProvider({ apiKey: "" });
  await assert.rejects(noKey.start(req), (e: unknown) => e instanceof ProviderError && e.kind === "BLOCKED" && e.message.includes("GEMINI_API_KEY"));
  assert.deepEqual(await p.poll("models/veo/operations/x"), { state: "FAILED", error: 'Mã thao tác Omni lạ: "models/veo/operations/x".', kind: "PERMANENT" });

  console.log("✓ Video Scale Omni (cửa mạng giả): tạo → hỏi → tải qua Files API · PROCESSING là tạm thời · mất phản hồi ⇒ AMBIGUOUS · khoá không lên URL / URI lạ · thiếu khoá ⇒ chặn");
}

const P = "vsomni-test-";

export async function testVideoScaleOmniDb(db: Db) {
  const clean = async () => {
    const runs = await db.select({ id: schema.videoScaleRuns.id }).from(schema.videoScaleRuns).where(like(schema.videoScaleRuns.productId, `${P}%`));
    const ids = runs.map((r) => r.id);
    if (ids.length) {
      await db.delete(schema.videoScaleJobs).where(inArray(schema.videoScaleJobs.runId, ids));
      await db.delete(schema.videoScaleVariants).where(inArray(schema.videoScaleVariants.runId, ids));
      await db.delete(schema.videoScaleRuns).where(inArray(schema.videoScaleRuns.id, ids));
    }
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  };
  await clean();
  try {
    await db.insert(schema.products).values({ id: `${P}p`, name: "Đầm so sánh model" });
    const run = async (model: string, isTest = false) =>
      (await db.insert(schema.videoScaleRuns).values({ productId: `${P}p`, sourceIds: ["s"], status: "DONE", promptVersion: 1, angleVocabVersion: 1, variantsRequested: 2, configSnapshot: { model }, isTest }).returning({ id: schema.videoScaleRuns.id }))[0].id;
    const variant = async (runId: string, seq: number, status: string, qc: string | null, usd: number | null, isTest = false) => {
      const [v] = await db
        .insert(schema.videoScaleVariants)
        .values({ runId, productId: `${P}p`, seq, angle: "OCCASION", angleVocabVersion: 1, script: { hook: "h", scenes: [], cta: "c" }, sourceId: "s", status, qcVerdict: qc, isTest })
        .returning({ id: schema.videoScaleVariants.id });
      if (usd !== null) await db.insert(schema.videoScaleJobs).values({ idempotencyKey: `${P}${v.id}`, kind: "CLIP", runId, variantId: v.id, status: "SUCCEEDED", maxAttempts: 3, costUsd: usd, costBasis: "ESTIMATED", isTest });
    };
    const veoRun = await run("veo-3.1-fast-generate-preview");
    await variant(veoRun, 1, "REJECTED", "FAIL", 1.6);
    await variant(veoRun, 2, "REVIEW", "FLAG", 1.6);
    const omniRun = await run("gemini-omni-1.1-flash");
    await variant(omniRun, 1, "REJECTED", "FAIL", 1.5);
    await variant(omniRun, 2, "REVIEW", "PASS", 1.5);
    await variant(omniRun, 3, "SCRIPTED", null, null);
    const fakeRun = await run("gemini-omni-1.1-flash", true);
    await variant(fakeRun, 1, "REVIEW", "PASS", 0, true);
    // Không video nào ĐÃ DUYỆT (CHECK đòi bản hoàn chỉnh) ⇒ tiền / video duyệt phải là null, không phải chia cho 0.
    const rows = (await modelComparison(db)).filter((r) => r.model === "gemini-omni-1.1-flash" || r.model === "veo-3.1-fast-generate-preview");
    const omni = rows.find((r) => r.model === "gemini-omni-1.1-flash");
    const veo = rows.find((r) => r.model === "veo-3.1-fast-generate-preview");
    assert.ok(omni && veo);
    assert.deepEqual([omni.videos, omni.qcPass, omni.qcFail, omni.rejected], [2, 1, 1, 1], `chưa QC không đếm, dữ liệu thử không đếm: ${JSON.stringify(omni)}`);
    assert.equal(omni.aiUsd, 3);
    assert.equal(omni.usdPerApproved, null);
    assert.deepEqual([veo.videos, veo.qcFlag, veo.qcFail], [2, 1, 1]);
    console.log("✓ Video Scale Omni (CSDL): so sánh model theo ảnh chụp cấu hình của lượt · bỏ dữ liệu thử · chưa QC không đếm · 0 video duyệt ⇒ —");
  } finally {
    await clean();
  }
}
