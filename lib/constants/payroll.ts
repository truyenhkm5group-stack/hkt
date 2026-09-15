import { vnDateKey } from "@/lib/format";

/** Nhân sự và cơ chế lương (lưu trong settings: payroll.employees) */
export type Employee = {
  id: string;
  name: string;
  /** Tên ngắn hiển thị, vd "Quân TA" */
  shortName: string;
  department: string;
  /** Từ khoá trong tên chiến dịch để nhận diện marketer, vd ["QA4", "QUAN TA"] */
  aliases: string[];
  /** Tài khoản quảng cáo (account_id) mặc định thuộc marketer này */
  accountIds: string[];
  /** Email đăng nhập ERP của nhân sự này — để người chỉ có quyền "Lương: xem của mình" thấy đúng dòng của mình */
  userEmail?: string;
  /** Lương cứng mỗi tháng (đ) */
  fixed: number;
  /** % lợi nhuận tổng của shop trong kỳ */
  percentTotal: number;
  /** % lợi nhuận cá nhân (lợi nhuận do chính người đó tạo ra qua các chiến dịch của mình) */
  percentPersonal: number;
  /** % doanh thu GTC ước tính cá nhân (tuỳ chọn, cho sale/CSKH) */
  percentRevenue: number;
  active: boolean;
  note: string;
};

export const PAYROLL_EMPLOYEES_KEY = "payroll.employees";

/**
 * PHIÊN BẢN PHÉP TÍNH LƯƠNG. Đổi CÔNG THỨC ⇒ tăng số này.
 *
 * Ảnh chụp của một kỳ đã chốt mang theo số này, nên sáu tháng sau vẫn biết được nó dựng bằng luật
 * nào — và hai kỳ mang hai số khác nhau thì màn hình in "đổi công thức giữa hai kỳ" thay vì vẽ một
 * mũi tên xu hướng. Cùng tinh thần với `METRIC_DEFINITION_VERSION` và
 * `FANPAGE_ATTRIBUTION_RULE_VERSION`.
 *
 * 2 = bản 14/09/2026: lương cứng chia theo SỐ NGÀY của kỳ (trước đó chép nguyên lương tháng), quy
 * kết marketer đi bằng ảnh chụp fanpage theo mốc đơn lên, và CHƯA BIẾT thôi in ra thành 0.
 */
export const PAYROLL_CALC_VERSION = 2;

/**
 * KHOÁ TỰ NHIÊN CỦA MỘT KỲ LƯƠNG — đọc được bằng mắt, và ổn định.
 *
 * Dùng chính hai mốc ngày chứ không dùng nhãn kỳ ("Tháng này"): nhãn ấy đổi nghĩa theo ngày mở
 * màn hình, nên một kỳ đã chốt sẽ trỏ sang khoảng khác vào tháng sau. `null` = kỳ không có mốc
 * đầu/cuối ⇒ KHÔNG chốt được, và đó là câu trả lời đúng chứ không phải một khoá giả.
 */
export function payrollPeriodKey(from: Date | null, to: Date | null): string | null {
  if (!from || !to) return null;
  return `${vnDateKey(from)}..${vnDateKey(to)}`;
}

export const DEPARTMENTS = ["Marketing", "Sale / CSKH", "Kho / Đóng gói", "Kế toán", "Quản lý", "Khác"] as const;

/** Lợi nhuận dùng để tính lương */
export type PayrollBasis = "profit1" | "profit2" | "cash" | "nominal";
export const PAYROLL_BASIS_LABEL: Record<PayrollBasis, string> = {
  profit1: "LN1 · doanh thu GTC − QC − giá vốn hàng giao thành công − vận chuyển − chi phí cố định/vận hành/khác",
  profit2: "LN2 · doanh thu GTC − QC − giá vốn TỔNG hàng nhập trong kỳ − vận chuyển − chi phí cố định/vận hành/khác",
  cash: "Dòng tiền thực (tiền vào − tiền ra trong kỳ), chia theo tỷ trọng LN1",
  nominal: "Danh nghĩa (đơn lên trong kỳ × tỷ lệ hoàn ước tính), tham khảo",
};
export const PAYROLL_BASIS_SHORT: Record<PayrollBasis, string> = { profit1: "LN1 · giá vốn hàng giao TC", profit2: "LN2 · giá vốn hàng nhập", cash: "Dòng tiền thực", nominal: "Danh nghĩa" };
export const PAYROLL_BASES: PayrollBasis[] = ["profit1", "profit2", "cash", "nominal"];
export function parsePayrollBasis(v: string | null | undefined): PayrollBasis {
  return v === "profit2" || v === "cash" || v === "nominal" ? v : "profit1";
}

/**
 * ═══════ CƠ SỞ NÀO ĐƯỢC PHÉP DÙNG ĐỂ CHỐT LƯƠNG ═══════
 *
 * Luật chủ shop chốt 14/09/2026: **lợi nhuận tính lương = doanh thu thực − TOÀN BỘ chi phí thuộc
 * phạm vi ghi nhận**, và *"tiền mua hàng chưa bán, trả nợ gốc, chuyển nội bộ, góp/rút vốn không tự
 * trở thành chi phí của lợi nhuận tính lương"*.
 *
 * Bốn cơ sở trong ERP KHÔNG tương đương nhau trước luật ấy, nhưng màn hình cho chọn cả bốn bằng
 * một ô chọn giống hệt nhau — nên một lần bấm nhầm là một kỳ lương tính trên cơ sở sai mà không có
 * gì báo. Sổ này khai rõ cái nào đủ điều kiện và cái nào KHÔNG, cùng LÝ DO đọc được.
 *
 * Không cơ sở nào bị gỡ: `profit2` và `cash` vẫn là số liệu quản trị hữu ích (áp lực tiền hàng,
 * dòng tiền thật). Chúng chỉ không được **âm thầm** trở thành căn cứ trả tiền cho người.
 */
export type PayrollBasisEligibility = { eligible: boolean; why: string };

export const PAYROLL_BASIS_ELIGIBILITY: Record<PayrollBasis, PayrollBasisEligibility> = {
  profit1: {
    eligible: true,
    why: "Doanh thu giao thành công trừ giá vốn CỦA CHÍNH HÀNG ĐÃ GIAO, quảng cáo, vận chuyển và chi phí vận hành đã ghi nhận — đúng định nghĩa 'doanh thu thực trừ toàn bộ chi phí thuộc phạm vi ghi nhận'.",
  },
  profit2: {
    eligible: false,
    why: "Trừ TOÀN BỘ giá vốn hàng NHẬP trong kỳ, kể cả hàng chưa bán. Nhập một lô lớn là lợi nhuận kỳ ấy âm và kỳ sau đẹp giả — tiền mua hàng chưa bán không phải chi phí của kỳ (AGENTS.md mục 14). Dùng để nhìn áp lực tiền hàng, không dùng để chốt lương.",
  },
  cash: {
    eligible: false,
    why: "Là DÒNG TIỀN (tiền vào − tiền ra trong kỳ), nên nó trừ cả tiền nhập hàng chưa bán và không trừ chi phí đã phát sinh mà chưa trả. Ngoài ra lợi nhuận cá nhân ở cơ sở này là phép QUY ĐỔI THEO TỶ TRỌNG, không đo được theo từng người.",
  },
  nominal: {
    eligible: false,
    why: "Là số DỰ PHÓNG: đơn lên trong kỳ × tỷ lệ giao thành công ƯỚC TÍNH. Chưa có chứng từ nào nói tiền đã về, nên nó không phải doanh thu thực (AGENTS.md mục 8.6 — dữ liệu suy đoán phải mang nhãn ước tính).",
  },
};

/** % lợi nhuận của một mã hàng ghi nhận cho người tạo ra đơn */
export type ProductShare = {
  /** Chủ mã hưởng % LN từ đơn do chính mình tạo (phần còn lại shop giữ) */
  ownerPct: number;
  /** Người chạy cùng hưởng % LN từ đơn mình tạo trên mã của người khác; phần còn lại (100 − Y) về chủ mã */
  crossPct: number;
};

/** Cấu hình chia lợi nhuận theo mã hàng (settings "payroll.config") */
export type PayrollConfig = {
  /** Marketer phụ trách chính từng mã (productId → employeeId): chịu tồn kho & giá vốn mã đó */
  productOwners: Record<string, string>;
  /** % LN chủ mã nhận từ đơn của marketer khác khi mã chưa khai % riêng (= 100 − crossPct mặc định) */
  ownerSharePct: number;
  /**
   * DI SẢN — KHÔNG CÒN THAM GIA QUY KẾT (chủ shop chốt 15/09/2026).
   *
   * Ánh xạ `page → người` này không có mốc hiệu lực, nên đổi một ô là đổi cả kỳ lương đã qua. Từ
   * bản này, ai được tính một đơn do `order_attributions` quyết — xem `attributionShares`. Dữ liệu
   * KHÔNG bị xoá (AGENTS.md mục 4: dùng cờ/trạng thái, không xoá), chỉ thôi được đọc làm căn cứ.
   */
  pageMarketers: Record<string, string>;
  /** % LN theo từng mã (productId → {ownerPct, crossPct}); mã chưa khai dùng {100, 100 − ownerSharePct} */
  productShares: Record<string, ProductShare>;
};
export const PAYROLL_CONFIG_KEY = "payroll.config";
export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = { productOwners: {}, ownerSharePct: 5, pageMarketers: {}, productShares: {} };

const clampPct = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
};

/** % LN áp dụng cho một mã: khai riêng > mặc định (chủ mã 100%, người chạy cùng 100 − ownerSharePct) */
export function shareFor(config: Pick<PayrollConfig, "productShares" | "ownerSharePct">, productId: string): ProductShare {
  const s = config.productShares?.[productId];
  const defaultCross = 100 - clampPct(config.ownerSharePct, 5);
  return { ownerPct: clampPct(s?.ownerPct, 100), crossPct: clampPct(s?.crossPct, defaultCross) };
}

/** Một phần doanh số của mã đã gán được (hoặc chưa) cho marketer */
export type PageBucket = {
  pageId: string | null;
  value: number;
  /**
   * NGƯỜI PHỤ TRÁCH FANPAGE ĐÃ CHỤP LẠI TẠI MỐC ĐƠN PHÁT SINH (`order_attributions.marketer_id`).
   *
   * Đây là nguồn CÓ THẨM QUYỀN DUY NHẤT cho câu "đơn này của ai", vì nó là hàm của (page, MỐC ĐƠN
   * LÊN) chứ không phải của (page, HÔM NAY) — xem `lib/constants/fanpage-attribution.ts`.
   */
  snapshotMarketerId?: string | null;
  /**
   * VÌ SAO phần này chưa có người: `NO_PAGE` · `NO_ASSIGNMENT` · `DUPLICATE`, hoặc `null` khi đơn
   * chưa có dòng quy kết nào (phải chạy lại đối soát). Không dùng để QUYẾT ĐỊNH ai được tính —
   * chỉ để màn hình nói được chỗ trống thuộc loại nào, vì ba loại ấy có ba cách sửa khác nhau.
   */
  attributionStatus?: AttributionGapReason | "ATTRIBUTED" | null;
};

/** Bốn lý do một phần doanh thu chưa thuộc về ai. `MISSING` = đơn chưa có dòng quy kết. */
export const ATTRIBUTION_GAP_REASONS = ["NO_PAGE", "NO_ASSIGNMENT", "DUPLICATE", "MISSING"] as const;
export type AttributionGapReason = (typeof ATTRIBUTION_GAP_REASONS)[number];

export const ATTRIBUTION_GAP_LABEL: Record<AttributionGapReason, string> = {
  NO_PAGE: "Đơn không có fanpage",
  NO_ASSIGNMENT: "Fanpage chưa gán marketer",
  DUPLICATE: "Trùng đơn — không tính cho ai",
  MISSING: "Chưa có dòng quy kết",
};

/**
 * `page` = có ít nhất một phần đi bằng ẢNH CHỤP; `none` = không phần nào quy kết được.
 *
 * Hai giá trị cũ `ads` và `owner` đã bị gỡ cùng với hai nguồn lấp chỗ mà chúng mô tả (chủ shop
 * chốt 15/09/2026): quảng cáo và chủ mã không còn được phép quyết định ai được tính đơn.
 */
export type AttributionMode = "page" | "none";

export type Attribution = {
  /** marketerId → tỷ trọng (0–1). Tổng ≤ 1; phần thiếu là phần CHƯA QUY KẾT ĐƯỢC, không chia cho ai. */
  shares: Map<string | null, number>;
  mode: AttributionMode;
  /** Phần giá trị ghi nhận đúng theo ảnh chụp fanpage. */
  mappedValue: number;
  /** Phần giá trị KHÔNG quy kết được — ở lại nhóm "Chưa gán marketer", không chia cho ai. */
  unmappedValue: number;
  /** `unmappedValue` tách theo lý do, để màn hình nói được việc phải làm. */
  byGap: Record<AttributionGapReason, number>;
};

/**
 * ═══════ GHI NHẬN ĐƠN & DOANH THU CỦA MỘT MÃ CHO MARKETER ═══════
 *
 * MỘT CĂN CỨ DUY NHẤT (chủ shop chốt 15/09/2026): **ảnh chụp người phụ trách fanpage tại MỐC ĐƠN
 * PHÁT SINH** (`order_attributions.marketer_id`). Không có bậc hai, không có bậc ba.
 *
 * ─── BA NGUỒN ĐÃ BỊ GỠ, VÀ VÌ SAO ───
 *
 * 1. **Bảng gán phẳng `payroll.config.pageMarketers`** — ánh xạ `page → người` KHÔNG có mốc hiệu
 *    lực. Chủ shop sửa ô ấy hôm nay là bảng lương THÁNG TRƯỚC đổi theo: một kỳ đã trả tiền tự viết
 *    lại chính nó. Ảnh chụp đứng yên vì nó ghi lại người phụ trách TẠI LÚC ĐƠN LÊN.
 * 2. **`ad_id` → chiến dịch → marketer** — trả lời câu hỏi KHÁC: "tiền quảng cáo nào tạo ra đơn
 *    này". Câu ấy vẫn được trả lời ở báo cáo Hiệu quả quảng cáo, và CHI PHÍ quảng cáo vẫn đi bằng
 *    chính nguồn ấy. Nhưng nó không được quyết định AI ĐƯỢC TÍNH ĐƠN.
 * 3. **Chủ mã / chia theo tỷ trọng** — đây không phải quy kết mà là PHỎNG ĐOÁN, và phỏng đoán ấy
 *    đang biến thành tiền trả cho người thật.
 *
 * ─── PHẦN CHƯA QUY KẾT ĐƯỢC KHÔNG BỊ CHIA, VÀ CŨNG KHÔNG BỊ GIẤU ───
 *
 * Trước bản này, phần `NO_PAGE` / `NO_ASSIGNMENT` / trùng đơn được chia lại theo tỷ trọng tiền
 * quảng cáo hoặc ném về chủ mã. Đo trên production 15/09/2026: riêng tháng 9 có 17.815.000đ doanh
 * thu giao thành công của 35 đơn KHÔNG có `page_id` đang được chia như vậy — tiền của một kênh
 * khác (landing / nhập tay) nằm trên thẻ điểm của một marketer.
 *
 * Nay phần ấy ở lại nhóm "Chưa gán marketer": một dòng THẬT, luôn hiện. Bất biến giữ nguyên —
 * Σ các marketer + phần chưa quy kết = tổng đem chia.
 *
 * ─── TRÙNG ĐƠN ───
 *
 * Đơn bị kết luận TRÙNG mang `marketer_id = NULL` (ràng buộc `order_attribution_marketer_check`)
 * nên nó rơi vào `byGap.DUPLICATE` và KHÔNG cộng cho ai: không đơn, không doanh thu, không lợi
 * nhuận, không hoa hồng. Dòng dữ liệu vẫn còn nguyên để tra.
 */
export function attributionShares(input: { byPage: PageBucket[] }): Attribution {
  const total = input.byPage.reduce((t, b) => t + Math.max(0, b.value), 0);
  const mapped = new Map<string | null, number>();
  const byGap: Record<AttributionGapReason, number> = { NO_PAGE: 0, NO_ASSIGNMENT: 0, DUPLICATE: 0, MISSING: 0 };
  let mappedValue = 0;
  let unmappedValue = 0;
  for (const b of input.byPage) {
    const v = Math.max(0, b.value);
    const mid = b.snapshotMarketerId || undefined;
    if (mid) {
      mapped.set(mid, (mapped.get(mid) ?? 0) + v);
      mappedValue += v;
      continue;
    }
    unmappedValue += v;
    const reason: AttributionGapReason =
      b.attributionStatus === "NO_PAGE" || b.attributionStatus === "NO_ASSIGNMENT" || b.attributionStatus === "DUPLICATE" ? b.attributionStatus : "MISSING";
    byGap[reason] += v;
  }
  const shares = new Map<string | null, number>();
  if (total > 0 && mappedValue > 0) for (const [mid, v] of mapped) shares.set(mid, v / total);
  return { shares, mode: shares.size ? "page" : "none", mappedValue, unmappedValue, byGap };
}

/**
 * Chia LN của phần đơn một marketer tạo ra trên mã: chủ mã giữ ownerPct % (còn lại shop giữ);
 * người chạy cùng giữ crossPct % (còn lại về chủ mã). LN âm thì người tạo đơn chịu hết.
 */
export function splitProfit(base: number, role: "owner" | "cross", share: ProductShare): { keep: number; toOwner: number; toShop: number } {
  if (base <= 0) return { keep: base, toOwner: 0, toShop: 0 };
  if (role === "owner") {
    const keep = Math.round((base * share.ownerPct) / 100);
    return { keep, toOwner: 0, toShop: base - keep };
  }
  const keep = Math.round((base * share.crossPct) / 100);
  return { keep, toOwner: base - keep, toShop: 0 };
}
