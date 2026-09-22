import type { AdsAction } from "@/lib/constants/ads-decision";
import { FLIP_WINDOW_DAYS, dayDiff, stabilityRuleOf } from "@/lib/constants/marketing-decision-ledger";

/**
 * ═══════════ ĐỘ BỀN CỦA MỘT KHUYẾN NGHỊ — HÀM THUẦN ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ, không gọi mô hình. Vào là một danh sách dòng sổ, ra là câu
 * trả lời *"khuyến nghị này đã đủ chín để ai đó (người hay máy) hành động chưa"*.
 *
 * Tách khỏi truy vấn có chủ ý: đây là chỗ DUY NHẤT quyết định một dòng được phép đi tiếp hay không,
 * nên nó phải kiểm thử được bằng vài mảng chữ, không cần dựng CSDL.
 *
 * ─── BỐN CÁCH MỘT KHUYẾN NGHỊ BỊ TỪ CHỐI, VÀ CHÚNG KHÁC NHAU ───
 *
 *   · `STALE`        — sổ chưa ghi tới hôm nay. Job không chạy thì ERP KHÔNG BIẾT, không phải
 *                      "không có gì đổi". Một bộ tự động chỉ đúng khi chạy đúng nhịp là một bộ tự
 *                      động sẽ sai.
 *   · `YOUNG`        — khuyến nghị mới, chưa giữ đủ số ngày.
 *   · `UNSTABLE`     — đổi ý quá nhiều lần: dòng đang ngồi trên ranh giới của một ngưỡng.
 *   · `RULE_CHANGED` — cửa sổ có hơn một phiên bản luật, nên chuỗi không so được với chính nó.
 *
 * Gộp bốn thứ đó thành một chữ "chưa đủ điều kiện" là lấy mất khả năng sửa: ba cái đầu tự khỏi
 * theo thời gian, cái thứ nhất phải đi xem vì sao job không chạy.
 */

export type LedgerPoint = {
  /** Ngày Việt Nam ERP đưa ra kết luận này (`YYYY-MM-DD`). */
  decisionDay: string;
  action: AdsAction;
  ruleVersion: number;
};

export type StabilityBlocker = "STALE" | "YOUNG" | "UNSTABLE" | "RULE_CHANGED" | "NOT_ACTIONABLE";

export type Stability = {
  action: AdsAction;
  /** Số ngày LIÊN TIẾP khuyến nghị giữ nguyên, tính lùi từ dòng mới nhất. Luôn ≥ 1 khi có dòng. */
  heldDays: number;
  /** Số lần đổi khuyến nghị giữa các quan sát trong cửa sổ nhịp. */
  flips: number;
  /** Số ngày trong cửa sổ nhịp mà sổ KHÔNG có dòng nào — chưa đo, không phải "không đổi". */
  missingDays: number;
  /** Sổ cũ hơn hôm nay bao nhiêu ngày. 0 = đã ghi tới hôm nay. */
  staleDays: number;
  ready: boolean;
  /** Vì sao chưa được phép hành động. `null` khi `ready`. */
  blocker: StabilityBlocker | null;
  reason: string;
};

/** Không có dòng sổ nào ⇒ CHƯA ĐO. Không phải "mới", không phải "ổn định". */
export const NO_HISTORY: Stability = {
  action: "INSUFFICIENT_DATA",
  heldDays: 0,
  flips: 0,
  missingDays: 0,
  staleDays: 0,
  ready: false,
  blocker: "STALE",
  reason: "Sổ chưa có dòng nào cho mục này — chưa đo, không phải chưa đổi.",
};

/**
 * @param points Dòng sổ của MỘT mục (một chiến dịch / mã hàng). Thứ tự tuỳ ý — hàm tự xếp.
 * @param asOfDay Ngày Việt Nam đang xét (`YYYY-MM-DD`).
 */
export function stabilityOf(points: LedgerPoint[], asOfDay: string): Stability {
  if (points.length === 0) return NO_HISTORY;

  // Xếp tăng dần theo ngày. Chuỗi ngày dạng `YYYY-MM-DD` so sánh chữ là so sánh đúng thứ tự thời gian.
  const sorted = [...points].sort((a, b) => (a.decisionDay < b.decisionDay ? -1 : a.decisionDay > b.decisionDay ? 1 : 0));
  const latest = sorted[sorted.length - 1];
  const staleDays = Math.max(0, dayDiff(latest.decisionDay, asOfDay));

  // ── Chuỗi giữ nguyên: đi lùi, đứt khi ĐỔI khuyến nghị, ĐỔI phiên bản luật, hoặc THIẾU một ngày ──
  let heldDays = 1;
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    const cur = sorted[i + 1];
    const prev = sorted[i];
    if (prev.action !== cur.action) break;
    if (prev.ruleVersion !== cur.ruleVersion) break;
    if (dayDiff(prev.decisionDay, cur.decisionDay) !== 1) break;
    heldDays += 1;
  }

  // ── Cửa sổ nhịp: đếm số lần đổi ý và số ngày sổ không có mặt ──
  const windowFrom = dayDiff("1970-01-01", latest.decisionDay) - (FLIP_WINDOW_DAYS - 1);
  const inWindow = sorted.filter((p) => dayDiff("1970-01-01", p.decisionDay) >= windowFrom);
  let flips = 0;
  for (let i = 1; i < inWindow.length; i += 1) if (inWindow[i].action !== inWindow[i - 1].action) flips += 1;
  const versions = new Set(inWindow.map((p) => p.ruleVersion));
  const observedDays = new Set(inWindow.map((p) => p.decisionDay)).size;
  // Cửa sổ chỉ dài tới đúng dòng đầu tiên từng có: mục mới lập không bị tính là "thiếu 9 ngày".
  const windowSpan = Math.min(FLIP_WINDOW_DAYS, dayDiff(sorted[0].decisionDay, latest.decisionDay) + 1);
  const missingDays = Math.max(0, windowSpan - observedDays);

  const base = { action: latest.action, heldDays, flips, missingDays, staleDays };
  const rule = stabilityRuleOf(latest.action);

  if (staleDays > 0) {
    return { ...base, ready: false, blocker: "STALE", reason: `Sổ mới ghi tới ${latest.decisionDay}, chậm ${staleDays} ngày so với ${asOfDay}. Chưa biết hôm nay ERP nghĩ gì.` };
  }
  if (!rule) {
    return { ...base, ready: false, blocker: "NOT_ACTIONABLE", reason: "Khuyến nghị này không dẫn tới một việc phải làm, nên không có cổng độ bền." };
  }
  if (versions.size > 1) {
    return { ...base, ready: false, blocker: "RULE_CHANGED", reason: `Luật quyết định đổi phiên bản trong ${FLIP_WINDOW_DAYS} ngày gần đây — chuỗi trước và sau không so được với nhau.` };
  }
  if (flips > rule.maxFlips) {
    return { ...base, ready: false, blocker: "UNSTABLE", reason: `Đổi khuyến nghị ${flips} lần trong ${FLIP_WINDOW_DAYS} ngày (trần ${rule.maxFlips}) — dòng này đang nằm sát một ngưỡng, chưa ngã ngũ.` };
  }
  if (heldDays < rule.minHeldDays) {
    return { ...base, ready: false, blocker: "YOUNG", reason: `Mới giữ ${heldDays} ngày, cần ${rule.minHeldDays}.` };
  }
  return { ...base, ready: true, blocker: null, reason: `Giữ nguyên ${heldDays} ngày liên tiếp, đổi ${flips} lần trong ${FLIP_WINDOW_DAYS} ngày.` };
}
