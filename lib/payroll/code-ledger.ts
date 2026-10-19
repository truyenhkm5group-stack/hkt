/**
 * ═══════════ SỔ LỢI NHUẬN THEO MÃ + THƯỞNG OWNER / SUPPORT — HÀM THUẦN ═══════════
 *
 * Đặc tả: `docs/payroll-code-ledger.md`. Chủ shop giao 19/10/2026 (Payroll V2).
 *
 * Không đọc CSDL, không đọc đồng hồ, chạy hai lần ra cùng kết quả.
 *
 * ─── BA TẦNG, THEO ĐÚNG THỨ TỰ ───
 *
 *  1. SỔ MÃ: mỗi mã có lũy kế và mốc cao nhất đã xét (High-Water Mark) RIÊNG, đứng trên lợi nhuận của
 *     mã tính MỘT lần (`products[].profit` — doanh thu dòng hàng, giá vốn, quảng cáo, vận chuyển,
 *     chi phí phân bổ). Đổi người phụ trách KHÔNG chạm sổ: sổ đi theo mã, không theo người.
 *
 *        Cum(t)      = Cum(t−1) + Profit(t)
 *        Eligible(t) = max(0, Cum(t) − max(0, HWM(t−1)))
 *        HWM(t)      = max(HWM(t−1), Cum(t))
 *
 *  2. CỔNG CÔNG TY: Σ phần đủ điều kiện của các mã KHÔNG được vượt lợi nhuận đủ điều kiện của CÔNG
 *     TY (`lib/payroll/profit-gate.ts`). Vượt thì phân bổ theo tỷ trọng phần đủ điều kiện của mã.
 *     Lãi của mã không bao giờ vượt qua lỗ của công ty.
 *
 *  3. CHIA THƯỞNG CỦA MỘT MÃ:
 *        OwnerBonus     = Allocated × X%
 *        SupportPool    = Allocated × Y%
 *        SupportBonus_i = SupportPool × Weight_i     (Σ Weight của SUPPORT hợp lệ = 100%)
 *     Trọng số lấy theo cách đã duyệt: tay (`MANUAL`), chi phí quảng cáo đối soát được (`AD_SPEND`),
 *     doanh thu quy kết (`ATTRIBUTED_REVENUE`). Thiếu căn cứ ⇒ `PENDING_RECONCILIATION` — KHÔNG BAO
 *     GIỜ tự chia đều.
 *
 * HWM của mã tiến lên cả khi công ty chưa đủ điều kiện: phần lãi ấy đã đi bù lỗ công ty, nên nó
 * KHÔNG trở thành quyền thưởng treo (chủ shop: "không mặc định chuyển thưởng chưa đủ điều kiện thành
 * khoản nợ thưởng phải trả").
 */
import { allocatePool } from "@/lib/payroll/profit-gate";

export type CodeState = { cumulative: number; highWater: number };
export type CodeMonthProfit = { productId: string; code: string; profit: number };

export type CodeLedgerRow = {
  productId: string;
  code: string;
  profit: number;
  openingCumulative: number;
  openingHighWater: number;
  cumulative: number;
  /** max(0, HWM) − lũy kế đầu tháng: phần lỗ / chênh mã phải lấp trước khi có lãi mới. */
  lossToRecover: number;
  eligible: number;
  closingHighWater: number;
};

const ZERO: CodeState = { cumulative: 0, highWater: 0 };

/** Một tháng của sổ mã. Mã không có số tháng này giữ nguyên trạng thái (lợi nhuận 0). */
export function codeLedgerStep(opening: ReadonlyMap<string, CodeState>, figures: readonly CodeMonthProfit[]): { rows: CodeLedgerRow[]; closing: Map<string, CodeState> } {
  const closing = new Map<string, CodeState>(opening);
  const rows: CodeLedgerRow[] = [];
  for (const f of figures) {
    const o = opening.get(f.productId) ?? ZERO;
    const cumulative = o.cumulative + f.profit;
    const hw = Math.max(0, o.highWater);
    const eligible = Math.max(0, cumulative - hw);
    const closingHighWater = Math.max(o.highWater, cumulative);
    rows.push({
      productId: f.productId,
      code: f.code,
      profit: f.profit,
      openingCumulative: o.cumulative,
      openingHighWater: o.highWater,
      cumulative,
      lossToRecover: Math.max(0, hw - o.cumulative),
      eligible,
      closingHighWater,
    });
    closing.set(f.productId, { cumulative, highWater: closingHighWater });
  }
  return { rows, closing };
}

/**
 * Phân bổ lợi nhuận đủ điều kiện của CÔNG TY xuống các mã. Σ phân bổ ≤ min(Σ đủ điều kiện mã, đủ
 * điều kiện công ty), đúng từng đồng; vượt thì theo tỷ trọng phần đủ điều kiện của mã.
 */
export function allocateCompanyToCodes(rows: readonly Pick<CodeLedgerRow, "productId" | "eligible">[], companyEligible: number): Map<string, number> {
  return allocatePool(
    rows.filter((r) => r.eligible > 0).map((r) => ({ key: r.productId, demand: r.eligible })),
    Math.max(0, companyEligible),
  );
}

export type CodeRole = "OWNER" | "SUPPORT";
export type WeightMethod = "MANUAL" | "AD_SPEND" | "ATTRIBUTED_REVENUE";

export const WEIGHT_METHOD_LABEL: Record<WeightMethod, string> = {
  MANUAL: "Tỷ lệ tay đã duyệt",
  AD_SPEND: "Theo chi phí quảng cáo đối soát được",
  ATTRIBUTED_REVENUE: "Theo doanh thu quy kết",
};

export type CodeAssignment = {
  id: string;
  productId: string;
  employeeId: string;
  role: CodeRole;
  ownerRateBp: number | null;
  weightMethod: WeightMethod | null;
  weightBp: number | null;
  from: Date;
  to: Date | null;
  policyRef: string;
};

export type CodeTerms = {
  id: string;
  /** `null` = điều khoản mặc định của công ty. */
  productId: string | null;
  supportPoolBp: number;
  maxBonusAmount: number | null;
  from: Date;
  to: Date | null;
  policyRef: string;
};

/**
 * MỘT ĐOẠN của tháng mà trong đó phân công và điều khoản của mã KHÔNG đổi. `weight` = phần của
 * tháng thuộc đoạn này (theo nghiệp vụ phát sinh trong đoạn — lớp truy vấn quyết căn cứ), Σ = 1.
 */
export type CodeSegment = {
  from: Date;
  to: Date;
  weight: number;
  /** Chi phí quảng cáo ĐỐI SOÁT ĐƯỢC của từng MKTer trên mã trong đoạn. */
  adSpendByEmployee: ReadonlyMap<string, number>;
  /** Doanh thu quy kết cho từng MKTer trên mã trong đoạn. */
  revenueByEmployee: ReadonlyMap<string, number>;
};

export type CodeBonusClaim = {
  key: string;
  employeeId: string;
  productId: string;
  code: string;
  role: CodeRole;
  segment: { from: Date; to: Date };
  /** % thực áp lên LN của mã cho khoản này (X, hoặc Y × trọng số). */
  ratePercent: number;
  /** Tạm tính trên phần đủ điều kiện CỦA MÃ (chưa qua cổng công ty). */
  provisional: number;
  /** Đề nghị trên phần đã PHÂN BỔ từ quỹ công ty, sau trần theo mã. `null` = công ty chưa kết luận. */
  demand: number | null;
  policyRef: string;
  label: string;
};

export type CodePending = {
  productId: string;
  code: string;
  employeeId: string | null;
  segment: { from: Date; to: Date };
  reason: string;
  /** Tạm tính của phần đang chờ (nếu tính được), để người duyệt thấy đang treo bao nhiêu. */
  provisional: number | null;
};

const covers = (from: Date, to: Date | null, a: Date, b: Date) => from.getTime() <= a.getTime() && (to === null || to.getTime() >= b.getTime());

/**
 * Chia `pool` theo trọng số: làm tròn xuống từng phần rồi phát từng đồng dư cho phần có số lẻ lớn
 * nhất (hoà thì theo khoá). Σ ĐÚNG bằng `pool` khi tổng trọng số > 0. BigInt vì pool × trọng số có
 * thể vượt 2^53.
 */
export function splitByWeights(pool: number, items: readonly { key: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const P = BigInt(Math.max(0, Math.floor(pool)));
  const ws = items.map((i) => ({ key: i.key, w: BigInt(Math.max(0, Math.round(i.weight))) }));
  const T = ws.reduce((t, i) => t + i.w, BigInt(0));
  if (T === BigInt(0)) {
    for (const i of ws) out.set(i.key, 0);
    return out;
  }
  const parts = ws.map((i) => ({ key: i.key, base: (P * i.w) / T, rem: (P * i.w) % T }));
  let left = P - parts.reduce((t, x) => t + x.base, BigInt(0));
  for (const x of [...parts].sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1))) {
    if (left <= BigInt(0)) break;
    x.base += BigInt(1);
    left -= BigInt(1);
  }
  for (const x of parts) out.set(x.key, Number(x.base));
  return out;
}

/** Khoản % theo số nguyên tiền: làm tròn XUỐNG — tổng không bao giờ vượt phần đem chia. */
const pct = (amount: number, bp: number) => Math.floor((Math.max(0, amount) * bp) / 10_000);

/**
 * ═══ CHIA THƯỞNG CỦA MỘT MÃ TRONG MỘT THÁNG ═══
 *
 * `eligible` = phần đủ điều kiện của mã (sổ mã); `allocated` = phần sau khi đã chia quỹ công ty
 * (`null` = cổng công ty chưa kết luận ⇒ chỉ có số tạm tính). Mỗi đoạn tính độc lập trên phần của
 * đoạn (`weight`), với phân công / điều khoản THỰC SỰ hiệu lực trong đoạn.
 */
export function codeBonusClaims(input: {
  productId: string;
  code: string;
  eligible: number;
  allocated: number | null;
  segments: readonly CodeSegment[];
  assignments: readonly CodeAssignment[];
  terms: readonly CodeTerms[];
  nameOf?: (employeeId: string) => string;
}): { claims: CodeBonusClaim[]; pending: CodePending[] } {
  const claims: CodeBonusClaim[] = [];
  const pending: CodePending[] = [];
  const ten = input.nameOf ?? ((id: string) => id);
  if (input.eligible <= 0) return { claims, pending };

  input.segments.forEach((seg, si) => {
    const span = { from: seg.from, to: seg.to };
    const eligS = Math.floor(input.eligible * seg.weight);
    const allocS = input.allocated === null ? null : Math.floor(input.allocated * seg.weight);
    const here = input.assignments.filter((a) => a.productId === input.productId && covers(a.from, a.to, seg.from, seg.to));
    const owners = here.filter((a) => a.role === "OWNER");
    const supports = here.filter((a) => a.role === "SUPPORT");
    if (!owners.length && !supports.length) return;
    const own = input.terms.filter((t) => t.productId === input.productId && covers(t.from, t.to, seg.from, seg.to));
    const dflt = input.terms.filter((t) => t.productId === null && covers(t.from, t.to, seg.from, seg.to));
    const termsHere = own.length ? own : dflt;
    const segClaims: CodeBonusClaim[] = [];
    const nghi = (employeeId: string | null, reason: string, provisional: number | null) =>
      pending.push({ productId: input.productId, code: input.code, employeeId, segment: span, reason, provisional });

    if (termsHere.length > 1) {
      nghi(null, `Mã ${input.code}: ${termsHere.length} điều khoản thưởng cùng hiệu lực trong đoạn — ERP không chọn hộ.`, null);
      return;
    }
    const term = termsHere[0] ?? null;
    if (owners.length > 1) {
      nghi(null, `Mã ${input.code}: ${owners.length} OWNER cùng hiệu lực trong đoạn — mỗi mã tối đa một OWNER một lúc.`, null);
      return;
    }
    const owner = owners[0] ?? null;
    const x = owner?.ownerRateBp ?? 0;
    const y = supports.length ? (term?.supportPoolBp ?? null) : 0;
    if (y !== null && x + y > 10_000) {
      nghi(null, `Mã ${input.code}: X% (${x / 100}%) + Y% (${y / 100}%) vượt 100% lợi nhuận đủ điều kiện của mã.`, null);
      return;
    }

    if (owner) {
      segClaims.push({
        key: `${owner.employeeId}:CODE:${input.productId}:OWNER:${si}`,
        employeeId: owner.employeeId,
        productId: input.productId,
        code: input.code,
        role: "OWNER",
        segment: span,
        ratePercent: x / 100,
        provisional: pct(eligS, x),
        demand: allocS === null ? null : pct(allocS, x),
        policyRef: owner.policyRef,
        label: `${ten(owner.employeeId)} · OWNER mã ${input.code} (${x / 100}%)`,
      });
    }

    if (supports.length) {
      if (y === null) {
        for (const s of supports) nghi(s.employeeId, `Mã ${input.code}: có SUPPORT nhưng chưa có điều khoản Y% (quỹ hỗ trợ) hiệu lực trong đoạn.`, null);
      } else {
        const methods = new Set(supports.map((s) => s.weightMethod));
        const poolProv = pct(eligS, y);
        if (methods.size > 1) {
          for (const s of supports) nghi(s.employeeId, `Mã ${input.code}: các SUPPORT dùng ${methods.size} cách tính trọng số khác nhau trong cùng đoạn — phải cùng một cách.`, null);
        } else {
          const method = [...methods][0] as WeightMethod;
          const raw = supports.map((s) => ({
            s,
            w: method === "MANUAL" ? (s.weightBp ?? 0) : method === "AD_SPEND" ? Math.max(0, seg.adSpendByEmployee.get(s.employeeId) ?? 0) : Math.max(0, seg.revenueByEmployee.get(s.employeeId) ?? 0),
          }));
          const tong = raw.reduce((t, r) => t + r.w, 0);
          const hongTay = method === "MANUAL" && tong !== 10_000;
          if (tong <= 0 || hongTay) {
            const why =
              method === "MANUAL"
                ? `tổng trọng số tay của SUPPORT là ${tong / 100}% — phải đúng 100%`
                : method === "AD_SPEND"
                  ? "không SUPPORT nào có chi phí quảng cáo đối soát được trên mã trong đoạn"
                  : "không SUPPORT nào có doanh thu quy kết trên mã trong đoạn";
            for (const r of raw) nghi(r.s.employeeId, `Mã ${input.code}: PENDING_RECONCILIATION — ${why}. ERP không tự chia đều.`, poolProv);
          } else {
            const poolDemand = allocS === null ? null : pct(allocS, y);
            const items = raw.map((r) => ({ key: r.s.id, weight: r.w }));
            const prov = splitByWeights(poolProv, items);
            const dem = poolDemand === null ? null : splitByWeights(poolDemand, items);
            for (const r of raw) {
              segClaims.push({
                key: `${r.s.employeeId}:CODE:${input.productId}:SUPPORT:${si}`,
                employeeId: r.s.employeeId,
                productId: input.productId,
                code: input.code,
                role: "SUPPORT",
                segment: span,
                ratePercent: (y / 100) * (r.w / tong),
                provisional: prov.get(r.s.id) ?? 0,
                demand: dem === null ? null : (dem.get(r.s.id) ?? 0),
                policyRef: r.s.policyRef,
                label: `${ten(r.s.employeeId)} · SUPPORT mã ${input.code} (${((y / 100) * (r.w / tong)).toFixed(2)}%)`,
              });
            }
          }
        }
      }
    }

    // ─── TRẦN THƯỞNG CỦA MÃ (theo điều khoản của đoạn, chia theo phần của đoạn) ───
    if (term?.maxBonusAmount !== null && term?.maxBonusAmount !== undefined) {
      const tran = Math.floor(term.maxBonusAmount * seg.weight);
      const capProv = allocatePool(segClaims.map((c) => ({ key: c.key, demand: c.provisional })), tran);
      const capDem = segClaims.every((c) => c.demand !== null) ? allocatePool(segClaims.map((c) => ({ key: c.key, demand: c.demand ?? 0 })), tran) : null;
      for (const c of segClaims) {
        c.provisional = capProv.get(c.key) ?? 0;
        if (capDem) c.demand = capDem.get(c.key) ?? 0;
      }
    }
    claims.push(...segClaims);
  });
  return { claims, pending };
}
