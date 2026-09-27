import { eq } from "drizzle-orm";

import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { BULK_DECLARE_MAX, type DeclareRowResult } from "@/lib/constants/model-bulk-declare";
import { isModelState, MODEL_REASON_MIN_LENGTH, observeModelStage, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";
import { transitionModelCore } from "@/lib/models/service";
import { getModelsEvidenceBatch } from "@/lib/queries/models";

/**
 * ═══════════ LÕI "KHAI THEO GỢI Ý" (Company OS · Agent Q) ═══════════
 *
 * KHÔNG "use server". Gọi DUY NHẤT từ server action `declareModelsFromSuggestion` (lib/actions/models.ts) —
 * tức là chỉ sau một cú bấm của người. Không job, không đồng bộ nào được gọi vào đây
 * (tests/company-os-bulk-declare.test.ts quét mã nguồn).
 *
 * Mỗi mẫu MỘT giao dịch riêng:
 *   khoá dòng mẫu (`FOR UPDATE`) → còn CHƯA KHAI không (hàng rào màn hình cũ) → `transitionModelCore(tx)`
 *   — đường duy nhất đổi `lifecycle_state`, ghi lịch sử + sự kiện `model.state_changed`.
 * Dòng hỏng không kéo dòng khác theo; lượt bấm lại tìm thấy trạng thái đã khác NULL ⇒ bỏ qua (idempotent).
 *
 * Gợi ý (`suggested`) do MÁY CHỦ tính lại lúc ghi từ chứng cứ theo lô — client không khai được "tôi chấp
 * nhận gợi ý" cho một trạng thái máy không hề gợi ý.
 */
export type DeclareFromSuggestionInput = {
  items: readonly { modelId: string; state: ModelState; expectedState: null }[];
  reason: string;
  /** Người bấm — `id` BẮT BUỘC (mục 34). Luồng này chỉ dành cho người: `actor_kind` luôn là USER. */
  actor: Actor;
  source: string;
  /** Mốc tính cửa sổ 30 ngày của chứng cứ (bài kiểm truyền mốc cố định). */
  now?: Date;
};

export type DeclareFromSuggestionResult = { ok: true; declared: number; results: DeclareRowResult[] } | { error: string };

const pm = schema.productModels;

/**
 * Câu lỗi GỐC: drizzle bọc lỗi CSDL thành "Failed query: <cả câu SQL + tham số>" và giữ lỗi thật ở `cause`.
 * In cả câu SQL lên màn hình vừa khó đọc vừa lộ tham số — lấy lỗi sâu nhất.
 */
function rootMessage(err: unknown): string {
  let e: unknown = err;
  for (let i = 0; i < 5 && e instanceof Error && e.cause instanceof Error; i++) e = e.cause;
  return e instanceof Error ? e.message : String(e);
}

export async function declareModelsFromSuggestionCore(db: Db, input: DeclareFromSuggestionInput): Promise<DeclareFromSuggestionResult> {
  if (!input.actor.id) return { error: "Khai theo gợi ý phải do một tài khoản ERP bấm (AGENTS.md mục 34) — máy không tự khai" };
  if (!input.items.length) return { error: "Chưa chọn mẫu nào" };
  if (input.items.length > BULK_DECLARE_MAX) return { error: `Mỗi lượt khai tối đa ${BULK_DECLARE_MAX} mẫu` };
  const reason = input.reason.trim();
  if (!reasonIsEnough(reason)) return { error: `Cần ghi lý do (ít nhất ${MODEL_REASON_MIN_LENGTH} ký tự) — đây là lần khai đầu tiên của các mẫu` };

  const evidence = await getModelsEvidenceBatch(
    input.items.map((i) => i.modelId),
    { now: input.now },
  );

  const results: DeclareRowResult[] = [];
  for (const item of input.items) {
    const e = evidence.get(item.modelId);
    const obs = e ? observeModelStage(e) : null;
    const suggested = obs?.stage ?? null;
    const row: DeclareRowResult = { modelId: item.modelId, code: null, outcome: "FAILED", state: item.state, suggested, accepted: null };
    if (!e) {
      results.push({ ...row, outcome: "NOT_FOUND" });
      continue;
    }
    if (!obs || suggested === null) {
      results.push({ ...row, outcome: "SKIPPED_NO_SUGGESTION" });
      continue;
    }
    try {
      const r = await db.transaction(async (tx): Promise<DeclareRowResult> => {
        const [m] = await tx.select({ code: pm.code, state: pm.lifecycleState }).from(pm).where(eq(pm.id, item.modelId)).for("update").limit(1);
        if (!m) return { ...row, outcome: "NOT_FOUND" };
        // Hàng rào màn hình cũ: chỉ khai khi mẫu VẪN chưa khai (`expectedState` luôn là NULL).
        if (m.state !== item.expectedState) return { ...row, code: m.code, outcome: "SKIPPED_ALREADY_DECLARED", current: isModelState(m.state) ? m.state : null };
        const t = await transitionModelCore(tx, {
          modelId: item.modelId,
          to: item.state,
          reason,
          actor: input.actor,
          actorKind: "USER",
          source: input.source,
          metadata: { suggested, accepted: item.state === suggested, basis: "ESTIMATED", suggestedReasons: obs.reasons },
        });
        if ("error" in t) return { ...row, code: m.code, outcome: "FAILED", error: t.error };
        return { ...row, code: m.code, outcome: "DECLARED", accepted: item.state === suggested, historyId: t.historyId };
      });
      results.push(r);
    } catch (err) {
      // Giao dịch của riêng dòng này đã lùi; các dòng khác đi tiếp.
      results.push({ ...row, outcome: "FAILED", error: rootMessage(err) });
    }
  }
  return { ok: true, declared: results.filter((r) => r.outcome === "DECLARED").length, results };
}
