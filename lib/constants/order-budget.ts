import type { InventoryDecisionKind } from "@/lib/constants/inventory-decision";

/**
 * ═══════════ NGÂN SÁCH ĐẶT HÀNG 30 NGÀY — ĐỀ XUẤT ĐẶT SO VỚI TIỀN THẬT ═══════════
 *
 * Trang Quyết định vốn tồn kho cộng ra "Vốn cần cho đề xuất đặt" — một con số đứng MỘT MÌNH. Nó trả lời
 * "cần bao nhiêu", không trả lời "có đủ tiền không", và càng không trả lời "nếu không đủ thì đặt mẫu nào
 * trước". Ngành bán lẻ gọi đây là hạn mức mua (open-to-buy); ở đây là bản RÚT GỌN, ghép ba con số đã có:
 *
 *   · TIỀN ĐANG CÓ       — `getCashPosition()` (số dư do ngân hàng ghi / ERP cộng thêm; chưa biết thì `null`);
 *   · DÒNG TIỀN 30 NGÀY  — kỳ 30 ngày của `getCashflow()` (COD sắp về − quảng cáo − vận hành − tiền xưởng
 *                          của lệnh ĐÃ gửi). Lệnh đã gửi nằm ở đây, nên đề xuất đặt (đã trừ hàng đặt
 *                          xưởng) KHÔNG bị đếm hai lần;
 *   · ĐỀ XUẤT ĐẶT        — dòng NGUY CƠ HẾT HÀNG / NÊN ĐẶT THÊM của `decideInventory`.
 *
 *   Dư địa = tiền đang có + dòng tiền ròng 30 ngày.  Đặt theo thứ tự ưu tiên cho tới khi hết dư địa.
 *
 * KHÔNG có ngưỡng nào ở đây (luật 38): không có "quỹ dự phòng mặc định", không có "giữ lại 20%". Muốn giữ
 * bao nhiêu là quyết định của chủ shop — màn hình in số còn lại sau khi đặt, người đọc tự cân.
 *
 * ─── BA CHỖ KHÔNG ĐƯỢC NÓI QUÁ ───
 *
 *  1. SỐ DƯ CHƯA BIẾT ⇒ KHÔNG có dư địa, KHÔNG xếp dòng nào vào "trong ngân sách". Lấy 0 làm số dư là kết
 *     luận "không đủ tiền" cho một shop có thể đang có vài trăm triệu.
 *  2. SỐ DƯ THIẾU TÀI KHOẢN ⇒ dư địa là CẬN DƯỚI. "Đủ tiền" vẫn đúng; "không đủ" thì CHƯA CHẮC — phải nói ra.
 *  3. ĐỀ XUẤT THIẾU GIÁ NHẬP ⇒ không xếp được vào ngân sách (không biết tốn bao nhiêu), đếm riêng; không
 *     coi là 0đ rồi nhét vào hàng đầu.
 *
 * Thứ tự ưu tiên là TIỀN ĐANG MẤT trước: nguy cơ hết hàng đứng trước nên đặt thêm; trong cùng nhóm, ước lãi
 * gộp mất lớn hơn đứng trước; bằng nhau thì dòng rẻ hơn đứng trước. Dừng ở dòng ĐẦU TIÊN không vừa — không
 * nhảy cóc nhét dòng rẻ ưu tiên thấp vào chỗ của dòng đắt ưu tiên cao.
 */

export type BudgetCash = {
  /** Tổng số dư biết được; `null` = không tài khoản nào biết số dư. */
  total: number | null;
  /** `false` = còn tài khoản chưa biết số dư ⇒ tổng là CẬN DƯỚI. */
  complete: boolean;
  unknownAccounts: number;
  /** Mốc số dư cũ nhất đã tính vào tổng — "số này đúng tới lúc nào". */
  stalestAt: Date | null;
  /** Chỗ chuỗi số dư đứt (thiếu / trùng giao dịch). */
  chainBreaks: number;
};

export type BudgetFlow = {
  days: number;
  codExpected: number;
  adsPlanned: number;
  opexPlanned: number;
  productionDue: number;
  net: number;
};

export type BudgetProposal = {
  variantId: string;
  productId: string;
  label: string;
  decision: Extract<InventoryDecisionKind, "STOCKOUT_RISK" | "REORDER">;
  qty: number;
  /** `null` = CHƯA BIẾT giá nhập. */
  capital: number | null;
  /** Ước lãi gộp mất nếu không đặt (luôn là ƯỚC TÍNH); `null` khi không tính được. */
  grossImpactEstimate: number | null;
};

export type BudgetLineState = "FUNDED" | "UNFUNDED" | "UNKNOWN_COST" | "UNKNOWN_CASH";

export const BUDGET_LINE_LABEL: Record<BudgetLineState, string> = {
  FUNDED: "Trong dư địa",
  UNFUNDED: "Vượt dư địa",
  UNKNOWN_COST: "Chưa có giá nhập",
  UNKNOWN_CASH: "Chưa biết số dư",
};

export const BUDGET_LINE_TONE: Record<BudgetLineState, string> = {
  FUNDED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  UNFUNDED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNKNOWN_COST: "bg-muted text-muted-foreground italic",
  UNKNOWN_CASH: "bg-muted text-muted-foreground italic",
};

export type BudgetLine = BudgetProposal & {
  state: BudgetLineState;
  /** Vốn cộng dồn tới hết dòng này theo thứ tự ưu tiên; `null` với dòng thiếu giá nhập. */
  cumulative: number | null;
};

export type BudgetVerdict = "FITS" | "OVER" | "NO_HEADROOM" | "UNKNOWN_CASH" | "NOTHING_TO_ORDER";

export const BUDGET_VERDICT_LABEL: Record<BudgetVerdict, string> = {
  FITS: "Đủ tiền cho mọi đề xuất có giá",
  OVER: "Không đủ cho mọi đề xuất",
  NO_HEADROOM: "Hết dư địa trước khi đặt",
  UNKNOWN_CASH: "Chưa biết số dư — chưa so được",
  NOTHING_TO_ORDER: "Không có đề xuất đặt",
};

export type OrderBudget = {
  verdict: BudgetVerdict;
  horizonDays: number;
  /** Tiền đang có + dòng tiền ròng kỳ; `null` = chưa biết số dư. */
  headroom: number | null;
  /** `true` = dư địa là CẬN DƯỚI (thiếu tài khoản) — "không đủ" chưa chắc. */
  headroomIsLowerBound: boolean;
  cash: BudgetCash;
  flow: BudgetFlow;
  /** Tổng vốn của đề xuất BIẾT giá. */
  requiredKnown: number;
  /** Số đề xuất thiếu giá nhập — tiền thật cần còn lớn hơn `requiredKnown`. */
  requiredUnknownCount: number;
  fundedCapital: number;
  fundedCount: number;
  unfundedCapital: number;
  unfundedCount: number;
  /** Dư địa còn lại nếu đặt TẤT CẢ đề xuất biết giá; `null` = chưa biết số dư. Âm = thiếu. */
  afterAll: number | null;
  lines: BudgetLine[];
  /** Những điều làm con số yếu đi — in cạnh kết luận, không chôn. */
  caveats: string[];
};

const RANK: Record<BudgetProposal["decision"], number> = { STOCKOUT_RISK: 0, REORDER: 1 };

/** Thứ tự ưu tiên — hàm riêng để kiểm thử được và để giao diện không tự xếp lại theo luật khác. */
export function compareProposals(a: BudgetProposal, b: BudgetProposal): number {
  return (
    RANK[a.decision] - RANK[b.decision] ||
    (b.grossImpactEstimate ?? -1) - (a.grossImpactEstimate ?? -1) ||
    (a.capital ?? Number.MAX_SAFE_INTEGER) - (b.capital ?? Number.MAX_SAFE_INTEGER) ||
    a.variantId.localeCompare(b.variantId)
  );
}

const vnd = (v: number) => `${Math.round(v).toLocaleString("vi-VN")}đ`;

/**
 * Dựng ngân sách. Hàm THUẦN: không đọc CSDL, không đọc đồng hồ (mốc số dư truyền vào, ngày in ra do
 * giao diện định dạng).
 */
export function buildOrderBudget(input: { cash: BudgetCash; flow: BudgetFlow; proposals: BudgetProposal[]; extraCaveats?: string[] }): OrderBudget {
  const { cash, flow } = input;
  const proposals = input.proposals.filter((p) => p.qty > 0).sort(compareProposals);
  const headroom = cash.total === null ? null : Math.round(cash.total + flow.net);
  const headroomIsLowerBound = headroom !== null && !cash.complete;

  const lines: BudgetLine[] = [];
  let cumulative = 0;
  let fundedCapital = 0;
  let fundedCount = 0;
  let unfundedCapital = 0;
  let unfundedCount = 0;
  let requiredKnown = 0;
  let requiredUnknownCount = 0;

  for (const p of proposals) {
    if (p.capital === null) {
      requiredUnknownCount += 1;
      lines.push({ ...p, state: "UNKNOWN_COST", cumulative: null });
      continue;
    }
    requiredKnown += p.capital;
    cumulative += p.capital;
    if (headroom === null) {
      lines.push({ ...p, state: "UNKNOWN_CASH", cumulative });
      continue;
    }
    // Dừng ở dòng ĐẦU TIÊN không vừa: `cumulative` cộng MỌI dòng biết giá đứng trước (cả dòng đã vượt) và chỉ
    // tăng, nên vượt một lần là mọi dòng sau đều vượt — dòng rẻ ưu tiên thấp không chen được vào chỗ trống.
    if (cumulative <= headroom) {
      fundedCapital += p.capital;
      fundedCount += 1;
      lines.push({ ...p, state: "FUNDED", cumulative });
    } else {
      unfundedCapital += p.capital;
      unfundedCount += 1;
      lines.push({ ...p, state: "UNFUNDED", cumulative });
    }
  }

  let verdict: BudgetVerdict;
  if (!proposals.length) verdict = "NOTHING_TO_ORDER";
  else if (headroom === null) verdict = "UNKNOWN_CASH";
  else if (headroom <= 0) verdict = "NO_HEADROOM";
  else if (unfundedCount > 0) verdict = "OVER";
  else verdict = "FITS";

  const caveats: string[] = [];
  if (cash.total === null) caveats.push("Chưa tài khoản ngân hàng nào có số dư do ngân hàng ghi — không tính được dư địa. Kết nối SePay hoặc tải sao kê có cột số dư.");
  if (cash.total !== null && !cash.complete)
    caveats.push(`Còn ${cash.unknownAccounts} tài khoản chưa biết số dư — dư địa là CẬN DƯỚI: "đủ tiền" vẫn đúng, "vượt dư địa" thì chưa chắc.`);
  if (cash.chainBreaks > 0) caveats.push(`Chuỗi số dư ngân hàng đứt ${cash.chainBreaks} chỗ (thiếu hoặc trùng giao dịch) — số dư có thể lệch.`);
  if (requiredUnknownCount > 0) caveats.push(`${requiredUnknownCount} đề xuất CHƯA CÓ GIÁ NHẬP — tiền thật cần còn lớn hơn ${vnd(requiredKnown)}.`);
  if (proposals.length)
    caveats.push(`Giả định tiền hàng của đề xuất mới phải trả trong ${flow.days} ngày tới. Dòng tiền ${flow.days} ngày chỉ gồm COD của đơn ĐÃ giao, không gồm doanh thu đơn chưa giao.`);
  if (proposals.length && flow.opexPlanned === 0)
    caveats.push(`Chi vận hành ${flow.days} ngày tới đang là 0đ vì 60 ngày qua không có khoản chi nào được ghi — dư địa đang CAO hơn thực tế.`);
  caveats.push(...(input.extraCaveats ?? []));

  return {
    verdict,
    horizonDays: flow.days,
    headroom,
    headroomIsLowerBound,
    cash,
    flow,
    requiredKnown: Math.round(requiredKnown),
    requiredUnknownCount,
    fundedCapital: Math.round(fundedCapital),
    fundedCount,
    unfundedCapital: Math.round(unfundedCapital),
    unfundedCount,
    afterAll: headroom === null ? null : Math.round(headroom - requiredKnown),
    lines,
    caveats,
  };
}
