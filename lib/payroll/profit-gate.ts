/**
 * ═══════════ CỔNG LỢI NHUẬN TOÀN CÔNG TY — HÀM THUẦN, MỘT ĐƯỜNG DUY NHẤT ═══════════
 *
 * Đặc tả: `docs/payroll-profit-gate.md`. Hằng số và quy chế: `lib/constants/payroll-profit-gate.ts`.
 *
 * Không đọc CSDL, không đọc đồng hồ, chạy hai lần ra cùng một kết quả. Bảng lương, ảnh chụp chốt kỳ,
 * lương tự động và script đối soát đều gọi CHÍNH hàm này — hai nơi tự nhân tỷ lệ là hai nơi sẽ nói
 * hai con số khác nhau về cùng một khoản thưởng.
 *
 * ─── CÔNG THỨC (một tháng lịch t) ───
 *
 *   N(t−1)  lợi nhuận lũy kế toàn công ty tới hết tháng trước, ĐÃ trừ thưởng lợi nhuận đã chia
 *   H(t−1)  mốc cao nhất đã chia (High-Water Mark), luôn ≥ N(t−1)
 *   B(t)    lợi nhuận của tháng TRƯỚC thưởng lợi nhuận, SAU mọi chi phí khác (giá vốn, quảng cáo,
 *           vận chuyển, hoàn, lương cố định, hoa hồng thông thường, vận hành, phân bổ)
 *
 *   Lỗ cần bù            L = H − N                (≥ 0)
 *   LN đủ điều kiện chia  E = max(0, B − L)
 *   Quỹ thưởng tối đa     Q = ⌊E × cap%⌋
 *   Đã phân bổ            S = min(Σ đề nghị, Q)  — chia theo tỷ lệ khi vượt quỹ, tổng KHÔNG BAO GIỜ > Q
 *   Lũy kế cuối tháng     N(t) = N + B − S
 *   Mốc mới               H(t) = E > 0 ? H + E − S : H
 *
 * Thưởng lợi nhuận KHÔNG nằm trong B — nó được tính TỪ B, nên tách ra là cách duy nhất không có
 * vòng lặp công thức (AGENTS.md mục 3.16 · `lib/constants/compensation-profit.ts`).
 *
 * Bất biến: H(t) ≥ N(t) với mọi t (chứng minh ở đặc tả §3). Hệ quả: lợi nhuận đã chia một lần không
 * bao giờ được chia lại — công ty lỗ sau một tháng đã thưởng thì phải lấy lại phần lỗ ấy TRƯỚC khi
 * phát sinh thưởng mới.
 */
import { PROFIT_GATE_LOSS_MESSAGE, type ProfitGateLedgerAdjustment } from "@/lib/constants/payroll-profit-gate";

export type ProfitGateStatus =
  /** Có lợi nhuận đủ điều kiện chia (E > 0). */
  | "ELIGIBLE"
  /** Đã xác lập, nhưng tháng này không có lợi nhuận đủ điều kiện (lỗ lũy kế chưa bù hết / tháng lỗ). */
  | "NO_ELIGIBLE_PROFIT"
  /** Chưa khai quy chế, hoặc số dư đầu tháng chưa xác lập. KHÔNG kết luận, chặn chốt. */
  | "NOT_ESTABLISHED"
  /** Thiếu chứng từ chi phí / con số chưa tính được. KHÔNG kết luận, chặn chốt. */
  | "DATA_INCOMPLETE"
  /** Kỳ không phải một tháng lịch, hoặc cơ sở không phải "Lợi nhuận tính lương". */
  | "NOT_APPLICABLE";

export const PROFIT_GATE_STATUS_LABEL: Record<ProfitGateStatus, string> = {
  ELIGIBLE: "Đủ điều kiện chia thưởng",
  NO_ELIGIBLE_PROFIT: "Chưa đủ điều kiện thưởng lợi nhuận",
  NOT_ESTABLISHED: "Chưa xác lập căn cứ",
  DATA_INCOMPLETE: "Thiếu dữ liệu — chưa kết luận",
  NOT_APPLICABLE: "Không áp dụng cho kỳ này",
};

/** Số dư đầu tháng của sổ lũy kế công ty. */
export type ProfitGateOpening = {
  cumulative: number;
  highWater: number;
  /** Thưởng lợi nhuận đã chia lũy kế (kể cả phần khai trước mốc mở sổ). */
  paidToDate: number;
  /**
   * `true` = mọi tháng từ mốc mở sổ tới tháng trước đều đã KHOÁ (hoặc chính là tháng mở sổ). Xem
   * được không có nghĩa là chốt được: số dư dựng từ tháng còn nháp sẽ đổi khi tháng ấy được chốt.
   */
  established: boolean;
  basis: "DECLARATION" | "LOCKED_MONTHS" | "SIMULATED";
  reason: string;
};

/**
 * MỘT KHOẢN THƯỞNG % LỢI NHUẬN CỦA MỘT NGƯỜI.
 *
 *  · `provisional` — TẠM TÍNH theo công thức của chính sách (LN kỳ × %), đúng con số bảng lương cũ in.
 *  · `demand`      — ĐỀ NGHỊ: như trên nhưng phần % LN toàn shop tính trên LN ĐỦ ĐIỀU KIỆN thay vì LN kỳ.
 *
 * `null` = CHƯA BIẾT (AGENTS.md mục 42), không phải 0.
 */
export type ProfitGateClaim = {
  key: string;
  employeeId: string;
  label: string;
  provisional: number | null;
  demand: number | null;
};

export type ProfitGateInput = {
  monthKey: string | null;
  /** `ok: false` ⇒ NOT_APPLICABLE kèm lý do. */
  applicable: { ok: true } | { ok: false; reason: string };
  policy: { poolCapPercent: number } | null;
  opening: ProfitGateOpening | null;
  /** Vì sao `opening` là `null` / chưa xác lập — in thẳng ra màn hình. */
  openingProblem: string | null;
  /** B(t). `null` = chưa tính được. */
  periodBase: number | null;
  /** Lỗ hổng chứng từ chi phí (cảnh báo mức `high` của máy chi phí). Có ⇒ DATA_INCOMPLETE. */
  costIssues: readonly string[];
  claims: readonly ProfitGateClaim[];
};

export type ProfitGateAllocation = ProfitGateClaim & {
  /** Thưởng ĐỦ ĐIỀU KIỆN DUYỆT. `null` = chưa kết luận được. */
  eligible: number | null;
  /** Phần CHƯA ĐỦ ĐIỀU KIỆN = tạm tính − đủ điều kiện. `null` khi chưa kết luận. */
  withheld: number | null;
  /** Vì sao chưa đủ điều kiện (hoặc vì sao bị giảm). `null` = đủ toàn bộ. */
  reason: string | null;
};

export type ProfitGateResult = {
  status: ProfitGateStatus;
  /** Đã có kết luận để trả tiền chưa (ELIGIBLE / NO_ELIGIBLE_PROFIT trên số dư ĐÃ xác lập). */
  established: boolean;
  message: string;
  monthKey: string | null;
  poolCapPercent: number | null;
  openingCumulative: number | null;
  openingHighWater: number | null;
  openingBasis: ProfitGateOpening["basis"] | null;
  /** L = H − N. */
  lossToRecover: number | null;
  periodBase: number | null;
  /** N + B — lũy kế trước khi chia thưởng tháng này. */
  cumulativeBeforeShare: number | null;
  eligibleProfit: number | null;
  poolCap: number | null;
  demandTotal: number | null;
  provisionalTotal: number | null;
  allocatedTotal: number | null;
  /** Q − S: phần quỹ còn được phép phân bổ. */
  remaining: number | null;
  /** Thưởng lợi nhuận đã chia lũy kế TRƯỚC tháng này. */
  paidToDate: number | null;
  closingCumulative: number | null;
  closingHighWater: number | null;
  allocations: ProfitGateAllocation[];
};

const vnd = (v: number) => `${Math.round(v).toLocaleString("vi-VN")} ₫`;

const sumOrNull = (xs: readonly (number | null)[]): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((t, x) => t + (x ?? 0), 0));

/**
 * ═══ CHIA QUỸ CHO NHIỀU NGƯỜI — TỔNG KHÔNG BAO GIỜ VƯỢT QUỸ ═══
 *
 * Tổng đề nghị ≤ quỹ ⇒ ai cũng nhận đủ. Vượt ⇒ chia theo tỷ lệ đề nghị, làm tròn XUỐNG từng phần,
 * rồi phát lần lượt từng đồng còn dư cho phần có số lẻ lớn nhất (hoà thì theo khoá, để chạy hai lần
 * ra cùng kết quả). Tổng ra ĐÚNG bằng quỹ — không thiếu một đồng, không thừa một đồng.
 *
 * Dùng BigInt: đề nghị × quỹ có thể vượt 2^53 (một tỷ × một tỷ), và một phép nhân số thực sai một
 * đồng là một phiếu lương sai một đồng.
 */
export function allocatePool(claims: readonly { key: string; demand: number }[], pool: number): Map<string, number> {
  const out = new Map<string, number>();
  const cap = Math.max(0, Math.floor(pool));
  const demands = claims.map((c) => ({ key: c.key, d: Math.max(0, Math.round(c.demand)) }));
  const total = demands.reduce((t, c) => t + c.d, 0);
  if (total <= cap) {
    for (const c of demands) out.set(c.key, c.d);
    return out;
  }
  const T = BigInt(total);
  const P = BigInt(cap);
  const parts = demands.map((c) => {
    const num = BigInt(c.d) * P;
    return { key: c.key, base: Number(num / T), rem: num % T };
  });
  let left = cap - parts.reduce((t, p) => t + p.base, 0);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  for (const p of order) {
    if (left <= 0) break;
    p.base += 1;
    left -= 1;
  }
  for (const p of parts) out.set(p.key, p.base);
  return out;
}

export function evaluateProfitGate(input: ProfitGateInput): ProfitGateResult {
  const provisionalTotal = sumOrNull(input.claims.map((c) => c.provisional));
  const demandTotal = sumOrNull(input.claims.map((c) => c.demand));
  const base: ProfitGateResult = {
    status: "NOT_ESTABLISHED",
    established: false,
    message: "",
    monthKey: input.monthKey,
    poolCapPercent: input.policy?.poolCapPercent ?? null,
    openingCumulative: input.opening?.cumulative ?? null,
    openingHighWater: input.opening?.highWater ?? null,
    openingBasis: input.opening?.basis ?? null,
    lossToRecover: input.opening ? Math.max(0, input.opening.highWater - input.opening.cumulative) : null,
    periodBase: input.periodBase,
    cumulativeBeforeShare: input.opening && input.periodBase !== null ? input.opening.cumulative + input.periodBase : null,
    eligibleProfit: null,
    poolCap: null,
    demandTotal,
    provisionalTotal,
    allocatedTotal: null,
    remaining: null,
    paidToDate: input.opening?.paidToDate ?? null,
    closingCumulative: null,
    closingHighWater: null,
    allocations: [],
  };

  /*
    CHƯA KẾT LUẬN ĐƯỢC ⇒ khoản nào thật sự BẰNG 0 thì vẫn là 0 (không có gì để chặn); khoản nào có
    số tạm tính khác 0 thì "đủ điều kiện" là CHƯA BIẾT — không được in thành 0 (người ta sẽ hiểu là
    "không được thưởng"), cũng không được in thành số tạm tính (đó là trả trước khi xét).
  */
  const undecided = (status: ProfitGateStatus, message: string): ProfitGateResult => ({
    ...base,
    status,
    message,
    allocations: input.claims.map((c) => {
      const zero = c.provisional === 0 && (c.demand === 0 || c.demand === null);
      return { ...c, eligible: zero ? 0 : null, withheld: zero ? 0 : null, reason: zero ? null : message };
    }),
  });

  if (!input.applicable.ok) return undecided("NOT_APPLICABLE", input.applicable.reason);
  if (input.costIssues.length) {
    return undecided(
      "DATA_INCOMPLETE",
      `Thiếu chứng từ chi phí nên chưa xác định được lợi nhuận đủ điều kiện chia — chặn duyệt thưởng tự động. ${input.costIssues.join(" · ")}`,
    );
  }
  if (input.periodBase === null) return undecided("DATA_INCOMPLETE", "Lợi nhuận của tháng chưa tính được, nên chưa xét được thưởng lợi nhuận.");
  if (!input.policy) {
    return undecided(
      "NOT_ESTABLISHED",
      "Chưa khai quy chế chia thưởng lợi nhuận (số dư lỗ lũy kế đã đối soát + quỹ thưởng tối đa). Thưởng % lợi nhuận chưa đủ điều kiện duyệt cho tới khi người có quyền duyệt lương khai ở Lương → Cấu hình.",
    );
  }
  if (!input.opening) return undecided("NOT_ESTABLISHED", input.openingProblem ?? "Số dư lũy kế đầu tháng chưa xác lập.");
  if (demandTotal === null) return undecided("DATA_INCOMPLETE", "Một khoản thưởng % lợi nhuận tạm tính đang CHƯA BIẾT, nên chưa chia được quỹ.");

  const { cumulative: N, highWater: H } = input.opening;
  const B = input.periodBase;
  const L = Math.max(0, H - N);
  const E = Math.max(0, B - L);
  const cap = input.policy.poolCapPercent;
  const Q = Math.floor((E * cap) / 100);
  const alloc = allocatePool(
    input.claims.map((c) => ({ key: c.key, demand: c.demand ?? 0 })),
    Q,
  );
  const S = [...alloc.values()].reduce((t, v) => t + v, 0);
  const scaled = demandTotal > Q;
  /** Lỗ còn phải bù SAU tháng này (tháng lỗ thì lỗ tăng thêm). */
  const conLo = Math.max(0, L - B);

  const message =
    E > 0
      ? `Lợi nhuận tháng ${vnd(B)}${L > 0 ? `, đã bù hết ${vnd(L)} lỗ lũy kế` : ""} ⇒ lợi nhuận đủ điều kiện chia ${vnd(E)}, quỹ thưởng tối đa ${cap}% = ${vnd(Q)}.${scaled ? ` Tổng đề nghị ${vnd(demandTotal)} vượt quỹ nên chia theo tỷ lệ.` : ""}`
      : L > 0
        ? `${PROFIT_GATE_LOSS_MESSAGE} Lỗ lũy kế cần bù đầu tháng ${vnd(L)}; lợi nhuận tháng ${vnd(B)}${conLo > 0 ? ` — còn ${vnd(conLo)} phải bù trước khi phát sinh thưởng mới` : ""}.`
        : `Lợi nhuận tháng ${vnd(B)} ≤ 0 nên không có lợi nhuận đủ điều kiện chia.`;

  const allocations: ProfitGateAllocation[] = input.claims.map((c) => {
    const eligible = alloc.get(c.key) ?? 0;
    const prov = c.provisional ?? 0;
    const withheld = Math.max(0, prov - eligible);
    let reason: string | null = null;
    if (withheld > 0) {
      if (E <= 0) reason = L > 0 ? `${PROFIT_GATE_LOSS_MESSAGE} Còn ${vnd(conLo)} lỗ cần bù.` : "Lợi nhuận toàn công ty của tháng ≤ 0.";
      else {
        const parts: string[] = [];
        if ((c.demand ?? 0) < prov) parts.push(`phần % lợi nhuận toàn công ty tính trên lợi nhuận đủ điều kiện ${vnd(E)} thay vì lợi nhuận tháng ${vnd(B)}`);
        if (eligible < (c.demand ?? 0)) parts.push(`quỹ thưởng tối đa ${vnd(Q)} nhỏ hơn tổng đề nghị ${vnd(demandTotal)}, chia theo tỷ lệ`);
        reason = `Giảm vì ${parts.join("; ")}.`;
      }
    }
    return { ...c, eligible, withheld, reason };
  });

  const established = input.opening.established;
  return {
    ...base,
    status: E > 0 ? "ELIGIBLE" : "NO_ELIGIBLE_PROFIT",
    established,
    message: established ? message : `${message} (MÔ PHỎNG — ${input.opening.reason})`,
    lossToRecover: L,
    eligibleProfit: E,
    poolCap: Q,
    allocatedTotal: S,
    remaining: Q - S,
    closingCumulative: N + B - S,
    closingHighWater: E > 0 ? H + E - S : H,
    allocations,
  };
}

/** Số dư đầu của tháng kế tiếp, từ kết quả đã có số của tháng này. */
export function nextOpening(opening: ProfitGateOpening, result: ProfitGateResult, monthLocked: boolean, reason: string): ProfitGateOpening | null {
  if (result.closingCumulative === null || result.closingHighWater === null || result.allocatedTotal === null) return null;
  const established = opening.established && monthLocked;
  return {
    cumulative: result.closingCumulative,
    highWater: result.closingHighWater,
    paidToDate: opening.paidToDate + result.allocatedTotal,
    established,
    basis: established ? "LOCKED_MONTHS" : "SIMULATED",
    reason: established ? "Dựng từ số dư mở sổ đã duyệt và các tháng đã khoá." : reason,
  };
}

/**
 * ═══ PHẦN CỦA CỔNG ĐƯỢC CHỤP VÀO KỲ ĐÃ KHOÁ ═══
 *
 * Đủ để tháng sau dựng lại số dư mà KHÔNG tính lại tháng này (AGENTS.md mục 21). `periodBase` là
 * lợi nhuận của RIÊNG tháng ấy; các khoản điều chỉnh muộn của những tháng ĐÃ KHOÁ trước đó nằm riêng
 * ở `lateAdjustments` — gộp vào một ô thì tháng sau đo chênh lệch của tháng này sẽ trừ lại khoản ấy
 * một lần nữa, và mất dấu "tháng k đã được ghi bù bao nhiêu" (cần để không ghi bù hai lần).
 */
export type ProfitGateSnapshot = {
  calcVersion: number;
  policyVersion: number | null;
  monthKey: string;
  status: ProfitGateStatus;
  established: boolean;
  periodBase: number | null;
  /** Điều chỉnh lũy kế tường minh đã ghi vào tháng này, chụp lại nguyên văn lúc khoá. */
  lateAdjustments: LateAdjustment[];
  /**
   * LỢI NHUẬN TỪNG MÃ của riêng tháng này (`docs/payroll-code-ledger.md`). Sổ mã các tháng sau dựng lại
   * từ chuỗi số này bằng hàm thuần — không tính lại tháng đã khoá. `undefined` = ảnh chụp trước Payroll V2.
   */
  codes?: { productId: string; code: string; profit: number }[];
  openingCumulative: number | null;
  openingHighWater: number | null;
  eligibleProfit: number | null;
  poolCap: number | null;
  allocatedTotal: number | null;
  closingCumulative: number | null;
  closingHighWater: number | null;
  paidToDate: number | null;
};

/**
 * CHỨNG TỪ ĐẾN MUỘN CỦA THÁNG ĐÃ KHOÁ — một dòng điều chỉnh lũy kế TƯỜNG MINH, có người duyệt
 * (`ProfitGateLedgerAdjustment`). ERP không tự đo lại tháng đã khoá: xem khối chú thích ở
 * `lib/constants/payroll-profit-gate.ts`.
 */
export type LateAdjustment = ProfitGateLedgerAdjustment;

/** Lợi nhuận đủ điều kiện chia khi đã biết số dư đầu và lợi nhuận tháng. */
export function eligibleProfitOf(opening: Pick<ProfitGateOpening, "cumulative" | "highWater"> | null, periodBase: number | null): number | null {
  if (!opening || periodBase === null) return null;
  return Math.max(0, periodBase - Math.max(0, opening.highWater - opening.cumulative));
}

/**
 * ĐI QUA MỘT THÁNG ĐÃ KHOÁ bằng số ĐÃ CHỤP — không tính lại.
 *
 * `allocated` là thưởng lợi nhuận THẬT SỰ đã chốt cho tháng ấy. Nếu một tháng cũ (khoá trước khi có
 * cổng) đã chốt thưởng vượt lợi nhuận đủ điều kiện, phần vượt làm lỗ cần bù TĂNG lên — đúng như
 * tiền đã ra khỏi túi — chứ không bị bỏ qua.
 */
export function lockedMonthStep(opening: ProfitGateOpening, base: number, allocated: number): ProfitGateOpening {
  const E = eligibleProfitOf(opening, base) ?? 0;
  return {
    cumulative: opening.cumulative + base - allocated,
    // `max`: mốc không bao giờ lùi. Tháng cũ chốt thưởng VƯỢT phần đủ điều kiện thì mốc đứng yên và
    // lũy kế tụt xuống dưới mốc — phần trả vượt thành lỗ phải bù, không thành "miễn phí".
    highWater: E > 0 ? Math.max(opening.highWater, opening.highWater + E - allocated) : opening.highWater,
    paidToDate: opening.paidToDate + allocated,
    established: opening.established,
    basis: opening.established ? "LOCKED_MONTHS" : opening.basis,
    reason: opening.reason,
  };
}
