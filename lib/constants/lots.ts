/**
 * ═══════════ LÔ & HẠN DÙNG — HÀM THUẦN, client-safe (docs/verticals/food-lots.md) ═══════════
 *
 * Lô là LỚP GẮN THÊM lên phiếu kho đã có (mã lô · hạn dùng · số lượng trên MỘT dòng phiếu nhập), KHÔNG phải sổ kho thứ hai:
 *  · Tồn thực tế / khả dụng của mẫu mã vẫn chỉ tính ở `lib/queries/stock.ts` (luật 10). Lô không cộng, không trừ một cái nào.
 *  · «Lô này còn bao nhiêu» là ƯỚC TÍNH (luật 8.6): tồn thực tế của mẫu mã được rải ngược vào các dòng nhập, dòng nhập MỚI NHẤT
 *    giữ hàng trước — tức giả định hàng xuất theo NHẬP TRƯỚC XUẤT TRƯỚC. Dòng nhập chưa gắn lô cũng nhận phần của nó («chưa gắn
 *    lô»), nên con số không bao giờ dồn hết vào lô đã khai.
 *  · Tồn của mẫu mã CHƯA BIẾT (chưa có phiếu nhập) ⇒ phần còn của mọi lô là `null`, không phải 0 (luật 42).
 */

export const LOT_LIMITS = { codeMax: 60, noteMax: 500, reasonMin: 3, maxQty: 1_000_000 } as const;

/** Cửa sổ «cận hạn» là BỘ LỌC XEM người dùng chọn trên trang, không phải ngưỡng nghiệp vụ (luật 38). */
export const LOT_WINDOW_OPTIONS = [7, 14, 30, 60, 90] as const;
export type LotWindow = (typeof LOT_WINDOW_OPTIONS)[number];

export function parseLotWindow(raw: unknown): LotWindow {
  const n = Number(raw);
  return (LOT_WINDOW_OPTIONS as readonly number[]).includes(n) ? (n as LotWindow) : 30;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLotDay(v: string): boolean {
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type LotExpiryState = "EXPIRED" | "NEAR" | "OK";

export const LOT_EXPIRY_LABEL: Record<LotExpiryState, string> = { EXPIRED: "Đã hết hạn", NEAR: "Cận hạn", OK: "Còn hạn" };

/** NGÀY HẾT HẠN vẫn còn dùng được (giống hạn bảo hành). Cận hạn = hết hạn trong `windowDays` ngày tới, kể cả hôm nay. */
export function lotExpiryState(expiresOn: string, today: string, windowDays: number): { state: LotExpiryState; daysLeft: number } {
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { state: "EXPIRED", daysLeft };
  return { state: daysLeft <= windowDays ? "NEAR" : "OK", daysLeft };
}

/** Một dòng nhập DƯƠNG của mẫu mã (phiếu nhập / tái nhập / điều chỉnh tăng), kèm các lô đã gắn lên nó. */
export type InboundLine = {
  itemId: string;
  receivedAt: string;
  quantity: number;
  lots: { id: string; expiresOn: string; quantity: number }[];
};

export type LotEstimate = {
  /** Phần còn ước tính của từng lô; `null` khi tồn mẫu mã chưa biết. */
  remaining: Map<string, number | null>;
  /** Phần còn ước tính nằm ở dòng nhập / phần dòng nhập CHƯA gắn lô. */
  untracked: number | null;
  /** Tồn thực tế lớn hơn tổng mọi dòng nhập (sổ có điều chỉnh / tái nhập không dòng dương) — phần dư không quy về lô nào. */
  unexplained: number | null;
};

/**
 * Rải tồn thực tế `onHand` của MỘT mẫu mã ngược vào các dòng nhập: dòng nhập MỚI NHẤT trước; trong một dòng, lô HẠN XA NHẤT
 * giữ hàng trước, phần chưa gắn lô giữ sau cùng (vì hàng cận hạn được xuất trước — FEFO). Tồn ≤ 0 ⇒ mọi lô còn 0.
 */
export function estimateLotRemaining(lines: readonly InboundLine[], onHand: number | null): LotEstimate {
  const remaining = new Map<string, number | null>();
  if (onHand === null) {
    for (const l of lines) for (const lot of l.lots) remaining.set(lot.id, null);
    return { remaining, untracked: null, unexplained: null };
  }
  let left = Math.max(0, onHand);
  let untracked = 0;
  const ordered = [...lines].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.itemId.localeCompare(a.itemId));
  for (const line of ordered) {
    const lots = [...line.lots].sort((a, b) => b.expiresOn.localeCompare(a.expiresOn) || a.id.localeCompare(b.id));
    for (const lot of lots) {
      const take = Math.min(left, lot.quantity);
      remaining.set(lot.id, take);
      left -= take;
    }
    const free = Math.max(0, line.quantity - line.lots.reduce((s, l) => s + l.quantity, 0));
    const take = Math.min(left, free);
    untracked += take;
    left -= take;
  }
  return { remaining, untracked, unexplained: left };
}

/** Thứ tự LẤY HÀNG: lô còn hàng, hạn GẦN nhất trước (FEFO). Lô đã hết hạn đứng riêng — không phải để bán. */
export function fefoPickOrder<T extends { expiresOn: string; remaining: number | null }>(lots: readonly T[], today: string): T[] {
  return lots.filter((l) => (l.remaining ?? 0) > 0 && l.expiresOn >= today).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}

/** Mã lô chuẩn hoá: bỏ khoảng trắng thừa; rỗng ⇒ `null`. */
export function normalizeLotCode(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  return v ? v.slice(0, LOT_LIMITS.codeMax) : null;
}
