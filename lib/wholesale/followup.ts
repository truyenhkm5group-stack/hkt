/**
 * HẸN GỌI LẠI — lựa chọn một chạm dùng chung cho màn điện thoại (/wholesale/mobile) và hộp «Ghi kết quả» trên danh sách lead.
 * Tệp THUẦN, client-safe. Mốc tính theo giờ Việt Nam (không theo múi giờ của máy người bấm).
 */

export const FOLLOW_OPTIONS = [
  { key: "none", label: "Không hẹn" },
  { key: "pm", label: "Chiều nay" },
  { key: "d1", label: "Mai" },
  { key: "d2", label: "2 ngày" },
  { key: "d3", label: "3 ngày" },
  { key: "d7", label: "1 tuần" },
  { key: "custom", label: "Chọn ngày" },
] as const;
export type FollowKey = (typeof FOLLOW_OPTIONS)[number]["key"];

/** Mốc theo giờ Việt Nam: `days` ngày nữa lúc `hour` giờ. */
function vnAt(now: number, days: number, hour: number): string {
  const vn = new Date(now + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + days, hour - 7, 0, 0)).toISOString();
}

/** Lựa chọn ⇒ mốc ISO (`null` = không hẹn). `custom` là ngày `YYYY-MM-DD`, hẹn 9 giờ sáng giờ VN. */
export function followIso(k: FollowKey, custom: string, now = Date.now()): string | null {
  if (k === "pm") return vnAt(now, 0, 15);
  if (k === "d1") return vnAt(now, 1, 9);
  if (k === "d2") return vnAt(now, 2, 9);
  if (k === "d3") return vnAt(now, 3, 9);
  if (k === "d7") return vnAt(now, 7, 9);
  if (k === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(custom)) return new Date(`${custom}T09:00:00+07:00`).toISOString();
  return null;
}

/** Số ngày gợi ý của một kết quả cuộc gọi (`callOutcomeEffect().followupDays`) ⇒ lựa chọn chọn sẵn. */
export function suggestedFollow(days: number | null): FollowKey {
  return days == null ? "none" : days <= 1 ? "d1" : days === 2 ? "d2" : days <= 3 ? "d3" : "d7";
}
