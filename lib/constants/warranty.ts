/**
 * ═══════════ BẢO HÀNH & ĐỔI TRẢ THEO SERIAL — HÀM THUẦN, client-safe (docs/verticals/household.md) ═══════════
 *
 * Hai thứ:
 *  · PHIẾU BẢO HÀNH — khách · sản phẩm · serial (tuỳ chọn) · ngày mua · số tháng ⇒ hạn (tính lúc ghi, `warrantyExpiry`).
 *  · CA BẢO HÀNH — mở (mô tả lỗi) → đang xử lý → xong (cách xử lý) / từ chối (lý do). «Còn bảo hành» KHÔNG lưu: so ngày mở ca
 *    với hạn của phiếu lúc đọc (`inWarrantyOn`) — phiếu sửa hạn thì mọi ca đọc lại đúng, không cột nào lệch.
 */

export const WARRANTY_LIMITS = { minMonths: 1, maxMonths: 120, serialMax: 80, nameMax: 200, issueMin: 5, issueMax: 1000, reasonMin: 3, noteMax: 1000, moneyMax: 2_000_000_000 } as const;

export const WARRANTY_CLAIM_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "REJECTED"] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];

export const WARRANTY_CLAIM_STATUS_LABEL: Record<WarrantyClaimStatus, string> = {
  OPEN: "Mới nhận",
  IN_PROGRESS: "Đang xử lý",
  DONE: "Đã xong",
  REJECTED: "Từ chối",
};

const CLAIM_NEXT: Record<WarrantyClaimStatus, readonly WarrantyClaimStatus[]> = {
  OPEN: ["IN_PROGRESS", "DONE", "REJECTED"],
  IN_PROGRESS: ["DONE", "REJECTED"],
  DONE: [],
  REJECTED: [],
};

/** Ca đã xong / từ chối thì không đổi nữa — ghi nhầm thì mở ca mới. */
export function canTransitionClaim(from: WarrantyClaimStatus, to: WarrantyClaimStatus): boolean {
  return CLAIM_NEXT[from].includes(to);
}

export function nextClaimStatuses(from: WarrantyClaimStatus): readonly WarrantyClaimStatus[] {
  return CLAIM_NEXT[from];
}

export const WARRANTY_RESOLUTIONS = ["REPAIRED", "REPLACED", "REFUNDED", "RETURNED_TO_SUPPLIER", "NO_FAULT"] as const;
export type WarrantyResolution = (typeof WARRANTY_RESOLUTIONS)[number];

export const WARRANTY_RESOLUTION_LABEL: Record<WarrantyResolution, string> = {
  REPAIRED: "Sửa xong",
  REPLACED: "Đổi máy mới",
  REFUNDED: "Hoàn tiền",
  RETURNED_TO_SUPPLIER: "Gửi nhà cung cấp",
  NO_FAULT: "Không lỗi — trả khách",
};

/** «YYYY-MM-DD» hợp lệ (ngày có thật). */
export function isDayKey(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Hạn bảo hành = ngày mua + N tháng, cùng ngày trong tháng; tháng đích ngắn hơn thì về NGÀY CUỐI tháng (31/01 + 1 tháng =
 * 28 hoặc 29/02 — không trôi sang tháng 3). Ngày sai dạng ⇒ `null`.
 */
export function warrantyExpiry(purchasedOn: string, months: number): string | null {
  if (!isDayKey(purchasedOn) || !Number.isInteger(months) || months < WARRANTY_LIMITS.minMonths || months > WARRANTY_LIMITS.maxMonths) return null;
  const [y, m, d] = purchasedOn.split("-").map(Number);
  const total = m - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = total % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(ty, tm, Math.min(d, lastDay)));
  return out.toISOString().slice(0, 10);
}

/** Ngày `onDay` (YYYY-MM-DD, giờ VN) còn trong hạn không — NGÀY HẾT HẠN vẫn còn bảo hành. */
export function inWarrantyOn(expiresOn: string, onDay: string): boolean {
  return onDay <= expiresOn;
}

export type WarrantyCardState = "IN_WARRANTY" | "EXPIRED" | "VOID";

export const WARRANTY_CARD_STATE_LABEL: Record<WarrantyCardState, string> = { IN_WARRANTY: "Còn bảo hành", EXPIRED: "Hết bảo hành", VOID: "Đã huỷ phiếu" };

/** Trạng thái phiếu tại một ngày + số ngày còn lại (âm = đã hết bấy nhiêu ngày). */
export function warrantyCardState(card: { status: string; expiresOn: string }, today: string): { state: WarrantyCardState; daysLeft: number } {
  const ms = Date.parse(`${card.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  const daysLeft = Math.round(ms / 86_400_000);
  if (card.status === "VOID") return { state: "VOID", daysLeft };
  return { state: inWarrantyOn(card.expiresOn, today) ? "IN_WARRANTY" : "EXPIRED", daysLeft };
}

/** Serial chuẩn hoá để lưu: bỏ khoảng trắng hai đầu; rỗng ⇒ `null` (phiếu không serial). So khớp không phân biệt hoa thường. */
export function normalizeSerial(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  return v ? v.slice(0, WARRANTY_LIMITS.serialMax) : null;
}
