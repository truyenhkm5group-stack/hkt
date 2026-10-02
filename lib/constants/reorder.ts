/**
 * ═══════════ NHẮC MUA LẠI — HÀM THUẦN, client-safe (docs/verticals/reorder-reminders.md) ═══════════
 *
 * Khách mua theo nhịp (hải sản cho quán ăn, mỹ phẩm, dịch vụ định kỳ…). Người bán cần biết AI sắp tới lúc mua lại để gọi
 * TRƯỚC khi khách mua chỗ khác. Không có bảng "đến hạn": tình trạng là hàm của lịch sử đơn + chu kỳ + hôm nay.
 *
 * CHU KỲ — hai nguồn, theo thứ tự:
 *  1. CỦA CHÍNH KHÁCH: trung vị khoảng cách giữa các NGÀY có đơn (≥ 2 ngày mua) — số đo thật.
 *  2. MẶC ĐỊNH CỦA TỔ CHỨC: chủ shop khai (`crm.reorder` → `defaultCycleDays`). KHÔNG có số mặc định trong mã (luật 38):
 *     chưa khai thì khách mới mua một lần là CHƯA BIẾT, không bị xếp "đến hạn" theo một con số đoán.
 */

export const REORDER_SETTING_KEY = "crm.reorder";
export type ReorderSetting = { defaultCycleDays: number | null; dueSoonDays: number };
/** Cửa sổ "sắp đến hạn" khi chưa khai — một lựa chọn HIỂN THỊ (bao nhiêu ngày trước hạn thì đưa vào danh sách gọi). */
export const REORDER_DUE_SOON_FALLBACK = 3;
export const REORDER_CYCLE_MAX = 365;

export function parseReorderSetting(raw: unknown): ReorderSetting {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const cycle = typeof v.defaultCycleDays === "number" && Number.isInteger(v.defaultCycleDays) && v.defaultCycleDays >= 1 && v.defaultCycleDays <= REORDER_CYCLE_MAX ? v.defaultCycleDays : null;
  const soon = typeof v.dueSoonDays === "number" && Number.isInteger(v.dueSoonDays) && v.dueSoonDays >= 0 && v.dueSoonDays <= 30 ? v.dueSoonDays : REORDER_DUE_SOON_FALLBACK;
  return { defaultCycleDays: cycle, dueSoonDays: soon };
}

export const TOUCH_KINDS = ["CALL", "MESSAGE", "VISIT", "OTHER"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];
export const TOUCH_KIND_LABEL: Record<TouchKind, string> = { CALL: "Gọi điện", MESSAGE: "Nhắn tin", VISIT: "Gặp trực tiếp", OTHER: "Khác" };

export const TOUCH_OUTCOMES = ["WILL_ORDER", "NOT_NOW", "NO_ANSWER", "DECLINED", "OTHER"] as const;
export type TouchOutcome = (typeof TOUCH_OUTCOMES)[number];
export const TOUCH_OUTCOME_LABEL: Record<TouchOutcome, string> = { WILL_ORDER: "Sẽ đặt", NOT_NOW: "Chưa cần", NO_ANSWER: "Không nghe / chưa trả lời", DECLINED: "Không mua nữa", OTHER: "Khác" };

export type ReorderStatus = "UNKNOWN" | "NOT_DUE" | "DUE_SOON" | "DUE" | "SNOOZED" | "DECLINED";
export const REORDER_STATUS_LABEL: Record<ReorderStatus, string> = {
  UNKNOWN: "Chưa biết chu kỳ",
  NOT_DUE: "Chưa tới hạn",
  DUE_SOON: "Sắp tới hạn",
  DUE: "Đến hạn mua lại",
  SNOOZED: "Đã hẹn liên hệ lại",
  DECLINED: "Khách báo không mua nữa",
};

function toUtc(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
function plusDays(d: string, n: number): string {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Trung vị khoảng cách (ngày) giữa các ngày mua khác nhau. Dưới 2 ngày mua ⇒ `null` (chưa đo được). */
export function medianGapDays(orderDays: readonly string[]): number | null {
  const days = [...new Set(orderDays)].sort();
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

export type LastTouch = { on: string; outcome: TouchOutcome; nextContactOn: string | null };

export type ReorderState = {
  status: ReorderStatus;
  lastOrderOn: string | null;
  orderDays: number;
  cycleDays: number | null;
  cycleSource: "OWN" | "DEFAULT" | null;
  /** Ngày dự kiến mua lại = đơn gần nhất + chu kỳ. */
  expectedOn: string | null;
  /** expectedOn − hôm nay (âm = đã quá hạn bấy nhiêu ngày). */
  daysUntil: number | null;
};

/**
 * Tình trạng mua lại của MỘT khách. Lượt liên hệ gần nhất chỉ được hoãn khách khỏi danh sách gọi khi nó NÓI RÕ: hẹn liên hệ
 * lại vào một ngày tương lai (`SNOOZED`), hoặc khách báo không mua nữa SAU đơn gần nhất (`DECLINED`) — đặt đơn mới là tự
 * mở lại. Một cuộc gọi không ai nghe KHÔNG giấu khách đi.
 */
export function reorderState(input: { orderDays: readonly string[]; today: string; setting: ReorderSetting; lastTouch: LastTouch | null }): ReorderState {
  const days = [...new Set(input.orderDays)].sort();
  const lastOrderOn = days.at(-1) ?? null;
  const own = medianGapDays(days);
  const cycleDays = own ?? input.setting.defaultCycleDays;
  const cycleSource = own !== null ? "OWN" : input.setting.defaultCycleDays !== null ? "DEFAULT" : null;
  const base = { lastOrderOn, orderDays: days.length, cycleDays, cycleSource } as const;
  if (!lastOrderOn || cycleDays === null) return { ...base, status: "UNKNOWN", expectedOn: null, daysUntil: null };
  const expectedOn = plusDays(lastOrderOn, cycleDays);
  const daysUntil = daysBetween(input.today, expectedOn);
  const t = input.lastTouch;
  if (t && t.outcome === "DECLINED" && t.on >= lastOrderOn) return { ...base, status: "DECLINED", expectedOn, daysUntil };
  if (t && t.nextContactOn && t.nextContactOn > input.today && t.on >= lastOrderOn) return { ...base, status: "SNOOZED", expectedOn, daysUntil };
  const status: ReorderStatus = daysUntil <= 0 ? "DUE" : daysUntil <= input.setting.dueSoonDays ? "DUE_SOON" : "NOT_DUE";
  return { ...base, status, expectedOn, daysUntil };
}
