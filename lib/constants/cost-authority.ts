/**
 * ════════════ SỔ ĐĂNG KÝ THẨM QUYỀN CHI PHÍ ════════════
 *
 * Một chỗ duy nhất trả lời: **khoản chi này được ai đưa vào lợi nhuận, theo cách nào, và nếu nguồn
 * đó chưa đủ dữ liệu thì lùi về đâu.**
 *
 * Trước đây câu trả lời nằm rải rác dưới dạng `category not in ('ADS','PURCHASE')` gõ tay ở sáu
 * truy vấn khác nhau. Hệ quả: danh sách đó thiếu `SHIPPING` và `RETURN_FEE` suốt một thời gian dài,
 * nên cước gõ tay bị trừ hai lần mà không ai thấy. Một hằng số gõ tay ở sáu chỗ thì sớm muộn cũng
 * lệch nhau; một sổ đăng ký thì đổi một lần là mọi nơi đổi theo.
 *
 * ─── VÌ SAO CÓ `fallback` VÀ `coverage` ───
 *
 * Chuyển thẩm quyền của một khoản từ nguồn A sang nguồn B là việc NGUY HIỂM: nếu B chưa thật sự
 * cung cấp được số, mà A đã bị loại, thì khoản đó thành **0** — và 0 nhìn giống một con số hợp lệ.
 * Lương biến mất khỏi lợi nhuận nguy hiểm hơn hẳn lương bị trừ hai lần, vì trừ hai lần thì lợi
 * nhuận thấp bất thường (dễ nghi), còn mất hẳn thì lợi nhuận cao đẹp (không ai nghi).
 *
 * Nên nguồn mới chỉ được cầm quyền khi CHỨNG MINH được là đã phủ đủ dữ liệu (`coverage`). Chưa đủ
 * thì tự động lùi về nguồn cũ VÀ nêu cảnh báo — không bao giờ lùi im lặng.
 */
import type { ExpenseCategory } from "@/db/schema";
import type { RecognitionMethod } from "@/lib/constants/cost-allocation";
import type { CostSource } from "@/lib/constants/cost-sources";

/** Các thành phần chi phí của báo cáo lợi nhuận. Mỗi đồng chỉ được thuộc về ĐÚNG MỘT thành phần. */
export const COST_COMPONENTS = [
  "COGS",
  "ADS",
  "SHIPPING",
  "RETURN_COST",
  "SALARY",
  "COMMISSION",
  "RENT",
  "SOFTWARE",
  "UTILITIES",
  "INVENTORY_RISK",
  "OTHER_OPERATING",
] as const;
export type CostComponent = (typeof COST_COMPONENTS)[number];

/** Chính sách với dữ liệu của các nguồn KHÔNG có thẩm quyền */
export type DuplicatePolicy =
  /** Loại hẳn khỏi phép tính lợi nhuận — nguồn có thẩm quyền đã bao trọn khoản này */
  | "EXCLUDE_OTHER_SOURCES"
  /** Cho phép, nhưng phải là khoản ĐIỀU CHỈNH có chứng cứ (nguồn = MANUAL_ADJUSTMENT + lý do) */
  | "ALLOW_WITH_EVIDENCE"
  /** Không có nguồn nào cạnh tranh */
  | "NONE";

/** Điều kiện để nguồn chính thật sự được cầm quyền */
export type CoverageRequirement =
  /** Không cần chứng minh gì — nguồn luôn có dữ liệu */
  | "NONE"
  /** Phải phủ đủ kỳ báo cáo; chưa đủ thì lùi về `fallback` kèm cảnh báo */
  | "COMPLETE_ELSE_FALLBACK";

export type CostAuthoritySpec = {
  label: string;
  source: CostSource;
  recognitionMethod: RecognitionMethod;
  /** Trường ngày quyết định khoản này thuộc kỳ nào */
  dateBasis: string;
  fallback: CostSource | null;
  duplicatePolicy: DuplicatePolicy;
  coverageRequirement: CoverageRequirement;
  /**
   * Nhóm ở bảng Chi phí thuộc thành phần này. Khi `duplicatePolicy = EXCLUDE_OTHER_SOURCES` và
   * nguồn chính đang cầm quyền, các nhóm này bị LOẠI khỏi đường "chi phí vận hành".
   */
  expenseCategories: ExpenseCategory[];
  note: string;
};

export const COST_AUTHORITY_REGISTRY: Record<CostComponent, CostAuthoritySpec> = {
  COGS: {
    label: "Giá vốn hàng bán",
    source: "INVENTORY",
    recognitionMethod: "ORDER_ATTRIBUTED",
    dateBasis: "orders.inserted_at (qua dòng đơn)",
    fallback: null,
    duplicatePolicy: "EXCLUDE_OTHER_SOURCES",
    coverageRequirement: "NONE",
    expenseCategories: ["PURCHASE"],
    note: "Giá nhập lấy từ phiếu kho gần nhất. Tiền trả xưởng ghi ở bảng Chi phí là DÒNG TIỀN, không phải giá vốn của kỳ.",
  },
  ADS: {
    label: "Quảng cáo",
    source: "ADS",
    recognitionMethod: "ACTUAL_DATED_SPEND",
    dateBasis: "ad_spends.spend_date",
    fallback: null,
    duplicatePolicy: "EXCLUDE_OTHER_SOURCES",
    coverageRequirement: "NONE",
    expenseCategories: ["ADS"],
    note: "Tài khoản quảng cáo có số thực chi TỪNG NGÀY, chính xác hơn mọi bản gõ tay.",
  },
  SHIPPING: {
    label: "Cước vận chuyển chiều đi",
    source: "SHIPMENT",
    recognitionMethod: "SHIPMENT_ATTRIBUTED",
    dateBasis: "mốc của chính vận đơn",
    fallback: null,
    // Cước gắn theo vận đơn thì bị loại; nhưng khoản ĐIỀU CHỈNH tay (đền bù, phí ngoại lệ, cước
    // chuyến gom hàng không thuộc vận đơn nào) là chi phí THẬT và không được vứt đi.
    duplicatePolicy: "ALLOW_WITH_EVIDENCE",
    coverageRequirement: "NONE",
    expenseCategories: ["SHIPPING"],
    note: "Cước từng đơn đã tính theo vận đơn / bảng kê. Khoản gõ tay chỉ được tính khi khai là ĐIỀU CHỈNH có lý do.",
  },
  RETURN_COST: {
    label: "Phí hoàn hàng",
    source: "SHIPMENT",
    recognitionMethod: "SHIPMENT_ATTRIBUTED",
    dateBasis: "mốc của chính vận đơn hoàn",
    fallback: null,
    duplicatePolicy: "ALLOW_WITH_EVIDENCE",
    coverageRequirement: "NONE",
    expenseCategories: ["RETURN_FEE"],
    note: "Như cước chiều đi: phí gắn theo vận đơn bị loại, khoản điều chỉnh có chứng cứ vẫn được tính.",
  },
  SALARY: {
    label: "Lương cố định",
    source: "PAYROLL",
    recognitionMethod: "PERIOD_PRORATA",
    dateBasis: "kỳ báo cáo (chia theo số ngày)",
    fallback: "EXPENSES",
    duplicatePolicy: "EXCLUDE_OTHER_SOURCES",
    // Bảng Lương chỉ được cầm quyền khi trả được số phủ đủ kỳ; chưa đủ thì lùi về bảng Chi phí.
    coverageRequirement: "COMPLETE_ELSE_FALLBACK",
    expenseCategories: ["SALARY"],
    note: "Lương tháng chia theo số ngày của kỳ. Chưa khai nhân sự thì bảng Chi phí giữ quyền, KHÔNG để lương thành 0.",
  },
  COMMISSION: {
    label: "Hoa hồng",
    source: "PAYROLL",
    recognitionMethod: "ORDER_ATTRIBUTED",
    dateBasis: "kỳ phát sinh đơn (theo cơ sở tính hoa hồng đã chốt)",
    fallback: "EXPENSES",
    duplicatePolicy: "EXCLUDE_OTHER_SOURCES",
    coverageRequirement: "COMPLETE_ELSE_FALLBACK",
    expenseCategories: ["SALARY"],
    note: "Hoa hồng đi theo ĐƠN, không chia đều theo ngày. Chưa chốt cơ sở tính thì không được cầm quyền.",
  },
  RENT: {
    label: "Mặt bằng · điện nước",
    source: "EXPENSES",
    recognitionMethod: "PERIOD_PRORATA",
    dateBasis: "expenses.period_start … period_end",
    fallback: null,
    duplicatePolicy: "NONE",
    coverageRequirement: "NONE",
    expenseCategories: ["RENT"],
    note: "Khai kỳ hiệu lực thì chia theo số ngày; chưa khai thì rơi trọn vào ngày ghi sổ (đã có cảnh báo riêng).",
  },
  SOFTWARE: {
    label: "Phần mềm · dịch vụ",
    source: "EXPENSES",
    recognitionMethod: "PERIOD_PRORATA",
    dateBasis: "expenses.period_start … period_end",
    fallback: null,
    duplicatePolicy: "NONE",
    coverageRequirement: "NONE",
    expenseCategories: ["SOFTWARE"],
    note: "Gói năm phải khai kỳ 12 tháng, không ném trọn vào tháng trả tiền.",
  },
  UTILITIES: {
    label: "Điện nước (gộp trong Mặt bằng)",
    source: "EXPENSES",
    recognitionMethod: "PERIOD_PRORATA",
    dateBasis: "expenses.period_start … period_end",
    fallback: null,
    duplicatePolicy: "NONE",
    coverageRequirement: "NONE",
    // CỐ Ý ĐỂ TRỐNG: ERP chưa có nhóm chi phí riêng cho điện nước, chúng đang nằm trong `RENT`.
    // Khai thành phần này ở đây để hợp đồng đầy đủ, nhưng KHÔNG map nhóm nào — nếu map `RENT` lần
    // nữa thì cùng một đồng xuất hiện ở hai thành phần.
    expenseCategories: [],
    note: "Chưa tách khỏi nhóm Mặt bằng. Luôn bằng 0 cho tới khi có nhóm chi phí riêng.",
  },
  INVENTORY_RISK: {
    label: "Dự phòng rủi ro tồn kho",
    source: "ASSUMPTION",
    recognitionMethod: "INVENTORY_RISK_BY_COGS",
    dateBasis: "kỳ bán hàng (giá vốn hàng bán ra)",
    fallback: null,
    duplicatePolicy: "NONE",
    coverageRequirement: "NONE",
    expenseCategories: [],
    note: "% × giá vốn hàng BÁN RA trong kỳ. Phần rủi ro của hàng chưa bán hiện riêng, không trừ.",
  },
  OTHER_OPERATING: {
    label: "Chi phí vận hành khác",
    source: "EXPENSES",
    recognitionMethod: "EVENT_DATE",
    dateBasis: "expenses.occurred_at",
    fallback: null,
    duplicatePolicy: "NONE",
    coverageRequirement: "NONE",
    expenseCategories: ["PACKAGING", "OTHER"],
    note: "Đóng gói, văn phòng phẩm, sửa chữa, thuế lệ phí, phí ngân hàng, lãi vay.",
  },
};

/** Thành phần chi phí mà một nhóm ở bảng Chi phí thuộc về. `null` = nhóm không thuộc thành phần nào. */
export function componentOfExpenseCategory(category: ExpenseCategory): CostComponent | null {
  for (const c of COST_COMPONENTS) {
    // SALARY và COMMISSION cùng dùng nhóm `SALARY`; quy về SALARY để không đếm hai lần.
    if (c === "COMMISSION") continue;
    if (COST_AUTHORITY_REGISTRY[c].expenseCategories.includes(category)) return c;
  }
  return null;
}

/**
 * Nhóm ở bảng Chi phí bị LOẠI hẳn khỏi đường "chi phí vận hành" vì nguồn khác bao trọn.
 *
 * `ALLOW_WITH_EVIDENCE` KHÔNG nằm ở đây: nhóm đó vẫn được tính, nhưng chỉ với khoản khai là điều
 * chỉnh có lý do (lọc theo `expenses.cost_source`, xem `lib/queries/cost-allocation.ts`).
 */
export const HARD_EXCLUDED_EXPENSE_CATEGORIES: ExpenseCategory[] = COST_COMPONENTS.flatMap((c) => {
  const spec = COST_AUTHORITY_REGISTRY[c];
  return spec.duplicatePolicy === "EXCLUDE_OTHER_SOURCES" && spec.coverageRequirement === "NONE" ? spec.expenseCategories : [];
});

/**
 * Nhóm chỉ được tính khi khoản chi khai là ĐIỀU CHỈNH có chứng cứ.
 * Cước và phí hoàn thông thường đã nằm ở vận đơn; nhưng đền bù, phí ngoại lệ, cước chuyến gom hàng
 * không gắn được vận đơn nào vẫn là tiền thật của shop.
 */
export const EVIDENCE_ONLY_EXPENSE_CATEGORIES: ExpenseCategory[] = COST_COMPONENTS.flatMap((c) => {
  const spec = COST_AUTHORITY_REGISTRY[c];
  return spec.duplicatePolicy === "ALLOW_WITH_EVIDENCE" ? spec.expenseCategories : [];
});

/**
 * Nhóm bị loại CÓ ĐIỀU KIỆN: chỉ khi nguồn chính đã phủ đủ dữ liệu.
 * Đây là `SALARY` trong giai đoạn chuyển giao sang bảng Lương.
 */
export const COVERAGE_GATED_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  ...new Set(
    COST_COMPONENTS.flatMap((c) => {
      const spec = COST_AUTHORITY_REGISTRY[c];
      return spec.coverageRequirement === "COMPLETE_ELSE_FALLBACK" ? spec.expenseCategories : [];
    }),
  ),
];

/** Nguồn chi phí đã phủ đủ dữ liệu để cầm quyền hay chưa */
export const COVERAGE_STATES = ["COMPLETE", "INCOMPLETE", "NOT_APPLICABLE"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];
