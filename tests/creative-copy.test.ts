import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY, DEFAULT_CREATIVE_CONFIG, normalizeCreativeConfig } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { approvalDigest, batchTicket, verifyBatchTicket } from "@/lib/creative/approval";
import { CAPTION_FALLBACK_PREFIX, CAPTION_ROUTE, captionFromImage, finalizeCaption, parseCaptionAnswer, type CaptionInput, type VariantCaptioner } from "@/lib/creative/caption";
import { copyEditBlocker, priceWarnings, saveVariantCopyCore, suggestVariantCopyCore } from "@/lib/creative/copy-edit";
import { buildBatch } from "@/lib/creative/generate";
import { readCreativeImage, storeCreativeImage } from "@/lib/creative/images";
import { batchApprovalContent } from "@/lib/creative/publish";
import { batchWindow } from "@/lib/creative/schedule";
import { WRITER_LIMITS, findPriceMentions, type CopyWriter } from "@/lib/creative/writer";
import type { ImageEditClient } from "@/lib/integrations/openai/images";
import { VARIANT_COPY_LIMITS, variantCopyInputSchema } from "@/lib/validation/creative";

/**
 * ═══════════ VÒNG MẪU — CÂU CHỮ THEO ẢNH + SOẠN CÂU CHỮ TRƯỚC KHI DUYỆT ═══════════
 *
 * Khoá:
 *  1. `captionFromImage()` (mô hình GIẢ qua `fetchImpl`): giá sai ⇒ viết lại MỘT lần ⇒ vẫn sai thì bỏ
 *     con số giá; dài ⇒ cắt đúng trần; mọi lỗi ⇒ `{ ok: false }`, KHÔNG ném; có sổ `ai_interactions`.
 *  2. Đường sinh gọi câu chữ theo ảnh SAU khi ảnh được lưu; hỏng (trả lỗi hoặc ném) ⇒ GIỮ câu nháp,
 *     mẫu vẫn `GENERATED`, lý do nằm ở `gen_error`.
 *  3. Sửa câu chữ: chặn khi lô đã duyệt / quá hạn / mẫu bị gạt; digest đổi ⇒ phiếu cũ vô hiệu; giá
 *     khác ERP chỉ CẢNH BÁO. Gợi ý không ghi gì vào mẫu.
 *  4. Mức mã nguồn: hai action mới có nút gọi, client component không nhập truy vấn / tệp chỉ-máy-chủ.
 *
 * Không gọi mạng thật: mọi lời gọi mô hình đi qua `fetchImpl` hoặc `deps.caption` TIÊM. Mốc thời gian
 * dựng từ `batchWindow()` của một ngày lô xa trong tương lai (AGENTS.md mục 50).
 *
 * Chạy riêng phần thuần: npx tsx --tsconfig tsconfig.json tests/creative-copy.test.ts
 */

const P = "cc-";
const goc = path.resolve(__dirname, "..");
const doc = (rel: string) => readFileSync(path.join(goc, rel), "utf8");

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 5, 4, 3, 2, 1, 9, 9, 9]);
}

function responses(status: number, answer: unknown): Response {
  const body = status === 200 ? { model: "gpt-test", output: [{ type: "message", content: [{ type: "output_text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] }], usage: { input_tokens: 800, output_tokens: 120 } } : { error: { message: String(answer) } };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ───────────────────────────── 1 + 4. THUẦN ─────────────────────────────

export function testCreativeCopyPure() {
  assert.deepEqual({ ...VARIANT_COPY_LIMITS }, { ...WRITER_LIMITS }, "ô đếm ký tự trên màn hình và trần máy viết phải là MỘT cặp số");

  const ok = { variantId: "v", headline: "Tiêu đề", primaryText: "Nội dung" };
  assert.ok(variantCopyInputSchema.safeParse(ok).success);
  assert.ok(variantCopyInputSchema.safeParse({ ...ok, headline: "" }).success, "tiêu đề được để trống (bài ảnh không có ô tiêu đề)");
  assert.ok(!variantCopyInputSchema.safeParse({ ...ok, primaryText: "   " }).success, "nội dung chính bắt buộc");
  assert.ok(!variantCopyInputSchema.safeParse({ ...ok, headline: "x".repeat(41) }).success, "tiêu đề > 40 ký tự");
  assert.ok(!variantCopyInputSchema.safeParse({ ...ok, primaryText: "x".repeat(501) }).success, "nội dung > 500 ký tự");
  assert.ok(!variantCopyInputSchema.safeParse({ ...ok, batchId: "lạ" }).success, "lược đồ chặt — không nhận trường lạ");

  const han = new Date("2031-05-11T05:30:00+07:00");
  const truoc = new Date(han.getTime() - 60_000);
  assert.equal(copyEditBlocker({ batchStatus: "PENDING_APPROVAL", approvalDeadline: han, variantStatus: "GENERATED" }, truoc), null);
  assert.equal(copyEditBlocker({ batchStatus: "PLANNED", approvalDeadline: han, variantStatus: "GENERATED" }, truoc), null, "lô còn đang dựng vẫn sửa được mẫu đã có ảnh");
  for (const st of ["APPROVED", "PUBLISHED", "EXPIRED", "REJECTED", "FAILED"]) assert.match(copyEditBlocker({ batchStatus: st, approvalDeadline: han, variantStatus: "GENERATED" }, truoc) ?? "", /chưa duyệt/, `lô ${st} ⇒ chặn`);
  assert.match(copyEditBlocker({ batchStatus: "PENDING_APPROVAL", approvalDeadline: han, variantStatus: "GENERATED" }, han) ?? "", /quá hạn/, "đúng hạn là hết hạn");
  for (const st of ["REJECTED", "GEN_FAILED", "PLANNED", "LIVE"]) assert.ok(copyEditBlocker({ batchStatus: "PENDING_APPROVAL", approvalDeadline: han, variantStatus: st }, truoc), `mẫu ${st} ⇒ chặn`);

  assert.deepEqual(priceWarnings("Đầm xinh, giá 299k", 299_000), []);
  assert.equal(priceWarnings("Đầm xinh, giá 199k", 299_000).length, 1, "giá khác ERP ⇒ một cảnh báo");
  assert.equal(priceWarnings("Đầm xinh, giá 199k", null).length, 1, "không biết giá ⇒ mọi con số giá đều đáng cảnh báo");

  const f = finalizeCaption({ headline: "Đầm đỏ chỉ 199k, mặc đi đâu cũng đẹp lắm luôn nha", primaryText: "Giá chỉ 199k. " + "Đẹp ".repeat(200) }, 299_000);
  assert.ok(f.priceStripped);
  assert.deepEqual(findPriceMentions(`${f.headline} ${f.primaryText}`), [], "giá sai bị bỏ");
  assert.ok(f.headline.length <= 40 && f.primaryText.length <= 500, "cắt đúng trần");
  assert.equal(parseCaptionAnswer("không phải json"), null);
  assert.equal(parseCaptionAnswer(JSON.stringify({ seen: "", options: [{ headline: "a", primaryText: "  " }] })), null, "không còn phương án có nội dung ⇒ null");
  assert.equal(parseCaptionAnswer("```json\n" + JSON.stringify({ seen: "đầm xanh", options: [{ headline: "a", primaryText: "b" }] }) + "\n```")?.options.length, 1, "chịu được rào ```json");

  // ── Mức mã nguồn ──
  const act = doc("lib/actions/creative-copy.ts");
  const code = boChuThich(act);
  assert.ok(/^"use server";/.test(act), "creative-copy.ts phải là Server Action");
  assert.equal((code.match(/can\(user, "ideas:write"\)/g) ?? []).length, 2, "cả hai action dùng quyền ideas:write");
  assert.ok(code.includes("variantCopyInputSchema.safeParse(") && code.includes("audit(") && code.includes("revalidatePath("));
  assert.ok(/before: r\.before/.test(code) && /after: \{ \.\.\.r\.after/.test(code), "nhật ký ghi câu chữ trước/sau");
  assert.ok(!/\bfetch\(/.test(code) && !code.includes(".update("), "action không tự gọi mạng, không tự ghi — đi qua lib/creative/copy-edit.ts");
  const suggestFn = code.slice(code.indexOf("export async function suggestVariantCopy("), code.indexOf("export async function saveVariantCopy("));
  assert.ok(!suggestFn.includes("audit(") && !suggestFn.includes("saveVariantCopyCore("), "gợi ý CHỈ ĐỌC — không ghi mẫu");

  const DIR = "app/(dashboard)/marketing/creatives";
  const editor = doc(`${DIR}/copy-editor.tsx`);
  assert.ok(/^\s*["']use client["']/.test(editor), "copy-editor.tsx là client component");
  for (const a of ["suggestVariantCopy(", "saveVariantCopy("]) assert.ok(editor.includes(a), `copy-editor.tsx phải gọi ${a}`);
  assert.ok(editor.includes("Sửa câu chữ ⇒ cần bấm duyệt lại"), "màn hình phải nói: sửa câu chữ ⇒ cần bấm duyệt lại");
  assert.ok(editor.includes("variantCopyInputSchema.safeParse("), "form báo lỗi bằng ĐÚNG lược đồ máy chủ dùng");
  const tab = doc(`${DIR}/approve-tab.tsx`);
  assert.ok(tab.includes("<EditCopyButton") && tab.includes("<AdPreview") && tab.includes("Sẵn sàng đăng"), "tab Duyệt lô có nút soạn câu chữ và khối Sẵn sàng đăng");
  assert.ok(tab.includes("fanpageDisplayName(db, pending.config.pageId)"), "tên fanpage theo cấu hình CHỤP của lô");

  const clients = readdirSync(path.join(goc, DIR))
    .filter((x) => x.endsWith(".tsx") || x.endsWith(".ts"))
    .map((x) => `${DIR}/${x}`)
    .filter((rel) => /^\s*["']use client["']/.test(doc(rel)));
  assert.ok(clients.includes(`${DIR}/copy-editor.tsx`));
  for (const rel of clients) {
    for (const m of doc(rel).matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
      const [, what, from] = m;
      if (from.startsWith("@/lib/queries/")) assert.ok(/^type\s/.test(what.trim()), `${rel} nhập ${from} ngoài \`import type\``);
      for (const cam of ["@/db", "node:", "@/lib/creative/", "@/lib/integrations/", "@/lib/auth/", "@/lib/ai/"]) assert.ok(!from.startsWith(cam), `${rel} nhập ${from} ở phía trình duyệt — tệp chỉ-máy-chủ`);
    }
  }
  const wiring = doc("tests/action-wiring.test.ts");
  assert.ok(!wiring.includes("lib/actions/creative-copy.ts::"), "hai action mới đã có nút — không được khai nợ trong action-wiring");
  console.log("✓ Vòng mẫu · soạn câu chữ (thuần): một cặp trần 40/500 · chặn khi lô đã duyệt/quá hạn/mẫu bị gạt · giá sai bị bỏ · hai action có nút · client không nhập tệp chỉ-máy-chủ");
}

// ───────────────────────────── 1. captionFromImage ─────────────────────────────

async function testCaption(db: Db, startedAt: Date) {
  const img = fakeJpeg(77);
  const input: CaptionInput = {
    image: { bytes: img, contentType: "image/jpeg" },
    product: { name: "Đầm cc", code: "CC001", priceVnd: 299_000 },
    genes: { scene: "CAFE", palette: "WARM" },
    draft: { headline: "Nháp", primaryText: "Câu nháp viết trước khi có ảnh" },
    winningExamples: [{ headline: "Thắng", primaryText: "Câu chữ thắng" }],
    options: 3,
  };
  const opt = (headline: string, primaryText: string) => ({ headline, primaryText });

  // Sai giá ⇒ viết lại MỘT lần ⇒ đúng thì giữ.
  const bodies: string[] = [];
  const answers = [
    { seen: "Đầm xanh trong quán cà phê", options: [opt("Đầm xanh dạo phố", "Chỉ 199k hôm nay"), opt("Xanh mát", "Mặc đi cà phê")] },
    { seen: "Đầm xanh trong quán cà phê", options: [opt("Đầm xanh dạo phố", "Chỉ 299.000đ, nhắn shop để tư vấn size"), opt("Xanh mát", "Mặc đi cà phê")] },
  ];
  const f1 = (async (_u: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return responses(200, answers[bodies.length - 1]);
  }) as typeof fetch;
  const r1 = await captionFromImage(db, input, { apiKey: "sk-test-FAKE", fetchImpl: f1, entityId: `${P}cap1` });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(bodies.length, 2, "giá sai ⇒ đúng MỘT lượt viết lại");
  assert.match(bodies[1], /199k/, "lượt viết lại phải nói rõ con số sai");
  const b64 = Buffer.from(img).toString("base64");
  assert.ok(bodies.every((b) => b.includes(b64) && b.includes("input_image")), "mô hình NHÌN ảnh ở mọi lượt");
  assert.ok(bodies.every((b) => !b.includes("sk-test")), "khoá không nằm trong thân yêu cầu");
  assert.match(bodies[0], /Viết 3 phương án/);
  assert.match(bodies[0], /299\.000đ/, "giá ERP tới mô hình");
  assert.match(bodies[0], /Câu nháp viết trước khi có ảnh/, "câu nháp tới mô hình để sửa theo ảnh");
  if (r1.ok) {
    assert.equal(r1.options.length, 2);
    assert.equal(r1.primaryText, "Chỉ 299.000đ, nhắn shop để tư vấn size");
    assert.equal(r1.priceStripped, false);
    assert.equal(r1.attempts, 2);
    assert.equal(r1.seen, "Đầm xanh trong quán cà phê");
    assert.equal(r1.costUsd, null, "model chưa có trong bảng giá ⇒ CHƯA BIẾT, không phải 0");
  }

  // Sai cả hai lần ⇒ bỏ con số giá; quá dài ⇒ cắt.
  const wrong = { seen: "", options: [opt("Sale sốc chỉ còn 150k hôm nay thôi nha cả nhà ơi", "Giá chỉ 199k. " + "Đẹp ".repeat(300))] };
  const f2 = (async () => responses(200, wrong)) as typeof fetch;
  const r2 = await captionFromImage(db, { ...input, options: 1 }, { apiKey: "sk-test-FAKE", fetchImpl: f2 });
  assert.ok(r2.ok);
  if (r2.ok) {
    assert.ok(r2.priceStripped);
    assert.deepEqual(findPriceMentions(`${r2.headline}\n${r2.primaryText}`), [], `vẫn sai sau khi viết lại ⇒ không còn con số giá nào: "${r2.headline}"`);
    assert.ok(r2.headline.length <= 40 && r2.primaryText.length <= 500, "độ dài cắt đúng trần");
    assert.equal(r2.options.length, 1);
  }

  // Không biết giá ⇒ MỌI con số giá đều sai.
  const f3 = (async () => responses(200, { seen: "", options: [opt("Đồng giá 499K", "Đồng giá 499K cả nhà ơi")] })) as typeof fetch;
  const r3 = await captionFromImage(db, { ...input, product: { ...input.product, priceVnd: null } }, { apiKey: "sk-test-FAKE", fetchImpl: f3 });
  assert.ok(r3.ok && findPriceMentions(`${r3.headline} ${r3.primaryText}`).length === 0);

  // Lỗi ⇒ { ok:false }, không ném.
  const throwing = (async () => {
    throw new Error("mạng đứt");
  }) as typeof fetch;
  const e1 = await captionFromImage(db, input, { apiKey: "sk-test-FAKE", fetchImpl: throwing });
  assert.ok(!e1.ok && /mạng đứt/.test(e1.error));
  const e2 = await captionFromImage(db, input, { apiKey: "sk-test-FAKE", fetchImpl: (async () => responses(500, "down")) as typeof fetch });
  assert.ok(!e2.ok && /HTTP 500/.test(e2.error));
  const e3 = await captionFromImage(db, input, { apiKey: "sk-test-FAKE", fetchImpl: (async () => responses(200, "không phải json")) as typeof fetch });
  assert.ok(!e3.ok, "hai lượt không ra JSON ⇒ lỗi, không ném");
  let goi = 0;
  const e4 = await captionFromImage(db, input, {
    apiKey: "",
    fetchImpl: (async () => {
      goi += 1;
      return responses(200, {});
    }) as typeof fetch,
  });
  assert.ok(!e4.ok && /OPENAI_API_KEY/.test(e4.error) && goi === 0, "thiếu khoá ⇒ không gọi mạng");
  const e5 = await captionFromImage(db, { ...input, image: { bytes: new Uint8Array(), contentType: "image/jpeg" } }, { apiKey: "sk-test-FAKE", fetchImpl: throwing });
  assert.ok(!e5.ok, "không có điểm ảnh ⇒ lỗi");

  const logged = await db
    .select({ status: schema.aiInteractions.status, prompt: schema.aiInteractions.prompt, rounds: schema.aiInteractions.rounds })
    .from(schema.aiInteractions)
    .where(and(eq(schema.aiInteractions.route, CAPTION_ROUTE), eq(schema.aiInteractions.entityId, `${P}cap1`), gte(schema.aiInteractions.createdAt, startedAt)));
  assert.equal(logged.length, 1, "mỗi lượt viết ghi đúng một dòng ai_interactions");
  assert.equal(logged[0].status, "OK");
  assert.equal(logged[0].rounds, 2);
  assert.ok(!logged[0].prompt.includes(b64), "sổ AI không chứa điểm ảnh");
  console.log("✓ Vòng mẫu · câu chữ theo ảnh: mô hình nhìn ảnh · giá sai ⇒ viết lại một lần ⇒ vẫn sai thì bỏ · cắt đúng 40/500 · lỗi không ném · có sổ AI");
}

// ───────────────────────────── 2 + 3. ĐƯỜNG SINH + SỬA ─────────────────────────────

async function cleanup(db: Db, day: string) {
  const batches = await db.select({ id: schema.creativeBatches.id }).from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, day));
  const ids = batches.map((b) => b.id);
  if (ids.length) {
    const vs = await db.select({ imageId: schema.creativeVariants.imageId }).from(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids));
    await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.batchId, ids));
    const imgs = vs.map((v) => v.imageId).filter((x): x is string => Boolean(x));
    if (imgs.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imgs));
    await db.delete(schema.creativeBatches).where(inArray(schema.creativeBatches.id, ids));
  }
}

export async function testCreativeCopyDb(db: Db) {
  const startedAt = new Date();
  const day = shiftDay(vnDay(startedAt), 75);
  const w = batchWindow(day, DEFAULT_CREATIVE_CONFIG);
  const at = new Date(w.buildFrom.getTime() + 3_600_000);
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const cfg = normalizeCreativeConfig({ enabled: true, batchSize: 2, extraCandidates: 0, focusProductIds: [`${P}prod`] }).config;
  let photoImageId: string | null = null;

  await cleanup(db, day);
  try {
    await testCaption(db, startedAt);

    const text = JSON.stringify(cfg);
    await db.insert(schema.settings).values({ key: CREATIVE_CONFIG_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text } });
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm cc", customId: "CC001" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, retailPrice: 350_000, retailPriceAfterDiscount: 299_000 });
    const photo = await storeCreativeImage(db, fakeJpeg(1));
    photoImageId = photo.id;
    await db.insert(schema.creativeSources).values({ id: `${P}photo`, kind: "PRODUCT_PHOTO", productId: `${P}prod`, imageId: photo.id, title: "ảnh thật cc" });

    // ── 2. Đường sinh: câu chữ theo ảnh hỏng (trả lỗi, rồi NÉM) ⇒ giữ nháp, mẫu vẫn GENERATED ──
    let tag = 500;
    const events: string[] = [];
    const writer: CopyWriter = async () => ({ imagePrompt: "p", primaryText: "Câu nháp cc", headline: "Nháp cc", model: "fake-writer", costUsd: 0.002, attempts: 1, priceStripped: false });
    const imageClient: ImageEditClient = async () => {
      tag += 1;
      events.push("image");
      return { bytes: fakeJpeg(tag), contentType: "image/jpeg", usage: null, costUsd: 0.04 };
    };
    let lan = 0;
    const brokenCaption: VariantCaptioner = async () => {
      lan += 1;
      events.push("caption");
      if (lan === 1) return { ok: false, error: "mô hình đọc ảnh bận" };
      throw new Error("lỗi ngoài dự kiến");
    };
    const summary = await buildBatch(db, at, { writer, imageClient, caption: brokenCaption, describe: async () => ({ ok: false as const, error: "bỏ qua" }), perTick: 5 });
    assert.ok(summary.generated >= 1, `phải sinh được ít nhất một mẫu: ${JSON.stringify(summary)}`);
    assert.equal(summary.failed, 0, "câu chữ theo ảnh hỏng KHÔNG làm mẫu thành GEN_FAILED");
    assert.deepEqual(events.slice(0, 2), ["image", "caption"], "câu chữ theo ảnh gọi SAU khi ảnh đã sinh");
    const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, day));
    assert.equal(batch.status, "PENDING_APPROVAL");
    const vs = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batch.id)).orderBy(asc(schema.creativeVariants.slot));
    assert.ok(vs.length >= 1 && vs.every((v) => v.status === "GENERATED" && v.imageId), "mẫu có ảnh vẫn GENERATED");
    assert.ok(vs.every((v) => v.primaryText === "Câu nháp cc" && v.headline === "Nháp cc" && v.writerModel === "fake-writer" && v.writerCostUsd === "0.002000"), "hỏng ⇒ GIỮ câu nháp và chi phí của người viết");
    assert.ok(vs.every((v) => v.genError.startsWith(CAPTION_FALLBACK_PREFIX)), "lý do nằm ở gen_error với tiền tố riêng");
    assert.match(vs[0].genError, /mô hình đọc ảnh bận/);
    if (vs.length > 1) assert.match(vs[1].genError, /lỗi ngoài dự kiến/, "caption NÉM cũng không làm hỏng mẫu");

    // ── 3a. Gợi ý: nhận đúng ảnh của mẫu, xin 3 phương án, KHÔNG ghi gì ──
    const target = vs[0];
    const stored = await readCreativeImage(db, target.imageId as string);
    let seenInput: CaptionInput | null = null;
    const fakeSuggest: VariantCaptioner = async (_d, input) => {
      seenInput = input;
      return { ok: true, headline: "A", primaryText: "Phương án A", options: [{ headline: "A", primaryText: "Phương án A" }, { headline: "B", primaryText: "Phương án B" }], seen: "đầm", model: "fake", costUsd: null, attempts: 1, priceStripped: false };
    };
    const sg = await suggestVariantCopyCore(db, target.id, at, { caption: fakeSuggest });
    assert.ok(sg.ok && sg.options.length === 2);
    const si = seenInput as CaptionInput | null;
    assert.ok(si && stored && Buffer.from(si.image.bytes).equals(stored.bytes), "gợi ý đọc đúng ảnh của mẫu");
    assert.equal(si?.options, 3);
    assert.equal(si?.product.priceVnd, 299_000, "giá ERP tới mô hình");
    assert.equal(si?.draft?.primaryText, "Câu nháp cc");
    const [still] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, target.id));
    assert.equal(still.primaryText, "Câu nháp cc", "gợi ý KHÔNG tự lưu");
    const sgErr = await suggestVariantCopyCore(db, target.id, at, { caption: async () => ({ ok: false, error: "bận" }) });
    assert.ok(!sgErr.ok && sgErr.error === "bận", "lỗi mô hình trả về, không ném");

    // ── 3b. Lưu: digest đổi ⇒ phiếu cũ vô hiệu; cảnh báo giá không chặn ──
    const digestBefore = approvalDigest(await batchApprovalContent(db, batch));
    const ticket = batchTicket(`${P}u`, batch.id, digestBefore);
    const saved = await saveVariantCopyCore(db, { variantId: target.id, headline: "Đầm xanh đi cà phê", primaryText: "Đầm xanh mặc đi cà phê, giá 199k" }, at);
    assert.ok(saved.ok && saved.changed, JSON.stringify(saved));
    if (saved.ok) {
      assert.deepEqual(saved.before, { headline: "Nháp cc", primaryText: "Câu nháp cc" });
      assert.equal(saved.warnings.length, 1, "giá khác ERP ⇒ CẢNH BÁO");
    }
    const [after] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, target.id));
    assert.equal(after.primaryText, "Đầm xanh mặc đi cà phê, giá 199k", "cảnh báo giá không chặn lưu");
    assert.equal(after.genError, "", "người đã soạn lại ⇒ bỏ ghi chú 'đang dùng câu nháp'");
    const digestAfter = approvalDigest(await batchApprovalContent(db, batch));
    assert.notEqual(digestAfter, digestBefore, "sửa câu chữ ⇒ digest đổi");
    assert.equal(verifyBatchTicket(ticket, `${P}u`, batch.id, digestAfter), false, "phiếu phát trước khi sửa KHÔNG dùng được nữa");
    const same = await saveVariantCopyCore(db, { variantId: target.id, headline: "Đầm xanh đi cà phê", primaryText: "Đầm xanh mặc đi cà phê, giá 199k" }, at);
    assert.ok(same.ok && !same.changed, "lưu y nguyên ⇒ không ghi");

    // ── 3c. Chặn: quá hạn · mẫu bị gạt · lô đã duyệt ──
    const late = await saveVariantCopyCore(db, { variantId: target.id, headline: "x", primaryText: "y" }, batch.approvalDeadline);
    assert.ok(!late.ok && /quá hạn/.test(late.error), "quá hạn ⇒ chặn");
    if (vs.length > 1) {
      await db.update(schema.creativeVariants).set({ status: "REJECTED" }).where(eq(schema.creativeVariants.id, vs[1].id));
      const rej = await saveVariantCopyCore(db, { variantId: vs[1].id, headline: "x", primaryText: "y" }, at);
      assert.ok(!rej.ok && /REJECTED/.test(rej.error), "mẫu đã gạt ⇒ chặn");
    }
    await db.update(schema.creativeBatches).set({ status: "APPROVED", approvedAt: at, approvalDigest: digestAfter }).where(eq(schema.creativeBatches.id, batch.id));
    const approved = await saveVariantCopyCore(db, { variantId: target.id, headline: "x", primaryText: "y" }, at);
    assert.ok(!approved.ok && /APPROVED/.test(approved.error), "lô đã duyệt ⇒ chặn");
    let goi = 0;
    const blockedSuggest = await suggestVariantCopyCore(db, target.id, at, {
      caption: async () => {
        goi += 1;
        return { ok: false, error: "không được gọi" };
      },
    });
    assert.ok(!blockedSuggest.ok && goi === 0, "lô đã duyệt ⇒ không tốn một lượt gọi mô hình nào");
    const [unchanged] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, target.id));
    assert.equal(unchanged.primaryText, "Đầm xanh mặc đi cà phê, giá 199k", "lượt bị chặn không ghi gì");
    console.log("✓ Vòng mẫu · soạn câu chữ (CSDL): đường sinh gọi câu chữ theo ảnh SAU ảnh, hỏng thì giữ nháp · gợi ý không tự lưu · lưu đổi digest ⇒ phiếu cũ vô hiệu · chặn khi quá hạn / đã gạt / đã duyệt");
  } finally {
    await cleanup(db, day);
    await db.delete(schema.creativeSources).where(like(schema.creativeSources.id, `${P}%`));
    if (photoImageId) await db.delete(schema.creativeImages).where(eq(schema.creativeImages.id, photoImageId));
    await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
    await db.delete(schema.aiInteractions).where(and(eq(schema.aiInteractions.route, CAPTION_ROUTE), gte(schema.aiInteractions.createdAt, startedAt)));
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}

if (process.argv[1] && /creative-copy\.test\.ts$/.test(process.argv[1])) {
  testCreativeCopyPure();
}
