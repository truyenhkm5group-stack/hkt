import { CARE_SLA, type CareStatus, type CareView } from "@/lib/constants/care";

/**
 * Luật thuần (không đụng CSDL) để cả máy chủ lẫn trình duyệt tính CÙNG một kết quả: kiện thuộc góc
 * nhìn nào, SLA còn hay đã vỡ. Client vá dòng sau mỗi hành động bằng đúng luật này — không cần tải lại.
 */
export type CareStateLike = { status: CareStatus; followUpAt: Date | null; doneAt: Date | null; firstResponseAt: Date | null };

export function careViewOf(care: CareStateLike, queueSince: Date, now = new Date()): { view: Exclude<CareView, "all">; reopened: boolean } {
  switch (care.status) {
    case "WAITING":
      return { view: care.followUpAt && care.followUpAt.getTime() <= now.getTime() ? "care" : "waiting", reopened: false };
    case "ESCALATED":
      return { view: "escalated", reopened: false };
    case "DONE": {
      const reopened = care.doneAt !== null && queueSince.getTime() > care.doneAt.getTime();
      return { view: reopened ? "care" : "done", reopened };
    }
    default:
      return { view: "care", reopened: false };
  }
}

export function slaOf(queueSince: Date, care: CareStateLike, now = new Date()) {
  const firstResponseDueAt = new Date(queueSince.getTime() + CARE_SLA.firstResponseHours * 3600_000);
  const resolveDueAt = new Date(queueSince.getTime() + CARE_SLA.resolveHours * 3600_000);
  const responded = care.firstResponseAt !== null && care.firstResponseAt.getTime() >= queueSince.getTime();
  const closed = care.status === "DONE" || care.status === "ESCALATED";
  return {
    firstResponseDueAt,
    resolveDueAt,
    firstResponseBreached: !responded && now.getTime() > firstResponseDueAt.getTime(),
    resolveBreached: !closed && now.getTime() > resolveDueAt.getTime(),
  };
}
