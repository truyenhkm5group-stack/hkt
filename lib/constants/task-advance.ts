import { TECH_TASK_TRANSITIONS, type TechTaskStatus } from "@/lib/constants/tech";

/**
 * ═══════════ NẤC 4 · ĐẨY TRẠNG THÁI VIỆC THEO BẰNG CHỨNG GITHUB — HÀM THUẦN ═══════════
 *
 * Tới Nấc 3b, phép chiếu PR đã chép `pr_state` · `ci_state` · `review_state` · `merge_state` về
 * `tech_tasks`. Nhưng TRẠNG THÁI VIỆC vẫn chỉ nhúc nhích khi có người bấm — nên hàng đợi `/tech`
 * đo TRÍ NHỚ của người bấm, không đo việc thật sự đang ở đâu.
 *
 * ─── MÁY CHỈ ĐI NHỮNG BƯỚC BẰNG CHỨNG NÓI RA DỨT KHOÁT ───
 *
 * Cám dỗ là để máy đi hết vòng đời. Không: phần lớn các bước còn lại là QUYẾT ĐỊNH, không phải
 * quan sát.
 *
 *   TRIAGED / SPEC_READY → BUILDING   khi việc ĐÃ CÓ một PR — "có người/agent bắt tay vào" là một
 *                                     sự kiện quan sát được, không phải một phán đoán.
 *   BUILDING → REVIEW                 khi đã có PR — "đã có thứ để người xem".
 *   REVIEW  → QA                      khi PR ĐÃ GỘP — ruleset đòi 1 duyệt và cổng `gates` xanh,
 *                                     nên gộp được nghĩa là cả hai điều kiện ấy ĐÃ xảy ra.
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
 * ─── VÌ SAO "ĐÃ CÓ PR" LÀ `OPEN` **HOẶC** `MERGED`, KHÔNG CHỈ `OPEN` ───
 *
 * ĐÃ CẮN THẬT, đo production 21/09/2026: TECH-2 nằm ở `TRIAGED` trong khi PR #82 của nó đã được
 * duyệt và ĐÃ GỘP. Bản đầu của bộ này chỉ có hai luật, cả hai cùng đòi `prState === "OPEN"` ở
 * khúc đầu — nên một việc không được đẩy đúng lúc PR còn mở thì MẮC KẸT VĨNH VIỄN: cửa sổ quan
 * sát đã đóng, và không luật nào còn khớp.
 *
 * Một bộ tự động chỉ đúng khi nó chạy đúng nhịp là một bộ tự động sẽ sai — nó không chịu được một
 * lần mất điện, một lần đổi lịch, hay một lượt chạy khởi động từ chỗ khác. Bằng chứng "việc này
 * đã có PR" KHÔNG hết hạn khi PR gộp; nó chỉ mạnh thêm.
 *
 * ─── MÁY KHÔNG CÃI NGƯỜI — NHƯNG CHỈ Ở ĐÚNG BƯỚC NGƯỜI ĐÃ LẬT ───
 *
 * Bản đầu hỏi một câu quá rộng: *"lượt đổi trạng thái gần nhất có phải của NGƯỜI không?"* Nếu có
 * thì máy im lặng, vĩnh viễn.
 *
 * ĐÃ ĐO THẬT trên production 22/09/2026 — và hậu quả lớn hơn nhiều so với ý định:
 *
 *     BRANCH | SYSTEM | mubjc3n2 → mubycq1x | 22/09 00:58
 *     …
 *     STATUS | HUMAN  | NEW → TRIAGED       | 21/09 15:10   ← lượt đổi gần nhất
 *
 * TECH-3 có PR #94 đang MỞ, phép chiếu đã ghép đúng, bộ đẩy chạy đều 5–10 phút một lần và luôn
 * SUCCESS. Nó vẫn đứng yên, vì lượt đổi trạng thái gần nhất là của người — xảy ra **10 tiếng
 * trước khi PR tồn tại**.
 *
 * Và đây không phải một ca lẻ. **Mọi việc thật đều bắt đầu bằng người kéo `NEW → TRIAGED`**, còn
 * máy thì không bao giờ tự đặt `TRIAGED` (nó nằm trong `TASK_ADVANCE_NEVER`). Nên lượt đổi gần
 * nhất của mọi việc thật LUÔN là của người, và cả Nấc 4 chưa từng nổ được một lần nào.
 *
 * ─── CÂU HỎI HẸP HƠN, GIỮ NGUYÊN THỨ CẦN GIỮ ───
 *
 * Thứ luật cũ sinh ra để chặn là PING-PONG: người kéo `REVIEW → BUILDING` vì họ biết điều máy
 * không biết, rồi máy đẩy lại `BUILDING → REVIEW` sau mười phút — và lần thứ hai họ tắt hẳn bộ
 * này đi.
 *
 * Nên câu hỏi đúng không phải "người có vừa đổi không", mà **"người có vừa LẬT NGƯỢC đúng bước
 * máy đang định đi không"**:
 *
 *     người `REVIEW → BUILDING`, máy muốn `BUILDING → REVIEW`   ⇒ NHƯỜNG (đúng bước bị lật)
 *     người `NEW → TRIAGED`,     máy muốn `TRIAGED → BUILDING`  ⇒ ĐI TIẾP (chưa ai phản đối)
 *
 * Cùng hình dạng với luật mục 59 của care: không chặn theo "có người động vào", mà chặn theo
 * ĐÚNG cái sự kiện chứng minh người đã phản đối.
 *
 * Nếu lượt đổi trạng thái GẦN NHẤT là do NGƯỜI làm, máy KHÔNG đẩy tiếp. Không có luật này thì một
 * người kéo việc từ `REVIEW` về `BUILDING` (vì họ biết điều gì đó máy không biết) sẽ thấy nó tự
 * nhảy lại sau mười phút — và lần thứ hai họ sẽ tắt hẳn bộ này đi.
 */

/**
 * Việc này ĐÃ CÓ một PR chưa.
 *
 * `OPEN` và `MERGED` đều trả lời CÓ. `CLOSED` (đóng mà không gộp) KHÔNG: một PR bị đóng bỏ là bằng
 * chứng rằng thứ đã làm không được dùng, và đẩy việc đi tiếp theo nó là đi tới bằng một cái đã bỏ.
 */
const daCoPr = (pr: TaskPrState) => pr.prState === "OPEN" || pr.prState === "MERGED";

export const TASK_ADVANCE_RULES = [
  {
    from: "TRIAGED" as TechTaskStatus,
    to: "BUILDING" as TechTaskStatus,
    khi: daCoPr,
    viSao: (pr: TaskPrState) => `PR #${pr.prNumber ?? "?"} đang ${pr.prState} — đã có người/agent bắt tay vào việc này.`,
  },
  {
    from: "SPEC_READY" as TechTaskStatus,
    to: "BUILDING" as TechTaskStatus,
    khi: daCoPr,
    viSao: (pr: TaskPrState) => `PR #${pr.prNumber ?? "?"} đang ${pr.prState} — đã có người/agent bắt tay vào việc này.`,
  },
  {
    from: "BUILDING" as TechTaskStatus,
    to: "REVIEW" as TechTaskStatus,
    /** Đã có PR cho việc này. */
    khi: daCoPr,
    viSao: (pr: TaskPrState) => `PR #${pr.prNumber ?? "?"} đang ${pr.prState} — đã có thứ để người xem.`,
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
 *
 * Mỗi lượt chỉ đi MỘT bước, cố ý: từng bước để lại một dòng sự kiện đọc được, và một việc nhảy ba
 * bậc trong một lượt thì không ai đọc lại được nó đã đi qua đâu.
 */
/** Lượt đổi trạng thái GẦN NHẤT do NGƯỜI làm — `null` nghĩa là chưa người nào từng đổi. */
export type LuotNguoiDoi = { tu: string; sang: string } | null;

/**
 * Người có vừa LẬT NGƯỢC đúng bước máy đang định đi không — HÀM THUẦN.
 *
 * Lật ngược = người đi từ ĐÍCH của máy về ĐÚNG trạng thái hiện tại. Đó là bằng chứng duy nhất
 * cho thấy họ đã nhìn thấy bước ấy và không muốn nó.
 */
export function nguoiDaLatNguoc(luot: LuotNguoiDoi, tu: string, den: string): boolean {
  return luot !== null && luot.tu === den && luot.sang === tu;
}

export function shouldAdvanceTask(input: { status: string; pr: TaskPrState; nguoiDoi: LuotNguoiDoi }): AdvanceVerdict {
  const tuTrangThai = TASK_ADVANCE_RULES.filter((r) => r.from === input.status);
  if (!tuTrangThai.length) return { advance: false, reason: `Trạng thái ${input.status} không có luật đẩy tự động.` };
  const luat = tuTrangThai.find((r) => r.khi(input.pr));
  if (!luat) {
    const dich = tuTrangThai.map((r) => r.to).join(" · ");
    return { advance: false, reason: `Chưa đủ bằng chứng để đi từ ${input.status} sang ${dich} (PR đang ${input.pr.prState || "CHƯA BIẾT"}).` };
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
  /*
    NHƯỜNG NGƯỜI — nhưng chỉ ở ĐÚNG bước họ đã lật. Xem khối docblock bên trên: hỏi rộng hơn thế
    thì bộ đẩy tê liệt với mọi việc thật.
  */
  if (nguoiDaLatNguoc(input.nguoiDoi, luat.from, luat.to)) {
    return { advance: false, reason: `NGƯỜI vừa kéo ${luat.to} về ${luat.from} — máy không đẩy lại đúng bước họ đã lật.` };
  }
  return { advance: true, to: luat.to, reason: luat.viSao(input.pr) };
}

/** Trạng thái máy KHÔNG BAO GIỜ tự đặt — khai tường minh để bài kiểm khoá được. */
export const TASK_ADVANCE_NEVER: readonly TechTaskStatus[] = ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING", "DONE", "FAILED", "BLOCKED", "ROLLED_BACK", "NEW", "TRIAGED", "SPEC_READY"];
