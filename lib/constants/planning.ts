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
};

/** Thuật toán đặt hàng: đặt = (nhu cầu trong thời gian SX + nhu cầu cover + tồn an toàn) − tồn khả dụng sau khi trừ đơn đã chốt */
export function computePlan(i: PlanInput, today = new Date()): PlanOutput {
  const available = i.stock - i.committed;
  // Không biết tồn thì KHÔNG đề xuất đặt hàng: đề xuất dựa trên dữ liệu bịa còn tệ hơn không đề xuất.
  if (i.stockKnown === false) {
    const velocity = i.windowDays > 0 ? i.soldInWindow / i.windowDays : 0;
    return { available, velocity, daysOfCover: null, stockOutDate: null, leadTimeDemand: 0,
      safetyStock: 0, target: 0, shortage: 0, suggested: 0, status: "UNKNOWN" };
  }
  const velocity = i.windowDays > 0 ? i.soldInWindow / i.windowDays : 0;
  const daysOfCover = velocity > 0 ? Math.max(0, available) / velocity : null;
  const leadTimeDemand = Math.ceil(velocity * i.leadTimeDays);
  const safetyStock = Math.ceil(velocity * i.safetyDays);
  const target = Math.ceil(velocity * (i.leadTimeDays + i.coverDays)) + safetyStock;
  const shortage = Math.max(0, -available);
  let suggested = Math.max(0, target - available);
  if (i.roundTo > 1 && suggested > 0) suggested = Math.ceil(suggested / i.roundTo) * i.roundTo;
  let status: PlanStatus;
  if (velocity <= 0 && available > 0) status = "IDLE";
  else if (available <= 0) status = "OUT";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays) status = "CRITICAL";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays + i.safetyDays) status = "LOW";
  else status = velocity <= 0 ? "IDLE" : "OK";
  const stockOutDate = daysOfCover !== null && available > 0 ? new Date(today.getTime() + daysOfCover * 86_400_000).toISOString().slice(0, 10) : available <= 0 && velocity > 0 ? today.toISOString().slice(0, 10) : null;
  return { available, velocity, daysOfCover, stockOutDate, leadTimeDemand, safetyStock, target, shortage, suggested, status };
}
