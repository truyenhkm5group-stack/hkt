/** Giả định lập kế hoạch đặt hàng sản xuất (settings "inventory.planning") */
export type PlanningAssumptions = {
  /** Thời gian sản xuất / nhập hàng về kho (ngày) */
  leadTimeDays: number;
  /** Muốn đủ hàng bán thêm bao nhiêu ngày sau khi lô mới về */
  coverDays: number;
  /** Cửa sổ tính tốc độ bán (ngày) */
  velocityWindowDays: number;
  /** Tồn an toàn tính theo số ngày bán */
  safetyDays: number;
  /** Làm tròn số lượng đặt lên bội số (1 = không làm tròn) */
  roundTo: number;
  /** Ghi đè thời gian sản xuất theo mã hàng (productId → ngày) */
  leadTimeOverrides: Record<string, number>;
};

export const PLANNING_KEY = "inventory.planning";

export const DEFAULT_PLANNING: PlanningAssumptions = {
  leadTimeDays: 7,
  coverDays: 14,
  velocityWindowDays: 14,
  safetyDays: 3,
  roundTo: 1,
  leadTimeOverrides: {},
};

export type PlanStatus = "UNKNOWN" | "OUT" | "CRITICAL" | "LOW" | "OK" | "IDLE";
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  UNKNOWN: "Chưa có phiếu nhập — không tính được tồn",
  OUT: "Hết hàng / âm",
  CRITICAL: "Hết trước khi SX xong",
  LOW: "Sắp thiếu",
  OK: "Đủ hàng",
  IDLE: "Không bán",
};
export const PLAN_STATUS_TONE: Record<PlanStatus, string> = {
  UNKNOWN: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  OUT: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  CRITICAL: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  LOW: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  OK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  IDLE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export type PlanInput = {
  /** Tồn khả dụng ERP hiện tại (nhập − giao thật − đang giao − hàng hoàn chưa về kho) */
  stock: number;
  /**
   * Tồn có tính được không. Mẫu mã chưa có phiếu nhập nào trong ERP thì tồn là KHÔNG BIẾT,
   * không phải 0 — không được lấy số âm bịa ra để đề xuất sản xuất.
   */
  stockKnown?: boolean;
  /** Đã chốt nhưng chưa gửi (đơn xác nhận / đóng gói / chờ lấy) */
  committed: number;
  /** Số lượng bán ròng (không huỷ, không hoàn) trong cửa sổ tốc độ */
  soldInWindow: number;
  windowDays: number;
  leadTimeDays: number;
  coverDays: number;
  safetyDays: number;
  roundTo: number;
  /** Hàng ĐANG Ở NGOÀI: đã rời kho, vận đơn chưa kết thúc — chưa biết giao được hay hoàn về. */
  inTransit?: number;
  /** Hàng CHỜ HOÀN VỀ: đã xác định phải quay lại kho, kho chưa lập phiếu tái nhập. */
  awaitingReturn?: number;
  /** Tỷ lệ hoàn thực tế (0–1) — dùng để ước phần hàng đang ở ngoài sẽ quay về kho. */
  returnRate?: number;
  /** Tỷ lệ hàng hoàn thực sự nhập lại được kho (0–1), tính từ phiếu tái nhập đã đếm. */
  returnRecoveryRate?: number;
  /** Có trừ hàng sắp về khỏi lượng cần đặt không (mặc định có). */
  countIncoming?: boolean;
};

export type PlanOutput = {
  available: number;
  velocity: number;
  daysOfCover: number | null;
  stockOutDate: string | null;
  leadTimeDemand: number;
  safetyStock: number;
  target: number;
  shortage: number;
  suggested: number;
  status: PlanStatus;
  /** Hàng chờ hoàn về × tỷ lệ nhập lại được kho. */
  incomingFromReturns: number;
  /** Hàng đang ở ngoài × tỷ lệ hoàn × tỷ lệ nhập lại được kho. */
  incomingFromTransit: number;
  /** Tổng hàng dự kiến quay lại kho trong kỳ kế hoạch. */
  incoming: number;
  /** Nguồn cung dùng để quyết định đặt hàng = khả dụng + hàng sắp về. */
  supply: number;
  /** Số ngày còn bán được nếu tính cả hàng sắp về. */
  daysOfCoverWithIncoming: number | null;
};

/**
 * Thuật toán đặt hàng:
 *
 *   đặt = (nhu cầu trong thời gian SX + nhu cầu số ngày muốn đủ bán + tồn an toàn) − nguồn cung
 *   nguồn cung = tồn khả dụng + hàng sắp quay lại kho
 *
 * HÀNG SẮP QUAY LẠI KHO là hàng đã rời kho nhưng sẽ về: đơn chờ hoàn về (đã xác định hoàn, kho
 * chưa lập phiếu tái nhập) và một phần hàng đang ở ngoài (vận đơn chưa kết thúc, ước theo tỷ lệ
 * hoàn thực tế). Cả hai đều nhân với tỷ lệ nhập lại được kho — hàng hoàn về không phải lúc nào
 * cũng bán lại được. Bỏ qua phần này là đặt thừa, vì shop có lượng hoàn lớn hơn nhiều so với
 * lượng đang giao.
 *
 * Hai tỷ lệ trên lấy từ dữ liệu thật của shop, không phải số ước lượng gõ tay.
 */
export function computePlan(i: PlanInput, today = new Date()): PlanOutput {
  const available = i.stock - i.committed;
  const tyLeNhapLai = clamp01(i.returnRecoveryRate ?? 1);
  const tyLeHoan = clamp01(i.returnRate ?? 0);
  const incomingFromReturns = Math.round(Math.max(0, i.awaitingReturn ?? 0) * tyLeNhapLai);
  const incomingFromTransit = Math.round(Math.max(0, i.inTransit ?? 0) * tyLeHoan * tyLeNhapLai);
  const incoming = i.countIncoming === false ? 0 : incomingFromReturns + incomingFromTransit;
  const supply = available + incoming;
  // Không biết tồn thì KHÔNG đề xuất đặt hàng: đề xuất dựa trên dữ liệu bịa còn tệ hơn không đề xuất.
  if (i.stockKnown === false) {
    const velocity = i.windowDays > 0 ? i.soldInWindow / i.windowDays : 0;
    return { available, velocity, daysOfCover: null, stockOutDate: null, leadTimeDemand: 0,
      safetyStock: 0, target: 0, shortage: 0, suggested: 0, status: "UNKNOWN",
      incomingFromReturns, incomingFromTransit, incoming, supply, daysOfCoverWithIncoming: null };
  }
  const velocity = i.windowDays > 0 ? i.soldInWindow / i.windowDays : 0;
  const daysOfCover = velocity > 0 ? Math.max(0, available) / velocity : null;
  const daysOfCoverWithIncoming = velocity > 0 ? Math.max(0, supply) / velocity : null;
  const leadTimeDemand = Math.ceil(velocity * i.leadTimeDays);
  const safetyStock = Math.ceil(velocity * i.safetyDays);
  const target = Math.ceil(velocity * (i.leadTimeDays + i.coverDays)) + safetyStock;
  const shortage = Math.max(0, -available);
  let suggested = Math.max(0, target - supply);
  if (i.roundTo > 1 && suggested > 0) suggested = Math.ceil(suggested / i.roundTo) * i.roundTo;
  // Tình trạng nói về HÔM NAY nên vẫn tính trên tồn khả dụng: hàng hoàn còn trên đường về không
  // bán được ngay, gộp vào đây sẽ giấu mất mẫu mã đang đứt hàng.
  let status: PlanStatus;
  if (velocity <= 0 && available > 0) status = "IDLE";
  else if (available <= 0) status = "OUT";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays) status = "CRITICAL";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays + i.safetyDays) status = "LOW";
  else status = velocity <= 0 ? "IDLE" : "OK";
  const stockOutDate = daysOfCover !== null && available > 0 ? new Date(today.getTime() + daysOfCover * 86_400_000).toISOString().slice(0, 10) : available <= 0 && velocity > 0 ? today.toISOString().slice(0, 10) : null;
  return { available, velocity, daysOfCover, stockOutDate, leadTimeDemand, safetyStock, target, shortage, suggested, status,
    incomingFromReturns, incomingFromTransit, incoming, supply, daysOfCoverWithIncoming };
}

function clamp01(v: number) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
