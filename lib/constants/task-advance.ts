import { TECH_TASK_TRANSITIONS, type TechTaskStatus } from "@/lib/constants/tech";

/**
 * ═══════════ NẤC 4 · ĐẨY TRẠNG THÁI VIỆC THEO BẰNG CHỨNG GITHUB — HÀM THUẦN ═══════════
 *
 * Tới Nấc 3b, phép chiếu PR đã chép `pr_state` · `ci_state` · `review_state` · `merge_state` về
 * `tech_tasks`. Nhưng TRẠNG THÁI VIỆC vẫn chỉ nhúc nhích khi có người bấm — nên hàng đợi `/tech`
 * đo TRÍ NHỚ của người bấm, không đo việc thật sự đang ở đâu.
 *
 * ─── HAI BƯỚC, VÀ CHỈ HAI ───
 *
 * Cám dỗ là để máy đi hết vòng đời. Không: phần lớn các bước còn lại là QUYẾT ĐỊNH, không phải
 * quan sát. Máy chỉ đi những bước mà bằng chứng GitHub nói ra dứt khoát:
 *
 *   BUILDING → REVIEW   khi có PR đang MỞ cho việc ấy — "đã có thứ để người xem" là một SỰ KIỆN,
 *                       không phải một phán đoán.
 *   REVIEW  → QA        khi PR ĐÃ GỘP — ruleset đòi 1 duyệt và cổng `gates` xanh, nên gộp được
 *                       nghĩa là cả hai điều kiện ấy ĐÃ xảy ra. Không phải máy tự kết luận.
 *
 * NHỮNG BƯỚC MÁY KHÔNG BAO GIỜ ĐI, và lý do từng bước:
 *
 *   · `READY_TO_DEPLOY` — "sẵn sàng deploy" là một quyết định về THỜI ĐIỂM, thuộc về người.
 *   · `DEPLOYING` / `OBSERVING` — đi theo lượt deploy thật, sổ khác đo (`tech_deployments`).
 *   · `DONE` — kho này đòi BẰNG CHỨNG production trước khi đóng việc. Máy không có bằng chứng ấy,
 *     nên nếu nó tự đóng thì nó phải bịa (cùng luật với sổ sự cố).
 *   · `FAILED` / `BLOCKED` — cả hai là lời QUY KẾT. CI đỏ giữa chừng là chuyện bình thường của
 *     một PR đang làm; gọi nó là "việc hỏng" thì mọi việc đều hỏng vài lần trước khi xong.
 *
 * ─── MÁY KHÔNG CÃI NGƯỜI ───
 *
 * Nếu lượt đổi trạng thái GẦN NHẤT là do NGƯỜI làm, máy KHÔNG đẩy tiếp. Không có luật này thì một
 * người kéo việc từ `REVIEW` về `BUILDING` (vì họ biết điều gì đó máy không biết) sẽ thấy nó tự
 * nhảy lại sau mười phút — và lần thứ hai họ sẽ tắt hẳn bộ này đi.
 */

export const TASK_ADVANCE_RULES = [
  {
    from: "BUILDING" as TechTaskStatus,
    to: "REVIEW" as TechTaskStatus,
    /** PR đang MỞ cho việc này. */
    khi: (pr: TaskPrState) => pr.prState === "OPEN",
    viSao: (pr: TaskPrState) => `PR #${pr.prNumber ?? "?"} đang MỞ — đã có thứ để người xem.`,
  },
  {
    from: "REVIEW" as TechTaskStatus,
    to: "QA" as TechTaskStatus,
    /** PR ĐÃ GỘP: ruleset đòi 1 duyệt + cổng `gates` xanh, nên gộp được nghĩa là cả hai đã xảy ra. */
    khi: (pr: TaskPrState) => pr.prState === "MERGED",
    viSao: (pr: TaskPrState) => `PR #${pr.prNumber ?? "?"} ĐÃ GỘP — ruleset đòi 1 duyệt và cổng gates xanh trước khi gộp.`,
  },
] as const;

export type TaskPrState = {
  prNumber: number | null;
  prState: string;
  ciState: string;
  reviewState: string;
  mergeState: string;
};

export type AdvanceVerdict =
  | { advance: false; reason: string }
  | { advance: true; to: TechTaskStatus; reason: string };

/**
 * Việc này có nên được đẩy tiếp không — HÀM THUẦN.
 *
 * `nguoiVuaDoi` = lượt đổi trạng thái gần nhất do NGƯỜI làm. Xem khối "máy không cãi người".
 */
export function shouldAdvanceTask(input: { status: string; pr: TaskPrState; nguoiVuaDoi: boolean }): AdvanceVerdict {
  if (input.nguoiVuaDoi) {
    return { advance: false, reason: "Lượt đổi trạng thái gần nhất là do NGƯỜI — máy không đẩy tiếp." };
  }
  const luat = TASK_ADVANCE_RULES.find((r) => r.from === input.status);
  if (!luat) return { advance: false, reason: `Trạng thái ${input.status} không có luật đẩy tự động.` };
  if (!luat.khi(input.pr)) {
    return { advance: false, reason: `Chưa đủ bằng chứng để đi từ ${luat.from} sang ${luat.to} (PR đang ${input.pr.prState || "CHƯA BIẾT"}).` };
  }
  /*
    KIỂM LẠI PHÉP CHUYỂN Ở ĐÂY, dù luật trên đã khai đúng.

    Hai nơi khai cùng một thứ thì chúng sẽ trôi xa nhau; `TECH_TASK_TRANSITIONS` là bảng có thẩm
    quyền, và nếu một ngày ai đó đổi nó thì bộ này phải dừng lại chứ không được đi một nước cờ
    không còn hợp lệ.
  */
  if (!TECH_TASK_TRANSITIONS[luat.from]?.includes(luat.to)) {
    return { advance: false, reason: `${luat.from} → ${luat.to} KHÔNG còn là phép chuyển hợp lệ — luật đẩy tự động đã trôi khỏi TECH_TASK_TRANSITIONS.` };
  }
  return { advance: true, to: luat.to, reason: luat.viSao(input.pr) };
}

/** Trạng thái máy KHÔNG BAO GIỜ tự đặt — khai tường minh để bài kiểm khoá được. */
export const TASK_ADVANCE_NEVER: readonly TechTaskStatus[] = ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING", "DONE", "FAILED", "BLOCKED", "ROLLED_BACK", "NEW", "TRIAGED", "SPEC_READY"];
