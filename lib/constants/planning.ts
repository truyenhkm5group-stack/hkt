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
  /**
   * SỐ LƯỢNG ĐẶT TỐI THIỂU của xưởng (MOQ). Đặt 5 cái mà xưởng chỉ nhận từ 50 thì con số 5 là vô
   * dụng — nó khiến bảng kế hoạch trông chính xác trong khi không đặt được.
   * 0 hoặc 1 = xưởng nhận mọi số lượng.
   */
  minOrderQty: number;
  /** Ghi đè MOQ theo mã hàng (productId → số lượng) */
  minOrderQtyOverrides: Record<string, number>;
  /** Ghi đè thời gian sản xuất theo mã hàng (productId → ngày) */
  leadTimeOverrides: Record<string, number>;
  /**
   * KHO TÁI NHẬP HÀNG HOÀN TRONG BAO NHIÊU NGÀY sau khi hàng về tới shop — MỤC TIÊU VẬN HÀNH do chủ
   * shop đặt, không phải số đo.
   *
   * Vì sao không đo: ngày 23/09/2026, toàn bộ 606 kiện tái nhập trong 60 ngày qua được làm trong
   * ĐÚNG MỘT NGÀY (tuần 14/09) — kho chưa tái nhập đều đặn, nên "trung vị 30,8 ngày" chỉ mô tả một
   * lần nhập bù. Phần ĐO được là ĐVVC trả hàng về shop (trung vị 7,7 ngày, 685 kiện) — cộng với số
   * này ra độ trễ hoàn dùng để trừ hàng hoàn của đơn tương lai khỏi số cần đặt.
   *
   * Kho chậm hơn con số này thì đề xuất sẽ THIẾU — lời diễn giải luôn in kịch bản "kho không tái
   * nhập kịp" để người đặt thấy số đặt tối đa.
   */
  restockDays: number;
};

export const PLANNING_KEY = "inventory.planning";

export const DEFAULT_PLANNING: PlanningAssumptions = {
  leadTimeDays: 7,
  coverDays: 14,
  velocityWindowDays: 14,
  safetyDays: 3,
  roundTo: 1,
  minOrderQty: 0,
  minOrderQtyOverrides: {},
  leadTimeOverrides: {},
  restockDays: 2,
};

/**
 * ───────────── TỐC ĐỘ BÁN CHỐNG NHIỄU ─────────────
 *
 * Tốc độ bán = tổng bán ÷ số ngày. Công thức đó sụp đổ khi shop có MỘT ngày đột biến: một buổi
 * livestream bán 60 cái trong cửa sổ 14 ngày đẩy tốc độ lên 4,3 cái/ngày, và kế hoạch sẽ đặt sản
 * xuất theo nhịp đó cho cả tháng sau — trong khi ngày thường chỉ bán 1–2 cái.
 *
 * CÁCH XỬ LÝ: chỉ khi MỘT ngày chiếm hơn nửa tổng bán của cả cửa sổ thì mới coi là đột biến và bỏ
 * ngày đó ra khỏi phép tính. Cố ý KHÔNG làm mượt mọi trường hợp — dao động bình thường là thông
 * tin thật, dập nó đi sẽ khiến kế hoạch luôn đặt thiếu.
 *
 * Cần ít nhất 7 ngày dữ liệu: bỏ một ngày trong cửa sổ 3 ngày là bỏ một phần ba bằng chứng.
 */
export const VELOCITY_PEAK_DOMINANCE = 0.5;
export const VELOCITY_MIN_WINDOW_FOR_TRIM = 7;

export type VelocityResult = {
  /** Tốc độ dùng để lập kế hoạch (món/ngày). */
  velocity: number;
  /** Tốc độ thô, chưa bỏ ngày đột biến — giữ lại để so sánh và giải thích. */
  rawVelocity: number;
  /** Có bỏ ngày đột biến hay không. */
  trimmed: boolean;
  /** Số lượng của ngày bán mạnh nhất trong cửa sổ. */
  peakDayQty: number;
};

export function computeVelocity(soldInWindow: number, windowDays: number, peakDayQty = 0): VelocityResult {
  const days = Math.max(1, windowDays);
  const sold = Math.max(0, soldInWindow);
  const peak = Math.max(0, peakDayQty);
  const rawVelocity = sold / days;
  const dominant = sold > 0 && peak / sold > VELOCITY_PEAK_DOMINANCE;
  if (days >= VELOCITY_MIN_WINDOW_FOR_TRIM && dominant && peak < sold) {
    return { velocity: (sold - peak) / (days - 1), rawVelocity, trimmed: true, peakDayQty: peak };
  }
  return { velocity: rawVelocity, rawVelocity, trimmed: false, peakDayQty: peak };
}

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
  /**
   * Số cái RỜI KHO theo đơn đã chốt trong cửa sổ tốc độ — GỘP: không tính đơn huỷ, NHƯNG tính cả
   * đơn đang giao lẫn đơn đã hoàn, và cả hàng tặng (hàng tặng cũng rời kho).
   *
   * Trước 23/09/2026 đây là số "ròng" nửa vời: đơn ĐÃ hoàn bị loại, đơn ĐANG giao thì tính đủ. Với
   * mã đang chạy, phần lớn đơn 14 ngày gần nhất còn đang giao, nên con số ấy vừa không phải gộp vừa
   * không phải ròng. Phần hàng quay về nay được trừ TƯỜNG MINH bằng tỷ lệ hoàn (`returnRate`) và
   * độ trễ hoàn (`returnLagDays`) — một chỗ, có tên, in ra được trong lời diễn giải.
   */
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
  /**
   * Tỷ lệ hoàn (0–1) của MÃ HÀNG = 1 − tỷ lệ giao thành công theo thang bậc chung
   * (`lib/constants/delivery-rate.ts`, AGENTS.md mục 68). Dùng cho CẢ HAI việc: ước hàng đang ở
   * ngoài sẽ quay về, VÀ trừ phần hàng của chính các đơn tương lai sẽ hoàn về kịp bán lại.
   */
  returnRate?: number;
  /**
   * ĐỘ TRỄ HOÀN (ngày): từ lúc hàng rời kho tới lúc kho tái nhập được hàng hoàn — trung vị ĐO trên
   * dữ liệu thật. Đơn gửi đi trong N ngày tới chỉ có hàng hoàn QUAY VỀ KỊP nếu nó đi sớm hơn
   * `N − returnLagDays` ngày.
   *
   * `null`/không khai = CHƯA ĐO ĐƯỢC ⇒ KHÔNG trừ hàng hoàn của đơn tương lai (phía thận trọng: có
   * thể đặt dư một chút, nhưng không bao giờ đặt thiếu vì trông chờ hàng hoàn chưa ai chứng minh là
   * sẽ về kịp).
   */
  returnLagDays?: number | null;
  /** Tỷ lệ hàng hoàn thực sự nhập lại được kho (0–1), tính từ phiếu tái nhập đã đếm. */
  returnRecoveryRate?: number;
  /** Có trừ hàng sắp về khỏi lượng cần đặt không (mặc định có). */
  countIncoming?: boolean;
  /** Số lượng bán của NGÀY MẠNH NHẤT trong cửa sổ — để loại đột biến khỏi tốc độ bán. */
  peakDayQty?: number;
  /** Số lượng đặt tối thiểu của xưởng cho mã hàng này. */
  minOrderQty?: number;
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
  /**
   * HẠN ĐẶT HÀNG: ngày muộn nhất phải đặt để lô mới về kịp trước khi hết hàng.
   * = ngày dự kiến hết hàng − thời gian sản xuất.
   * `null` khi chưa dự báo được ngày hết hàng. Quá khứ nghĩa là ĐÃ MUỘN — vẫn hiện, không giấu.
   */
  reorderByDate: string | null;
  /** Tốc độ bán thô, chưa bỏ ngày đột biến. */
  rawVelocity: number;
  /** Đã bỏ một ngày đột biến khỏi tốc độ bán hay chưa. */
  velocityTrimmed: boolean;
  /** Số lượng đề xuất trước khi nâng lên mức đặt tối thiểu của xưởng. */
  suggestedBeforeMoq: number;
  /** Đề xuất đã bị nâng lên vì xưởng có mức đặt tối thiểu. */
  moqApplied: boolean;
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
  /**
   * Tốc độ HAO KHO RÒNG (cái/ngày) = tốc độ gửi đi × (1 − tỷ lệ hoàn × tỷ lệ nhập lại được): phần
   * mỗi cái gửi đi thật sự mất khỏi kho. Chỉ áp dụng SAU độ trễ hoàn — trước đó kho hao theo tốc độ
   * gửi đi, vì hàng hoàn chưa kịp về.
   */
  netVelocity: number;
  /**
   * Số cái được TRỪ khỏi mục tiêu vì hàng của chính các đơn gửi đi trong kỳ kế hoạch sẽ hoàn về
   * kịp bán lại. 0 khi chưa đo được độ trễ hoàn. Làm tròn XUỐNG — không trừ nửa cái hàng chưa về.
   */
  futureReturnCredit: number;
};

/**
 * Thuật toán đặt hàng (chủ shop yêu cầu 23/09/2026: phải tính theo GTC và tỷ lệ hoàn để không đặt
 * dư rồi tồn không bán hết):
 *
 *   g            = tốc độ GỬI ĐI (đơn đã chốt, không huỷ — gồm cả đơn đang giao / đã hoàn)
 *   cần có       = g × (SX + muốn đủ bán) + g × an toàn − hàng hoàn của CHÍNH các đơn ấy về kịp
 *   hàng hoàn về kịp = g × tỷ lệ hoàn × tỷ lệ nhập lại được × max(0, SX + đủ bán + an toàn − độ trễ hoàn)
 *   đặt          = cần có − nguồn cung
 *   nguồn cung   = tồn khả dụng + hàng sắp quay lại kho
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
  const v = computeVelocity(i.soldInWindow, i.windowDays, i.peakDayQty ?? 0);
  /*
    HAO KHO RÒNG. Trong mỗi cái gửi đi, phần `tyLeHoan` quay về và `tyLeNhapLai` của phần ấy bán lại
    được — nên thứ thật sự mất khỏi kho là `1 − tyLeHoan × tyLeNhapLai`. Nhưng hàng hoàn chỉ về SAU
    `returnLagDays` ngày: trước mốc đó kho hao theo tốc độ gửi đi đầy đủ.
  */
  const lag = i.returnLagDays !== null && i.returnLagDays !== undefined && Number.isFinite(i.returnLagDays) && i.returnLagDays >= 0 ? i.returnLagDays : null;
  const netVelocity = v.velocity * (1 - tyLeHoan * tyLeNhapLai);
  /** Số ngày `x` cái hàng đủ bán: hao đủ tốc độ tới độ trễ hoàn, sau đó hao theo tốc độ ròng. */
  const coverOf = (x: number): number | null => {
    if (v.velocity <= 0) return null;
    if (lag === null || x <= v.velocity * lag) return x / v.velocity;
    return netVelocity > 0 ? lag + (x - v.velocity * lag) / netVelocity : null;
  };
  if (i.stockKnown === false) {
    return { available, velocity: v.velocity, rawVelocity: v.rawVelocity, velocityTrimmed: v.trimmed,
      daysOfCover: null, stockOutDate: null, reorderByDate: null, leadTimeDemand: 0,
      safetyStock: 0, target: 0, shortage: 0, suggested: 0, suggestedBeforeMoq: 0, moqApplied: false, status: "UNKNOWN",
      incomingFromReturns, incomingFromTransit, incoming, supply, daysOfCoverWithIncoming: null, netVelocity, futureReturnCredit: 0 };
  }
  const velocity = v.velocity;
  const daysOfCover = coverOf(Math.max(0, available));
  const daysOfCoverWithIncoming = coverOf(Math.max(0, supply));
  const leadTimeDemand = Math.ceil(velocity * i.leadTimeDays);
  const safetyStock = Math.ceil(velocity * i.safetyDays);
  /*
    PHẦN HOÀN CỦA CHÍNH CÁC ĐƠN TƯƠNG LAI. Kỳ kế hoạch dài `L + C + S` ngày; đơn gửi đi trong
    `L + C + S − lag` ngày đầu có hàng hoàn về kịp để bán lại trong kỳ. Làm tròn XUỐNG.
  */
  const horizon = i.leadTimeDays + i.coverDays + i.safetyDays;
  const futureReturnCredit = lag === null ? 0 : Math.floor(velocity * tyLeHoan * tyLeNhapLai * Math.max(0, horizon - lag) + 1e-9);
  const target = Math.max(0, Math.ceil(velocity * (i.leadTimeDays + i.coverDays)) + safetyStock - futureReturnCredit);
  const shortage = Math.max(0, -available);
  let suggested = Math.max(0, target - supply);
  if (i.roundTo > 1 && suggested > 0) suggested = Math.ceil(suggested / i.roundTo) * i.roundTo;
  // MỨC ĐẶT TỐI THIỂU của xưởng: đề xuất 5 cái trong khi xưởng chỉ nhận từ 50 là con số vô dụng —
  // nó khiến bảng trông chính xác trong khi đơn hàng không đặt được. Nâng lên đúng mức đặt được và
  // NÓI RA rằng đã nâng, để chủ shop biết phần chênh là do xưởng chứ không phải do nhu cầu.
  const suggestedBeforeMoq = suggested;
  const moq = Math.max(0, i.minOrderQty ?? 0);
  const moqApplied = suggested > 0 && moq > 1 && suggested < moq;
  if (moqApplied) suggested = moq;
  // Tình trạng nói về HÔM NAY nên vẫn tính trên tồn khả dụng: hàng hoàn còn trên đường về không
  // bán được ngay, gộp vào đây sẽ giấu mất mẫu mã đang đứt hàng.
  let status: PlanStatus;
  if (velocity <= 0 && available > 0) status = "IDLE";
  else if (available <= 0) status = "OUT";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays) status = "CRITICAL";
  else if (daysOfCover !== null && daysOfCover < i.leadTimeDays + i.safetyDays) status = "LOW";
  else status = velocity <= 0 ? "IDLE" : "OK";
  const stockOutDate = daysOfCover !== null && available > 0 ? new Date(today.getTime() + daysOfCover * 86_400_000).toISOString().slice(0, 10) : available <= 0 && velocity > 0 ? today.toISOString().slice(0, 10) : null;
  // HẠN ĐẶT HÀNG: lùi từ ngày hết hàng về đúng thời gian sản xuất. Ngày này ở quá khứ nghĩa là đã
  // muộn — vẫn hiện ra, vì giấu nó đi thì mẫu mã đang đứt hàng trông y hệt mẫu mã còn kịp.
  const reorderByDate = stockOutDate ? new Date(new Date(`${stockOutDate}T00:00:00Z`).getTime() - i.leadTimeDays * 86_400_000).toISOString().slice(0, 10) : null;
  return { available, velocity, rawVelocity: v.rawVelocity, velocityTrimmed: v.trimmed, daysOfCover, stockOutDate, reorderByDate,
    leadTimeDemand, safetyStock, target, shortage, suggested, suggestedBeforeMoq, moqApplied, status,
    incomingFromReturns, incomingFromTransit, incoming, supply, daysOfCoverWithIncoming, netVelocity, futureReturnCredit };
}

function clamp01(v: number) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
