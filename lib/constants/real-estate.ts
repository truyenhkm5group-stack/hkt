/**
 * ═══════════ BẢNG HÀNG BẤT ĐỘNG SẢN — HÀM THUẦN, client-safe (docs/verticals/real-estate.md) ═══════════
 *
 * Sàn / đại lý phân phối căn của một dự án cho nhiều sale cùng lúc. Nỗi đau số một: HAI SALE GIỮ CÙNG MỘT CĂN, khách cọc rồi
 * mới biết căn đã có người. Nên:
 *  · Mỗi căn tại một thời điểm có NHIỀU NHẤT một lượt giữ chỗ còn hiệu lực và một khoản cọc còn hiệu lực (chỉ mục duy nhất có
 *    điều kiện ở CSDL + khoá tư vấn theo căn ở đường ghi).
 *  · Giữ chỗ CÓ HẠN (số giờ do dự án khai — quyết định kinh doanh, không mặc định); quá hạn là tự hết, không ai phải bấm nhả.
 *  · Trạng thái căn KHÔNG lưu cột: tính lúc đọc từ khoá · đã bán · cọc · giữ chỗ còn hạn (`unitState`).
 */

export const RE_UNIT_STATES = ["AVAILABLE", "HELD", "DEPOSITED", "SOLD", "LOCKED"] as const;
export type ReUnitState = (typeof RE_UNIT_STATES)[number];

export const RE_UNIT_STATE_LABEL: Record<ReUnitState, string> = {
  AVAILABLE: "Còn trống",
  HELD: "Đang giữ chỗ",
  DEPOSITED: "Đã cọc",
  SOLD: "Đã bán",
  LOCKED: "Chủ đầu tư khoá",
};

export const RE_HOLD_STATUSES = ["ACTIVE", "RELEASED", "EXPIRED", "CONVERTED"] as const;
export type ReHoldStatus = (typeof RE_HOLD_STATUSES)[number];
export const RE_HOLD_STATUS_LABEL: Record<ReHoldStatus, string> = { ACTIVE: "Đang giữ", RELEASED: "Đã nhả", EXPIRED: "Hết hạn", CONVERTED: "Đã chuyển cọc" };

export const RE_DEPOSIT_STATUSES = ["ACTIVE", "REFUNDED", "FORFEITED", "CONVERTED"] as const;
export type ReDepositStatus = (typeof RE_DEPOSIT_STATUSES)[number];
export const RE_DEPOSIT_STATUS_LABEL: Record<ReDepositStatus, string> = { ACTIVE: "Đang cọc", REFUNDED: "Đã hoàn cọc", FORFEITED: "Khách bỏ cọc", CONVERTED: "Đã ký bán" };

export const RE_LIMITS = { codeMax: 40, nameMax: 160, textMax: 1000, reasonMin: 3, holdHoursMin: 1, holdHoursMax: 720, priceMax: 1_000_000_000_000, bulkUnitsMax: 500 } as const;

/** Lượt giữ chỗ còn hiệu lực TẠI `now`: trạng thái ACTIVE và chưa tới hạn. Quá hạn mà dòng còn ACTIVE ⇒ coi như đã hết. */
export function holdLive(hold: { status: string; expiresAt: Date | string }, now: Date): boolean {
  return hold.status === "ACTIVE" && new Date(hold.expiresAt).getTime() > now.getTime();
}

export function holdExpiresAt(heldAt: Date, hours: number): Date {
  return new Date(heldAt.getTime() + hours * 3_600_000);
}

/**
 * Trạng thái một căn tại `now`, ưu tiên: ĐÃ BÁN > KHOÁ > ĐÃ CỌC > ĐANG GIỮ CHỖ > CÒN TRỐNG. (Căn đã bán thì khoá sau đó cũng
 * không đổi sự thật là đã bán; căn khoá thì không giữ / cọc được.)
 */
export function unitState(u: { soldAt: Date | string | null; lockedAt: Date | string | null; hasActiveDeposit: boolean; holds: readonly { status: string; expiresAt: Date | string }[] }, now: Date): ReUnitState {
  if (u.soldAt) return "SOLD";
  if (u.lockedAt) return "LOCKED";
  if (u.hasActiveDeposit) return "DEPOSITED";
  if (u.holds.some((h) => holdLive(h, now))) return "HELD";
  return "AVAILABLE";
}

/** Thời gian giữ còn lại (phút, làm tròn xuống); hết hạn ⇒ 0. */
export function holdMinutesLeft(expiresAt: Date | string, now: Date): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000));
}

export type ParsedUnitLine = { code: string; block: string; floor: string; areaM2: number | null; listPrice: number | null };

/**
 * Dán danh sách căn, mỗi dòng «mã | toà/khu | tầng | diện tích m² | giá niêm yết». Chỉ mã là bắt buộc; diện tích / giá trống
 * ⇒ `null` (chưa công bố — không phải 0). Dòng hỏng trả về kèm số dòng, không đoán.
 */
export function parseUnitLines(text: string): { units: ParsedUnitLine[]; errors: { line: number; message: string }[] } {
  const units: ParsedUnitLine[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/[|\t;]/).map((p) => p.trim());
    const code = parts[0] ?? "";
    if (!code || code.length > RE_LIMITS.codeMax) return void errors.push({ line: i + 1, message: "Thiếu mã căn hoặc mã quá dài" });
    if (seen.has(code.toLowerCase())) return void errors.push({ line: i + 1, message: `Mã ${code} lặp trong danh sách` });
    // Diện tích: dấu phẩy là phần thập phân («75,5»). Giá: dấu chấm / phẩy / cách là phân cách nghìn («2.500.000.000»).
    const num = (s: string | undefined, label: string, money: boolean): number | null | "BAD" => {
      const v = money ? (s ?? "").replace(/[\s.,]/g, "") : (s ?? "").replace(/\s/g, "").replace(",", ".");
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ line: i + 1, message: `${label} không phải số` });
        return "BAD";
      }
      return n;
    };
    const area = num(parts[3], "Diện tích", false);
    const price = num(parts[4], "Giá", true);
    if (area === "BAD" || price === "BAD") return;
    if (price !== null && (!Number.isInteger(price) || price > RE_LIMITS.priceMax)) return void errors.push({ line: i + 1, message: "Giá phải là số nguyên đồng" });
    seen.add(code.toLowerCase());
    units.push({ code, block: (parts[1] ?? "").slice(0, 40), floor: (parts[2] ?? "").slice(0, 20), areaM2: area, listPrice: price });
  });
  return { units, errors };
}
