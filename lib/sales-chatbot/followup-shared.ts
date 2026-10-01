/**
 * ═══════════ FOLLOW-UP TỰ ĐỘNG — PHẦN THUẦN (0185) ═══════════
 *
 * Chủ shop 01/10/2026: khách đang ở BẤT KỲ bước nào của quy trình bán (đang tư vấn rồi mất hút · đã cho SĐT nhưng chưa
 * chốt · từ chối upsell rồi chưa xác nhận) mà im lặng ⇒ hội thoại `WAITING`; AI nhắn follow-up theo lịch, DỪNG khi khách
 * nhắn lại / chốt đơn / từ chối rõ ràng / cần người xử lý. Lịch mặc định 1 giờ · 6 giờ · 22 giờ tính từ lúc bắt đầu im lặng.
 *
 * Facebook chỉ cho page nhắn trong 24 GIỜ kể từ tin cuối của khách (ngoài khung là vi phạm chính sách nhắn tin) ⇒ không
 * mốc nào quá 23 giờ, và mỗi lượt gửi kiểm lại khung (`withinMessagingWindow`). Tệp này không đọc CSDL — client import được.
 */

export const FOLLOWUP_SETTING_KEY = "ai.salesChatbot.followup";

/** Khung nhắn của Facebook là 24 giờ; chừa nửa giờ cho trễ hàng đợi / lệch đồng hồ. */
export const MESSAGING_WINDOW_MS = 23.5 * 3_600_000;
export const FOLLOWUP_MAX_STEPS = 3;
/** Mốc muộn nhất (phút) — phải nằm trong khung 24 giờ. */
export const FOLLOWUP_MAX_MINUTES = 23 * 60;

export type FollowupSettings = { enabled: boolean; stepsMinutes: number[] };
export const DEFAULT_FOLLOWUP_SETTINGS: FollowupSettings = { enabled: true, stepsMinutes: [60, 360, 1320] };

/** Lịch hợp lệ: 1–3 mốc, nguyên dương, TĂNG DẦN, không mốc nào quá 23 giờ. Sai ⇒ lỗi tiếng Việt (không sửa hộ). */
export function validateFollowupSteps(raw: unknown): { ok: true; steps: number[] } | { ok: false; error: string } {
  const arr = Array.isArray(raw) ? raw : [];
  const steps = arr.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (steps.length === 0 || steps.length > FOLLOWUP_MAX_STEPS || steps.length !== arr.length) return { ok: false, error: `Lịch follow-up có 1–${FOLLOWUP_MAX_STEPS} mốc (phút).` };
  if (steps.some((s) => !Number.isInteger(s) || s < 5)) return { ok: false, error: "Mỗi mốc là số phút nguyên, ít nhất 5 phút." };
  if (steps.some((s, i) => i > 0 && s <= steps[i - 1])) return { ok: false, error: "Các mốc phải tăng dần." };
  if (steps[steps.length - 1] > FOLLOWUP_MAX_MINUTES) return { ok: false, error: "Facebook chỉ cho nhắn trong 24 giờ kể từ tin cuối của khách — mốc muộn nhất 23 giờ (1380 phút)." };
  return { ok: true, steps };
}

export function parseFollowupSettings(v: unknown): FollowupSettings {
  const o = (v && typeof v === "object" ? v : {}) as { enabled?: unknown; stepsMinutes?: unknown };
  const steps = validateFollowupSteps(o.stepsMinutes);
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_FOLLOWUP_SETTINGS.enabled, stepsMinutes: steps.ok ? steps.steps : [...DEFAULT_FOLLOWUP_SETTINGS.stepsMinutes] };
}

/** Mốc follow-up KẾ TIẾP sau khi đã gửi `sent` lần — `null` khi hết lịch. HÀM THUẦN. */
export function nextFollowupAt(waitingSince: Date, sent: number, steps: readonly number[]): Date | null {
  const m = steps[sent];
  return m === undefined ? null : new Date(waitingSince.getTime() + m * 60_000);
}

/** Còn trong khung 24 giờ của Facebook (tính từ tin cuối của khách)? Không biết tin cuối ⇒ KHÔNG gửi. HÀM THUẦN. */
export function withinMessagingWindow(lastCustomerAt: Date | null, at: Date): boolean {
  return lastCustomerAt !== null && at.getTime() - lastCustomerAt.getTime() < MESSAGING_WINDOW_MS;
}

/** Nhãn cho màn hình: «1 giờ · 6 giờ · 22 giờ». */
export function followupStepsLabel(steps: readonly number[]): string {
  return steps.map((m) => (m % 60 === 0 ? `${m / 60} giờ` : m > 60 ? `${Math.floor(m / 60)} giờ ${m % 60} phút` : `${m} phút`)).join(" · ");
}
