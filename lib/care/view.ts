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
 * Góc nhìn của một kiện đang trong điều kiện cần care:
 *  · NEW / ASSIGNED / IN_PROGRESS      → Cần care
 *  · WAITING_*                          → Đang chờ kết quả; tới hạn theo dõi thì về Cần care
 *  · ESCALATED                          → Escalated
 *  · RESOLVED / CANCELLED               → Đã xử lý; nhưng nếu kiện VÀO LẠI điều kiện cần care sau khi
 *                                          đóng (giao hụt mới) thì là "mở lại" và về Cần care
 */
export function careViewOf(care: CareStateLike, queueSince: Date, now = new Date()): { view: Exclude<CareView, "all">; reopened: boolean } {
  if (CARE_WAITING_STATUSES.includes(care.status)) {
    return { view: care.followUpAt && care.followUpAt.getTime() <= now.getTime() ? "care" : "waiting", reopened: false };
  }
  if (care.status === "ESCALATED") return { view: "escalated", reopened: false };
  if (CARE_TERMINAL_STATUSES.includes(care.status)) {
    const reopened = care.doneAt !== null && queueSince.getTime() > care.doneAt.getTime();
    return { view: reopened ? "care" : "done", reopened };
  }
  return { view: "care", reopened: false };
}

export function slaOf(queueSince: Date, care: CareStateLike, now = new Date()): CareSla {
  const firstResponseDueAt = new Date(queueSince.getTime() + CARE_SLA.firstResponseHours * 3600_000);
  const resolveDueAt = new Date(queueSince.getTime() + CARE_SLA.resolveHours * 3600_000);
  const responded = care.firstResponseAt !== null && care.firstResponseAt.getTime() >= queueSince.getTime();
  const closed = CARE_TERMINAL_STATUSES.includes(care.status) || care.status === "ESCALATED";
  return {
    firstResponseDueAt,
    resolveDueAt,
    firstResponseBreached: !responded && now.getTime() > firstResponseDueAt.getTime(),
    resolveBreached: !closed && now.getTime() > resolveDueAt.getTime(),
  };
}
