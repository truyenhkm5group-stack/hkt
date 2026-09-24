import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_HARD_LIMITS,
  DEFAULT_CREATIVE_CONFIG,
  IMAGE_BATCH_PRICE_FACTOR,
  IMAGE_MODEL_TOKEN_PRICE_PER_MTOK,
  estimateImageUsd,
  imageModelBatchSupport,
  imagePriceKeyOf,
  normalizeCreativeConfig,
  type Genes,
} from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { VariantCaptioner } from "@/lib/creative/caption";
import { buildBatch, imageSpendToday, reservedImageSpend } from "@/lib/creative/generate";
import { parseImageBatchState } from "@/lib/creative/image-batch";
import { sha256Hex, storeCreativeImage } from "@/lib/creative/images";
import { batchWindow, imageBatchFallbackAt } from "@/lib/creative/schedule";
import type { CopyWriter } from "@/lib/creative/writer";
import { createBatch, imageEditBatchLine, openAiBatchClient, parseImageBatchResults, uploadEditReferences, uploadFile, type ImageEditBatchRef } from "@/lib/integrations/openai/batch";
import { imageEditCostUsd, parseImageUsage, type ImageEditClient, type ImageEditInputImage } from "@/lib/integrations/openai/images";

/**
 * ═══════════ VÒNG MẪU · ẢNH QUA BATCH API (chủ shop chốt 24/09/2026 "Cao + Batch, giữ 2 USD") ═══════════
 *
 * Khoá:
 *  (a) hợp đồng: mặc định gpt-image-2.5-sunburst · cao · 4:5 · BATCH · vẽ nốt 2:00 ở mức vừa; trần 2 USD
 *      KHÔNG đổi; giá ước tính theo token × bảng giá MỘT chỗ, × 0,5 khi đi Batch; mô hình lạ ⇒ mô hình đắt nhất;
 *  (b) client Files + Batch: đúng trường, đúng `purpose`, khoá chỉ ở tiêu đề; hàng rào điểm ảnh chặn TRƯỚC
 *      byte đầu tiên, ở cả lượt tải ảnh lẫn lượt dựng dòng JSONL;
 *  (c) đường sinh: MỘT lô Batch cho N ô (JSONL đúng model / quality / size / custom_id, ảnh tham chiếu chỉ là
 *      ảnh của shop); chạy lại không gửi lô thứ hai; `completed` ⇒ ảnh lưu, câu chữ theo ảnh, GENERATED,
 *      lô Chờ duyệt; dòng lỗi ⇒ GEN_FAILED có lý do;
 *  (d) tới 2:00 còn ô thiếu ⇒ huỷ lô Batch, dòng đã xong vẫn được nhận, phần còn lại vẽ nốt ở `medium`;
 *  (e) OpenAI từ chối lô (vd mô hình không nhận Batch) ⇒ vẽ nốt NGAY ở `medium`;
 *  (f) trần ngày tính theo giá Batch và không vượt 2 USD;
 *  (g) `SYNC` không đụng tới Files / Batch.
 *
 * Không gọi mạng thật: "OpenAI" là một `fetch` giả trong bộ nhớ, đi qua CHÍNH client thật. Mốc thời gian dựng
 * từ `batchWindow()` / `imageBatchFallbackAt()` của NGÀY MAI theo đồng hồ thật (AGENTS.md mục 50).
 */

const P = "cib-";
const KEY = "sk-test-FAKE-cib";
const G1: Genes = { angle: "LIFESTYLE", scene: "CAFE", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "NONE", palette: "WARM" };

function fakeJpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tag & 0xff, (tag >> 8) & 0xff, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ───────────────────────────── OpenAI giả ─────────────────────────────

type FakeFile = { id: string; purpose: string; filename: string; bytes: Uint8Array };
type FakeBatch = { id: string; status: string; input_file_id: string; endpoint: string; completion_window: string; metadata: Record<string, string>; output_file_id: string | null; error_file_id: string | null };

const USAGE = { input_tokens: 3000, output_tokens: 5870, input_tokens_details: { text_tokens: 1000, image_tokens: 2000 } };

class FakeOpenAi {
  files = new Map<string, FakeFile>();
  uploaded: FakeFile[] = [];
  deleted: string[] = [];
  batches = new Map<string, FakeBatch>();
  calls: string[] = [];
  createError: { status: number; message: string } | null = null;
  authOk = true;
  private seq = 0;
  private tag = 5000;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${KEY}`) this.authOk = false;
    const p = url.pathname;
    if (method === "POST" && p === "/v1/files") {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const f: FakeFile = { id: `file-${++this.seq}`, purpose: String(form.get("purpose")), filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      this.files.set(f.id, f);
      this.uploaded.push(f);
      return json(200, { id: f.id, object: "file", bytes: f.bytes.length, purpose: f.purpose, filename: f.filename, status: "uploaded" });
    }
    if (method === "POST" && p === "/v1/batches") {
      if (this.createError) return json(this.createError.status, { error: { message: this.createError.message } });
      const b = JSON.parse(String(init?.body)) as { input_file_id: string; endpoint: string; completion_window: string; metadata: Record<string, string> };
      const batch: FakeBatch = { id: `batch_${++this.seq}`, status: "validating", ...b, output_file_id: null, error_file_id: null };
      this.batches.set(batch.id, batch);
      return json(200, { object: "batch", ...batch });
    }
    const mCancel = /^\/v1\/batches\/([^/]+)\/cancel$/.exec(p);
    if (method === "POST" && mCancel) {
      const b = this.batches.get(mCancel[1]);
      if (!b) return json(404, { error: { message: "no batch" } });
      b.status = "cancelling";
      return json(200, { object: "batch", ...b });
    }
    const mGet = /^\/v1\/batches\/([^/]+)$/.exec(p);
    if (method === "GET" && mGet) {
      const b = this.batches.get(mGet[1]);
      return b ? json(200, { object: "batch", ...b }) : json(404, { error: { message: "no batch" } });
    }
    const mContent = /^\/v1\/files\/([^/]+)\/content$/.exec(p);
    if (method === "GET" && mContent) {
      const f = this.files.get(mContent[1]);
      return f ? new Response(Buffer.from(f.bytes).toString("utf8"), { status: 200 }) : json(404, { error: { message: "no file" } });
    }
    const mDel = /^\/v1\/files\/([^/]+)$/.exec(p);
    if (method === "DELETE" && mDel) {
      this.deleted.push(mDel[1]);
      this.files.delete(mDel[1]);
      return json(200, { id: mDel[1], deleted: true });
    }
    return json(404, { error: { message: `không có đường ${method} ${p}` } });
  }) as typeof fetch;

  /** Dòng JSONL của tệp đầu vào của một lô. */
  inputLines(batchId: string): { custom_id: string; method: string; url: string; body: { model: string; prompt: string; images: { file_id: string }[]; size: string; quality: string; output_format: string; n: number } }[] {
    const b = this.batches.get(batchId);
    const f = b ? this.uploaded.find((x) => x.id === b.input_file_id) : undefined;
    assert.ok(f, "tệp đầu vào của lô phải đã được tải lên");
    return Buffer.from(f.bytes)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  private putFile(purpose: string, text: string): string {
    const f: FakeFile = { id: `file-${++this.seq}`, purpose, filename: `${purpose}.jsonl`, bytes: new TextEncoder().encode(text) };
    this.files.set(f.id, f);
    return f.id;
  }

  setStatus(batchId: string, status: string) {
    const b = this.batches.get(batchId);
    assert.ok(b);
    b.status = status;
  }

  /** Kết thúc lô: `ok` ⇒ dòng ra ảnh, `fail` ⇒ dòng lỗi vào tệp lỗi. */
  finish(batchId: string, status: "completed" | "cancelled", ok: string[], fail: string[]) {
    const b = this.batches.get(batchId);
    assert.ok(b);
    const out = ok.map((id) => {
      this.tag += 1;
      return JSON.stringify({ id: `batch_req_${id}`, custom_id: id, response: { status_code: 200, request_id: "r", body: { created: 1, data: [{ b64_json: Buffer.from(fakeJpeg(this.tag)).toString("base64") }], usage: USAGE } }, error: null });
    });
    const err = fail.map((id) => JSON.stringify({ id: `batch_req_${id}`, custom_id: id, response: { status_code: 400, request_id: "r", body: { error: { message: "Your request was rejected by the safety system." } } }, error: null }));
    b.status = status;
    b.output_file_id = out.length ? this.putFile("batch_output", `${out.join("\n")}\n`) : null;
    b.error_file_id = err.length ? this.putFile("batch_output", `${err.join("\n")}\n`) : null;
  }
}

// ───────────────────────────── (a) hợp đồng ─────────────────────────────

function testContract() {
  const d = DEFAULT_CREATIVE_CONFIG;
  assert.equal(d.imageModel, "gpt-image-2.5-sunburst", "chủ shop chốt 24/09/2026: mô hình mạnh nhất cho sửa ảnh");
  assert.equal(d.imageQuality, "medium", "chủ shop chốt lần hai 24/09/2026: sunburst mức vừa, gọi ngay");
  assert.equal(d.imageSize, "1088x1360", "khổ dọc 4:5 cho bảng tin Facebook");
  assert.equal(d.imageMode, "SYNC", "sunburst không nhận Batch ⇒ mặc định gọi ngay");
  assert.equal(d.batchFallbackHourVn, 2);
  assert.equal(d.fallbackImageQuality, "medium");
  assert.equal(CREATIVE_HARD_LIMITS.maxImageUsdPerDay, 2, "trần 2 USD / ngày giữ nguyên");
  const [w, h] = d.imageSize.split("x").map(Number);
  assert.ok(w % 16 === 0 && h % 16 === 0 && w / h === 0.8, "4:5, hai cạnh bội số 16");

  // Bộ đọc cấu hình: giữ hai khổ cũ, nhận khổ mới, giá trị lạ về mặc định (không đoán).
  for (const s of ["1024x1024", "1024x1536", "1088x1360"] as const) assert.equal(normalizeCreativeConfig({ imageSize: s }).config.imageSize, s);
  assert.equal(normalizeCreativeConfig({ imageSize: "4096x4096" }).config.imageSize, d.imageSize);
  assert.equal(normalizeCreativeConfig({ imageMode: "SYNC" }).config.imageMode, "SYNC");
  assert.equal(normalizeCreativeConfig({ imageMode: "BATCH" }).config.imageMode, "BATCH");
  assert.equal(normalizeCreativeConfig({ imageMode: "nhanh" }).config.imageMode, d.imageMode, "giá trị lạ về mặc định");
  assert.equal(normalizeCreativeConfig({ batchFallbackHourVn: 99 }).config.batchFallbackHourVn, 23);
  assert.equal(normalizeCreativeConfig({ fallbackImageQuality: "low" }).config.fallbackImageQuality, "low");

  // Giá: một bảng, Batch = 50%, mô hình lạ ⇒ mô hình đắt nhất.
  const m = d.imageModel;
  const batchHigh = estimateImageUsd(m, "high", "1088x1360", "BATCH");
  const syncHigh = estimateImageUsd(m, "high", "1088x1360", "SYNC");
  assert.ok(Math.abs(batchHigh - syncHigh * IMAGE_BATCH_PRICE_FACTOR) < 1e-6, "Batch = 50% giá gọi ngay");
  assert.equal(estimateImageUsd(`${m}-2026-09-08`, "high", "1088x1360", "BATCH"), batchHigh, "bản chụp có hậu tố ngày cùng giá");
  // Lô MẶC ĐỊNH (chủ shop 24/09, lần hai) = các ô thiết kế + sinh dư; mockup cộng thêm tuỳ số mẫu được chọn.
  const lo = d.designSlots + d.extraCandidates;
  assert.ok(batchHigh * lo <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, `một lô ${lo} ảnh cao qua Batch (${batchHigh * lo}) phải vừa trần 2 USD`);
  assert.ok(syncHigh * lo > CREATIVE_HARD_LIMITS.maxImageUsdPerDay, "gọi ngay chất lượng cao cả lô thì vượt trần — lý do vẽ nốt phải hạ chất lượng");
  assert.ok(estimateImageUsd(m, d.fallbackImageQuality, d.imageSize) * lo <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, "vẽ nốt cả lô ở mức vừa vẫn trong trần");
  // Lô ĐẦY TRẦN (20 mẫu) ở cấu hình ĐANG CHẠY (gọi ngay · vừa · 4:5) vẫn vừa trần 2 USD. "Cao + Batch" với 20 ảnh thì
  // KHÔNG vừa — máy chặn ô vượt bằng GEN_FAILED có lý do (không tiêu quá), và tab Cấu hình in cảnh báo.
  const full = d.batchSize + d.extraCandidates;
  assert.ok(estimateImageUsd(m, d.imageQuality, d.imageSize, d.imageMode) * full <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, `lô đầy ${full} ảnh ở cấu hình đang chạy phải vừa trần ngày`);
  const unknown = estimateImageUsd("mo-hinh-la", "high", "1088x1360");
  for (const k of Object.keys(IMAGE_MODEL_TOKEN_PRICE_PER_MTOK)) assert.ok(unknown >= estimateImageUsd(k, "high", "1088x1360"), `mô hình lạ phải ước tính ≥ ${k}`);
  assert.ok(estimateImageUsd(m, "high", "1024x1536") > estimateImageUsd(m, "high", "1024x1024"), "khổ lớn hơn đắt hơn");
  assert.equal(imagePriceKeyOf("gpt-image-1-mini"), null, "không khớp theo tiền tố trần");
  assert.equal(imagePriceKeyOf("gpt-image-2.5-sunburst"), "gpt-image-2.5-sunburst", "gpt-image-2 không nuốt gpt-image-2.5-*");

  // Ghi chi phí sau khi gọi: CÙNG bảng giá, Batch = nửa giá.
  const u = parseImageUsage(USAGE);
  const sync = imageEditCostUsd(m, u, "SYNC");
  assert.equal(sync, (1000 * 5 + 2000 * 8 + 5870 * 30) / 1_000_000);
  assert.equal(imageEditCostUsd(m, u, "BATCH"), Math.round((sync ?? 0) * 0.5 * 1e6) / 1e6);
  assert.equal(imageEditCostUsd("mo-hinh-la", u), null, "mô hình không có giá ⇒ CHƯA BIẾT khi GHI (ước tính chặn thì lấy mô hình đắt nhất)");

  assert.equal(imageModelBatchSupport(m), false, "tài liệu 24/09/2026: sunburst không nhận Batch — màn hình phải cảnh báo");
  assert.equal(imageModelBatchSupport("gpt-image-1"), true);
  assert.equal(imageModelBatchSupport("mo-hinh-la"), null, "chưa đọc ≠ không hỗ trợ");

  // Mốc vẽ nốt: 2:00 ngày chạy với lịch mặc định; giờ ghi sau hạn duyệt ⇒ tối hôm trước.
  const day = "2030-01-10";
  assert.equal(imageBatchFallbackAt(day, d).toISOString(), new Date("2030-01-10T02:00:00+07:00").toISOString());
  assert.equal(imageBatchFallbackAt(day, { ...d, batchFallbackHourVn: 22 }).toISOString(), new Date("2030-01-09T22:00:00+07:00").toISOString());
  assert.ok(imageBatchFallbackAt(day, { ...d, batchFallbackHourVn: 6 }) < batchWindow(day, d).approvalDeadline, "không bao giờ là mốc sau hạn duyệt");
  console.log("✓ Vòng mẫu · Batch ảnh — hợp đồng: sunburst · vừa · 4:5 · gọi ngay (Batch bật được cho mô hình nhận nó, vẽ nốt 2:00 ở mức vừa) · trần 2 USD giữ nguyên · giá một bảng, Batch 50%, mô hình lạ tính giá đắt nhất");
}

// ───────────────────────────── (b) client ─────────────────────────────

async function testClient() {
  const fake = new FakeOpenAi();
  const deps = { apiKey: KEY, fetchImpl: fake.fetch };
  const up = await uploadFile({ purpose: "vision", filename: "a.jpg", bytes: fakeJpeg(1), contentType: "image/jpeg" }, deps);
  assert.equal(fake.uploaded[0].purpose, "vision");
  assert.equal(up.id, fake.uploaded[0].id);
  const b = await createBatch({ inputFileId: up.id, endpoint: "/v1/images/edits", metadata: { x: "1" } }, deps);
  const stored = fake.batches.get(b.id);
  assert.equal(stored?.endpoint, "/v1/images/edits");
  assert.equal(stored?.completion_window, "24h");
  assert.equal(stored?.input_file_id, up.id);
  assert.ok(fake.authOk, "khoá đi đúng tiêu đề Authorization");

  fake.createError = { status: 400, message: "model not supported" };
  await assert.rejects(() => createBatch({ inputFileId: up.id, endpoint: "/v1/images/edits" }, deps), (e: Error) => /HTTP 400/.test(e.message) && /model not supported/.test(e.message) && !e.message.includes(KEY));
  fake.createError = null;
  await assert.rejects(() => uploadFile({ purpose: "batch", filename: "x", bytes: new Uint8Array([1]), contentType: "text/plain" }, { apiKey: "", fetchImpl: fake.fetch }), /OPENAI_API_KEY/);

  // Hàng rào điểm ảnh: chặn TRƯỚC khi tải một byte nào.
  const product: ImageEditInputImage = { kind: "PRODUCT_PHOTO", bytes: fakeJpeg(2), contentType: "image/jpeg" };
  const before = fake.calls.length;
  const client = openAiBatchClient(deps);
  for (const kind of ["SPY", "MANUAL", "RND", "OWN_AD", ""]) {
    const smuggled = { kind, bytes: fakeJpeg(3), contentType: "image/jpeg" } as unknown as ImageEditInputImage;
    await assert.rejects(() => uploadEditReferences(client, [product, smuggled]), /ranh giới 2/, `(b) tải lên: loại "${kind}" phải bị chặn`);
    assert.throws(
      () => imageEditBatchLine({ customId: "v", model: "m", prompt: "p", size: "1088x1360", quality: "high", images: [{ kind: "PRODUCT_PHOTO", fileId: "f1" }, { kind, fileId: "f2" } as unknown as ImageEditBatchRef] }),
      /ranh giới 2/,
      `(b) dòng JSONL: loại "${kind}" phải bị chặn`,
    );
  }
  await assert.rejects(() => uploadEditReferences(client, [{ kind: "OWN_VARIANT", bytes: fakeJpeg(4), contentType: "image/jpeg" }]), /ranh giới 3/, "(b) thiếu ảnh sản phẩm thật ⇒ chặn");
  assert.throws(() => imageEditBatchLine({ customId: "v", model: "m", prompt: "p", size: "1088x1360", quality: "high", images: [{ kind: "OWN_VARIANT", fileId: "f" }] }), /ranh giới 3/);
  assert.equal(fake.calls.length, before, "(b) mọi lượt bị chặn đều chặn TRƯỚC khi gọi mạng");

  // Một ảnh dùng cho hai ô chỉ tải một lần.
  const cache = new Map<string, string>();
  const r1 = await uploadEditReferences(client, [product], cache);
  const r2 = await uploadEditReferences(client, [product], cache);
  assert.equal(r1[0].fileId, r2[0].fileId);

  const res = parseImageBatchResults(
    [
      JSON.stringify({ custom_id: "a", response: { status_code: 200, body: { data: [{ b64_json: Buffer.from(fakeJpeg(7)).toString("base64") }], usage: USAGE } }, error: null }),
      JSON.stringify({ custom_id: "b", response: { status_code: 400, body: { error: { message: "rejected" } } }, error: null }),
      JSON.stringify({ custom_id: "c", response: null, error: { code: "batch_expired", message: "hết hạn" } }),
      "không phải json",
      JSON.stringify({ response: { status_code: 200 } }),
    ].join("\n"),
    "gpt-image-2.5-sunburst",
  );
  assert.deepEqual(res.map((r) => [r.customId, r.ok]), [["a", true], ["b", false], ["c", false]], "dòng hỏng / thiếu custom_id bị bỏ, không đoán");
  const a = res[0];
  assert.ok(a.ok && a.image.costUsd === imageEditCostUsd("gpt-image-2.5-sunburst", parseImageUsage(USAGE), "BATCH"), "chi phí dòng Batch = usage × giá Batch");
  assert.ok(!res[1].ok && /HTTP 400/.test(res[1].error) && /rejected/.test(res[1].error));
  assert.ok(!res[2].ok && /batch_expired/.test(res[2].error));
  console.log("✓ Vòng mẫu · Batch ảnh — client: purpose vision/batch · endpoint /v1/images/edits · 24h · khoá chỉ ở tiêu đề · hàng rào điểm ảnh chặn trước byte đầu tiên ở cả tải ảnh lẫn dòng JSONL");
}

// ───────────────────────────── (g) mức mã nguồn ─────────────────────────────

function testSourceGuard() {
  const gen = readFileSync(path.join(process.cwd(), "lib/creative/generate.ts"), "utf8");
  assert.match(gen, /images = await gatherPixels\(db, \{ productPhotoSourceId: variant\.productPhotoSourceId, parentVariantId: variant\.parentVariantId, ownAdSourceId: variant\.inspirationSourceId \}\);\n[\s\S]{0,400}const refs = await uploadEditReferences\(client, images, cache\);/, "ảnh tải lên Batch chỉ đến từ gatherPixels");
  assert.equal([...gen.matchAll(/uploadEditReferences\(/g)].length, 1, "một chỗ tải ảnh tham chiếu");
  const batch = readFileSync(path.join(process.cwd(), "lib/integrations/openai/batch.ts"), "utf8");
  const upFn = batch.slice(batch.indexOf("export async function uploadEditReferences("), batch.indexOf("export function imageEditBatchLine("));
  assert.match(upFn.split("\n").slice(0, 3).join("\n"), /assertPixelSafe\(images\);/, "hàng rào là dòng đầu của hàm tải ảnh");
  const lineFn = batch.slice(batch.indexOf("export function imageEditBatchLine("), batch.indexOf("export type ImageBatchLineResult"));
  assert.match(lineFn.split("\n").slice(0, 3).join("\n"), /assertPixelSafe\(input\.images\);/, "hàng rào là dòng đầu của hàm dựng dòng JSONL");
  const code = batch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal([...code.matchAll(/purpose: "vision"/g)].length, 1, "chỉ một chỗ tải ảnh (purpose vision)");
}

// ───────────────────────────── (c)–(g) đường sinh ─────────────────────────────

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

async function lotOf(db: Db, batchDay: string) {
  const [batch] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.batchDay, batchDay));
  const variants = batch ? await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batch.id)) : [];
  return { batch, variants, state: batch ? parseImageBatchState(batch.plan) : null };
}

export async function testCreativeImageBatch(db: Db) {
  testContract();
  await testClient();
  testSourceGuard();

  const startedAt = new Date();
  const batchDay = shiftDay(vnDay(startedAt), 1);
  // Khối này kiểm ĐƯỜNG BATCH ⇒ khai tường minh, không dựa vào mặc định (mặc định là gọi ngay từ khi chủ shop chốt lại).
  // Không ô THIẾT KẾ ở đây: 1 mockup của mã (mẫu thắng của vòng) + 3 thăm dò = 4 ô, như lô cũ.
  const baseCfg = { ...DEFAULT_CREATIVE_CONFIG, enabled: true, batchSize: 3, extraCandidates: 1, designSlots: 0, exploreSlots: 3, mockupProductIds: [`${P}prod`], imageMode: "BATCH" as const, imageQuality: "high" as const };
  const w = batchWindow(batchDay, baseCfg);
  // 14:01 giờ VN của HÔM NAY — cùng ngày Việt Nam với `created_at` mà CSDL sắp ghi (trần ngày đếm trên nó).
  const now = new Date(w.buildFrom.getTime() + 60_000);
  const fallbackAt = imageBatchFallbackAt(batchDay, baseCfg);
  const parentDay = shiftDay(batchDay, -7);
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const imageIds: string[] = [];
  const sourceIds: string[] = [];

  try {
    // ─── Dữ liệu nền: một mã, ảnh sản phẩm thật, ảnh SPY (chỉ được đọc thành chữ), một mẫu THẮNG làm mẫu cha ───
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm cib", customId: "CIB01" });
    await db.insert(schema.productVariants).values({ id: `${P}var`, productId: `${P}prod`, retailPrice: 350_000, retailPriceAfterDiscount: 299_000 });
    const store = async (tag: number) => {
      const s = await storeCreativeImage(db, fakeJpeg(tag));
      imageIds.push(s.id);
      return s;
    };
    const photo = await store(21);
    const spy = await store(22);
    const win = await store(23);
    const src = async (v: typeof schema.creativeSources.$inferInsert) => {
      const [r] = await db.insert(schema.creativeSources).values(v).returning({ id: schema.creativeSources.id });
      sourceIds.push(r.id);
      return r.id;
    };
    const photoId = await src({ kind: "PRODUCT_PHOTO", productId: `${P}prod`, title: `${P}photo`, imageId: photo.id });
    await src({ kind: "SPY", title: `${P}spy`, imageId: spy.id, genes: { scene: "STREET" }, visionSummary: "Đường phố cib", visionAt: startedAt });
    const pw = batchWindow(parentDay, baseCfg);
    const [parentBatch] = await db
      .insert(schema.creativeBatches)
      .values({ batchDay: parentDay, status: "PUBLISHED", slotCount: 1, startAt: pw.startAt, endAt: pw.endAt, approvalDeadline: pw.approvalDeadline, ruleVersion: 1, approvedAt: startedAt, approvalDigest: `${P}digest` })
      .returning({ id: schema.creativeBatches.id });
    await db.insert(schema.creativeVariants).values({ batchId: parentBatch.id, slot: 1, mode: "EXPLORE", productId: `${P}prod`, productPhotoSourceId: photoId, genes: G1, genesVersion: 1, primaryText: "Thắng cib", headline: "Thắng", imageId: win.id, genModel: "gpt-image-1", genCostUsd: "0.040000", status: "ENDED", fbAdId: `${P}ad-1`, libraryAt: startedAt, libraryOrders: 150 });

    // ─── Bản giả ───
    const allowedShas = new Set([photo.sha256, win.sha256]);
    const syncCalls: { model: string; quality: string; size: string; kinds: string[] }[] = [];
    let tag = 7000;
    const syncClient: ImageEditClient = async (input) => {
      syncCalls.push({ model: input.model, quality: input.quality, size: input.size, kinds: input.images.map((i) => i.kind) });
      tag += 1;
      return { bytes: fakeJpeg(tag), contentType: "image/jpeg", usage: null, costUsd: estimateImageUsd(input.model, input.quality, input.size) };
    };
    let writes = 0;
    const writer: CopyWriter = async () => {
      writes += 1;
      return { imagePrompt: `prompt cib ${writes}`, primaryText: "Câu nháp cib", headline: "Nháp cib", model: "fake-writer", costUsd: 0.001, attempts: 1, priceStripped: false };
    };
    let captions = 0;
    const caption: VariantCaptioner = async () => {
      captions += 1;
      return { ok: true, headline: "Theo ảnh", primaryText: "Câu theo ảnh cib", options: [{ headline: "Theo ảnh", primaryText: "Câu theo ảnh cib" }], seen: "", model: "fake-caption", costUsd: 0.001, attempts: 1, priceStripped: false };
    };
    const describe = async () => ({ ok: false as const, error: "bỏ qua" });
    const depsFor = (fake: FakeOpenAi, perTick = 10) => ({ imageClient: syncClient, writer, caption, describe, perTick, batchClient: openAiBatchClient({ apiKey: KEY, fetchImpl: fake.fetch }) });
    const unitBatch = estimateImageUsd(baseCfg.imageModel, baseCfg.imageQuality, baseCfg.imageSize, "BATCH");

    // ═══ (c) Gửi MỘT lô Batch, chạy lại không gửi lô thứ hai, completed ⇒ GENERATED + Chờ duyệt ═══
    await setConfig(db, baseCfg);
    const f1 = new FakeOpenAi();
    const t1 = await buildBatch(db, now, depsFor(f1));
    assert.equal(t1.created, true);
    assert.equal(t1.status, "PLANNED", "đã gửi Batch, chưa có ảnh ⇒ lô còn Đang dựng");
    assert.equal(f1.batches.size, 1, "(c) đúng MỘT lô Batch");
    assert.equal(syncCalls.length, 0, "(c) chế độ Batch không gọi ngay");
    const l1 = await lotOf(db, batchDay);
    const n = l1.variants.length;
    assert.ok(n >= 2, `lô phải có ít nhất hai ô (có ${n})`);
    assert.equal(writes, n, "câu chữ viết cho mọi ô ngay lúc gửi");
    assert.ok(l1.variants.every((v) => v.status === "PLANNED" && v.imagePrompt.startsWith("prompt cib") && !v.imageId), "câu lệnh lưu ngay, ô vẫn chờ ảnh");
    assert.equal(l1.state?.phase, "SUBMITTED");
    assert.match(t1.imageBatch ?? "", /Batch ảnh batch_/, "tóm tắt nói lô Batch đang ở đâu (vào sync_runs.detail)");
    const [openaiBatchId] = [...f1.batches.keys()];
    assert.equal(l1.state?.openaiBatchId, openaiBatchId);
    const fb = f1.batches.get(openaiBatchId);
    assert.equal(fb?.endpoint, "/v1/images/edits");
    assert.equal(fb?.metadata.creative_batch_id, l1.batch.id);
    const lines = f1.inputLines(openaiBatchId);
    assert.deepEqual(new Set(lines.map((l) => l.custom_id)), new Set(l1.variants.map((v) => v.id)), "(c) custom_id = id mẫu, mỗi ô một dòng");
    const byFile = new Map(f1.uploaded.map((u) => [u.id, u]));
    for (const l of lines) {
      assert.equal(l.method, "POST");
      assert.equal(l.url, "/v1/images/edits");
      assert.equal(l.body.model, "gpt-image-2.5-sunburst");
      assert.equal(l.body.quality, "high");
      assert.equal(l.body.size, "1088x1360");
      assert.equal(l.body.output_format, "jpeg");
      assert.equal(l.body.n, 1);
      assert.ok(l.body.images.length >= 1);
      for (const ref of l.body.images) {
        const up = byFile.get(ref.file_id);
        assert.equal(up?.purpose, "vision", "ảnh tham chiếu tải lên với purpose vision");
        assert.ok(up && allowedShas.has(sha256Hex(up.bytes)), "(c) ảnh tham chiếu CHỈ là ảnh sản phẩm thật / mẫu thắng của shop");
      }
      assert.ok(l.body.images.some((r) => byFile.get(r.file_id) && sha256Hex(byFile.get(r.file_id)?.bytes ?? new Uint8Array()) === photo.sha256), "mỗi dòng có ảnh sản phẩm thật");
    }
    assert.ok(!f1.uploaded.some((u) => sha256Hex(u.bytes) === spy.sha256), "(c) điểm ảnh SPY không bao giờ tới OpenAI");
    assert.equal(f1.uploaded.filter((u) => u.purpose === "vision" && sha256Hex(u.bytes) === photo.sha256).length, 1, "ảnh sản phẩm dùng chung chỉ tải một lần");
    const res1 = await reservedImageSpend(db, now);
    assert.equal(res1.images, n);
    assert.ok(Math.abs(res1.usd - n * unitBatch) < 1e-6, "tiền giữ chỗ = số ô × giá ước tính Batch");

    // Chạy lại khi OpenAI còn đang làm: KHÔNG gửi lô thứ hai, không viết lại.
    f1.setStatus(openaiBatchId, "in_progress");
    const t2 = await buildBatch(db, new Date(now.getTime() + 10 * 60_000), depsFor(f1));
    assert.equal(t2.created, false);
    assert.equal(f1.batches.size, 1, "(c) chạy lại không gửi lô thứ hai");
    assert.equal(writes, n, "(c) chạy lại không viết lại câu chữ");
    assert.equal(t2.status, "PLANNED");
    assert.match(t2.imageBatch ?? "", /in_progress/);

    // OpenAI xong: mọi dòng ra ảnh trừ MỘT dòng lỗi.
    const ids = l1.variants.map((v) => v.id);
    const bad = ids[ids.length - 1];
    f1.finish(openaiBatchId, "completed", ids.slice(0, -1), [bad]);
    const t3 = await buildBatch(db, new Date(now.getTime() + 20 * 60_000), depsFor(f1));
    assert.equal(t3.generated, n - 1);
    assert.equal(t3.status, "PENDING_APPROVAL", "(c) không còn ô chờ ảnh ⇒ Chờ duyệt");
    assert.equal(captions, n - 1, "(c) câu chữ viết lại THEO ẢNH cho mỗi ảnh về");
    assert.equal(syncCalls.length, 0, "(c) lô completed có ảnh ⇒ không vẽ nốt");
    const l3 = await lotOf(db, batchDay);
    const costBatch = imageEditCostUsd("gpt-image-2.5-sunburst", parseImageUsage(USAGE), "BATCH");
    for (const v of l3.variants.filter((x) => x.id !== bad)) {
      assert.equal(v.status, "GENERATED");
      assert.ok(v.imageId, "ảnh đã lưu");
      assert.equal(v.primaryText, "Câu theo ảnh cib");
      assert.equal(v.genModel, "gpt-image-2.5-sunburst");
      assert.equal(v.genCostUsd, costBatch?.toFixed(6), "(c) chi phí ghi theo usage × giá Batch");
    }
    const badRow = l3.variants.find((x) => x.id === bad);
    assert.equal(badRow?.status, "GEN_FAILED", "(c) dòng lỗi ⇒ GEN_FAILED");
    assert.match(badRow?.genError ?? "", /OpenAI Batch báo lỗi.*safety system/);
    assert.equal(l3.state?.phase, "SETTLED");
    assert.equal((await reservedImageSpend(db, now)).usd, 0, "xong ⇒ trả chỗ trong trần");
    assert.ok(f1.uploaded.every((u) => f1.deleted.includes(u.id)), "tệp đã tải lên OpenAI được dọn");
    const t4 = await buildBatch(db, new Date(now.getTime() + 30 * 60_000), depsFor(f1));
    assert.equal(t4.generated, 0);
    assert.equal(f1.batches.size, 1);
    assert.match(t4.skippedReason ?? "", /PENDING_APPROVAL/);
    console.log(`✓ Vòng mẫu · Batch ảnh — một lô ${n} ô, JSONL đúng mô hình/chất lượng/khổ/custom_id, chỉ ảnh của shop · chạy lại không gửi lô thứ hai · completed ⇒ ảnh + câu chữ theo ảnh + Chờ duyệt · dòng lỗi ⇒ GEN_FAILED`);

    // ═══ (d) Tới 2:00 còn ô thiếu ⇒ huỷ, nhận dòng đã xong, vẽ nốt ở medium ═══
    await dropBatch(db, batchDay);
    captions = 0;
    const f2 = new FakeOpenAi();
    await buildBatch(db, now, depsFor(f2));
    const [id2] = [...f2.batches.keys()];
    f2.setStatus(id2, "in_progress");
    const before2 = await buildBatch(db, new Date(fallbackAt.getTime() - 60_000), depsFor(f2));
    assert.equal(before2.status, "PLANNED");
    assert.ok(!f2.calls.some((c) => c.endsWith("/cancel")), "(d) trước 2:00 không huỷ");
    const at2 = await buildBatch(db, fallbackAt, depsFor(f2));
    assert.ok(f2.calls.some((c) => c === `POST /v1/batches/${id2}/cancel`), "(d) tới 2:00 ⇒ huỷ lô Batch");
    assert.equal(syncCalls.length, 0, "(d) đang huỷ ⇒ chưa vẽ nốt (đợi biết dòng nào đã xong, không trả tiền hai lần)");
    assert.equal((await lotOf(db, batchDay)).state?.phase, "CANCELLING");
    assert.match(at2.imageBatch ?? "", /huỷ/);
    const l2 = await lotOf(db, batchDay);
    const doneEarly = l2.variants[0].id;
    f2.finish(id2, "cancelled", [doneEarly], []);
    const after2 = await buildBatch(db, new Date(fallbackAt.getTime() + 10 * 60_000), depsFor(f2));
    const l2b = await lotOf(db, batchDay);
    assert.equal(l2b.variants.find((v) => v.id === doneEarly)?.genCostUsd, costBatch?.toFixed(6), "(d) dòng đã xong trước khi huỷ vẫn được nhận, giá Batch");
    assert.equal(syncCalls.length, l2.variants.length - 1, "(d) phần còn lại vẽ nốt bằng gọi ngay");
    assert.ok(syncCalls.every((c) => c.quality === "medium" && c.model === "gpt-image-2.5-sunburst" && c.size === "1088x1360"), "(d) vẽ nốt ở chất lượng medium, cùng mô hình + khổ");
    assert.ok(syncCalls.every((c) => c.kinds.every((k) => k === "PRODUCT_PHOTO" || k === "OWN_VARIANT")), "(d) vẽ nốt vẫn chỉ ảnh của shop");
    assert.equal(writes, n + l2.variants.length, "(d) vẽ nốt dùng lại câu lệnh đã viết, không viết lần hai");
    assert.equal(after2.status, "PENDING_APPROVAL");
    assert.ok(l2b.variants.every((v) => v.status === "GENERATED"));
    console.log("✓ Vòng mẫu · Batch ảnh — tới 2:00 chưa xong ⇒ huỷ, nhận dòng đã xong, vẽ nốt ở medium bằng gọi ngay, không viết lại câu chữ");

    // ═══ (e) OpenAI từ chối lô ⇒ vẽ nốt NGAY ở medium ═══
    await dropBatch(db, batchDay);
    syncCalls.length = 0;
    const f3 = new FakeOpenAi();
    f3.createError = { status: 400, message: "gpt-image-2.5-sunburst does not support the Batch API" };
    const t5 = await buildBatch(db, now, depsFor(f3));
    const l5 = await lotOf(db, batchDay);
    assert.equal(l5.state?.phase, "FAILED");
    assert.match(l5.state?.error ?? "", /does not support the Batch API/, "(e) câu từ chối của OpenAI được giữ nguyên để người đọc");
    assert.equal(syncCalls.length, l5.variants.length, "(e) vẽ nốt ngay trong cùng lượt");
    assert.ok(syncCalls.every((c) => c.quality === "medium"));
    assert.equal(t5.status, "PENDING_APPROVAL");
    assert.ok(f3.uploaded.every((u) => f3.deleted.includes(u.id)), "(e) tệp đã tải lên được dọn");
    assert.match(t5.imageBatch ?? "", /gửi hỏng/);
    console.log("✓ Vòng mẫu · Batch ảnh — OpenAI từ chối lô ⇒ vẽ nốt ngay ở medium, câu lỗi giữ nguyên, tệp được dọn");

    // ═══ (f) Trần ngày theo giá Batch, không vượt 2 USD ═══
    await dropBatch(db, batchDay);
    const unitSync = estimateImageUsd(baseCfg.imageModel, baseCfg.imageQuality, baseCfg.imageSize);
    const spent0 = await imageSpendToday(db, now, unitSync);
    const cap = spent0.usd + unitBatch * 2.5;
    assert.ok(cap <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, `trần thử (${cap}) phải dưới trần cứng`);
    assert.equal(Math.floor((cap - spent0.usd) / unitSync), 1, "cùng số tiền ấy, gọi ngay chất lượng cao chỉ đủ MỘT ảnh");
    await setConfig(db, { ...baseCfg, imageDailyCapUsd: cap });
    const f4 = new FakeOpenAi();
    const t6 = await buildBatch(db, now, depsFor(f4));
    const [id4] = [...f4.batches.keys()];
    assert.equal(f4.inputLines(id4).length, 2, "(f) trần tính theo giá Batch ⇒ gửi đúng HAI ô");
    assert.ok(t6.capped >= 1);
    const l6 = await lotOf(db, batchDay);
    assert.ok(l6.variants.filter((v) => v.status === "GEN_FAILED").every((v) => /Chạm trần chi sinh ảnh .* lô Batch chỉ gửi 2 ô/.test(v.genError)), "(f) ô vượt trần mang lý do rõ");
    const r6 = await reservedImageSpend(db, now);
    assert.ok(spent0.usd + r6.usd <= cap + 1e-9 && cap <= CREATIVE_HARD_LIMITS.maxImageUsdPerDay, "(f) đã chi + giữ chỗ không vượt trần");
    // Lô khác cùng ngày gọi ngay: phần tiền Batch đang giữ chỗ phải chặn nó.
    const t6b = await buildBatch(db, now, depsFor(f4));
    assert.equal(f4.batches.size, 1, "(f) giữ chỗ không đẻ lô thứ hai");
    assert.equal(t6b.status, "PLANNED");
    console.log("✓ Vòng mẫu · Batch ảnh — trần ngày tính theo giá Batch (cùng tiền: 2 ảnh Batch vs 1 ảnh gọi ngay), đã chi + giữ chỗ không vượt 2 USD");

    // ═══ (g) SYNC không đụng Files / Batch ═══
    await dropBatch(db, batchDay);
    syncCalls.length = 0;
    await setConfig(db, { ...baseCfg, imageMode: "SYNC" });
    const f5 = new FakeOpenAi();
    const t7 = await buildBatch(db, now, depsFor(f5));
    assert.equal(f5.calls.length, 0, "(g) SYNC không gọi Files / Batch");
    assert.ok(syncCalls.length > 0 && syncCalls.every((c) => c.quality === "high"), "(g) SYNC vẽ ở chất lượng cấu hình, không phải chất lượng vẽ nốt");
    assert.equal(t7.imageBatch, null);
    console.log("✓ Vòng mẫu · Batch ảnh — SYNC giữ hành vi cũ, không đụng Files / Batch");
  } finally {
    await dropBatch(db, batchDay);
    await dropBatch(db, parentDay);
    if (sourceIds.length) await db.delete(schema.creativeSources).where(inArray(schema.creativeSources.id, sourceIds));
    if (imageIds.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, imageIds));
    await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
}
