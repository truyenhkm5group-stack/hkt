import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { FakeProvider } from "@/lib/ai/provider";
import { CREATIVE_CONFIG_KEY, DEFAULT_CREATIVE_CONFIG, estimateImageUsd, normalizeCreativeConfig, type Genes } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { buildBatch, imageSpendToday } from "@/lib/creative/generate";
import { sha256Hex, storeCreativeImage } from "@/lib/creative/images";
import { batchWindow } from "@/lib/creative/schedule";
import { describeSource } from "@/lib/creative/vision";
import { PRESERVE_PRODUCT_CLAUSE, findPriceMentions, geneDirectives, writeVariantCopy, type CopyWriter, type WriterInput } from "@/lib/creative/writer";
import { editImage, imageEditCostUsd, parseImageUsage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";
import { loadPlanInputs } from "@/lib/queries/creative-plan";

/**
 * ═══════════ VÒNG MẪU · GÓI A (SINH) — TỪ LÔ RỖNG TỚI ẢNH CHỜ DUYỆT ═══════════
 *
 * Khoá:
 *  (a) ảnh SPY / MANUAL / RND KHÔNG BAO GIỜ tới máy sinh ảnh — bản giả ghi lại mọi loại + băm;
 *  (b) `editImage()` ném lỗi khi nhận loại ảnh lạ, TRƯỚC khi gọi mạng; thử lại chỉ với 429/5xx;
 *  (c) chạy `buildBatch()` nhiều lần không đẻ lô thứ hai và không sinh lại ảnh đã có;
 *  (d) chạm trần ngày ⇒ `GEN_FAILED` có lý do, lô vẫn tới `PENDING_APPROVAL` nếu có ảnh;
 *  (e) `enabled = false` ⇒ không tạo gì;
 *  (f) câu chữ sai giá bị bắt viết lại, vẫn sai thì bỏ con số giá;
 *  (g) mức mã nguồn: chỉ nguồn ảnh sản phẩm + mẫu cha dẫn tới `readCreativeImage` trong đường sinh.
 *
 * Không gọi mạng thật, không đọc biến môi trường: mọi lời gọi OpenAI đi qua `fetch` / client TIÊM.
 * Mốc thời gian dựng từ `batchWindow()` của NGÀY MAI theo đồng hồ thật (AGENTS.md mục 50): trần
 * ngày đếm trên `created_at` do CSDL ghi bằng đồng hồ thật, nên `now` phải cùng ngày Việt Nam với nó.
 */

const P = "cg-";
const G1: Genes = { angle: "LIFESTYLE", scene: "CAFE", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "NONE", palette: "WARM" };
const G2: Genes = { angle: "QUALITY_DETAIL", scene: "STUDIO_PLAIN", model: "NONE", composition: "DETAIL_CLOSEUP", textOverlay: "HEADLINE", palette: "NEUTRAL" };

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ───────────────────────────── (b) editImage ─────────────────────────────

async function testEditImageBoundary() {
  let fetchCalls = 0;
  const neverFetch = (async () => {
    fetchCalls += 1;
    throw new Error("không được gọi mạng");
  }) as typeof fetch;
  const product: ImageEditInputImage = { kind: "PRODUCT_PHOTO", bytes: fakeJpeg(1), contentType: "image/jpeg" };
  const base = { model: "gpt-image-1", prompt: "a dress", size: "1024x1024" as const, quality: "medium" as const };

  for (const kind of ["SPY", "MANUAL", "RND", "", "product_photo"]) {
    const smuggled = { kind, bytes: fakeJpeg(2), contentType: "image/jpeg" } as unknown as ImageEditInputImage;
    await assert.rejects(() => editImage({ ...base, images: [product, smuggled] }, { apiKey: "sk-test-FAKE", fetchImpl: neverFetch }), /ranh giới 2/, `(b) loại "${kind}" phải bị chặn lúc chạy`);
  }
  await assert.rejects(() => editImage({ ...base, images: [] }, { apiKey: "sk-test-FAKE", fetchImpl: neverFetch }), /ít nhất một ảnh/);
  await assert.rejects(
    () => editImage({ ...base, images: [{ kind: "OWN_VARIANT", bytes: fakeJpeg(3), contentType: "image/jpeg" }] }, { apiKey: "sk-test-FAKE", fetchImpl: neverFetch }),
    /ranh giới 3/,
    "(b) thiếu ảnh sản phẩm thật ⇒ chặn",
  );
  await assert.rejects(() => editImage({ ...base, images: [product] }, { apiKey: "", fetchImpl: neverFetch }), /OPENAI_API_KEY/);
  assert.equal(fetchCalls, 0, "(b) mọi lượt bị chặn đều chặn TRƯỚC khi gọi mạng");

  // Thử lại ĐÚNG một lần với 5xx; đọc ảnh + usage; multipart đủ trường.
  const seen: FormData[] = [];
  const out = fakeJpeg(99);
  const usage = { input_tokens: 1000, output_tokens: 4000, input_tokens_details: { text_tokens: 200, image_tokens: 800 } };
  let n = 0;
  const flaky = (async (_url: string | URL | Request, init?: RequestInit) => {
    n += 1;
    seen.push(init?.body as FormData);
    return n === 1 ? jsonResponse(503, { error: { message: "busy" } }) : jsonResponse(200, { data: [{ b64_json: Buffer.from(out).toString("base64") }], usage });
  }) as typeof fetch;
  const res = await editImage({ ...base, images: [product, { kind: "OWN_VARIANT", bytes: fakeJpeg(4), contentType: "image/jpeg" }] }, { apiKey: "sk-test-FAKE", fetchImpl: flaky });
  assert.equal(n, 2, "(b) 503 ⇒ thử lại đúng một lần");
  assert.deepEqual([...res.bytes], [...out]);
  assert.equal(res.contentType, "image/jpeg");
  assert.equal(res.costUsd, 0.169, "(b) chi phí theo token: 200×$5 + 800×$10 + 4000×$40 / 1M");
  const form = seen[1];
  assert.equal(form.getAll("image[]").length, 2);
  assert.equal(form.get("model"), "gpt-image-1");
  assert.equal(form.get("output_format"), "jpeg");
  assert.equal(form.get("n"), "1");
  assert.equal(form.get("quality"), "medium");

  // 4xx khác 429 ⇒ KHÔNG thử lại, và câu lỗi không mang khoá.
  let m = 0;
  const bad = (async () => {
    m += 1;
    return jsonResponse(400, { error: { message: "prompt rejected" } });
  }) as typeof fetch;
  await assert.rejects(
    () => editImage({ ...base, images: [product] }, { apiKey: "sk-test-FAKE", fetchImpl: bad }),
    (e: Error) => /HTTP 400/.test(e.message) && !e.message.includes("sk-test"),
  );
  assert.equal(m, 1, "(b) 400 ⇒ không thử lại");

  assert.equal(imageEditCostUsd("gpt-image-1", null), null, "không có usage ⇒ CHƯA BIẾT, không phải 0");
  assert.equal(imageEditCostUsd("gpt-image-1-mini", parseImageUsage(usage)), null, "model khác giá ⇒ CHƯA BIẾT, không tính nhầm theo tiền tố");
  assert.equal(parseImageUsage({ output_tokens: 3 }), null);
  console.log("✓ Vòng mẫu · sinh ảnh: loại ảnh lạ bị chặn trước khi gọi mạng · thử lại chỉ với 5xx · chi phí theo token, CHƯA BIẾT ≠ 0");
}

// ───────────────────────────── (f) writer ─────────────────────────────

function copyJson(primaryText: string, headline = "Đầm đi cà phê cuối tuần") {
  return JSON.stringify({ imagePrompt: "A young woman sitting in a bright cafe, soft morning light, relaxed pose.", primaryText, headline });
}

async function testWriter(db: Db, startedAt: Date) {
  const input: WriterInput = {
    genes: { ...G1, textOverlay: "PRICE_AND_HEADLINE" },
    mode: "EXPLORE",
    why: "Ý mới",
    product: { name: "Đầm cg", code: "CG001", priceVnd: 299_000 },
    inspirationSummary: null,
    winningExamples: [],
  };
  const reply = (text: string) => () => ({ content: [{ type: "text" as const, text }], stopReason: "end_turn" as const });

  // Sai giá ⇒ viết lại một lần ⇒ đúng giá thì giữ.
  const p1 = new FakeProvider([reply(copyJson("Giá chỉ 199k, mặc đi đâu cũng đẹp")), reply(copyJson("Chỉ 299.000đ, mặc đi đâu cũng đẹp"))]);
  const r1 = await writeVariantCopy(input, { provider: p1, entityId: `${P}w1` });
  assert.equal(p1.calls.length, 2, "(f) giá sai ⇒ đúng MỘT lượt viết lại");
  assert.match(JSON.stringify(p1.calls[1].messages), /199k/, "(f) lượt viết lại phải nói rõ con số sai");
  assert.equal(r1.attempts, 2);
  assert.equal(r1.priceStripped, false);
  assert.deepEqual(findPriceMentions(r1.primaryText).map((x) => x.vnd), [299_000]);

  // Sai cả hai lần ⇒ bỏ con số giá.
  const p2 = new FakeProvider([reply(copyJson("Giá chỉ 199k hôm nay")), reply(copyJson("Giá chỉ 249.000 đ hôm nay"))]);
  const r2 = await writeVariantCopy(input, { provider: p2 });
  assert.equal(r2.priceStripped, true);
  assert.deepEqual(findPriceMentions(r2.primaryText), [], `(f) vẫn sai sau khi viết lại ⇒ không còn con số giá nào: "${r2.primaryText}"`);

  // Không biết giá ⇒ MỌI con số giá đều sai.
  const p3 = new FakeProvider([reply(copyJson("Đồng giá 499K")), reply(copyJson("Đồng giá 499K"))]);
  const r3 = await writeVariantCopy({ ...input, product: { ...input.product, priceVnd: null } }, { provider: p3 });
  assert.deepEqual(findPriceMentions(r3.primaryText), []);
  assert.doesNotMatch(r3.imagePrompt, /price badge/, "không biết giá ⇒ không in nhãn giá lên ảnh");

  // Đúng ngay ⇒ một lượt; câu lệnh ảnh mang đủ sáu chỉ thị gen + câu giữ sản phẩm.
  const p4 = new FakeProvider([reply(copyJson("Mặc đi cà phê cuối tuần, giá 299k."))]);
  const r4 = await writeVariantCopy(input, { provider: p4 });
  assert.equal(p4.calls.length, 1);
  for (const d of geneDirectives(input.genes, 299_000, r4.headline)) assert.ok(r4.imagePrompt.includes(d), `câu lệnh ảnh thiếu chỉ thị: ${d}`);
  assert.ok(r4.imagePrompt.includes(PRESERVE_PRODUCT_CLAUSE));
  assert.match(r4.imagePrompt, /299\.000đ/, "nhãn giá trên ảnh = đúng giá ERP");

  // Quá dài ⇒ cắt ở ranh giới từ.
  const long = "Đầm ".repeat(200);
  const p5 = new FakeProvider([reply(copyJson(long, "Tiêu đề rất rất rất rất rất rất dài quá bốn mươi ký tự"))]);
  const r5 = await writeVariantCopy(input, { provider: p5 });
  assert.ok(r5.headline.length <= 40 && r5.primaryText.length <= 500);

  await assert.rejects(() => writeVariantCopy(input, { provider: null }), /AI đang tắt/, "(f) không có provider ⇒ lỗi rõ ràng");

  const logged = await db.select({ id: schema.aiInteractions.id }).from(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, "creative.writer"), eq(schema.aiInteractions.entityId, `${P}w1`), gte(schema.aiInteractions.createdAt, startedAt)));
  assert.equal(logged.length, 1, "mỗi lượt viết ghi đúng một dòng ai_interactions");

  assert.deepEqual(findPriceMentions("3 màu, size 38, giảm 20%"), [], "số trơn không phải giá");
  assert.deepEqual(findPriceMentions("1,2tr và 350.000 VND").map((x) => x.vnd), [1_200_000, 350_000]);
  console.log("✓ Vòng mẫu · viết câu chữ: sai giá ⇒ viết lại một lần ⇒ vẫn sai thì bỏ số giá · đủ sáu gen + giữ sản phẩm · có sổ AI");
}

// ───────────────────────────── vision ─────────────────────────────

async function testVision(db: Db, spySourceId: string, spyBytes: Uint8Array, startedAt: Date) {
  const noKey = await describeSource(db, spySourceId, { apiKey: "" });
  assert.equal(noKey.ok, false);

  let sent = "";
  const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent = String(init?.body ?? "");
    const answer = JSON.stringify({ genes: { angle: "BOGUS", scene: "STREET", model: null, composition: "COLLAGE", textOverlay: "NONE", palette: "VIVID" }, summary: "x".repeat(900) });
    return jsonResponse(200, { model: "gpt-test", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }], usage: { input_tokens: 500, output_tokens: 60 } });
  }) as typeof fetch;
  const r = await describeSource(db, spySourceId, { apiKey: "sk-test-FAKE", fetchImpl: fake });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.genes, { scene: "STREET", composition: "COLLAGE", textOverlay: "NONE", palette: "VIVID" }, "gen lạ / null bị BỎ, không bị ép");
  assert.equal(r.summary.length, 400);
  assert.ok(sent.includes(Buffer.from(spyBytes).toString("base64")), "mô hình ĐỌC ảnh được nhận ảnh SPY — đọc là hợp lệ");
  assert.ok(!sent.includes("sk-test"), "khoá không nằm trong thân yêu cầu");
  const [row] = await db.select().from(schema.creativeSources).where(eq(schema.creativeSources.id, spySourceId));
  assert.equal(row.visionModel, "gpt-test");
  assert.ok(row.visionAt);
  const logged = await db.select({ status: schema.aiInteractions.status, prompt: schema.aiInteractions.prompt }).from(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, "creative.vision"), eq(schema.aiInteractions.entityId, spySourceId), gte(schema.aiInteractions.createdAt, startedAt)));
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].prompt.includes("base64"), "sổ AI không chứa điểm ảnh");

  const broken = (async () => jsonResponse(500, { error: { message: "down" } })) as typeof fetch;
  const r2 = await describeSource(db, spySourceId, { apiKey: "sk-test-FAKE", fetchImpl: broken });
  assert.equal(r2.ok, false, "lỗi ⇒ { ok:false }, không ném");
  console.log("✓ Vòng mẫu · đọc ảnh nguồn: gen lọc qua từ vựng · mô tả ≤ 400 ký tự · có sổ AI · lỗi không ném");
}

// ───────────────────────────── (g) mức mã nguồn ─────────────────────────────

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function testGenerateSourceGuard() {
  const src = stripComments(readFileSync(path.join(process.cwd(), "lib/creative/generate.ts"), "utf8"));
  const start = src.indexOf("async function gatherPixels(");
  assert.ok(start >= 0, "(g) phải có một hàm gom điểm ảnh duy nhất");
  const endMatch = /\r?\n\}\r?\n/.exec(src.slice(start));
  assert.ok(endMatch, "(g) không tìm thấy cuối hàm gatherPixels");
  const body = src.slice(start, start + endMatch.index);
  const signature = body.split(/\r?\n/)[0];
  assert.match(signature, /ref:\s*\{\s*productPhotoSourceId: string \| null; parentVariantId: string \| null\s*\}/, "(g) gatherPixels chỉ nhận nguồn ảnh sản phẩm + mẫu cha");
  assert.doesNotMatch(body, /inspiration/i, "(g) gatherPixels không được nhắc tới nguồn cảm hứng");

  const reads = [...src.matchAll(/readCreativeImage\(/g)].map((m) => m.index ?? 0);
  assert.ok(reads.length >= 2, "(g) gatherPixels phải đọc ảnh sản phẩm + ảnh mẫu cha");
  for (const i of reads) assert.ok(i > start && i < start + endMatch.index, "(g) readCreativeImage chỉ được gọi bên trong gatherPixels");

  for (const line of src.split(/\r?\n/).filter((l) => l.includes("inspirationSourceId"))) {
    assert.ok(/inspirationSourceId: s\.inspirationSourceId,/.test(line) || /inspirationSummaryOf\(db, variant\.inspirationSourceId\)/.test(line), `(g) nguồn cảm hứng chỉ được lưu vào ô hoặc đọc thành CHỮ: ${line.trim()}`);
  }
  const summaryFn = src.slice(src.indexOf("async function inspirationSummaryOf("), src.indexOf("function errText("));
  assert.match(summaryFn, /visionSummary/);
  assert.doesNotMatch(summaryFn, /imageId|readCreativeImage/, "(g) nguồn cảm hứng chỉ đi tiếp bằng vision_summary");
  assert.match(src, /const images = await gatherPixels\(db, \{ productPhotoSourceId: variant\.productPhotoSourceId, parentVariantId: variant\.parentVariantId \}\);/);
  assert.match(src, /deps\.imageClient\(\{ model: cfg\.imageModel, prompt: copy\.imagePrompt, images, /, "(g) client ảnh chỉ nhận ảnh từ gatherPixels");
  console.log("✓ Vòng mẫu · mức mã nguồn: chỉ ảnh sản phẩm + mẫu cha dẫn tới readCreativeImage trong đường sinh");
}

// ───────────────────────────── (a)(c)(d)(e) buildBatch ─────────────────────────────

async function setConfig(db: Db, value: Record<string, unknown>) {
  const text = JSON.stringify(value);
  await db.insert(schema.settings).values({ key: CREATIVE_CONFIG_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text } });
}

async function dropBatch(db: Db, batchDay: string) {
  const [b] = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
  if (!b) return;
  const vs = await db.select({ id: schema.creativeVariants.id, imageId: schema.creativeVariants.imageId }).from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, b.id));
  await db.delete(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, b.id));
  const imgs = vs.map((v) => v.imageId).filter((x): x is string => Boolean(x));
  if (imgs.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imgs));
  await db.delete(schema.creativeBatches).where(eq(schema.creativeBatches.id, b.id));
}

export async function testCreativeGenerate(db: Db) {
  const startedAt = new Date();
  const batchDay = shiftDay(vnDay(startedAt), 1);
  const baseCfg = { ...DEFAULT_CREATIVE_CONFIG, batchSize: 5, extraCandidates: 1, exploreShare: 0.5 };
  const w = batchWindow(batchDay, baseCfg);
  // 14:01 giờ VN của HÔM NAY — cùng ngày Việt Nam với `created_at` mà CSDL sắp ghi.
  const now = new Date(w.buildFrom.getTime() + 60_000);
  const parentDay = shiftDay(batchDay, -5);
  const learningDay = shiftDay(batchDay, -1);
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const imageIds: string[] = [];
  const sourceIds: string[] = [];

  try {
    await testEditImageBoundary();
    testGenerateSourceGuard();

    // ─── Dữ liệu nền ───
    await db.insert(schema.products).values({ id: `${P}prod-1`, name: "Đầm cg", customId: "CG001" });
    await db.insert(schema.productVariants).values([
      { id: `${P}var-1a`, productId: `${P}prod-1`, retailPrice: 350_000, retailPriceAfterDiscount: 299_000 },
      { id: `${P}var-1b`, productId: `${P}prod-1`, retailPrice: 350_000, retailPriceAfterDiscount: 299_000 },
    ]);
    const store = async (tag: number) => {
      const s = await storeCreativeImage(db, fakeJpeg(tag));
      imageIds.push(s.id);
      return s;
    };
    const photo = await store(10);
    const spy = await store(11);
    const manual = await store(12);
    const rnd = await store(13);
    const win = await store(14);
    const src = async (v: typeof schema.creativeSources.$inferInsert) => {
      const [r] = await db.insert(schema.creativeSources).values(v).returning({ id: schema.creativeSources.id });
      sourceIds.push(r.id);
      return r.id;
    };
    const photoId = await src({ kind: "PRODUCT_PHOTO", productId: `${P}prod-1`, title: `${P}photo`, imageId: photo.id });
    const spyId = await src({ kind: "SPY", title: `${P}spy`, imageId: spy.id, genes: { scene: "STREET", palette: "VIVID" }, visionSummary: "Bố cục đường phố, ánh nắng chiều", visionAt: startedAt });
    const manualId = await src({ kind: "MANUAL", title: `${P}manual`, imageId: manual.id, genes: { scene: "HOME" }, visionSummary: "Phòng khách sáng, ảnh gương", visionAt: startedAt });
    const rndId = await src({ kind: "RND", title: `${P}rnd`, imageId: rnd.id });

    await testWriter(db, startedAt);
    await testVision(db, spyId, fakeJpeg(11), startedAt);
    // Trả SPY về trạng thái đã đọc sẵn, để lượt dựng lô không đọc lại nó.
    await db.update(schema.creativeSources).set({ genes: { scene: "STREET", palette: "VIVID" }, visionSummary: "Bố cục đường phố, ánh nắng chiều", visionAt: startedAt }).where(eq(schema.creativeSources.id, spyId));

    const pw = batchWindow(parentDay, baseCfg);
    const [parentBatch] = await db
      .insert(schema.creativeBatches)
      .values({ batchDay: parentDay, status: "PUBLISHED", slotCount: 2, startAt: pw.startAt, endAt: pw.endAt, approvalDeadline: pw.approvalDeadline, ruleVersion: 1, approvedAt: startedAt, approvalDigest: `${P}digest` })
      .returning({ id: schema.creativeBatches.id });
    const [winV] = await db
      .insert(schema.creativeVariants)
      .values({ batchId: parentBatch.id, slot: 1, mode: "EXPLORE", productId: `${P}prod-1`, productPhotoSourceId: photoId, genes: G1, genesVersion: 1, primaryText: "Câu chữ thắng cg", headline: "Tiêu đề thắng", imageId: win.id, genModel: "gpt-image-1", genCostUsd: "0.040000", status: "ENDED", fbAdId: `${P}ad-1`, libraryAt: startedAt, libraryOrders: 120 })
      .returning({ id: schema.creativeVariants.id });
    const [promV] = await db
      .insert(schema.creativeVariants)
      .values({ batchId: parentBatch.id, slot: 2, mode: "EXPLORE", productId: `${P}prod-1`, productPhotoSourceId: photoId, genes: G2, genesVersion: 1, status: "ENDED", fbAdId: `${P}ad-2` })
      .returning({ id: schema.creativeVariants.id });
    await db.insert(schema.creativeVerdicts).values([
      { verdictDay: shiftDay(parentDay, 1), variantId: promV.id, verdict: "RUNNING", metrics: { spendVnd: 50_000, bookedOrders: 1 }, ruleVersion: 1 },
      { verdictDay: shiftDay(parentDay, 2), variantId: promV.id, verdict: "PROMISING", metrics: { spendVnd: 200_000, bookedOrders: 12 }, ruleVersion: 1 },
    ]);
    await db.insert(schema.creativeLearnings).values({
      learningDay,
      geneStats: [{ key: "scene", value: "CAFE", tests: 4, successes: 3, wins: 1, spendVnd: 800_000, bookedOrders: 40, posteriorMean: 0.66, relativeCount: 0 }, { key: "scene", value: "MARS" }, { nonsense: true }],
      ruleVersion: 1,
      genesVersion: 1,
    });

    // ─── loadPlanInputs ───
    const inputs = await loadPlanInputs(db, batchDay, normalizeCreativeConfig(baseCfg).config);
    assert.deepEqual(inputs.products.map((x) => [x.productId, x.photoSourceId, x.recentTests]), [[`${P}prod-1`, photoId, 2]]);
    assert.deepEqual(new Set(inputs.inspirations.map((x) => x.sourceId)), new Set([spyId, manualId, rndId]), "nguồn cảm hứng = mọi nguồn bật không phải ảnh sản phẩm");
    const byId = new Map(inputs.parents.map((x) => [x.variantId, x]));
    assert.equal(byId.get(winV.id)?.verdict, "WIN");
    assert.equal(byId.get(winV.id)?.imageId, win.id);
    assert.equal(byId.get(winV.id)?.spendVnd, null, "không có phán quyết ⇒ số chi CHƯA BIẾT, không phải 0");
    assert.equal(byId.get(promV.id)?.verdict, "PROMISING", "phán quyết MỚI NHẤT quyết định");
    assert.equal(byId.get(promV.id)?.bookedOrders, 12);
    assert.equal(inputs.stats.length, 1, "dòng gene_stats hỏng bị bỏ, không làm hỏng cả sổ");
    assert.equal(inputs.slotCount, 6);
    assert.equal(inputs.recentSignatures.length, 2);
    const focused = await loadPlanInputs(db, batchDay, { ...normalizeCreativeConfig(baseCfg).config, focusProductIds: [`${P}khac`] });
    assert.equal(focused.products.length, 0, "focusProductIds lọc mã hàng");

    // ─── Bản giả ───
    const shaOf = { photo: photo.sha256, win: win.sha256, forbidden: new Set([spy.sha256, manual.sha256, rnd.sha256]) };
    const unit = estimateImageUsd(baseCfg.imageModel, baseCfg.imageQuality, baseCfg.imageSize);
    const imageCalls: { kinds: string[]; shas: string[] }[] = [];
    let tag = 1000;
    const fakeClient: ImageEditClient = async (input) => {
      imageCalls.push({ kinds: input.images.map((i) => i.kind), shas: input.images.map((i) => sha256Hex(i.bytes)) });
      tag += 1;
      return { bytes: fakeJpeg(tag), contentType: "image/jpeg", usage: null, costUsd: unit };
    };
    const writerCalls: WriterInput[] = [];
    const fakeWriter: CopyWriter = async (input) => {
      writerCalls.push(input);
      return { imagePrompt: "prompt", primaryText: "Câu chữ", headline: "Tiêu đề", model: "fake-writer", costUsd: null, attempts: 1, priceStripped: false };
    };
    const described: string[] = [];
    const fakeDescribe = async (_db: Db, id: string) => {
      described.push(id);
      return { ok: false as const, error: "giả" };
    };
    const deps = (perTick: number) => ({ imageClient: fakeClient, writer: fakeWriter, describe: fakeDescribe, perTick });

    // (e) TẮT ⇒ không tạo gì.
    await setConfig(db, { ...baseCfg, enabled: false });
    const off = await buildBatch(db, now, deps(3));
    assert.match(off.skippedReason ?? "", /TẮT/);
    assert.equal((await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay))).length, 0, "(e) tắt ⇒ không lô nào");
    assert.equal(imageCalls.length + writerCalls.length + described.length, 0, "(e) tắt ⇒ không gọi gì");

    // (a)(c) Hai tick sinh hết, tick thứ ba không làm gì.
    await setConfig(db, { ...baseCfg, enabled: true });
    const t1 = await buildBatch(db, now, deps(3));
    assert.equal(t1.batchDay, batchDay);
    assert.equal(t1.created, true);
    assert.equal(t1.generated, 3);
    assert.equal(t1.status, "PLANNED", "còn ô chưa sinh ⇒ lô vẫn đang dựng");
    assert.deepEqual(described, [rndId], "chỉ nguồn CHƯA đọc được đọc trước khi lập lô");
    const t2 = await buildBatch(db, now, deps(3));
    assert.equal(t2.created, false, "(c) tick thứ hai không lập lô mới");
    const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
    const variants = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batch.id));
    const total = variants.length;
    assert.ok(total >= 4, `lô phải có đủ ô để kiểm (có ${total})`);
    assert.equal(t1.generated + t2.generated, total);
    assert.equal(t2.status, "PENDING_APPROVAL");
    const callsAfter = imageCalls.length;
    const t3 = await buildBatch(db, now, deps(3));
    assert.equal(t3.generated, 0);
    assert.equal(imageCalls.length, callsAfter, "(c) lô đã đủ ảnh ⇒ không sinh lại ảnh nào");
    assert.match(t3.skippedReason ?? "", /PENDING_APPROVAL/);
    assert.equal((await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay))).length, 1, "(c) đúng MỘT lô cho một ngày");
    assert.ok(variants.every((v) => v.status === "GENERATED" && v.imageId && v.genCostUsd === unit.toFixed(6) && v.writerModel === "fake-writer" && v.writerCostUsd === ""), "(c) mọi mẫu có ảnh, chi phí thật, chi phí viết CHƯA BIẾT = ''");
    assert.equal(batch.ruleVersion, 1);
    assert.equal((batch.configSnapshot as { batchSize?: number }).batchSize, 5, "cấu hình chụp nguyên vào lô");

    // (a) Điểm ảnh tới máy sinh ảnh chỉ là ảnh của shop.
    assert.equal(imageCalls.length, total);
    for (const c of imageCalls) {
      assert.ok(c.kinds.every((k) => k === "PRODUCT_PHOTO" || k === "OWN_VARIANT"), `(a) loại ảnh lạ tới máy sinh ảnh: ${c.kinds.join(",")}`);
      assert.ok(c.shas.every((s) => !shaOf.forbidden.has(s)), "(a) điểm ảnh SPY / MANUAL / RND tới máy sinh ảnh");
      assert.equal(c.shas.filter((s, i) => c.kinds[i] === "PRODUCT_PHOTO" && s === shaOf.photo).length, 1, "(a) mỗi lượt có đúng một ảnh sản phẩm thật");
      c.shas.forEach((s, i) => c.kinds[i] === "OWN_VARIANT" && assert.equal(s, shaOf.win, "(a) ảnh mẫu cha là ảnh của mẫu THẮNG"));
    }
    const exploit = variants.filter((v) => v.mode === "EXPLOIT");
    assert.ok(exploit.length > 0 && imageCalls.some((c) => c.kinds.includes("OWN_VARIANT")), "có ô khai thác gửi ảnh mẫu cha");
    const withInsp = variants.filter((v) => v.inspirationSourceId === spyId || v.inspirationSourceId === manualId);
    assert.ok(withInsp.length > 0, "có ô thăm dò dùng nguồn spy/tay");
    assert.ok(writerCalls.some((wc) => wc.inspirationSummary === "Bố cục đường phố, ánh nắng chiều"), "(a) nguồn SPY đi vào người viết bằng CHỮ");
    assert.ok(writerCalls.every((wc) => wc.product.priceVnd === 299_000 && wc.product.code === "CG001"), "giá ERP tới người viết");
    assert.ok(writerCalls.some((wc) => wc.winningExamples.some((e) => e.headline === "Tiêu đề thắng")), "câu chữ mẫu thắng tới người viết");

    // (d) Chạm trần ngày: cho đúng HAI ảnh nữa rồi chặn.
    await dropBatch(db, batchDay);
    const before = await imageSpendToday(db, now, unit);
    await setConfig(db, { ...baseCfg, enabled: true, imageDailyCapUsd: before.usd + unit * 2.5 });
    const callsBeforeCap = imageCalls.length;
    const capped = await buildBatch(db, now, deps(10));
    assert.equal(capped.created, true);
    assert.equal(capped.generated, 2, "(d) trần cho đúng hai ảnh");
    assert.equal(imageCalls.length - callsBeforeCap, 2, "(d) chạm trần ⇒ không gọi máy sinh ảnh thêm lần nào");
    assert.ok(capped.capped >= 1);
    assert.equal(capped.status, "PENDING_APPROVAL", "(d) có ảnh ⇒ lô vẫn tới duyệt");
    const [cb] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
    const cvs = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, cb.id));
    const failed = cvs.filter((v) => v.status === "GEN_FAILED");
    assert.equal(failed.length, capped.capped);
    assert.ok(failed.every((v) => /Chạm trần chi sinh ảnh/.test(v.genError) && !v.imageId), "(d) mẫu bị chặn mang lý do rõ, không có ảnh");

    // Không ảnh nào ⇒ lô FAILED kèm lý do.
    await dropBatch(db, batchDay);
    await setConfig(db, { ...baseCfg, enabled: true });
    const failingClient: ImageEditClient = async () => {
      throw new Error("máy sinh ảnh hỏng");
    };
    const dead = await buildBatch(db, now, { ...deps(10), imageClient: failingClient });
    assert.equal(dead.status, "FAILED");
    assert.equal(dead.generated, 0);
    const [deadBatch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
    assert.ok(deadBatch.error.length > 0, "lô FAILED phải nói vì sao");
    const dvs = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, deadBatch.id));
    assert.ok(dvs.every((v) => v.status === "GEN_FAILED" && /máy sinh ảnh hỏng/.test(v.genError) && v.primaryText === "Câu chữ"), "lỗi sinh ảnh vẫn giữ câu chữ đã viết để người xem lại");

    console.log(`✓ Vòng mẫu · dựng lô: tắt ⇒ không tạo gì · ${total} ô qua hai tick rồi dừng · một lô một ngày · chỉ ảnh của shop tới máy sinh ảnh · chạm trần ⇒ GEN_FAILED có lý do`);
  } finally {
    await dropBatch(db, batchDay);
    const [pb] = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, parentDay));
    if (pb) {
      const pvs = await db.select({ id: schema.creativeVariants.id }).from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, pb.id));
      if (pvs.length) await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, pvs.map((v) => v.id)));
      await db.delete(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, pb.id));
      await db.delete(schema.creativeBatches).where(eq(schema.creativeBatches.id, pb.id));
    }
    await db.delete(schema.creativeLearnings).where(eq(schema.creativeLearnings.learningDay, learningDay));
    if (sourceIds.length) await db.delete(schema.creativeSources).where(inArray(schema.creativeSources.id, sourceIds));
    if (imageIds.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imageIds));
    await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
    await db.delete(schema.aiInteractions).where(and(like(schema.aiInteractions.route, "creative.%"), gte(schema.aiInteractions.createdAt, startedAt)));
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}
