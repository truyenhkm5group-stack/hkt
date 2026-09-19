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
