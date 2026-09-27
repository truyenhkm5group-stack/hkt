/**
 * ═══════════ KHAI THEO GỢI Ý — MÁY GỢI Ý, NGƯỜI BẤM (Company OS · Agent Q) ═══════════
 *
 * Tệp THUẦN — không đọc/ghi CSDL, client import được.
 *
 * Đo production 27/09/2026 (ops company-os-summary): 25 mẫu, 18 mẫu thiết kế TK "Chưa khai". Không ai khai
 * từng mẫu một, trong khi máy đã tính sẵn GIAI ĐOẠN QUAN SÁT (`observeModelStage`, ƯỚC TÍNH) cho mỗi mẫu.
 * Luồng này đặt gợi ý ấy trước mặt NGƯỜI để họ xác nhận (hoặc chọn khác) cả lô trong một cú bấm.
 *
 * Luật (target-architecture Q3, AGENTS.md mục 8.8, 34, 35):
 *  · gợi ý KHÔNG BAO GIỜ tự thành lời khai — không job, không tự chấp nhận; mỗi dòng ghi ra mang
 *    `actor_kind = USER` và `users.id` của người bấm;
 *  · chỉ mẫu CHƯA KHAI (`lifecycle_state IS NULL`) — mẫu đã có lời khai không bị đè, kể cả khi người khác
 *    vừa khai trong lúc màn hình này còn mở (dòng đó bị BỎ QUA và báo lại);
 *  · mẫu máy không có gợi ý (chưa đủ chứng cứ) KHÔNG chọn được — khai tay ở trang từng mẫu;
 *  · gợi ý ghi kèm vào `metadata` của dòng lịch sử: `{ suggested, accepted, basis: "ESTIMATED" }` —
 *    người đọc sau biết lời khai này là người XÁC NHẬN phép đoán hay người CHỌN KHÁC.
 */
import type { ModelEvidence, ModelState, ObservedModelStage } from "@/lib/constants/model-lifecycle";
import { evidenceUnknowns, observeModelStage } from "@/lib/constants/model-lifecycle";

/** Trần kỹ thuật một lượt khai (một giao dịch mỗi mẫu) — không phải ngưỡng nghiệp vụ. */
export const BULK_DECLARE_MAX = 200;

/** Lý do điền sẵn — sửa được, nhưng vẫn phải ≥ `MODEL_REASON_MIN_LENGTH`. */
export const BULK_DECLARE_DEFAULT_REASON = "Khai lần đầu theo gợi ý của ERP (giai đoạn ước tính)";

/** Nguồn của dòng lịch sử khi khai từ bảng gợi ý trên `/models`. */
export const BULK_DECLARE_SOURCE = "ui:/models:bulk-suggest";

/** Nguồn khi khai theo gợi ý ở trang một mẫu (cùng luồng, một dòng). */
export function modelSuggestSource(modelId: string): string {
  return `ui:/models/${modelId}:suggest`;
}

export const BULK_DECLARE_NO_SUGGESTION_LABEL = "Chưa đủ dữ liệu để gợi ý";

/** Một dòng của bảng xem trước. */
export type DeclarePreviewRow = {
  modelId: string;
  code: string;
  name: string;
  image: string | null;
  /** `null` = máy không gợi ý ⇒ KHÔNG chọn được. */
  suggested: ModelState | null;
  reasons: string[];
  /** Ô chứng cứ CHƯA BIẾT (luật 42) — "máy chưa thấy" có thể là "máy không đọc được". */
  unknowns: string[];
  selectable: boolean;
  /** Mặc định tick CHỈ khi có gợi ý. */
  defaultChecked: boolean;
};

/**
 * Dựng bảng xem trước từ danh sách mẫu (đã lọc CHƯA KHAI) và chứng cứ theo lô. Mẫu thiếu chứng cứ trong
 * bản đồ (không đọc được) ⇒ không gợi ý, không chọn được. Mẫu đã có trạng thái lọt vào ⇒ bị loại.
 */
export function buildDeclarePreview(
  models: readonly { id: string; code: string; name: string; productName?: string | null; image: string | null; state: ModelState | null }[],
  evidence: ReadonlyMap<string, ModelEvidence>,
): DeclarePreviewRow[] {
  const out: DeclarePreviewRow[] = [];
  for (const m of models) {
    if (m.state !== null) continue;
    const e = evidence.get(m.id);
    const obs: ObservedModelStage = e ? observeModelStage(e) : { stage: null, reasons: [], basis: "ESTIMATED" };
    const selectable = obs.stage !== null;
    out.push({
      modelId: m.id,
      code: m.code,
      name: m.name || m.productName || "",
      image: m.image,
      suggested: obs.stage,
      reasons: obs.reasons,
      unknowns: e ? evidenceUnknowns(e) : ["Không đọc được chứng cứ của mẫu này."],
      selectable,
      defaultChecked: selectable,
    });
  }
  return out;
}

/** Kết cục của MỘT dòng trong lượt khai — không dòng nào biến mất khỏi báo cáo. */
export const DECLARE_ROW_OUTCOMES = ["DECLARED", "SKIPPED_ALREADY_DECLARED", "SKIPPED_NO_SUGGESTION", "NOT_FOUND", "FAILED"] as const;
export type DeclareRowOutcome = (typeof DECLARE_ROW_OUTCOMES)[number];

export const DECLARE_ROW_OUTCOME_LABEL: Record<DeclareRowOutcome, string> = {
  DECLARED: "Đã khai",
  SKIPPED_ALREADY_DECLARED: "Bỏ qua — mẫu đã có người khai trong lúc màn hình còn mở",
  SKIPPED_NO_SUGGESTION: "Bỏ qua — máy không còn gợi ý cho mẫu này",
  NOT_FOUND: "Không tìm thấy mẫu",
  FAILED: "Lỗi",
};

export type DeclareRowResult = {
  modelId: string;
  code: string | null;
  outcome: DeclareRowOutcome;
  /** Trạng thái người chọn. */
  state: string;
  /** Gợi ý của máy LÚC GHI (máy chủ tính lại, không nhận từ client). */
  suggested: ModelState | null;
  accepted: boolean | null;
  /** Trạng thái hiện tại khi bị bỏ qua vì đã khai. */
  current?: ModelState | null;
  error?: string;
  historyId?: string;
};
