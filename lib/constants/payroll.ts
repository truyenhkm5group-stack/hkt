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

/**
 * ═══════ CƠ SỞ LỢI NHUẬN DÙNG ĐỂ TÍNH LƯƠNG ═══════
 *
 * ─── VÌ SAO `profit1` KHÔNG CÒN LÀ CÁI TÊN NGHIỆP VỤ ───
 *
 * "profit1" và "profit2" không nói lên điều gì: hai cái tên ấy chỉ nói rằng có hai thứ và cái này
 * đứng trước cái kia. Người đọc bảng lương phải mở mã nguồn mới biết mình đang trả tiền theo cơ sở
 * nào — và một cơ sở chọn nhầm là cả một kỳ lương tính sai mà không có gì báo.
 *
 * Nên mỗi cơ sở nay có một TÊN NGHIỆP VỤ tường minh (`PAYROLL_BASIS_NAME`), và màn hình dùng tên
 * ấy. Giá trị cũ VẪN nhận được ở URL — đường dẫn đã lưu, đã gửi cho nhau, đã nằm trong
 * `payroll_periods.basis` của những kỳ ĐÃ CHỐT. Đổi giá trị lưu trữ là làm mồ côi chúng; đổi cái
 * TÊN người đọc thì không mất gì.
 */
export type PayrollBasis = "profit1" | "profit2" | "cash" | "nominal";

/**
 * TÊN NGHIỆP VỤ CỦA TỪNG CƠ SỞ — thứ màn hình hiện, thay cho `profit1`/`profit2`.
 *
 * `COMPENSATION_PROFIT` là cơ sở DUY NHẤT được phép chốt lương (xem `PAYROLL_BASIS_ELIGIBILITY`):
 * doanh thu giao thành công trừ giá vốn CỦA CHÍNH HÀNG ĐÃ GIAO, quảng cáo, vận chuyển và chi phí
 * vận hành đã ghi nhận.
 */
export const PAYROLL_BASIS_NAME: Record<PayrollBasis, string> = {
  profit1: "Lợi nhuận tính lương",
  profit2: "Lợi nhuận sau giá vốn hàng nhập",
  cash: "Dòng tiền thực",
  nominal: "Lợi nhuận danh nghĩa (dự phóng)",
};

/**
 * KHOÁ NGHIỆP VỤ — nhận được ở URL bên cạnh giá trị cũ, để đường dẫn mới đọc được bằng mắt.
 * KHÔNG dùng để lưu: `payroll_periods.basis` giữ nguyên giá trị cũ (xem khối trên).
 */
export const PAYROLL_BASIS_ALIAS: Record<string, PayrollBasis> = {
  "compensation-profit": "profit1",
  "purchase-cogs-profit": "profit2",
  "cash-flow": "cash",
  "nominal-profit": "nominal",
};
export const PAYROLL_BASIS_LABEL: Record<PayrollBasis, string> = {
  profit1: "LN1 · doanh thu GTC − QC − giá vốn hàng giao thành công − vận chuyển − chi phí cố định/vận hành/khác",
  profit2: "LN2 · doanh thu GTC − QC − giá vốn TỔNG hàng nhập trong kỳ − vận chuyển − chi phí cố định/vận hành/khác",
  cash: "Dòng tiền thực (tiền vào − tiền ra trong kỳ), chia theo tỷ trọng LN1",
  nominal: "Danh nghĩa (đơn lên trong kỳ × tỷ lệ hoàn ước tính), tham khảo",
};
export const PAYROLL_BASIS_SHORT: Record<PayrollBasis, string> = { profit1: "LN1 · giá vốn hàng giao TC", profit2: "LN2 · giá vốn hàng nhập", cash: "Dòng tiền thực", nominal: "Danh nghĩa" };
export const PAYROLL_BASES: PayrollBasis[] = ["profit1", "profit2", "cash", "nominal"];
/**
 * Nhận CẢ HAI cách viết: khoá nghiệp vụ mới (`compensation-profit`) và giá trị cũ (`profit1`).
 * Giá trị lạ rơi về cơ sở tính lương — mặc định phải là cơ sở ĐƯỢC PHÉP chốt, không phải cơ sở
 * cuối cùng trong danh sách.
 */
export function parsePayrollBasis(v: string | null | undefined): PayrollBasis {
  if (!v) return "profit1";
  const alias = PAYROLL_BASIS_ALIAS[v];
  if (alias) return alias;
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
  /** Fanpage (page_id) → marketer: đơn & doanh thu phát sinh trên page được ghi nhận cho marketer đó (mỗi page một người) */
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
  /** marketer nhận diện từ `ad_id` của đơn. CHỈ dùng khi fanpage không nói được gì — xem `attributionShares`. */
  adMarketerId?: string | null;
  /**
   * NGƯỜI PHỤ TRÁCH FANPAGE ĐÃ CHỤP LẠI TẠI MỐC ĐƠN PHÁT SINH (`order_attributions.marketer_id`).
   *
   * Đây là nguồn CÓ THẨM QUYỀN cho câu "đơn này của ai", vì nó là hàm của (page, MỐC ĐƠN LÊN) chứ
   * không phải của (page, HÔM NAY) — xem `lib/constants/fanpage-attribution.ts`, luật bất biến 1.
   */
  snapshotMarketerId?: string | null;
};
export type AttributionMode = "page" | "ads" | "owner" | "none";
export type Attribution = {
  /** marketerId → tỷ trọng (0–1), tổng = 1 khi có người nhận */
  shares: Map<string | null, number>;
  mode: AttributionMode;
  /** Phần giá trị (doanh số) trên page chưa gán / không có page, đã được chia theo QC hoặc về chủ mã */
  unmappedValue: number;
  /** Phần giá trị ghi nhận đúng theo fanpage */
  mappedValue: number;
  /** Trong `mappedValue`: phần đi bằng ẢNH CHỤP có mốc thời gian — con số đo ĐỘ PHỦ của nguồn đúng. */
  snapshotValue: number;
  /** Trong `mappedValue`: phần còn phải dùng bảng gán PHẲNG (không có mốc hiệu lực). */
  legacyPageValue: number;
};

/**
 * ═══════ GHI NHẬN ĐƠN & DOANH THU CỦA MỘT MÃ CHO MARKETER ═══════
 *
 * THỨ TỰ CĂN CỨ (chủ shop chốt: đơn/doanh thu marketer bám theo FANPAGE):
 *
 *  1. **ẢNH CHỤP người phụ trách fanpage tại MỐC ĐƠN PHÁT SINH** (`order_attributions`) — có thẩm
 *     quyền, vì nó là hàm của (page, mốc đơn lên).
 *  2. **Bảng gán PHẲNG `payroll.config.pageMarketers`** — chỉ để lấp chỗ đơn chưa có ảnh chụp.
 *  3. **`ad_id` → chiến dịch → marketer** — CHỈ khi fanpage không nói được gì.
 *  4. đơn trên page chưa gán / không có page: chia theo tỷ trọng tiền QC trên mã, không có QC thì
 *     về chủ mã, không có chủ mã thì chia theo tỷ trọng đã ghi nhận theo page;
 *  5. mã không có page nào gán: chia theo QC, rồi chủ mã, rồi không ai.
 *
 * ─── VÌ SAO ẢNH CHỤP PHẢI ĐỨNG TRƯỚC BẢNG PHẲNG ───
 *
 * `pageMarketers` là một ánh xạ `page → người`, KHÔNG có mốc hiệu lực. Fanpage A giao cho An từ
 * 01/09 rồi chuyển cho Bình từ 10/09: chủ shop sửa ô ấy hôm nay, và bảng lương THÁNG TRƯỚC lập tức
 * chuyển toàn bộ doanh thu của An sang Bình — một kỳ đã trả tiền tự viết lại chính nó. Ảnh chụp
 * đứng yên vì nó ghi lại người phụ trách TẠI LÚC ĐƠN LÊN.
 *
 * ─── VÌ SAO QUẢNG CÁO TỤT XUỐNG SAU FANPAGE ───
 *
 * `ad_id` trước đây đứng TRÊN fanpage. Nó chính xác tới từng mẩu quảng cáo, nhưng nó trả lời câu
 * hỏi KHÁC: "tiền quảng cáo nào tạo ra đơn này". Chủ shop chấm marketer theo FANPAGE họ phụ trách,
 * nên hiệu quả quảng cáo không được ghi đè người được tính đơn. Nó vẫn lấp chỗ fanpage im lặng.
 *
 * Đơn bị kết luận TRÙNG mang `marketer_id = NULL` (ràng buộc `order_attribution_marketer_check`)
 * nên rơi xuống bậc 2 — CỐ Ý: doanh thu ở đây là doanh thu GIAO THÀNH CÔNG, tiền thật đã về; bỏ nó
 * ra khỏi phần chia sẽ làm Σ các marketer không còn bằng tổng của shop. Loại trùng đơn là việc của
 * chỉ số MARKETING (`/marketing/fanpages`), đo ở mốc chốt đơn.
 */
export function attributionShares(input: { byPage: PageBucket[]; pageMarketers: Record<string, string>; adShares: Map<string | null, number>; ownerId: string | null }): Attribution {
  const total = input.byPage.reduce((t, b) => t + Math.max(0, b.value), 0);
  const mapped = new Map<string | null, number>();
  let mappedValue = 0;
  let unmappedValue = 0;
  let snapshotValue = 0;
  let legacyPageValue = 0;
  for (const b of input.byPage) {
    const v = Math.max(0, b.value);
    // Ảnh chụp có mốc thời gian TRƯỚC, rồi bảng gán phẳng, rồi mới tới quảng cáo (xem khối trên).
    const snapshot = b.snapshotMarketerId || undefined;
    const flat = b.pageId ? input.pageMarketers[b.pageId] : undefined;
    const mid = snapshot || flat || b.adMarketerId || undefined;
    if (mid) {
      mapped.set(mid, (mapped.get(mid) ?? 0) + v);
      mappedValue += v;
      if (snapshot) snapshotValue += v;
      else if (flat) legacyPageValue += v;
    } else unmappedValue += v;
  }
  const adTotal = [...input.adShares.values()].reduce((t, v) => t + v, 0);
  const shares = new Map<string | null, number>();
  if (total > 0 && mappedValue > 0) {
    for (const [mid, v] of mapped) shares.set(mid, v / total);
    if (unmappedValue > 0) {
      const w = unmappedValue / total;
      if (adTotal > 0) for (const [mid, sh] of input.adShares) shares.set(mid, (shares.get(mid) ?? 0) + (w * sh) / adTotal);
      else if (input.ownerId) shares.set(input.ownerId, (shares.get(input.ownerId) ?? 0) + w);
      else for (const [mid, v] of mapped) shares.set(mid, (shares.get(mid) ?? 0) + (w * v) / mappedValue);
    }
    return { shares, mode: "page", unmappedValue, mappedValue, snapshotValue, legacyPageValue };
  }
  if (adTotal > 0) {
    for (const [mid, sh] of input.adShares) shares.set(mid, sh / adTotal);
    return { shares, mode: "ads", unmappedValue, mappedValue, snapshotValue, legacyPageValue };
  }
  if (input.ownerId) {
    shares.set(input.ownerId, 1);
    return { shares, mode: "owner", unmappedValue, mappedValue, snapshotValue, legacyPageValue };
  }
  return { shares, mode: "none", unmappedValue, mappedValue, snapshotValue, legacyPageValue };
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
