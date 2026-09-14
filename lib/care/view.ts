import { CARE_SLA, CARE_TERMINAL_STATUSES, CARE_WAITING_STATUSES, type CareStatus, type CareView } from "@/lib/constants/care";

/**
 * Luật thuần (không đụng CSDL) để cả máy chủ lẫn trình duyệt tính CÙNG một kết quả: kiện thuộc góc
 * nhìn nào, SLA còn hay đã vỡ. Client vá dòng sau mỗi hành động bằng đúng luật này — không cần tải lại.
 */
export type CareStateLike = { status: CareStatus; followUpAt: Date | null; doneAt: Date | null; firstResponseAt: Date | null };

export type CareSla = {
  firstResponseDueAt: Date;
  resolveDueAt: Date;
  firstResponseBreached: boolean;
  resolveBreached: boolean;
};

/**
 * Ngưỡng SLA đang hiệu lực. Mặc định lấy từ `CARE_SLA`; máy chủ đọc phần ghi đè của chủ shop qua
 * sổ hạn xử lý (`lib/care/sla.ts` → `getWorkConfig()`, luật 22) rồi truyền xuống — hàm thuần ở đây
 * không đọc CSDL nên trình duyệt và máy chủ vẫn tính cùng một kết quả trên cùng một bộ số.
 */
export type CareSlaHours = { firstResponseHours: number; resolveHours: number };
export const DEFAULT_CARE_SLA_HOURS: CareSlaHours = { firstResponseHours: CARE_SLA.firstResponseHours, resolveHours: CARE_SLA.resolveHours };

/**
 * Góc nhìn của một kiện đang trong điều kiện cần care:
 *  · NEW / ASSIGNED / IN_PROGRESS      → Cần care
 *  · WAITING_*                          → Đang chờ kết quả; tới hạn theo dõi thì về Cần care.
 *                                          KHÔNG có giờ hẹn = đã tới hạn: một cái hẹn không có giờ
 *                                          không phải một cái hẹn (đo 13/09/2026: 16 ca chờ với
 *                                          follow_up_at NULL biến mất khỏi Cần care vĩnh viễn)
 *  · ESCALATED                          → Escalated
 *  · RESOLVED / CANCELLED               → Đã xử lý; nhưng nếu kiện VÀO LẠI điều kiện cần care sau khi
 *                                          đóng (giao hụt mới) thì là "mở lại" và về Cần care
 */
export function careViewOf(care: CareStateLike, queueSince: Date, now = new Date()): { view: Exclude<CareView, "all">; reopened: boolean } {
  if (CARE_WAITING_STATUSES.includes(care.status)) {
    return { view: care.followUpAt === null || care.followUpAt.getTime() <= now.getTime() ? "care" : "waiting", reopened: false };
  }
  if (care.status === "ESCALATED") return { view: "escalated", reopened: false };
  if (CARE_TERMINAL_STATUSES.includes(care.status)) {
    const reopened = care.doneAt !== null && queueSince.getTime() > care.doneAt.getTime();
    return { view: reopened ? "care" : "done", reopened };
  }
  return { view: "care", reopened: false };
}

export function slaOf(queueSince: Date, care: CareStateLike, now = new Date(), hours: CareSlaHours = DEFAULT_CARE_SLA_HOURS): CareSla {
  const firstResponseDueAt = new Date(queueSince.getTime() + hours.firstResponseHours * 3600_000);
  const resolveDueAt = new Date(queueSince.getTime() + hours.resolveHours * 3600_000);
  const responded = care.firstResponseAt !== null && care.firstResponseAt.getTime() >= queueSince.getTime();
  const closed = CARE_TERMINAL_STATUSES.includes(care.status) || care.status === "ESCALATED";
  // Đang CHỜ với một cái hẹn CÒN Ở PHÍA TRƯỚC: đội đã làm phần mình, đồng hồ đóng ca tạm dừng.
  // Hẹn đã qua (hoặc không có giờ hẹn) thì đồng hồ chạy tiếp.
  const paused = CARE_WAITING_STATUSES.includes(care.status) && care.followUpAt !== null && care.followUpAt.getTime() > now.getTime();
  return {
    firstResponseDueAt,
    resolveDueAt,
    firstResponseBreached: !responded && now.getTime() > firstResponseDueAt.getTime(),
    resolveBreached: !closed && !paused && now.getTime() > resolveDueAt.getTime(),
  };
}
