/**
 * ═══════════ LỖ LŨY KẾ VÀ HOA HỒNG SAU BÙ LỖ — PHÉP TÍNH THUẦN ═══════════
 *
 * Chủ shop chốt 15/09/2026: **lợi nhuận âm của một MKTer không được xoá khi sang tháng mới.** Tháng
 * sau phải bù hết phần âm ấy trước, chỉ phần dương CÒN LẠI mới là cơ sở tính hoa hồng được trả.
 *
 * ─── VÌ SAO PHẢI CÓ FILE RIÊNG, KHÔNG NHÉT VÀO `lib/queries/payroll.ts` ───
 *
 * Bảng lương hôm nay tính hoa hồng cá nhân bằng `max(personalProfit, 0) × %`. Cái `max(…, 0)` ấy
 * đúng ở chỗ "không trả tiền âm cho người ta", nhưng nó cũng **vứt mất con số âm**: tháng lỗ 10
 * triệu và tháng hoà vốn cho ra cùng một kết quả là 0, nên tháng sau lãi 15 triệu thì người ấy ăn
 * hoa hồng trên đủ 15 triệu như chưa từng có tháng lỗ. Số âm phải được GIỮ LẠI ở một sổ, không
 * phải bị `max` nuốt.
 *
 * Phép tính này là **hàm thuần**: không đọc CSDL, không biết tháng nào đã chốt, không tự quyết
 * định số dư đầu kỳ. Đọc dữ liệu nằm ở `lib/queries/payroll-carryover.ts`. Tách ra vì ba lý do:
 * kiểm thử được từng ca bằng số chủ shop đưa; chạy hai lần ra đúng một kết quả; và không có đường
 * nào để một phép tính lặng lẽ ghi vào sổ.
 *
 * ─── BA CON SỐ KHÁC NHAU, ĐỪNG GỘP ───
 *
 *  1. **LN thực phát sinh của tháng** (`realProfit`) — kết quả kinh doanh thật của tháng ấy. Lỗ cũ
 *     KHÔNG được trừ vào đây lần nữa; nó đã là chi phí của tháng nó phát sinh rồi.
 *  2. **LN tính hoa hồng sau bù lỗ** (`commissionBase`) — chỉ dùng để tính thưởng.
 *  3. **Tiền hoa hồng phải trả** (`payableCommission`) — không bao giờ âm.
 *
 * "Hoa hồng có dấu" (`signedCommission`) là số để chủ shop THEO DÕI, không phải một khoản nợ mới
 * để cộng dồn. Chỉ `closingBalance` (số dư lợi nhuận) mới chuyển sang tháng sau. Cộng cả hai là
 * trừ một lần lỗ thành hai lần.
 */

/** Đơn vị tiền là VND nguyên; mọi giá trị ở đây đã là số nguyên hoặc sẽ được làm tròn tại chỗ khai báo. */
export type Dong = number;

/**
 * `null` = CHƯA BIẾT số dư đầu kỳ (chưa có tháng trước được xác lập), KHÁC HẲN 0 (đã xác minh là
 * không còn lỗ). AGENTS.md mục 42 · mục 8.5.
 */
export type OpeningBalance = Dong | null;

export type CarryoverInput = {
  /** Số dư lỗ mang sang, LUÔN ≤ 0. `null` = chưa biết. */
  openingBalance: OpeningBalance;
  /** LN thực phát sinh của tháng, đã trừ đủ chi phí thuộc tháng. Âm/dương/0 đều hợp lệ. */
  realProfit: Dong;
  /** Tỷ lệ hoa hồng cá nhân có hiệu lực của tháng hưởng, đơn vị PHẦN TRĂM (10 = 10%). */
  commissionPercent: number;
};

export type CarryoverResult = {
  openingBalance: OpeningBalance;
  realProfit: Dong;
  /** `S_t = P_t + D_{t-1}` — giữ được số âm. `null` khi số dư đầu kỳ chưa biết. */
  afterCarry: Dong | null;
  /** Phần lỗ cũ ĐƯỢC BÙ trong tháng này (≥ 0). */
  lossApplied: Dong | null;
  /** Phần lỗ MỚI phát sinh, làm số dư âm thêm (≥ 0). */
  lossAdded: Dong | null;
  /** `max(S_t, 0)` — cơ sở tính hoa hồng được trả. */
  commissionBase: Dong | null;
  /** `r × S_t`, GIỮ DẤU, chỉ để theo dõi. Không phải khoản phải trả, không cộng dồn. */
  signedCommission: Dong | null;
  /** `round(r × max(S_t, 0))` — tiền thật, không bao giờ âm. */
  payableCommission: Dong | null;
  /** `D_t = min(S_t, 0)` — số dư chuyển sang tháng sau, LUÔN ≤ 0. */
  closingBalance: Dong | null;
  /** Vì sao chưa tính được (rỗng khi tính được). */
  unknownReason: string | null;
};

const round = (v: number) => Math.round(v);

/**
 * Một tháng, một người. `realProfit` đã là LN thực của tháng — hàm này KHÔNG tự trừ chi phí nào.
 *
 * Thứ tự cố ý: bù lỗ trên ĐƠN VỊ LỢI NHUẬN trước, rồi mới áp tỷ lệ của tháng hưởng. Làm ngược lại
 * (quy lỗ thành "nợ hoa hồng" bằng tỷ lệ tháng cũ rồi trừ vào tiền) cho ra số khác ngay khi tỷ lệ
 * đổi, và biến một khoản lỗ KINH DOANH thành một khoản nợ TIỀN của nhân viên — thứ chủ shop không
 * yêu cầu và luật không cho phép.
 */
export function carryoverMonth(input: CarryoverInput): CarryoverResult {
  const { openingBalance, realProfit, commissionPercent } = input;
  const rate = Number(commissionPercent) / 100;

  if (openingBalance === null || !Number.isFinite(openingBalance)) {
    return {
      openingBalance: null,
      realProfit,
      afterCarry: null,
      lossApplied: null,
      lossAdded: null,
      commissionBase: null,
      signedCommission: null,
      payableCommission: null,
      closingBalance: null,
      unknownReason:
        "Chưa xác lập số dư lỗ đầu tháng (tháng trước chưa chốt hoặc chưa khai số dư mở sổ), nên chưa tính được cơ sở hoa hồng sau bù lỗ.",
    };
  }

  // Số dư mang sang theo định nghĩa là ≤ 0. Nhận vào một số dương là lỗi gọi hàm, không phải một
  // "khoản lãi mang sang" — lãi đã được trả hoa hồng ở tháng nó phát sinh, chuyển tiếp là trả hai lần.
  const opening = Math.min(0, round(openingBalance));
  const profit = round(realProfit);
  const afterCarry = profit + opening;
  const commissionBase = Math.max(afterCarry, 0);
  const closingBalance = Math.min(afterCarry, 0);

  return {
    openingBalance: opening,
    realProfit: profit,
    afterCarry,
    // Cả hai số dư đều ≤ 0 nên hiệu của chúng nói đúng chiều thay đổi.
    lossApplied: Math.max(0, closingBalance - opening),
    lossAdded: Math.max(0, opening - closingBalance),
    commissionBase,
    signedCommission: round(rate * afterCarry),
    payableCommission: round(rate * commissionBase),
    closingBalance,
    unknownReason: null,
  };
}

/**
 * Nhiều tháng liên tiếp của MỘT người. Tính TUẦN TỰ — số dư cuối tháng này là số dư đầu tháng sau.
 *
 * Không có đường tắt nào cho "xem cả quý": lấy `max` trên tổng ba tháng làm mất đúng phần lỗ mà cơ
 * chế này sinh ra để giữ. Muốn xem nhiều tháng thì cộng KẾT QUẢ của từng tháng, không cộng đầu vào.
 */
export function carryoverChain(
  months: readonly CarryoverInput[],
  opening: OpeningBalance,
): CarryoverResult[] {
  const out: CarryoverResult[] = [];
  let balance: OpeningBalance = opening;
  for (const m of months) {
    const r = carryoverMonth({ ...m, openingBalance: balance });
    out.push(r);
    balance = r.closingBalance;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HOA HỒNG LÀ CHI PHÍ — GIẢI HỆ, KHÔNG LẶP
   ══════════════════════════════════════════════════════════════════════════════

   Khi hoa hồng được tính trên chính lợi nhuận SAU khi đã trừ hoa hồng, ta có hệ:

       P = Q − H
       H = r × max(P + D, 0)

   Q = còn lại sau MỌI chi phí khác kể cả lương cứng; D ≤ 0 là lỗ mang sang.

   Giải đóng: giả sử P + D > 0 thì H = r(Q − H + D) ⇒ H = r(Q + D) / (1 + r).
   Khi đó P + D = (Q + D)/(1 + r) > 0 — giả thiết tự nhất quán, không cần kiểm lại.
   Ngược lại Q + D ≤ 0 thì H = 0 và P = Q, cũng tự nhất quán.

   Nên KHÔNG có vòng lặp, không có ngưỡng hội tụ, và chạy hai lần ra đúng một số.

   LÀM TRÒN: làm tròn ĐÚNG MỘT LẦN, ở `H` — vì `H` là tiền thật trả cho người thật. `P` suy ra
   bằng `Q − H`, nên đẳng thức `P + H = Q` luôn đúng tuyệt đối và không có đồng nào rơi vào khe
   làm tròn. Làm tròn cả hai rồi mới cộng là cách tạo ra chênh lệch 1 đồng không ai giải thích được.
*/

export type CommissionSolveInput = {
  /** Còn lại sau mọi chi phí khác (kể cả lương cứng), TRƯỚC hoa hồng. */
  beforeCommission: Dong;
  /** Số dư lỗ mang sang (≤ 0). `null` = chưa biết ⇒ không giải. */
  openingBalance: OpeningBalance;
  commissionPercent: number;
};

export type CommissionSolveResult = {
  solved: boolean;
  /** LN thực của tháng SAU khi đã trừ hoa hồng phải trả. */
  realProfit: Dong | null;
  payableCommission: Dong | null;
  commissionBase: Dong | null;
  closingBalance: Dong | null;
  reason: string | null;
};

export function solveCommissionWithCarryover(input: CommissionSolveInput): CommissionSolveResult {
  const { beforeCommission, openingBalance, commissionPercent } = input;
  const unsolved = (reason: string): CommissionSolveResult => ({
    solved: false,
    realProfit: null,
    payableCommission: null,
    commissionBase: null,
    closingBalance: null,
    reason,
  });

  if (openingBalance === null || !Number.isFinite(openingBalance)) {
    return unsolved("Chưa xác lập số dư lỗ đầu tháng nên không giải được hệ hoa hồng sau chi phí.");
  }
  const rate = Number(commissionPercent) / 100;
  if (!Number.isFinite(rate)) return unsolved("Tỷ lệ hoa hồng không hợp lệ.");
  // r = −100% làm mẫu số (1 + r) bằng 0: hệ vô nghiệm hoặc vô số nghiệm. Nói thẳng, không chia.
  if (1 + rate <= 0) {
    return unsolved(
      `Tỷ lệ hoa hồng ${commissionPercent}% làm hệ không giải được (mẫu số 1 + r ≤ 0). Đây là lỗi cấu hình, không phải kết quả bằng 0.`,
    );
  }
  if (!Number.isFinite(beforeCommission)) return unsolved("Lợi nhuận trước hoa hồng chưa biết.");

  const opening = Math.min(0, round(openingBalance));
  const q = round(beforeCommission);
  const qPlusD = q + opening;

  const payable = qPlusD > 0 ? round((rate * qPlusD) / (1 + rate)) : 0;
  const realProfit = q - payable;
  const afterCarry = realProfit + opening;

  return {
    solved: true,
    realProfit,
    payableCommission: payable,
    commissionBase: Math.max(afterCarry, 0),
    closingBalance: Math.min(afterCarry, 0),
    reason: null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   HỆ NHIỀU NGƯỜI Ở CẤP SHOP
   ══════════════════════════════════════════════════════════════════════════════

       P_shop = R − C_khác − Σ F_i − Σ B_i
       B_i    = a_i × max(P_shop, 0) + b_i × max(P_i + D_i, 0) + c_i × max(R_i, 0)

   Chỉ số hạng `a_i` phụ thuộc `P_shop`; hai số hạng còn lại là hằng đối với `P_shop` vì `P_i` và
   `R_i` đến từ phép quy kết, không từ lợi nhuận shop. Đặt `A = Σ a_i` và gom phần không phụ thuộc
   vào `K`:

       P_shop = K − A × max(P_shop, 0)

   K > 0 ⇒ P_shop = K / (1 + A)  (dương, tự nhất quán)
   K ≤ 0 ⇒ P_shop = K            (max bằng 0, tự nhất quán)

   ĐIỀU KIỆN TỒN TẠI: A > −1. Với A ≤ −1 hệ vô nghiệm hoặc vô số nghiệm — trả `solved: false` và
   nói lý do, KHÔNG in một con số. `A` chỉ âm khi có người khai % lợi nhuận tổng âm, tức lỗi cấu
   hình; im lặng nuốt nó là cách một bảng lương sai mà không ai thấy.

   KHÔNG BÙ CHÉO: lỗ của A không bao giờ bù bằng lãi của B — `D_i` chỉ vào số hạng `b_i` của chính
   người i.
*/

export type ShopPerson = {
  employeeId: string;
  /** a_i — % lợi nhuận TOÀN SHOP */
  percentTotal: number;
  /** b_i — % lợi nhuận CÁ NHÂN (áp trên cơ sở SAU bù lỗ) */
  percentPersonal: number;
  /** c_i — % doanh thu cá nhân */
  percentRevenue: number;
  /** Lương cứng thuộc kỳ */
  fixed: Dong;
  /** LN cá nhân thực phát sinh của kỳ (đã theo chính sách quy kết hiện hành) */
  personalProfit: Dong;
  /** Doanh thu quy kết của kỳ */
  personalRevenue: Dong;
  /** Số dư lỗ mang sang của CHÍNH người này (≤ 0), `null` = chưa biết */
  openingBalance: OpeningBalance;
};

export type ShopSolveInput = {
  /** Doanh thu thực của kỳ */
  revenue: Dong;
  /** Mọi chi phí khác của kỳ, KHÔNG gồm lương cứng và hoa hồng của những người liệt kê dưới đây */
  otherCost: Dong;
  people: readonly ShopPerson[];
};

export type ShopPersonResult = {
  employeeId: string;
  fixed: Dong;
  bonusTotal: Dong;
  bonusPersonal: Dong | null;
  bonusRevenue: Dong;
  /** Tổng phải trả cho người này; `null` khi một phần chưa biết */
  payable: Dong | null;
  carry: CarryoverResult;
};

export type ShopSolveResult = {
  solved: boolean;
  shopProfit: Dong | null;
  /** Tổng lương cứng + hoa hồng đã tính vào chi phí */
  payrollCost: Dong | null;
  people: ShopPersonResult[];
  reason: string | null;
};

export function solveShopPayroll(input: ShopSolveInput): ShopSolveResult {
  const { revenue, otherCost, people } = input;
  const A = people.reduce((t, p) => t + Number(p.percentTotal || 0) / 100, 0);
  if (!(1 + A > 0)) {
    return {
      solved: false,
      shopProfit: null,
      payrollCost: null,
      people: [],
      reason: `Tổng % lợi nhuận toàn shop của các nhân sự là ${(A * 100).toFixed(2)}% làm hệ không giải được (1 + A ≤ 0). Kiểm tra lại cấu hình % lợi nhuận tổng — đây là lỗi khai báo, không phải lợi nhuận bằng 0.`,
    };
  }

  // Bù lỗ đi trên ĐƠN VỊ LỢI NHUẬN của từng người, độc lập với P_shop.
  const carries = people.map((p) =>
    carryoverMonth({
      openingBalance: p.openingBalance,
      realProfit: p.personalProfit,
      commissionPercent: p.percentPersonal,
    }),
  );

  const fixedTotal = people.reduce((t, p) => t + Math.round(p.fixed || 0), 0);
  const revenueBonusTotal = people.reduce(
    (t, p) => t + Math.round(Math.max(0, p.personalRevenue || 0) * (Number(p.percentRevenue || 0) / 100)),
    0,
  );
  // Một người chưa biết số dư ⇒ thưởng theo LN cá nhân của người ấy CHƯA BIẾT. Đưa 0 vào K là
  // khẳng định "không phải trả gì", nên thay vào đó ta ghi nhận và trả `null` ở dòng người ấy,
  // đồng thời KHÔNG kết luận tổng chi phí lương của shop.
  const personalBonusKnown = carries.every((c) => c.payableCommission !== null);
  const personalBonusTotal = carries.reduce((t, c) => t + (c.payableCommission ?? 0), 0);

  const K = Math.round(revenue) - Math.round(otherCost) - fixedTotal - revenueBonusTotal - personalBonusTotal;
  const shopProfit = K > 0 ? Math.round(K / (1 + A)) : K;

  const results: ShopPersonResult[] = people.map((p, i) => {
    const bonusTotal = Math.round(Math.max(shopProfit, 0) * (Number(p.percentTotal || 0) / 100));
    const bonusRevenue = Math.round(Math.max(0, p.personalRevenue || 0) * (Number(p.percentRevenue || 0) / 100));
    const bonusPersonal = carries[i].payableCommission;
    const fixed = Math.round(p.fixed || 0);
    return {
      employeeId: p.employeeId,
      fixed,
      bonusTotal,
      bonusPersonal,
      bonusRevenue,
      payable: bonusPersonal === null ? null : fixed + bonusTotal + bonusPersonal + bonusRevenue,
      carry: carries[i],
    };
  });

  const payrollCost = results.every((r) => r.payable !== null)
    ? results.reduce((t, r) => t + (r.payable ?? 0), 0)
    : null;

  return {
    solved: true,
    shopProfit,
    payrollCost: personalBonusKnown ? payrollCost : null,
    people: results,
    reason: personalBonusKnown
      ? null
      : "Ít nhất một nhân sự chưa xác lập số dư lỗ đầu kỳ, nên tổng chi phí lương của kỳ là CHƯA BIẾT.",
  };
}
