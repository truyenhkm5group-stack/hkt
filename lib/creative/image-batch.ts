import { IMAGE_QUALITIES, IMAGE_SIZES, IMAGE_QUALITY_LABEL, type ImageQuality, type ImageSize } from "@/lib/constants/creative-loop";

/**
 * ═══════════ TRẠNG THÁI LÔ BATCH ẢNH CỦA MỘT LÔ MẪU — HÀM THUẦN ═══════════
 *
 * Lưu ở `creative_batches.plan.imageBatch` (jsonb đã có — không cần cột mới: không màn hình nào lọc
 * theo nó, chỉ đường sinh đọc lại và tóm tắt của job in ra). Đường ghi DUY NHẤT là `generate.ts`.
 *
 * Vòng đời:
 *
 *   (không có)  ──gửi──▶ SUBMITTING ──tạo lô xong──▶ SUBMITTED ──OpenAI xong/hỏng──▶ SETTLED
 *                            │                          │
 *                            │ (đứt giữa chừng,         └──tới mốc vẽ nốt──▶ CANCELLING ──đã huỷ──▶ SETTLED
 *                            │  tới mốc vẽ nốt)                               └──quá 30 phút──▶ ABANDONED
 *                            ▼
 *                        ABANDONED            gửi hỏng ngay (4xx, mạng) ──▶ FAILED
 *
 * `SUBMITTING` được ghi TRƯỚC khi gọi OpenAI và có điều kiện "chưa có `imageBatch`" trong câu `UPDATE`:
 * hai lượt chạy không bao giờ gửi hai lô Batch cho cùng một lô mẫu. Lượt gửi đứt giữa chừng thì KHÔNG gửi
 * lại (không biết OpenAI đã nhận chưa — gửi lại là có thể trả tiền hai lần); tới mốc vẽ nốt thì bỏ và vẽ
 * bằng gọi ngay, đúng như một lô Batch chưa xong.
 *
 * Ba pha đầu (`RESERVING_PHASES`) GIỮ CHỖ trong trần ngày: tiền của một lô đã gửi mà chưa về ảnh vẫn là
 * tiền sẽ tiêu. Các pha còn lại trả chỗ — ảnh đã về tự được đếm theo `gen_cost_usd`.
 */

export const IMAGE_BATCH_PHASES = ["SUBMITTING", "SUBMITTED", "CANCELLING", "SETTLED", "FAILED", "ABANDONED"] as const;
export type ImageBatchPhase = (typeof IMAGE_BATCH_PHASES)[number];
export const RESERVING_PHASES: readonly ImageBatchPhase[] = ["SUBMITTING", "SUBMITTED", "CANCELLING"];

/** Đã yêu cầu huỷ mà bấy nhiêu phút sau OpenAI vẫn "đang huỷ" ⇒ bỏ, vẽ nốt bằng gọi ngay. */
export const IMAGE_BATCH_CANCEL_GRACE_MINUTES = 30;

export type ImageBatchState = {
  phase: ImageBatchPhase;
  /** Id lô trên OpenAI (`batch_…`). `""` khi chưa tạo được. */
  openaiBatchId: string;
  /** Trạng thái OpenAI đọc được lần gần nhất. */
  openaiStatus: string;
  claimedAt: string;
  submittedAt: string;
  checkedAt: string;
  cancelRequestedAt: string;
  settledAt: string;
  model: string;
  quality: ImageQuality;
  size: ImageSize;
  /** Id mẫu đã đi vào lô (`custom_id` của từng dòng). */
  variantIds: string[];
  /** Tệp đã tải lên OpenAI (ảnh tham chiếu + JSONL) — dọn sau khi xong. */
  fileIds: string[];
  /** Chỗ GIỮ trong trần ngày (ước tính giá Batch × số ô), trả về 0 khi rời pha giữ chỗ. */
  reservedUsd: number;
  reservedImages: number;
  generated: number;
  failed: number;
  error: string;
};

export function emptyImageBatchState(p: Pick<ImageBatchState, "model" | "quality" | "size">): ImageBatchState {
  return { phase: "SUBMITTING", openaiBatchId: "", openaiStatus: "", claimedAt: "", submittedAt: "", checkedAt: "", cancelRequestedAt: "", settledAt: "", variantIds: [], fileIds: [], reservedUsd: 0, reservedImages: 0, generated: 0, failed: 0, error: "", ...p };
}

/** Đọc từ `plan` (JSON không tin được). Không có / pha lạ ⇒ `null`. */
export function parseImageBatchState(plan: unknown): ImageBatchState | null {
  const raw = plan && typeof plan === "object" ? (plan as Record<string, unknown>).imageBatch : null;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const phase = IMAGE_BATCH_PHASES.find((x) => x === r.phase);
  if (!phase) return null;
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && y !== "") : []);
  return {
    phase,
    openaiBatchId: s(r.openaiBatchId),
    openaiStatus: s(r.openaiStatus),
    claimedAt: s(r.claimedAt),
    submittedAt: s(r.submittedAt),
    checkedAt: s(r.checkedAt),
    cancelRequestedAt: s(r.cancelRequestedAt),
    settledAt: s(r.settledAt),
    model: s(r.model),
    quality: IMAGE_QUALITIES.find((x) => x === r.quality) ?? "high",
    size: IMAGE_SIZES.find((x) => x === r.size) ?? "1024x1024",
    variantIds: arr(r.variantIds),
    fileIds: arr(r.fileIds),
    reservedUsd: n(r.reservedUsd),
    reservedImages: n(r.reservedImages),
    generated: n(r.generated),
    failed: n(r.failed),
    error: s(r.error),
  };
}

export function isReserving(state: ImageBatchState | null): boolean {
  return state !== null && RESERVING_PHASES.includes(state.phase);
}

/** Một câu cho `sync_runs.detail` và thông báo — lô Batch đang ở đâu. */
export function describeImageBatch(state: ImageBatchState | null, fallbackQuality: ImageQuality): string {
  if (!state) return "";
  const id = state.openaiBatchId ? ` ${state.openaiBatchId}` : "";
  const nOs = state.variantIds.length;
  const rest = `vẽ nốt bằng gọi ngay ở chất lượng ${IMAGE_QUALITY_LABEL[fallbackQuality].toLowerCase()}`;
  switch (state.phase) {
    case "SUBMITTING":
      return `Batch ảnh: đang gửi ${nOs} ô (lượt gửi chưa xác nhận).`;
    case "SUBMITTED":
      return `Batch ảnh${id}: OpenAI báo "${state.openaiStatus || "?"}" · ${nOs} ô · giữ chỗ ~${state.reservedUsd.toFixed(3)} USD.`;
    case "CANCELLING":
      return `Batch ảnh${id}: tới mốc vẽ nốt mà chưa xong — đã yêu cầu huỷ (OpenAI báo "${state.openaiStatus || "?"}"); còn thiếu ô nào thì ${rest}.`;
    case "SETTLED":
      return `Batch ảnh${id}: xong ("${state.openaiStatus || "?"}") — ${state.generated} ảnh, ${state.failed} ô lỗi${state.generated + state.failed < nOs ? `, ${nOs - state.generated - state.failed} ô ${rest}` : ""}.${state.error ? ` ${state.error}` : ""}`;
    case "FAILED":
      return `Batch ảnh: gửi hỏng — ${state.error || "không rõ lý do"}`;
    case "ABANDONED":
      return `Batch ảnh${id}: đã bỏ — ${state.error || rest}`;
  }
}
