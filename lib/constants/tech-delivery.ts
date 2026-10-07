/**
 * ═══════════ ĐƯỜNG GIAO HÀNG: PR → CI → GỘP → DEPLOY → HẬU KIỂM (Pha 3) ═══════════
 *
 * docs/tech-control-plane/README.md mục 10. Tệp THUẦN, CLIENT-SAFE, không đọc đồng hồ (mọi hàm nhận `now`).
 * Mọi phản ứng với sự kiện GitHub là PHÉP TÍNH tất định ở đây — không gọi model nào. Model chỉ được gọi khi một
 * việc SỬA (CI đỏ) được một worker nhận, như mọi việc khác.
 *
 * ─── GITHUB VẪN LÀ BÊN CÓ THẨM QUYỀN ───
 *
 * ERP không tự gộp, không tự deploy, không nới cổng nào. Nó QUAN SÁT: PR mở chưa, CI xanh chưa, đã gộp chưa, lượt
 * deploy nào đã chạy commit chứa nó, production có khoẻ sau đó không — rồi đẩy trạng thái VIỆC theo chứng cứ đó.
 */
import type { TechTaskStatus } from "@/lib/constants/tech";

/* ═════════════════════ PR / CI ⇒ SỰ KIỆN ═════════════════════ */

export type PrSnapshot = { prNumber: number | null; prState: string; ciState: string; headSha: string };

export type PrEventName = "pr.opened" | "pr.merged" | "pr.closed" | "ci.passed" | "ci.failed";

/**
 * Sự kiện sinh ra từ MỘT lượt đổi của phép chiếu PR. Mỗi sự kiện kèm khoá chống trùng gắn với PR + SHA: chạy
 * lại đồng bộ / một lượt "đổi" lặp lại không đẻ sự kiện thứ hai. CI đổi trên CÙNG SHA (PENDING → FAILURE) là một
 * sự kiện; đẩy commit mới rồi lại đỏ là sự kiện MỚI (SHA khác) — đúng thứ cần đếm cho trần sửa CI.
 */
export function prTransitionEvents(prev: PrSnapshot, next: PrSnapshot): { name: PrEventName; dedupe: string }[] {
  const out: { name: PrEventName; dedupe: string }[] = [];
  const n = next.prNumber;
  if (n === null) return out;
  if (prev.prNumber !== n) out.push({ name: "pr.opened", dedupe: `pr:${n}:opened` });
  if (next.prState === "MERGED" && prev.prState !== "MERGED") out.push({ name: "pr.merged", dedupe: `pr:${n}:merged` });
  if (next.prState === "CLOSED" && prev.prState !== "CLOSED") out.push({ name: "pr.closed", dedupe: `pr:${n}:closed:${next.headSha}` });
  const ciDoi = next.ciState !== prev.ciState || next.headSha !== prev.headSha;
  if (ciDoi && next.ciState === "SUCCESS") out.push({ name: "ci.passed", dedupe: `pr:${n}:ci:${next.headSha}:SUCCESS` });
  if (ciDoi && next.ciState === "FAILURE") out.push({ name: "ci.failed", dedupe: `pr:${n}:ci:${next.headSha}:FAILURE` });
  return out;
}

/* ═════════════════════ CI ĐỎ ⇒ VIỆC SỬA (CÓ TRẦN) ═════════════════════ */

/** Một PR của worker được sửa CI tối đa ngần này lần (mỗi lần một việc con `ci-debug`). Hết ⇒ việc gốc FAILED. */
export const CI_FIX_MAX = 2;

export type CiFixDecision = "CREATE_FIX" | "FIX_IN_FLIGHT" | "EXHAUSTED" | "NOT_WORKER" | "NOT_OPEN";

/**
 * CI đỏ trên PR của một việc ⇒ làm gì. Chỉ PR của nhánh WORKER (`ai/worker/…`) được tự sửa — PR người mở thì
 * người sửa. Đang có việc sửa còn mở ⇒ không đẻ thêm (một đợt đỏ, một việc sửa). Hết trần ⇒ dừng, không vòng vô hạn.
 */
export function ciFixDecision(input: { branch: string; prState: string; fixTasksTotal: number; fixTasksOpen: number }): CiFixDecision {
  if (!input.branch.startsWith("ai/worker/")) return "NOT_WORKER";
  if (input.prState !== "OPEN") return "NOT_OPEN";
  if (input.fixTasksOpen > 0) return "FIX_IN_FLIGHT";
  if (input.fixTasksTotal >= CI_FIX_MAX) return "EXHAUSTED";
  return "CREATE_FIX";
}

/* ═════════════════════ ĐÃ GỘP + ĐÃ DEPLOY ⇒ HẬU KIỂM ═════════════════════ */

/**
 * Việc đã gộp (QA) mà một lượt deploy THÀNH CÔNG + ĐÃ ĐỐI CHIẾU (commit đang chạy = commit của lượt đó) chứa commit
 * gộp của nó ⇒ đi tiếp tới OBSERVING, qua ĐÚNG các khâu trung gian (nhật ký kể đủ đường đi). Đây là ghi lại một
 * sự việc đã xảy ra, không phải một quyết định deploy: lượt deploy do người / Delivery Controller dispatch.
 */
export function deployCatchUpSteps(status: TechTaskStatus): TechTaskStatus[] {
  switch (status) {
    case "QA":
      return ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING"];
    case "READY_TO_DEPLOY":
      return ["DEPLOYING", "OBSERVING"];
    case "DEPLOYING":
      return ["OBSERVING"];
    default:
      return [];
  }
}

/** Cửa sổ quan sát sau deploy trước khi máy được ghi "đã xác minh trên production". */
export const OBSERVATION_MINUTES = 30;

export type ObservationVerdict = "WAIT" | "PASS" | "INCIDENT" | "NO_EVIDENCE";

/**
 * Hậu kiểm sau deploy — hàm thuần.
 *  · Không có lượt deploy đã đối chiếu nào chứa việc ⇒ `NO_EVIDENCE` (KHÔNG kết luận gì).
 *  · Có sự cố SEV0/SEV1 mở SAU mốc deploy ⇒ `INCIDENT` (việc chuyển "Cần chủ shop": PRODUCTION_INCIDENT).
 *  · Chưa đủ cửa sổ quan sát ⇒ `WAIT`.
 *  · Đủ cửa sổ, commit đang chạy vẫn là commit đã đối chiếu, không sự cố nặng ⇒ `PASS`.
 * Không có nhánh nào biến "chưa biết" thành "khoẻ": thiếu chứng cứ là `NO_EVIDENCE`, không phải `PASS`.
 */
export function observationVerdict(input: {
  deployedAt: Date | null;
  verified: boolean;
  severeIncidentsSince: number;
  now: Date;
}): ObservationVerdict {
  if (!input.deployedAt || !input.verified) return "NO_EVIDENCE";
  if (input.severeIncidentsSince > 0) return "INCIDENT";
  if (input.now.getTime() - input.deployedAt.getTime() < OBSERVATION_MINUTES * 60_000) return "WAIT";
  return "PASS";
}
