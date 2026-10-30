import { LEAD_STATUS_LABEL, isLeadStatus, type LeadStatus } from "@/lib/wholesale/constants";

/**
 * ═══════════ NHIỆT ĐỘ LEAD (NÓNG / ẤM / NGUỘI) — HÀM THUẦN, ĐỌC RA LÚC XEM (P1a, 27/10/2026) ═══════════
 *
 * Nhiệt độ trả lời "nên ưu tiên lead này NGAY BÂY GIỜ không", khác hạng A–D (lead có HỢP với shop không — `scoring.ts`,
 * không đổi). Nó là hàm của thời gian nên KHÔNG lưu cột: lưu thì một lead "nóng" hôm qua vẫn nằm "nóng" tới khi có job ghi
 * lại, và hai màn hình đọc hai lúc nói hai điều.
 *
 * Luật (ngưỡng ở hằng số có tên bên dưới):
 *  · Đã thành khách (WON) ⇒ KHÔNG ÁP DỤNG (`null`), không phải "nguội".
 *  · KHÔNG LIÊN HỆ / Mất ⇒ NGUỘI.
 *  · Khách ĐÃ PHẢN HỒI (Quan tâm → Đang thương lượng): tương tác gần nhất ≤ `TEMPERATURE_HOT_DAYS` ⇒ NÓNG; ≤
 *    `TEMPERATURE_WARM_DAYS` ⇒ ẤM; lâu hơn ⇒ NGUỘI, trừ khi đã hẹn gọi lại trong tương lai (ẤM). Không có mốc nào ⇒ ẤM kèm câu
 *    "chưa có mốc" — CHƯA BIẾT không được in thành NÓNG, cũng không phải NGUỘI.
 *  · Khách CHƯA phản hồi: không bao giờ NÓNG (máy chưa nghe khách nói gì). Hạng trong `TEMPERATURE_WARM_GRADES` ⇒ ẤM; còn lại
 *    ⇒ NGUỘI. «Không nghe máy» từ `TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS` lần trở lên ⇒ NGUỘI dù hạng cao.
 */

export const LEAD_TEMPERATURES = ["HOT", "WARM", "COLD"] as const;
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number];

export const LEAD_TEMPERATURE_LABEL: Record<LeadTemperature, string> = { HOT: "Nóng", WARM: "Ấm", COLD: "Nguội" };

/** Khách đã phản hồi và có tương tác trong chừng này ngày ⇒ NÓNG. */
export const TEMPERATURE_HOT_DAYS = 7;
/** Khách đã phản hồi và có tương tác trong chừng này ngày ⇒ ẤM; lâu hơn ⇒ NGUỘI. */
export const TEMPERATURE_WARM_DAYS = 30;
/** Số lần liên hệ của lead «Không nghe máy» mà từ đó coi là NGUỘI. */
export const TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS = 3;
/** Hạng mà lead chưa phản hồi vẫn được coi là ẤM. */
export const TEMPERATURE_WARM_GRADES: readonly string[] = ["A", "B"];

/** Trạng thái chứng tỏ khách đã phản hồi mà chưa chốt (WON tách riêng). */
const ENGAGED: readonly LeadStatus[] = ["INTERESTED", "CATALOG_SENT", "PRICE_SENT", "SAMPLE_REQUESTED", "NEGOTIATING"];

type When = Date | string | null | undefined;

export type TemperatureInput = {
  grade: string | null;
  status: string;
  lastContactAt?: When;
  firstResponseAt?: When;
  /** Mốc hoạt động có chữ gần nhất (ghi chú / cuộc gọi) nếu màn hình có. */
  lastActivityAt?: When;
  nextFollowupAt?: When;
  contactAttemptCount?: number | null;
};

export type TemperatureResult = { temperature: LeadTemperature | null; reasons: string[] };

const DAY_MS = 86_400_000;

function toTime(v: When): number | null {
  if (v == null || v === "") return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

export function leadTemperature(lead: TemperatureInput, now: Date = new Date()): TemperatureResult {
  const status: LeadStatus = isLeadStatus(lead.status) ? lead.status : "NEW";
  if (status === "WON") return { temperature: null, reasons: ["Đã thành khách — nhiệt độ không áp dụng."] };
  if (status === "DO_NOT_CONTACT") return { temperature: "COLD", reasons: ["Khách yêu cầu không liên hệ."] };
  if (status === "LOST") return { temperature: "COLD", reasons: ["Lead đã mất."] };

  const nowMs = now.getTime();
  const times = [toTime(lead.lastContactAt), toTime(lead.firstResponseAt), toTime(lead.lastActivityAt)].filter((t): t is number => t != null);
  const last = times.length ? Math.max(...times) : null;
  const ageDays = last != null ? Math.max(0, Math.floor((nowMs - last) / DAY_MS)) : null;

  if (ENGAGED.includes(status)) {
    const reasons = [`Khách đã phản hồi («${LEAD_STATUS_LABEL[status]}»).`];
    const follow = toTime(lead.nextFollowupAt);
    if (ageDays == null) return { temperature: "WARM", reasons: [...reasons, "Chưa có mốc tương tác nào được ghi — không kết luận nóng."] };
    if (ageDays <= TEMPERATURE_HOT_DAYS) return { temperature: "HOT", reasons: [...reasons, `Tương tác gần nhất ${ageDays} ngày trước (≤ ${TEMPERATURE_HOT_DAYS} ngày).`] };
    if (ageDays <= TEMPERATURE_WARM_DAYS) return { temperature: "WARM", reasons: [...reasons, `Tương tác gần nhất ${ageDays} ngày trước (≤ ${TEMPERATURE_WARM_DAYS} ngày).`] };
    if (follow != null && follow > nowMs) return { temperature: "WARM", reasons: [...reasons, `Im ${ageDays} ngày nhưng đã hẹn gọi lại.`] };
    return { temperature: "COLD", reasons: [...reasons, `Im ${ageDays} ngày (> ${TEMPERATURE_WARM_DAYS} ngày) — cần hâm lại.`] };
  }

  const reasons = ["Khách chưa phản hồi."];
  const attempts = lead.contactAttemptCount ?? 0;
  if (status === "NO_ANSWER" && attempts >= TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS) return { temperature: "COLD", reasons: [...reasons, `Không nghe máy sau ${attempts} lần liên hệ (≥ ${TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS}).`] };
  if (lead.grade && TEMPERATURE_WARM_GRADES.includes(lead.grade)) return { temperature: "WARM", reasons: [...reasons, `Hạng ${lead.grade} — hợp với shop, đáng gọi sớm.`] };
  return { temperature: "COLD", reasons: [...reasons, lead.grade ? `Hạng ${lead.grade}.` : "Chưa chấm hạng."] };
}
