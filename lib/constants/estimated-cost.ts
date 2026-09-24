/**
 * ═══════════ GIÁ VỐN DỰ TÍNH — CHỖ TRỐNG ĐƯỢC LẤP BẰNG MỘT CON SỐ CÓ TÊN NGƯỜI ĐẶT ═══════════
 *
 * Chủ shop yêu cầu 23/09/2026: *"tự đặt giá vốn hàng nhập dự tính cho những mã chưa có giá nhập
 * thực tế, để xem lợi nhuận mã và margin theo giá nhập dự tính, tỷ lệ GTC dự tính, từ đó căn % CPQC
 * khi chạy ads"*.
 *
 * Trước bản này, sản phẩm không có giá vốn (không phiếu nhập, không giá Pancake) bị
 * `LINE_UNIT_COST` tính **0 ₫** — ô giá vốn in "—", nhưng LỢI NHUẬN vẫn trừ 0 đồng, nên đúng những
 * mã mới đang cần căn quảng cáo nhất lại trông như lãi trọn tiền hàng. Trần CPQC tính trên con số đó
 * sẽ bảo chủ shop được đốt quá tay.
 *
 * ─── BỐN LUẬT ───
 *
 *   1. GIÁ THẬT LUÔN THẮNG. Giá dự tính chỉ lấp ĐÚNG những sản phẩm mà `LINE_UNIT_COST` ra 0 —
 *      có phiếu nhập hay giá Pancake là con số đặt tay tự đứng sang một bên, không cần ai gỡ.
 *   2. CHỈ BÁO CÁO LỢI NHUẬN DANH NGHĨA đọc nó (`getNominalProfitReport(…, withEstimatedCost)`,
 *      mặc định TẮT). Bảng lương, báo cáo marketer, dòng tiền thực, sổ kho, tồn kho đều không đọc:
 *      một con số đoán không được đi vào tiền của ai (AGENTS.md mục 7) hay vào chứng từ nào.
 *      NGOẠI LỆ DUY NHẤT (chủ shop chốt 23/09/2026): bảng "Bóc tách theo MKTer" ở /ads/daily
 *      (`lib/queries/marketer-daily-nominal.ts`) đọc giá dự tính, vì nó phải nói CÙNG con số với
 *      tab Lợi nhuận danh nghĩa — đo production: 522 sản phẩm/30 ngày chưa có giá vốn, trừ 0 ₫ thì
 *      LN ròng lệch −150,7% (lãi thành lỗ). Bảng ấy không vào lương và mang nhãn "dự tính".
 *   3. LƯU Ở KHOÁ RIÊNG (`profit.estimatedCosts`), không trong `profit.assumptions`: lược đồ của
 *      `saveProfitAssumptions` bỏ mọi trường nó không biết, nên để chung là mỗi lần sửa khối Giả
 *      định thì toàn bộ giá dự tính biến mất, im lặng.
 *   4. MANG NHÃN Ở MỌI CHỖ NÓ ĐI QUA (AGENTS.md mục 8.6): phần tiền dự tính là một trường riêng
 *      (`expectedCogsEstimated`) chứ không tan vào tổng.
 */
export const ESTIMATED_COST_KEY = "profit.estimatedCosts";

export type EstimatedCost = {
  /** Giá vốn dự tính cho MỘT sản phẩm (VND, số nguyên dương). */
  unitCost: number;
  /** Vì sao đặt con số này — báo giá xưởng, lô thử… Bắt buộc: con số không lý do là con số không ai kiểm lại được. */
  reason: string;
  setAt: string | null;
  /** Email người đặt — MÁY CHỦ đọc từ phiên đăng nhập, không nhận từ client (mục 34). */
  setBy: string | null;
};

export type EstimatedCostMap = Record<string, EstimatedCost>;

/** Trần hợp lý cho một đơn giá nhập: chặn gõ nhầm thêm ba số 0, không phải một ngưỡng nghiệp vụ. */
export const ESTIMATED_UNIT_COST_MAX = 100_000_000;

/**
 * Đọc bản lưu một cách PHÒNG THỦ: dòng hỏng thì BỎ dòng đó, không bao giờ biến nó thành 0 ₫ —
 * một giá vốn 0 ₫ đặt tay còn tệ hơn chỗ trống, vì nó mang nhãn "đã có người đặt".
 */
export function parseEstimatedCosts(raw: unknown): EstimatedCostMap {
  const out: EstimatedCostMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [productId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!productId || !v || typeof v !== "object") continue;
    const x = v as Partial<EstimatedCost>;
    const unitCost = Math.round(Number(x.unitCost));
    if (!Number.isFinite(unitCost) || unitCost <= 0 || unitCost > ESTIMATED_UNIT_COST_MAX) continue;
    out[productId] = {
      unitCost,
      reason: typeof x.reason === "string" ? x.reason : "",
      setAt: typeof x.setAt === "string" ? x.setAt : null,
      setBy: typeof x.setBy === "string" ? x.setBy : null,
    };
  }
  return out;
}

/**
 * ═══════════ TRẦN CPQC — CHI BAO NHIÊU QUẢNG CÁO THÌ MÃ CÒN ĐẠT BIÊN MUỐN CÓ ═══════════
 *
 * Mọi khoản trong lợi nhuận danh nghĩa của một mã KHÔNG phụ thuộc quảng cáo, trừ hai: chính CPQC và
 * "chi phí khác" (= CPQC × %, phí thẻ ngoại tệ). Nên:
 *
 *     LN trước QC   = LN danh nghĩa + CPQC + CP khác
 *     LN(chi = A)   = LN trước QC − A × (1 + %khác)
 *     Trần(biên m)  = (LN trước QC − m × DT GTC ƯT) ÷ (1 + %khác)          m = 0 ⇒ hoà vốn
 *
 * rồi quy ra hai đơn vị người chạy quảng cáo dùng hằng ngày: **% doanh số POS** (cùng mẫu số với cột
 * CPQC "DS" của bảng — so thẳng được) và **CPQC tối đa trên mỗi đơn chốt** (so với "chi phí mỗi kết
 * quả" trên Trình quản lý quảng cáo).
 *
 * ─── GIỚI HẠN PHẢI NÓI RA ───
 *
 * Đây là phép tính TẠI ĐIỂM HIỆN TẠI: giữ nguyên tỷ lệ GTC, giá bán bình quân và phần vận hành đã
 * phân bổ. Vận hành cố định không nở ra khi đơn tăng, nên chạy mạnh hơn thì trần thật nhích lên
 * chút ít — con số này nghiêng về phía THẬN TRỌNG, không phía liều.
 *
 * Trần ≤ 0 là một câu trả lời thật: mã LỖ (hoặc dưới biên muốn có) ngay cả khi không tiêu đồng
 * quảng cáo nào. Màn hình in đúng câu đó, không in "0%" như thể còn được chạy tới 0.
 *
 * Biên mục tiêu KHÔNG có mặc định (AGENTS.md mục 38): người xem gõ, không gõ thì chỉ có trần hoà vốn.
 */
export type AdsCeilingPoint = {
  /** Số tiền CPQC tối đa của kỳ (VND). ≤ 0 ⇒ không còn chỗ cho quảng cáo. */
  spend: number;
  /** Trần tính theo % doanh số POS. `null` khi chưa có doanh số để chia. */
  overPosSales: number | null;
  /** Trần trên mỗi đơn chốt (VND). `null` khi chưa có đơn. */
  perOrder: number | null;
};

export type AdsCeiling = {
  profitBeforeAds: number;
  breakEven: AdsCeilingPoint;
  /** `null` khi người xem chưa gõ biên mục tiêu. */
  target: AdsCeilingPoint | null;
  /**
   * Khoảng cách từ CPQC hiện tại tới trần HOÀ VỐN, tính theo điểm % doanh số POS. Dương = còn dư,
   * âm = đang vượt. `null` khi không có mẫu số.
   */
  headroomPoints: number | null;
};

export function adsCeiling(input: {
  netProfit: number;
  adSpend: number;
  otherCost: number;
  expectedRevenue: number;
  posSales: number;
  orders: number;
  /** Chi phí khác theo % CPQC (Giả định `otherCostPercentOfAds`), đơn vị %. */
  otherCostPercentOfAds: number;
  /** Biên lợi nhuận mong muốn trên DT GTC ước tính (%). `null` = chưa đặt. */
  targetMarginPct: number | null;
}): AdsCeiling {
  const heSo = 1 + Math.max(0, input.otherCostPercentOfAds || 0) / 100;
  const profitBeforeAds = input.netProfit + input.adSpend + input.otherCost;
  const diem = (spend: number): AdsCeilingPoint => ({
    spend: Math.round(spend),
    overPosSales: input.posSales > 0 ? (spend / input.posSales) * 100 : null,
    perOrder: input.orders > 0 ? Math.round(spend / input.orders) : null,
  });
  const breakEven = diem(profitBeforeAds / heSo);
  const target =
    input.targetMarginPct === null || !Number.isFinite(input.targetMarginPct)
      ? null
      : diem((profitBeforeAds - (input.targetMarginPct / 100) * input.expectedRevenue) / heSo);
  const hienTai = input.posSales > 0 ? (input.adSpend / input.posSales) * 100 : null;
  return {
    profitBeforeAds,
    breakEven,
    target,
    headroomPoints: breakEven.overPosSales === null || hienTai === null ? null : breakEven.overPosSales - hienTai,
  };
}

/** Đọc biên mục tiêu từ URL (`?bien=12.5`). Rỗng / sai / ngoài (−100, 100) ⇒ `null`, không đoán. */
export function parseTargetMargin(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n <= -100 || n >= 100) return null;
  return n;
}
