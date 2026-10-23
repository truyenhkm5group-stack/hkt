/**
 * ═══ YÊU CẦU MUA THỬ (SRC-5a) — KIỂU + LUẬT THUẦN, CLIENT-SAFE ═══
 *
 *  · Số lượng theo màu × cỡ: đọc / ghi jsonb `sourcing_trial_requests.quantities` chỉ qua `validateTrialLines` / `parseTrialLines`.
 *  · ẢNH CHỤP lúc xin (`TrialSnapshot`): bậc giá, MOQ, cân nặng, tham số giá về và KẾT QUẢ công thức tại tổng số lượng — bất biến,
 *    màn hình đọc nó, không tính lại khi tham số đổi.
 *  · Trạng thái HIỂN THỊ = trạng thái của bảng (việc người đã làm) + trạng thái lời duyệt (`approval_requests`, nguồn duy nhất của
 *    duyệt / từ chối / hết hạn). Hàm thuần, không đọc CSDL.
 */
import type { LandedCostConfig, SourcingPlatform } from "@/lib/constants/sourcing";
import type { LandedCost } from "@/lib/sourcing/landed-cost";
import type { PriceTier } from "@/lib/sourcing/price";

export type TrialLine = { color: string; size: string; qty: number };

export const TRIAL_LINES_MAX = 200;
export const TRIAL_QTY_MAX = 1_000_000;
const TEXT_MAX = 60;

/** Kiểm + chuẩn hoá dòng số lượng. Sai ⇒ câu lỗi (để người sửa), không tự gộp / bỏ dòng. */
export function validateTrialLines(lines: readonly TrialLine[]): { lines: TrialLine[]; totalQty: number } | { error: string } {
  if (!lines.length) return { error: "Cần ít nhất một dòng số lượng." };
  if (lines.length > TRIAL_LINES_MAX) return { error: `Tối đa ${TRIAL_LINES_MAX} dòng.` };
  const out: TrialLine[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const color = lines[i].color.trim().slice(0, TEXT_MAX);
    const size = lines[i].size.trim().slice(0, TEXT_MAX);
    const qty = lines[i].qty;
    if (!Number.isInteger(qty) || qty < 1) return { error: `Dòng ${i + 1}: số lượng phải là số nguyên ≥ 1.` };
    const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
    if (seen.has(key)) return { error: `Dòng ${i + 1}: trùng màu / cỡ với dòng trước — gộp số lượng vào một dòng.` };
    seen.add(key);
    total += qty;
    out.push({ color, size, qty });
  }
  if (total > TRIAL_QTY_MAX) return { error: `Tổng số lượng tối đa ${TRIAL_QTY_MAX}.` };
  return { lines: out, totalQty: total };
}

export function parseTrialLines(raw: unknown): TrialLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TrialLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { color, size, qty } = r as Record<string, unknown>;
    if (typeof color !== "string" || typeof size !== "string" || typeof qty !== "number") return null;
    out.push({ color, size, qty });
  }
  const v = validateTrialLines(out);
  return "error" in v ? null : v.lines;
}

export type TrialSnapshot = {
  capturedAt: string;
  offer: { id: string; platform: SourcingPlatform; offerId: string | null; canonicalUrl: string; titleVi: string };
  /** Lần chụp giá dùng để xin — `null` khi mẫu chưa chụp giá. */
  priceSnapshotId: string | null;
  priceCapturedAt: string | null;
  tiers: PriceTier[] | null;
  moq: number | null;
  weightG: number | null;
  landedConfig: LandedCostConfig;
  /** Kết quả công thức tại TỔNG số lượng xin, lúc xin. */
  landed: LandedCost;
  totalQty: number;
};

/** Giá về ước tính MỘT cái trong ảnh chụp — `null` khi lúc xin chưa tính được. */
export function snapshotUnitEstimate(s: TrialSnapshot): number | null {
  return s.landed.kind === "ESTIMATE" ? s.landed.totalVnd : null;
}

export function parseTrialSnapshot(raw: unknown): TrialSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Partial<TrialSnapshot>;
  if (typeof r.capturedAt !== "string" || !r.offer || typeof r.offer.id !== "string" || !r.landed || typeof r.landed !== "object" || typeof r.totalQty !== "number" || !r.landedConfig) return null;
  return r as TrialSnapshot;
}

/** Dữ liệu ĐƯA CHO cổng duyệt — dựng lại từ đúng các cột đã lưu, nên lúc xin và lúc tiêu thụ ra cùng dấu vân tay. */
export function trialApprovalPayload(t: { id: string; totalQty: number; quantities: TrialLine[]; unitEstimateVnd: number | null }) {
  return { trialId: t.id, totalQty: t.totalQty, quantities: t.quantities.map((l) => ({ color: l.color, size: l.size, qty: l.qty })), unitEstimateVnd: t.unitEstimateVnd };
}

export const TRIAL_STATUSES = ["REQUESTED", "ORDERED", "RECEIVED", "CANCELLED"] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export type TrialState = "PENDING_APPROVAL" | "APPROVED" | "APPROVAL_EXPIRED" | "REJECTED" | "NO_APPROVAL" | "ORDERED" | "RECEIVED" | "CANCELLED";

export const TRIAL_STATE_LABEL: Record<TrialState, string> = {
  PENDING_APPROVAL: "Chờ duyệt",
  APPROVED: "Đã duyệt — chờ người xin đánh dấu đã đặt",
  APPROVAL_EXPIRED: "Lời duyệt hết hạn — xin lại",
  REJECTED: "Bị từ chối",
  NO_APPROVAL: "Không thấy lời duyệt — xin lại",
  ORDERED: "Đã đặt (ngoài ERP) — chờ hàng về",
  RECEIVED: "Hàng đã về",
  CANCELLED: "Đã huỷ",
};

/**
 * `approval.stillValid` do máy chủ tính bằng `approvalStillValid` (lõi duyệt) — không chép luật hạn hiệu lực sang đây.
 * Bảng đã đi tiếp (đã đặt / đã về / huỷ) thì trạng thái của bảng thắng: đó là việc người đã làm.
 */
export function deriveTrialState(status: TrialStatus, approval: { status: string; stillValid: boolean } | null): TrialState {
  if (status === "ORDERED" || status === "RECEIVED" || status === "CANCELLED") return status;
  if (!approval) return "NO_APPROVAL";
  if (approval.status === "PENDING") return "PENDING_APPROVAL";
  if (approval.status === "REJECTED") return "REJECTED";
  if (approval.status === "APPROVED") return approval.stillValid ? "APPROVED" : "APPROVAL_EXPIRED";
  if (approval.status === "EXPIRED") return "APPROVAL_EXPIRED";
  // EXECUTED mà bảng chưa ghi «đã đặt» = lượt tiêu thụ hỏng giữa chừng — nói ra thay vì đoán.
  return "NO_APPROVAL";
}

/** Huỷ được khi: chưa về; và KHÔNG đang chờ duyệt (người duyệt từ chối là cách rút một yêu cầu đang chờ). */
export function canCancelTrial(state: TrialState): boolean {
  return state !== "RECEIVED" && state !== "CANCELLED" && state !== "PENDING_APPROVAL";
}
