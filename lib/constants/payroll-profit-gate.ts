/**
 * ═══════════ QUY CHẾ CHIA THƯỞNG LỢI NHUẬN — CỔNG LỖ LŨY KẾ TOÀN CÔNG TY ═══════════
 *
 * Đặc tả: `docs/payroll-profit-gate.md`. Chủ shop giao 19/10/2026: *"Không cho phép phát sinh
 * thưởng % lợi nhuận mới khi công ty còn lỗ lũy kế chưa bù hết."*
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Bảng lương cũ tính thưởng % lợi nhuận bằng `max(LN của KỲ, 0) × %` — và với phần cá nhân là
 * `max(LN CÁ NHÂN, 0) × %`. Cả hai chỉ nhìn ĐÚNG MỘT KỲ và ĐÚNG MỘT NGƯỜI. Công ty lỗ ba tháng rồi
 * lãi một tháng thì tháng lãi ấy chia thưởng trên đủ số lãi, như chưa từng có ba tháng lỗ; và một
 * MKTer lãi trên mã của mình vẫn ăn % lợi nhuận cá nhân trong khi cả công ty đang âm.
 *
 * Đo production 18/10/2026 (đường cũ, bốn nhân sự): tháng 8 lợi nhuận shop ≤ 0, tháng 9 dương, tháng
 * 10 ≤ 0 — tháng 9 vẫn tính 20.946.743 ₫ thưởng theo lợi nhuận mà không nhìn tháng 8.
 *
 * ─── BA CON SỐ, KHÔNG ĐƯỢC GỘP ───
 *
 *  · **LỢI NHUẬN KẾ TOÁN** — kết quả kinh doanh sau MỌI chi phí, kể cả thưởng đã chia.
 *  · **LỢI NHUẬN ĐÓNG GÓP CÁ NHÂN** — phần quy kết cho một người. Là CHỈ SỐ đo người, KHÔNG BAO GIỜ
 *    là căn cứ vượt qua điều kiện lỗ của công ty.
 *  · **LỢI NHUẬN ĐỦ ĐIỀU KIỆN CHIA** — phần lợi nhuận của tháng còn lại SAU KHI đã bù hết lỗ lũy kế
 *    và vượt mốc cao nhất đã từng chia (High-Water Mark). Quỹ thưởng chỉ sinh ra từ con số này.
 *
 * ─── VÌ SAO LÀ MỘT KHAI BÁO CÓ NGƯỜI DUYỆT, KHÔNG PHẢI MỘT PHÉP TÍNH NGƯỢC VỀ QUÁ KHỨ ───
 *
 * Cùng lý lẽ với sổ lỗ MKTer (`lib/constants/payroll-carryover.ts`): lỗ lũy kế của những tháng
 * trước khi ERP có số — tiền vốn, hàng tồn, chi phí ngoài sổ — ERP KHÔNG biết. Dựng nó từ công thức
 * hôm nay trên dữ liệu hôm nay rồi gọi là "số dư đã đối soát" là tự bịa một con số. Nên số dư đầu là
 * KHAI BÁO của người có quyền duyệt lương, có ngày, có lý do, có số hiệu quy chế — và mọi lần khai lại
 * là một PHIÊN BẢN MỚI, bản cũ không bị xoá.
 *
 * Chưa khai ⇒ cổng ở trạng thái CHƯA XÁC LẬP ⇒ thưởng % lợi nhuận là CHƯA ĐỦ ĐIỀU KIỆN và chốt kỳ bị
 * chặn. Không có đường lùi về "trả như cũ" — AGENTS.md mục 31: mọi nhánh lỗi rơi về phía HẸP HƠN.
 */

import { PAYROLL_COMPONENT_SIGN } from "@/lib/constants/payroll-components";

export const PAYROLL_PROFIT_GATE_KEY = "payroll.profit-gate";

/**
 * PHIÊN BẢN PHÉP TÍNH CỔNG. Đổi cách biến (lợi nhuận tháng + số dư) thành quỹ thưởng ⇒ TĂNG số này.
 * Ảnh chụp kỳ đã khoá mang theo số này.
 */
export const PROFIT_GATE_CALC_VERSION = 1;

/** Số tháng tối đa được MÔ PHỎNG sống để dựng số dư khi các tháng trước chưa khoá. */
export const PROFIT_GATE_MAX_SIMULATED_MONTHS = 12;

/**
 * MỘT PHIÊN BẢN QUY CHẾ. Bất biến sau khi lưu — khai lại là thêm một phiên bản, không sửa bản cũ.
 */
export type ProfitGatePolicy = {
  version: number;
  /**
   * THÁNG MỞ SỔ (`YYYY-MM`) — tháng ĐẦU TIÊN cổng xét. Tháng trước mốc này: thưởng % lợi nhuận là
   * CHƯA ĐỦ ĐIỀU KIỆN (không có số dư đã duyệt), không phải "trả như cũ".
   */
  openingMonth: string;
  /**
   * LỢI NHUẬN LŨY KẾ TOÀN CÔNG TY tới HẾT THÁNG TRƯỚC `openingMonth`, đã trừ mọi khoản thưởng lợi
   * nhuận đã chi. ÂM = lỗ lũy kế còn phải bù. Số nguyên VND, lấy từ số dư đã đối soát.
   */
  openingCumulative: number;
  /**
   * MỐC CAO NHẤT ĐÃ CHIA (High-Water Mark) tại cùng thời điểm, ≥ 0. Lợi nhuận lũy kế phải vượt mốc
   * này mới sinh ra lợi nhuận đủ điều kiện chia. Mặc định khai = `max(0, openingCumulative)`: phần
   * lãi trước mốc mở sổ coi như đã được xử lý (chia hoặc giữ lại), không chia lại.
   */
  openingHighWater: number;
  /** Tổng thưởng % lợi nhuận đã chi trước mốc mở sổ — để màn hình hiện "thưởng đã chi" đầy đủ. */
  openingPaidBonus: number;
  /**
   * QUỸ THƯỞNG TỐI ĐA, % của lợi nhuận đủ điều kiện chia. Do quy chế quyết, không có mặc định
   * (AGENTS.md mục 38 — ngưỡng là quyết định kinh doanh). `(0, 100]`. `null` chỉ hợp lệ khi có
   * `poolCapSchedule` — khi ấy tháng đứng TRƯỚC mốc đầu của lịch là CHƯA XÁC LẬP trần.
   */
  poolCapPercent: number | null;
  /**
   * TRẦN QUỸ THEO THÁNG (chủ shop 21/10/2026: 35% tới 10/2026, 40% từ 11/2026). Mốc cuối có
   * `fromMonth ≤ tháng` thắng; trước mốc đầu dùng `poolCapPercent`; cả hai trống ⇒ CHƯA XÁC LẬP —
   * KHÔNG lấy mốc đầu áp ngược. Thiếu trường (phiên bản cũ) = không có lịch.
   */
  poolCapSchedule?: ProfitGateCapStep[];
  /**
   * NGƯỜI NHẬN PHẦN CÒN LẠI CỦA QUỸ (chủ shop 21/10/2026): «35% và 40% lợi nhuận là con số tổng lợi nhuận
   * phân chia … dùng MKTer hoặc nhân viên khác thì cần chia phần cho các nhân viên đó, và chỉ nhận được phần
   * còn lại để tổng LN phân chia không vượt quá». Người này KHÔNG đòi riêng: mọi khoản thưởng % lợi nhuận
   * của họ gộp thành MỘT khoản = quỹ − Σ đề nghị của mọi người khác, không bao giờ âm
   * (`lib/payroll/profit-gate.ts`). Thiếu / `null` = không có ai.
   */
  residualClaimant?: { employeeId: string } | null;
  /** Số hiệu / tên quy chế thưởng đang áp dụng, để đối chiếu với hợp đồng. */
  regulationRef: string;
  /** Căn cứ của số dư đầu (biên bản đối soát, báo cáo tài chính…) và lý do khai. */
  reason: string;
  approvedById: string | null;
  approvedByEmail: string;
  /** ISO. */
  approvedAt: string;
};

/**
 * ═══ ĐIỀU CHỈNH LŨY KẾ — CHỨNG TỪ ĐẾN MUỘN CỦA THÁNG ĐÃ KHOÁ, GHI TƯỜNG MINH ═══
 *
 * Kỳ đã khoá là BẤT BIẾN (AGENTS.md mục 21) và ERP KHÔNG tự đo lại nó: lợi nhuận "sống" của một tháng
 * cũ được tính bằng giá vốn, giá báo MKT và giả định chi phí của HÔM NAY, nên đem nó trừ đi số đã
 * chụp là trộn chứng từ đến muộn với một lần đổi giá — và một lần hạ giá báo MKT thành "lãi muộn"
 * hàng chục triệu (review độc lập vòng 4). Không có phép tính nào tách được hai thứ ấy.
 *
 * Nên đơn hoàn về muộn / chi phí nhập muộn của tháng đã khoá đi vào lũy kế bằng MỘT DÒNG có người
 * duyệt: ghi vào một tháng CÒN MỞ, cộng vào lợi nhuận đem xét của tháng ấy ĐÚNG MỘT LẦN, và được chụp
 * cùng tháng ấy khi khoá. Chỉ thêm, không sửa, không xoá — sai thì ghi một dòng ngược dấu.
 */
export type ProfitGateLedgerAdjustment = {
  id: string;
  /** Tháng GHI (đang mở) — khoản này cộng vào lợi nhuận đem xét của tháng này. */
  monthKey: string;
  /** Tháng chứng từ thuộc về (đã khoá), để đối chiếu. `null` = không gắn một tháng. */
  aboutMonth: string | null;
  /** Có dấu: âm = chi phí / hoàn muộn làm giảm lợi nhuận; dương = doanh thu muộn. */
  amount: number;
  reason: string;
  approvedById: string | null;
  approvedByEmail: string;
  /** ISO. */
  approvedAt: string;
};

export type ProfitGateConfig = {
  /** Phiên bản đang hiệu lực — `null` = CHƯA KHAI. */
  active: ProfitGatePolicy | null;
  /** Mọi phiên bản đã từng lưu, cũ → mới. Không bao giờ xoá. */
  history: ProfitGatePolicy[];
  /** Điều chỉnh lũy kế tường minh, cũ → mới. Chỉ thêm. */
  adjustments: ProfitGateLedgerAdjustment[];
};

export const DEFAULT_PROFIT_GATE_CONFIG: ProfitGateConfig = { active: null, history: [], adjustments: [] };

/** Một mốc của lịch trần quỹ: từ tháng `fromMonth` (YYYY-MM) trần là `percent`% LN đủ điều kiện. */
export type ProfitGateCapStep = { fromMonth: string; percent: number };

/**
 * Trần quỹ của MỘT tháng. `null` = chưa xác lập (tháng trước mốc đầu của lịch mà không có trần chung) —
 * cổng đứng ở CHƯA XÁC LẬP, không đoán. `monthKey` `null` (kỳ không trọn tháng) ⇒ trần chung.
 */
export function poolCapPercentFor(policy: { poolCapPercent: number | null; poolCapSchedule?: readonly ProfitGateCapStep[] }, monthKey: string | null): number | null {
  const lich = [...(policy.poolCapSchedule ?? [])].sort((x, y) => x.fromMonth.localeCompare(y.fromMonth));
  if (monthKey) {
    let chon: number | null = null;
    for (const m of lich) if (m.fromMonth <= monthKey) chon = m.percent;
    if (chon !== null) return chon;
  }
  return policy.poolCapPercent ?? null;
}

/** Nhãn ngắn của trần quỹ để in: «35% từ 2026-06 · 40% từ 2026-11». */
export function poolCapLabel(policy: { poolCapPercent: number | null; poolCapSchedule?: readonly ProfitGateCapStep[] }): string {
  const lich = [...(policy.poolCapSchedule ?? [])].sort((x, y) => x.fromMonth.localeCompare(y.fromMonth));
  const phan = lich.map((m) => `${m.percent}% từ ${m.fromMonth}`);
  if (policy.poolCapPercent !== null && policy.poolCapPercent !== undefined) phan.unshift(lich.length ? `${policy.poolCapPercent}% trước mốc đầu` : `${policy.poolCapPercent}%`);
  return phan.join(" · ") || "chưa khai";
}

/**
 * ═══ KHOẢN NÀO LÀ "THƯỞNG % LỢI NHUẬN" — ĐI QUA CỔNG ═══
 *
 * Phân loại theo ĐẠI LƯỢNG, không theo tên loại: hoa hồng % lợi nhuận cá nhân mang loại `COMMISSION`
 * trong chính sách chuyển từ hồ sơ cũ, nhưng nó vẫn là thưởng trên LỢI NHUẬN. Một khoản tính trên
 * lợi nhuận (cá nhân hay toàn shop), hoặc khai loại `PROFIT_SHARE`, là thưởng chia lợi nhuận và phải
 * qua cổng. Hoa hồng trên doanh thu / số đơn / sản lượng là HOA HỒNG THÔNG THƯỜNG — một chi phí,
 * không qua cổng, và được trừ vào cơ sở trước khi xét cổng.
 */
export const PROFIT_BASIS_KEYS = ["PROFIT_PERSONAL", "PROFIT_SHOP"] as const;

/**
 * Chỉ khoản CỘNG vào thu nhập mới là "thưởng". Một khoản KHẤU TRỪ / TẠM ỨNG khai trên đại lượng lợi
 * nhuận mà bị coi là thưởng thì cổng kẹp nó về 0 — và khoản trừ ấy lặng lẽ biến mất, lương TĂNG.
 */
export function isProfitLinked(kind: string, basisKey: string | null): boolean {
  if ((PAYROLL_COMPONENT_SIGN as Record<string, number>)[kind] === -1) return false;
  if (kind === "PROFIT_SHARE") return true;
  return basisKey !== null && (PROFIT_BASIS_KEYS as readonly string[]).includes(basisKey);
}

/**
 * Thù lao THÔNG THƯỜNG mà máy chi phí chưa biết — trừ vào cơ sở trước khi xét cổng. Lương cứng /
 * phụ cấp / theo thời gian KHÔNG ở đây: chúng đi qua nguồn ghi nhận chi phí nhân sự
 * (`lib/queries/payroll-cost.ts`), và trừ thêm ở đây là trừ hai lần.
 */
export const REGULAR_VARIABLE_KINDS = ["COMMISSION", "KPI", "BONUS", "PIECE_RATE"] as const;

export function isRegularVariable(kind: string, basisKey: string | null): boolean {
  return (REGULAR_VARIABLE_KINDS as readonly string[]).includes(kind) && !isProfitLinked(kind, basisKey);
}

/** Câu nguyên văn chủ shop yêu cầu hiện khi công ty còn lỗ lũy kế. */
export const PROFIT_GATE_LOSS_MESSAGE = "Chưa đủ điều kiện thưởng lợi nhuận — công ty chưa bù hết lỗ lũy kế.";
