/**
 * MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN — HẠN XỬ LÝ, KHAI ĐƯỢC.
 *
 * ═══ KHOẢNG TRỐNG NÀY LÀ GÌ ═══
 *
 * `sales_conversations.human_takeover_at` có HAI nơi ghi, nói hai điều ngược nhau: nhân viên bấm
 * "tự nhận việc" (có `takeover_by_user_id`), và CHÍNH MÁY gọi `conversation.handoff` khi nó không
 * trả lời được (không có khoá người). Vế thứ hai mới là việc cần người nhất.
 *
 * Đo 18/09/2026: **24 lần máy xin người vào, 0 lần có người nhận.** Màn hình trợ lý đã hiện chúng
 * lên (cờ `machineHandoff`) — nhưng chỉ là một cái nhãn: không có hạn xử lý, không già đi, không
 * chiếu vào hàng đợi việc nào. Một việc không có đồng hồ là một việc không ai thấy mình muộn.
 *
 * ═══ VÌ SAO ĐÂY LÀ MỘT BÁO CÁO, KHÔNG PHẢI MỘT NGUỒN VIỆC ═══
 *
 * Kho mã đã có hai bộ máy dò việc sót ở CÙNG ĐỘ MỊN MỘT HỘI THOẠI (`getSalesLeakageQueue`,
 * `copilotQueue`). Khai thêm một NGUỒN VIỆC ở đúng độ mịn ấy là mời cộng hai lần ở mọi tổng hợp —
 * đúng điều luật 19 cấm, và `ALERT_KINDS_OWNED_ELSEWHERE` không đỡ được vì đây không phải một
 * "alert kind".
 *
 * Nên tệp này cố ý DỪNG ở mức báo cáo: nó đếm, nó xếp hạng theo tuổi, nó nói cái nào quá hạn. Nó
 * KHÔNG tạo dòng việc, KHÔNG tự giao ai, KHÔNG gửi gì cho khách, và KHÔNG gọi mô hình.
 *
 * ═══ NGƯỠNG KHÔNG CÓ MẶC ĐỊNH NGHIỆP VỤ ═══
 *
 * "Bao nhiêu phút thì muộn" là quyết định của chủ shop, không phải của người viết mã. Ghi cứng
 * một con số ở đây là lặng lẽ thay chủ shop quyết một chính sách vận hành — và con số ấy sẽ sống
 * mãi vì không ai biết nó từ đâu ra.
 */

/** Khoá cấu hình trong bảng `settings`. */
export const MACHINE_HANDOFF_SLA_KEY = "work.machineHandoffSlaMinutes";

/**
 * CHƯA KHAI ⇒ `null`, và khi ấy cột "quá hạn" phải in CHƯA BIẾT chứ không phải "không quá hạn".
 *
 * Đây là chỗ dễ sai nhất: mặc định 0 làm mọi việc quá hạn ngay lập tức, mặc định vô cùng làm
 * không việc nào quá hạn bao giờ. Cả hai đều là một chính sách được quyết lặng lẽ.
 */
export type MachineHandoffSla = number | null;

export function parseSlaMinutes(raw: unknown): MachineHandoffSla {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Ba trạng thái, và `UNKNOWN` là một câu trả lời thật chứ không phải chỗ trống. */
export const HANDOFF_SLA_STATES = ["OK", "OVERDUE", "UNKNOWN"] as const;
export type HandoffSlaState = (typeof HANDOFF_SLA_STATES)[number];

export const HANDOFF_SLA_LABEL: Record<HandoffSlaState, string> = {
  OK: "Trong hạn",
  OVERDUE: "Quá hạn",
  UNKNOWN: "Chưa khai hạn xử lý",
};

/**
 * Quá hạn chưa — HÀM THUẦN, tính LÚC ĐỌC.
 *
 * Không ghi một cờ "quá hạn" vào CSDL: cờ ấy đúng lúc ghi rồi sai dần theo từng phút, còn phép so
 * này đúng tới từng giây mà không tốn một dòng nào. Cùng cách luật 26 xử lý leo thang hạn xử lý.
 */
export function slaStateOf(ageMinutes: number | null, sla: MachineHandoffSla): HandoffSlaState {
  if (sla === null || ageMinutes === null) return "UNKNOWN";
  return ageMinutes > sla ? "OVERDUE" : "OK";
}

/**
 * ═══════════ VÒNG ĐỜI MỘT VIỆC CHUYỂN NGƯỜI ═══════════
 *
 * Ba mức, và chúng đọc từ BA chỗ khác nhau — không mức nào suy ra được từ mức kia:
 *
 *   `UNCLAIMED` — có mốc xin (`human_takeover_at`), KHÔNG có khoá người.
 *   `CLAIMED`   — có khoá người (`takeover_by_user_id`). Lúc nhận nằm ở `takeover_claimed_at`.
 *   `RESOLVED`  — người đã TRẢ VIỆC VỀ MÁY. Trả việc XOÁ cả ba cột trên, nên trạng thái này KHÔNG
 *                 đọc được từ bảng hội thoại: nó chỉ còn ở nhật ký thao tác (`RELEASE`).
 *
 * Vì sao tách `takeover_claimed_at` khỏi `human_takeover_at`: cột thứ nhất trả lời "một con người
 * cầm việc lúc nào", cột thứ hai trả lời "khách bắt đầu chờ lúc nào". Dùng một cột cho cả hai thì
 * mỗi lượt nhận việc xoá sạch thời gian chờ ra khỏi mọi phép đo — đúng con số cần nhất.
 */
export const HANDOFF_LIFECYCLE = ["UNCLAIMED", "CLAIMED", "RESOLVED"] as const;
export type HandoffLifecycle = (typeof HANDOFF_LIFECYCLE)[number];

export const HANDOFF_LIFECYCLE_LABEL: Record<HandoffLifecycle, string> = {
  UNCLAIMED: "Chưa ai nhận",
  CLAIMED: "Đã có người cầm",
  RESOLVED: "Đã trả việc về máy",
};

/** Hai cột quyết định vòng đời của một hội thoại đang mở. HÀM THUẦN. */
export function openHandoffLifecycle(row: { handoffAt: Date | null; ownerUserId: string | null }): HandoffLifecycle | null {
  if (row.ownerUserId) return "CLAIMED";
  return row.handoffAt ? "UNCLAIMED" : null;
}

/**
 * ═══════════ NHẬN VIỆC: QUYẾT ĐỊNH, TÁCH KHỎI PHÉP GHI ═══════════
 *
 * HÀM THUẦN — không đọc CSDL, không ghi gì. Server action gọi nó rồi mới ghi.
 *
 * VÌ SAO TÁCH RA: nhánh này đã sai một lần theo đúng kiểu không bài kiểm nào bắt được nếu nó còn
 * nằm lẫn trong một server action. Bản trước gác bằng `humanTakeoverAt` — cột mà CHÍNH MÁY cũng
 * ghi khi nó xin người vào. Với một việc máy chuyển sang, cột ấy đã có giá trị, nhánh ghi bị bỏ
 * qua, `takeover_by_user_id` không bao giờ được ghi, và hội thoại ở lại "chưa ai nhận" VĨNH VIỄN
 * dù vừa có người bấm. Đo 19/09/2026: 202 việc máy xin người vào, 0 việc có chủ.
 *
 * Gác bằng KHOÁ NGƯỜI, không gác bằng mốc thời gian: "đã có chủ chưa" và "đã được đánh dấu chưa"
 * là hai câu hỏi khác nhau, và chỉ câu thứ nhất mới trả lời được "ai chịu trách nhiệm".
 */
export type TakeoverPlan =
  | {
      kind: "CLAIM";
      /** GIỮ mốc cũ nếu máy đã xin từ trước — đó là lúc khách BẮT ĐẦU CHỜ. */
      humanTakeoverAt: Date;
      takeoverClaimedAt: Date;
      /** GIỮ lý do máy đã khai: đè lên nó là xoá mất VÌ SAO máy phải gọi người. */
      takeoverReason: string;
    }
  | { kind: "ALREADY_MINE" }
  | { kind: "TAKEN_BY_OTHER"; ownerUserId: string };

export const TAKEOVER_SELF_REASON = "Nhân viên tự nhận việc từ hàng đợi trợ lý";

export function planTakeover(
  conversation: { humanTakeoverAt: Date | null; takeoverByUserId: string | null; takeoverReason: string | null },
  userId: string,
  note: string | undefined,
  now: Date,
): TakeoverPlan {
  const chu = conversation.takeoverByUserId;
  if (chu) return chu === userId ? { kind: "ALREADY_MINE" } : { kind: "TAKEN_BY_OTHER", ownerUserId: chu };
  return {
    kind: "CLAIM",
    humanTakeoverAt: conversation.humanTakeoverAt ?? now,
    takeoverClaimedAt: now,
    takeoverReason: conversation.takeoverReason || note || TAKEOVER_SELF_REASON,
  };
}
