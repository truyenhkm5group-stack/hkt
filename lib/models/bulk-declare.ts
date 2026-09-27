import { eq } from "drizzle-orm";

import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { BULK_DECLARE_MAX, type DeclareRowResult } from "@/lib/constants/model-bulk-declare";
import { isModelState, MODEL_REASON_MIN_LENGTH, observeModelStage, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";
import { staleStateSuggestion, STALE_UPDATE_KIND, type StaleStateFacts } from "@/lib/constants/model-stale-state";
import { transitionModelCore } from "@/lib/models/service";
import { getModelsStaleFactsBatch } from "@/lib/queries/model-stale-state";
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
 *
 * ─── HAI LUỒNG, MỘT LÕI (Agent ST mở rộng) ───
 *  · `expectedState: null`  — KHAI LẦN ĐẦU (Q): gợi ý = `observeModelStage` (ước tính); hàng rào "vẫn chưa khai".
 *  · `expectedState: <X>`   — CẬP NHẬT THEO THỰC TẾ (ST): gợi ý = `staleStateSuggestion(X, dữ kiện)` — chứng
 *    cứ đã đi trước lời khai X; hàng rào "lời khai VẪN là X" (đúng trạng thái người thấy trên bảng xem trước).
 *    Lời khai đã đổi ⇒ `SKIPPED_STATE_CHANGED`, không đè — bấm hai lần cũng rơi vào nhánh này (lượt đầu đã đổi
 *    lời khai), nên không có dòng thứ hai. Lịch sử ghi `metadata { kind: "STALE_UPDATE", suggested, accepted,
 *    reasons }`.
 */
export type DeclareFromSuggestionInput = {
  items: readonly { modelId: string; state: ModelState; expectedState: ModelState | null }[];
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
  if (!reasonIsEnough(reason)) return { error: `Cần ghi lý do (ít nhất ${MODEL_REASON_MIN_LENGTH} ký tự) — mỗi lượt khai theo gợi ý / cập nhật theo thực tế đều ghi vào lịch sử của mẫu` };

  const evidence = await getModelsEvidenceBatch(
    input.items.map((i) => i.modelId),
    { now: input.now },
  );
  // Dữ kiện "đi sau thực tế" chỉ đọc cho dòng CẬP NHẬT — dùng lại đúng lô chứng cứ vừa đọc.
  const staleIds = input.items.filter((i) => i.expectedState !== null).map((i) => i.modelId);
  const staleFacts = staleIds.length ? await getModelsStaleFactsBatch(staleIds, { now: input.now, evidence }) : new Map<string, StaleStateFacts>();

  const results: DeclareRowResult[] = [];
  for (const item of input.items) {
    const e = evidence.get(item.modelId);
    const expected = item.expectedState;
    // Luồng khai lần đầu: giai đoạn ước tính. Luồng cập nhật: đề xuất đi TỚI từ đúng lời khai người đã thấy.
    const obs = expected === null ? (e ? observeModelStage(e) : null) : null;
    const facts = expected === null ? null : (staleFacts.get(item.modelId) ?? null);
    const stale = expected !== null && facts ? staleStateSuggestion(expected, facts) : null;
    const suggested = expected === null ? (obs?.stage ?? null) : (stale?.to ?? null);
    const row: DeclareRowResult = { modelId: item.modelId, code: null, outcome: "FAILED", state: item.state, suggested, accepted: null };
    if (!e) {
      results.push({ ...row, outcome: "NOT_FOUND" });
      continue;
    }
    if (suggested === null) {
      results.push({ ...row, outcome: "SKIPPED_NO_SUGGESTION" });
      continue;
    }
    const metadata =
      expected === null
        ? { suggested, accepted: item.state === suggested, basis: "ESTIMATED", suggestedReasons: obs?.reasons ?? [] }
        : { kind: STALE_UPDATE_KIND, suggested, accepted: item.state === suggested, reasons: stale?.reasons ?? [] };
    try {
      const r = await db.transaction(async (tx): Promise<DeclareRowResult> => {
        const [m] = await tx.select({ code: pm.code, state: pm.lifecycleState }).from(pm).where(eq(pm.id, item.modelId)).for("update").limit(1);
        if (!m) return { ...row, outcome: "NOT_FOUND" };
        // Hàng rào màn hình cũ: lời khai phải VẪN là thứ người thấy (`NULL` cho khai lần đầu, X cho cập nhật).
        if (m.state !== item.expectedState) return { ...row, code: m.code, outcome: expected === null ? "SKIPPED_ALREADY_DECLARED" : "SKIPPED_STATE_CHANGED", current: isModelState(m.state) ? m.state : null };
        const t = await transitionModelCore(tx, {
          modelId: item.modelId,
          to: item.state,
          reason,
          actor: input.actor,
          actorKind: "USER",
          source: input.source,
          metadata,
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
