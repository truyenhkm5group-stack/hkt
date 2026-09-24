import { createHash } from "node:crypto";
import type { ImageMode, ImageQuality, ImageSize } from "@/lib/constants/creative-loop";
import { assertPixelSafe, decodeImageEditBody, type ImageEditInputImage, type ImageEditKind, type ImageEditResult } from "@/lib/integrations/openai/images";
import { env } from "@/lib/env";

/**
 * ═══════════ OPENAI FILES + BATCH — VẼ ẢNH GIÁ 50% ═══════════
 *
 * Chủ shop chốt 24/09/2026 "Cao + Batch, giữ 2 USD": lô ảnh của vòng mẫu gửi qua Batch API lúc dựng lô.
 * Tệp này là MỌI lời gọi mạng của đường ấy, không phụ thuộc CSDL, không SDK — mỗi hàm tiêm được
 * `fetchImpl` + `apiKey` để kiểm thử không gọi mạng thật.
 *
 * ─── HỢP ĐỒNG ĐÃ ĐỌC TỪ TÀI LIỆU CHÍNH THỨC (developers.openai.com, đọc 24/09/2026) ───
 *
 *  · `/api/docs/guides/batch` — tệp đầu vào là JSONL, mỗi dòng `{ custom_id, method, url, body }`, tải lên
 *    Files API với `purpose: "batch"`; tạo lô `POST /v1/batches { input_file_id, endpoint,
 *    completion_window: "24h", metadata }`; `endpoint` nhận `/v1/images/edits`; trạng thái `validating ·
 *    failed · in_progress · finalizing · completed · expired · cancelling · cancelled`; huỷ
 *    `POST /v1/batches/{id}/cancel`; dòng kết quả `{ id, custom_id, response: { status_code, body }, error }`
 *    nằm ở `output_file_id` / `error_file_id`; giá giảm 50%.
 *  · `/api/reference/resources/images` (Create image edit) — thân JSON nhận `images: [{ file_id } |
 *    { image_url }]`: "The File API ID of an uploaded image to use as input". Tài liệu Batch KHÔNG nói
 *    dòng Batch nhận multipart, nên dòng Batch đi đường JSON này; đường gọi ngay (`editImage`) giữ multipart.
 *  · `/api/reference/resources/files` — `POST /v1/files` multipart (`file`, `purpose`); ảnh làm đầu vào
 *    cho mô hình dùng `purpose: "vision"`; đọc nội dung `GET /v1/files/{id}/content`; xoá `DELETE /v1/files/{id}`.
 *
 * ─── HÀNG RÀO ĐIỂM ẢNH (ranh giới 2 + 3 của vòng mẫu) — ÁP CẢ Ở ĐÂY ───
 *
 * Đường Batch đưa điểm ảnh sang OpenAI qua MỘT cửa khác (`POST /v1/files`), nên `assertPixelSafe` chạy lại ở
 * CẢ HAI chỗ: trước khi tải bất kỳ byte nào lên (`uploadEditReferences`), và khi dựng từng dòng JSONL
 * (`imageEditBatchLine`) — dòng nào tham chiếu một tệp không mang nhãn ảnh của shop thì không dựng được.
 * `tests/creative-image-batch.test.ts` khoá cả hai.
 *
 * ─── KHOÁ ───
 *
 * Chỉ đi vào tiêu đề `Authorization`. Câu lỗi dựng từ mã HTTP + câu lỗi OpenAI trả về.
 */

export const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
export const OPENAI_BATCHES_URL = "https://api.openai.com/v1/batches";
/** Đường dẫn TƯƠNG ĐỐI mà dòng Batch và `endpoint` của lô mang (không kèm host). */
export const IMAGE_EDITS_BATCH_ENDPOINT = "/v1/images/edits";
export const BATCH_COMPLETION_WINDOW = "24h";

export type OpenAiDeps = { fetchImpl?: typeof fetch; apiKey?: string; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 120_000;

/** Trạng thái lô Batch. `TERMINAL` = OpenAI không làm gì thêm với lô này nữa. */
export const OPENAI_BATCH_TERMINAL = ["completed", "failed", "expired", "cancelled"] as const;

export type OpenAiBatch = {
  id: string;
  status: string;
  outputFileId: string | null;
  errorFileId: string | null;
  /** Lỗi cấp LÔ (vd tệp đầu vào hỏng lúc `validating`). */
  errors: string[];
  requestCounts: { total: number; completed: number; failed: number } | null;
};

export function isBatchTerminal(status: string): boolean {
  return (OPENAI_BATCH_TERMINAL as readonly string[]).includes(status);
}

function keyOf(deps: OpenAiDeps): string {
  const k = deps.apiKey ?? env.openaiRest.apiKey;
  if (!k) throw new Error("Chưa có OPENAI_API_KEY trên máy chủ — không gửi được lô Batch.");
  return k;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    return typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** Một lời gọi. Thử lại MỘT lần với 429 / 5xx; lỗi 4xx khác gọi lại cũng ra đúng lỗi ấy. */
async function call(url: string, init: { method: string; body?: BodyInit; json?: unknown }, deps: OpenAiDeps, what: string): Promise<Response> {
  const apiKey = keyOf(deps);
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    try {
      res = await doFetch(url, { method: init.method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      throw new Error(name === "TimeoutError" || name === "AbortError" ? `${what}: quá ${Math.round(timeoutMs / 1000)} giây — đã bỏ.` : `${what}: không gọi được OpenAI (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (res.ok || !(res.status === 429 || res.status >= 500) || attempt === 1) break;
  }
  if (!res) throw new Error(`${what}: không gọi được OpenAI.`);
  if (!res.ok) {
    const msg = await errorText(res);
    throw new Error(`${what}: OpenAI từ chối (HTTP ${res.status})${msg ? `: ${msg}` : ""}.`);
  }
  return res;
}

async function jsonOf(res: Response, what: string): Promise<Record<string, unknown>> {
  try {
    const b = (await res.json()) as unknown;
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch {
    /* rơi xuống lỗi chung */
  }
  throw new Error(`${what}: OpenAI trả về phản hồi không phải JSON.`);
}

function str(x: unknown): string | null {
  return typeof x === "string" && x ? x : null;
}

function parseBatch(b: Record<string, unknown>, what: string): OpenAiBatch {
  const id = str(b.id);
  const status = str(b.status);
  if (!id || !status) throw new Error(`${what}: phản hồi thiếu id / status của lô.`);
  const errs = b.errors && typeof b.errors === "object" ? (b.errors as { data?: unknown }).data : null;
  const errors = Array.isArray(errs) ? errs.map((e) => (e && typeof e === "object" ? str((e as Record<string, unknown>).message) : null)).filter((x): x is string => Boolean(x)) : [];
  const rc = b.request_counts && typeof b.request_counts === "object" ? (b.request_counts as Record<string, unknown>) : null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { id, status, outputFileId: str(b.output_file_id), errorFileId: str(b.error_file_id), errors, requestCounts: rc ? { total: n(rc.total), completed: n(rc.completed), failed: n(rc.failed) } : null };
}

// ───────────────────────────── FILES ─────────────────────────────

export type FilePurpose = "batch" | "vision";

/** `POST /v1/files` (multipart: `purpose`, `file`). */
export async function uploadFile(input: { purpose: FilePurpose; filename: string; bytes: Uint8Array; contentType: string }, deps: OpenAiDeps = {}): Promise<{ id: string }> {
  const form = new FormData();
  form.append("purpose", input.purpose);
  // Chép sang một ArrayBuffer riêng: `Blob` không nhận thẳng một view trên bộ đệm dùng chung.
  const copy = new Uint8Array(input.bytes.byteLength);
  copy.set(input.bytes);
  form.append("file", new Blob([copy.buffer], { type: input.contentType }), input.filename);
  const b = await jsonOf(await call(OPENAI_FILES_URL, { method: "POST", body: form }, deps, "Tải tệp lên OpenAI"), "Tải tệp lên OpenAI");
  const id = str(b.id);
  if (!id) throw new Error("Tải tệp lên OpenAI: phản hồi không có id tệp.");
  return { id };
}

/** `GET /v1/files/{id}/content` — nội dung CHỮ (tệp kết quả JSONL của lô). */
export async function fileContent(fileId: string, deps: OpenAiDeps = {}): Promise<string> {
  const res = await call(`${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}/content`, { method: "GET" }, deps, "Đọc tệp kết quả Batch");
  return res.text();
}

/** `DELETE /v1/files/{id}`. Dọn dẹp — nơi gọi nuốt lỗi. */
export async function deleteFile(fileId: string, deps: OpenAiDeps = {}): Promise<void> {
  await call(`${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}`, { method: "DELETE" }, deps, "Xoá tệp trên OpenAI");
}

// ───────────────────────────── BATCHES ─────────────────────────────

export async function createBatch(input: { inputFileId: string; endpoint: typeof IMAGE_EDITS_BATCH_ENDPOINT; metadata?: Record<string, string> }, deps: OpenAiDeps = {}): Promise<OpenAiBatch> {
  const b = await jsonOf(
    await call(OPENAI_BATCHES_URL, { method: "POST", json: { input_file_id: input.inputFileId, endpoint: input.endpoint, completion_window: BATCH_COMPLETION_WINDOW, ...(input.metadata ? { metadata: input.metadata } : {}) } }, deps, "Tạo lô Batch"),
    "Tạo lô Batch",
  );
  return parseBatch(b, "Tạo lô Batch");
}

export async function retrieveBatch(batchId: string, deps: OpenAiDeps = {}): Promise<OpenAiBatch> {
  return parseBatch(await jsonOf(await call(`${OPENAI_BATCHES_URL}/${encodeURIComponent(batchId)}`, { method: "GET" }, deps, "Đọc lô Batch"), "Đọc lô Batch"), "Đọc lô Batch");
}

export async function cancelBatch(batchId: string, deps: OpenAiDeps = {}): Promise<OpenAiBatch> {
  return parseBatch(await jsonOf(await call(`${OPENAI_BATCHES_URL}/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }, deps, "Huỷ lô Batch"), "Huỷ lô Batch"), "Huỷ lô Batch");
}

/** Hình dạng để TIÊM vào đường sinh: kiểm thử truyền bản dựng trên `fetch` giả. */
export type ImageBatchClient = {
  uploadFile: (input: { purpose: FilePurpose; filename: string; bytes: Uint8Array; contentType: string }) => Promise<{ id: string }>;
  createBatch: (input: { inputFileId: string; endpoint: typeof IMAGE_EDITS_BATCH_ENDPOINT; metadata?: Record<string, string> }) => Promise<OpenAiBatch>;
  retrieveBatch: (batchId: string) => Promise<OpenAiBatch>;
  cancelBatch: (batchId: string) => Promise<OpenAiBatch>;
  fileContent: (fileId: string) => Promise<string>;
  deleteFile: (fileId: string) => Promise<void>;
};

export function openAiBatchClient(deps: OpenAiDeps = {}): ImageBatchClient {
  return {
    uploadFile: (i) => uploadFile(i, deps),
    createBatch: (i) => createBatch(i, deps),
    retrieveBatch: (id) => retrieveBatch(id, deps),
    cancelBatch: (id) => cancelBatch(id, deps),
    fileContent: (id) => fileContent(id, deps),
    deleteFile: (id) => deleteFile(id, deps),
  };
}

// ───────────────────────────── ẢNH QUA BATCH ─────────────────────────────

export type ImageEditBatchRef = { kind: ImageEditKind; fileId: string };

function extOf(contentType: string): string {
  return contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
}

/**
 * Tải ẢNH THAM CHIẾU của MỘT ô lên Files API (`purpose: "vision"`). Hàng rào chạy TRƯỚC byte đầu tiên:
 * cả bộ ảnh phải qua `assertPixelSafe` (chỉ ảnh sản phẩm thật + ảnh của chính shop, có ít nhất một ảnh
 * sản phẩm). `cache` (băm → id tệp) để một ảnh sản phẩm dùng cho nhiều ô chỉ tải một lần.
 */
export async function uploadEditReferences(client: Pick<ImageBatchClient, "uploadFile">, images: ImageEditInputImage[], cache: Map<string, string> = new Map()): Promise<ImageEditBatchRef[]> {
  assertPixelSafe(images);
  const out: ImageEditBatchRef[] = [];
  for (const img of images) {
    const sha = createHash("sha256").update(img.bytes).digest("hex");
    let fileId = cache.get(sha);
    if (!fileId) {
      fileId = (await client.uploadFile({ purpose: "vision", filename: `ref-${sha.slice(0, 12)}-${img.kind.toLowerCase()}.${extOf(img.contentType)}`, bytes: img.bytes, contentType: img.contentType })).id;
      cache.set(sha, fileId);
    }
    out.push({ kind: img.kind, fileId });
  }
  return out;
}

/**
 * MỘT dòng JSONL cho `/v1/images/edits`. `custom_id` = id mẫu (khoá để nối kết quả về đúng ô). Nhãn ảnh đi
 * cùng id tệp CHỈ để kiểm lại hàng rào ở đây — OpenAI chỉ nhận `file_id`.
 */
export function imageEditBatchLine(input: { customId: string; model: string; prompt: string; images: ImageEditBatchRef[]; size: ImageSize; quality: ImageQuality }): string {
  assertPixelSafe(input.images);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Câu lệnh sinh ảnh trống.");
  if (!input.customId) throw new Error("Dòng Batch thiếu custom_id.");
  return JSON.stringify({
    custom_id: input.customId,
    method: "POST",
    url: IMAGE_EDITS_BATCH_ENDPOINT,
    body: { model: input.model, prompt, images: input.images.map((i) => ({ file_id: i.fileId })), size: input.size, quality: input.quality, output_format: "jpeg", n: 1 },
  });
}

export type ImageBatchLineResult = { customId: string; ok: true; image: ImageEditResult } | { customId: string; ok: false; error: string };

/**
 * Đọc tệp kết quả (hoặc tệp lỗi) JSONL. Dòng hỏng / thiếu `custom_id` bị bỏ — không đoán nó thuộc ô nào.
 * Chi phí mỗi ảnh tính theo `usage` × giá Batch (`mode`).
 */
export function parseImageBatchResults(jsonl: string, model: string, mode: ImageMode = "BATCH"): ImageBatchLineResult[] {
  const out: ImageBatchLineResult[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const customId = str(r.custom_id);
    if (!customId) continue;
    const resp = r.response && typeof r.response === "object" ? (r.response as { status_code?: unknown; body?: unknown }) : null;
    const errObj = r.error && typeof r.error === "object" ? (r.error as { message?: unknown; code?: unknown }) : null;
    if (resp && resp.status_code === 200 && !errObj) {
      try {
        out.push({ customId, ok: true, image: decodeImageEditBody(resp.body, model, mode) });
      } catch (e) {
        out.push({ customId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    const bodyErr = resp?.body && typeof resp.body === "object" ? (resp.body as { error?: { message?: unknown } }).error?.message : null;
    const msg = str(errObj?.message) ?? str(bodyErr) ?? "";
    const code = str(errObj?.code);
    out.push({ customId, ok: false, error: `${typeof resp?.status_code === "number" ? `HTTP ${resp.status_code}` : "lỗi"}${code ? ` ${code}` : ""}${msg ? `: ${msg.slice(0, 300)}` : ""}` });
  }
  return out;
}
