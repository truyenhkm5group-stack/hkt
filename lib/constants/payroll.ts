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

export type PageBucket = { pageId: string | null; value: number };
export type AttributionMode = "page" | "ads" | "owner" | "none";
export type Attribution = {
  /** marketerId → tỷ trọng (0–1), tổng = 1 khi có người nhận */
  shares: Map<string | null, number>;
  mode: AttributionMode;
  /** Phần giá trị (doanh số) trên page chưa gán / không có page, đã được chia theo QC hoặc về chủ mã */
  unmappedValue: number;
  /** Phần giá trị ghi nhận đúng theo fanpage */
  mappedValue: number;
};

/**
 * Ghi nhận đơn & doanh thu của một mã cho marketer:
 *  1. theo FANPAGE phát sinh đơn (pageMarketers) — mỗi page thuộc một marketer;
 *  2. đơn trên page chưa gán / không có page: chia theo tỷ trọng tiền QC trên mã, không có QC thì về chủ mã,
 *     không có chủ mã thì chia theo tỷ trọng đã ghi nhận theo page;
 *  3. mã không có page nào gán: chia theo QC (như cũ), rồi chủ mã, rồi không ai.
 */
export function attributionShares(input: { byPage: PageBucket[]; pageMarketers: Record<string, string>; adShares: Map<string | null, number>; ownerId: string | null }): Attribution {
  const total = input.byPage.reduce((t, b) => t + Math.max(0, b.value), 0);
  const mapped = new Map<string | null, number>();
  let mappedValue = 0;
  let unmappedValue = 0;
  for (const b of input.byPage) {
    const v = Math.max(0, b.value);
    const mid = b.pageId ? input.pageMarketers[b.pageId] : undefined;
    if (mid) {
      mapped.set(mid, (mapped.get(mid) ?? 0) + v);
      mappedValue += v;
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
    return { shares, mode: "page", unmappedValue, mappedValue };
  }
  if (adTotal > 0) {
    for (const [mid, sh] of input.adShares) shares.set(mid, sh / adTotal);
    return { shares, mode: "ads", unmappedValue, mappedValue };
  }
  if (input.ownerId) {
    shares.set(input.ownerId, 1);
    return { shares, mode: "owner", unmappedValue, mappedValue };
  }
  return { shares, mode: "none", unmappedValue, mappedValue };
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
