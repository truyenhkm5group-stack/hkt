/**
 * ════════════ NHÓM KẾ TOÁN CHO GIAO DỊCH SAO KÊ ════════════
 *
 * ─── RANH GIỚI CỨNG: SAO KÊ LÀ TIỀN, KHÔNG PHẢI CHI PHÍ ───
 *
 * Một dòng tiền ra **không** tự sinh chi phí trong lãi lỗ. Trả lương qua ngân hàng ngày 05 là tiền
 * đi ra ngày 05, nhưng chi phí lương của tháng đó đã được ghi nhận theo kỳ ở nguồn có thẩm quyền
 * (`lib/constants/cost-authority.ts`). Nếu dòng sao kê cũng sinh ra một khoản chi thì cùng một đồng
 * bị trừ hai lần — và lần thứ hai còn rơi sai kỳ.
 *
 * Nên nhóm kế toán ở đây chỉ quyết định giao dịch thuộc LOẠI DÒNG TIỀN nào (`BankCashClass`).
 * Việc nối nó với chứng từ (khoản chi, bảng kê COD, phiếu nhập, chi tiêu QC) là ĐỐI CHIẾU
 * (`bank_transactions.linked_type` / `linked_id`), không phải ghi nhận.
 *
 *   SỔ NGÂN HÀNG   = sự thật về TIỀN (đã vào/ra tài khoản, theo ngày ngân hàng ghi)
 *   PROFIT ENGINE  = sự thật về CHI PHÍ KINH TẾ (theo kỳ hưởng lợi ích, theo nguồn có thẩm quyền)
 *
 * Hai thứ đó lệch nhau là chuyện bình thường và KHÔNG được trộn.
 */

export const BANK_GROUPS = [
  "UNCLASSIFIED",
  // ── Tiền vào ──
  "SALES_REVENUE",
  "COD_SETTLEMENT",
  "OTHER_INCOME",
  "CAPITAL_IN",
  "LOAN_IN",
  // ── Tiền ra: chi phí có thẩm quyền ở bảng Chi phí ──
  "PAYROLL_SALARY",
  "PAYROLL_COMMISSION",
  "RENT_UTILITIES",
  "SOFTWARE",
  "PACKAGING",
  "TAX",
  "BANK_FEE",
  "LOAN_INTEREST",
  "OTHER_EXPENSE",
  // ── Tiền ra: đã có nguồn chuyên biệt, chỉ đối chiếu ──
  "ADS_SPEND",
  "PURCHASE",
  "SHIPPING_FEE",
  "RETURN_FEE",
  // ── Không ảnh hưởng lãi lỗ ──
  "INTERNAL_TRANSFER",
  "LOAN_PRINCIPAL",
  "OWNER_DRAW",
  "ASSET_PURCHASE",
  "SUPPLIER_DEPOSIT",
  "NOT_BUSINESS",
] as const;
export type BankGroup = (typeof BANK_GROUPS)[number];

/**
 * LOẠI DÒNG TIỀN — thứ DUY NHẤT mà nhóm kế toán quyết định.
 *
 * Cố ý KHÔNG có "chi phí": phân loại một dòng tiền không tạo ra chi phí nào cả.
 */
export const BANK_CASH_CLASSES = [
  "BUSINESS_INFLOW",
  "BUSINESS_OUTFLOW",
  "INTERNAL_TRANSFER",
  "CAPITAL",
  "OWNER",
  "TAX",
  "OTHER",
  "UNCLASSIFIED",
] as const;
export type BankCashClass = (typeof BANK_CASH_CLASSES)[number];

export const BANK_CASH_CLASS_LABEL: Record<BankCashClass, string> = {
  BUSINESS_INFLOW: "Tiền vào kinh doanh",
  BUSINESS_OUTFLOW: "Tiền ra kinh doanh",
  INTERNAL_TRANSFER: "Chuyển nội bộ",
  CAPITAL: "Vốn / vay",
  OWNER: "Chủ sở hữu",
  TAX: "Thuế",
  OTHER: "Khác",
  UNCLASSIFIED: "Chưa phân loại",
};

/** Loại chứng từ mà một giao dịch có thể được NỐI tới để đối chiếu (không tạo chi phí mới) */
export const BANK_LINK_TYPES = ["EXPENSE", "COD_BATCH", "STOCK_RECEIPT", "AD_SPEND"] as const;
export type BankLinkType = (typeof BANK_LINK_TYPES)[number];

export const BANK_LINK_TYPE_LABEL: Record<BankLinkType, string> = {
  EXPENSE: "Khoản chi ở bảng Chi phí",
  COD_BATCH: "Đợt nhận tiền COD",
  STOCK_RECEIPT: "Phiếu nhập kho",
  AD_SPEND: "Chi tiêu quảng cáo",
};

export type BankGroupSpec = {
  label: string;
  /** Chiều tiền tự nhiên của nhóm — để cảnh báo khi gán sai chiều, KHÔNG chặn cứng */
  direction: "IN" | "OUT" | "ANY";
  /** Loại dòng tiền. Đây là thứ DUY NHẤT nhóm kế toán quyết định. */
  cashClass: BankCashClass;
  /**
   * Chứng từ nên NỐI tới để đối chiếu. `null` = không có gì để đối chiếu.
   * Nối là để trả lời "đồng tiền này ứng với chứng từ nào", KHÔNG phải để tạo chi phí.
   */
  linkTo: BankLinkType | null;
  hint: string;
};

export const BANK_GROUP_SPEC: Record<BankGroup, BankGroupSpec> = {
  UNCLASSIFIED: {
    label: "Chưa phân loại",
    direction: "ANY",
    cashClass: "UNCLASSIFIED",
    linkTo: null,
    hint: "Chưa gán nhóm nên KHÔNG vào lãi lỗ. Vẫn tính vào dòng tiền vì tiền đã thật sự vào/ra tài khoản.",
  },
  SALES_REVENUE: {
    label: "Doanh thu bán hàng",
    direction: "IN",
    cashClass: "BUSINESS_INFLOW",
    linkTo: null,
    hint: "Khách chuyển khoản trả tiền hàng. Doanh thu đã ghi từ đơn hàng nên dòng này chỉ dùng đối chiếu tiền về.",
  },
  COD_SETTLEMENT: {
    label: "Tiền COD ĐVVC trả về",
    direction: "IN",
    cashClass: "BUSINESS_INFLOW",
    linkTo: "COD_BATCH",
    hint: "Viettel Post trả tiền theo bảng kê. Đối chiếu với module Đối soát COD; không cộng thêm vào doanh thu.",
  },
  OTHER_INCOME: {
    label: "Thu nhập khác",
    direction: "IN",
    cashClass: "BUSINESS_INFLOW",
    linkTo: null,
    hint: "Lãi ngân hàng, hoàn tiền nhà cung cấp, thanh lý tài sản.",
  },
  CAPITAL_IN: {
    label: "Góp vốn",
    direction: "IN",
    cashClass: "CAPITAL",
    linkTo: null,
    hint: "Chủ shop bơm vốn vào. Là nguồn vốn, không phải doanh thu.",
  },
  LOAN_IN: {
    label: "Nhận tiền vay",
    direction: "IN",
    cashClass: "CAPITAL",
    linkTo: null,
    hint: "Tiền vay về tài khoản. Không phải doanh thu; chỉ phần LÃI vay mới là chi phí.",
  },
  PAYROLL_SALARY: {
    label: "Lương cố định",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Lương tháng. Nên khai KỲ HIỆU LỰC để báo cáo tuần chia đúng theo ngày, không dồn vào ngày trả lương.",
  },
  PAYROLL_COMMISSION: {
    label: "Hoa hồng / thưởng",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Hoa hồng theo doanh số / đơn. Bản chất đi theo ĐƠN chứ không theo ngày, nên tách riêng khỏi lương cố định để không bị chia đều oan.",
  },
  RENT_UTILITIES: {
    label: "Mặt bằng · điện nước",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Thuê mặt bằng, điện, nước, internet. Khai kỳ hiệu lực để chia theo số ngày.",
  },
  SOFTWARE: {
    label: "Phần mềm · dịch vụ",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Thuê bao phần mềm, máy chủ, tên miền. Gói năm phải khai kỳ 12 tháng, không ném trọn vào tháng trả tiền.",
  },
  PACKAGING: {
    label: "Đóng gói",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Túi, thùng, băng keo, tem. Nếu đã dùng chứng từ thật thì đặt giả định đóng hàng/đơn về 0 để không trừ hai lần.",
  },
  TAX: {
    label: "Thuế · lệ phí",
    direction: "OUT",
    cashClass: "TAX",
    linkTo: "EXPENSE",
    hint: "Thuế khoán, lệ phí môn bài. Khác với dự trù thuế % trong giả định báo cáo: đây là tiền đã nộp thật.",
  },
  BANK_FEE: {
    label: "Phí ngân hàng",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Phí chuyển khoản, phí duy trì tài khoản, phí SMS.",
  },
  LOAN_INTEREST: {
    label: "Lãi vay",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Chỉ phần LÃI là chi phí. Phần gốc phải gán nhóm Trả nợ gốc.",
  },
  OTHER_EXPENSE: {
    label: "Chi phí vận hành khác",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "EXPENSE",
    hint: "Văn phòng phẩm, sửa chữa, chi phí lẻ.",
  },
  ADS_SPEND: {
    label: "Chi quảng cáo",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "AD_SPEND",
    hint: "Meta / TikTok trừ thẻ. Số thực chi THEO NGÀY đã về từ tài khoản quảng cáo, dòng này chỉ để đối chiếu tiền ra.",
  },
  PURCHASE: {
    label: "Nhập hàng · trả tiền xưởng",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: "STOCK_RECEIPT",
    hint: "Tiền hàng đã nằm trong giá vốn qua phiếu nhập kho, dòng này chỉ để đối chiếu công nợ xưởng.",
  },
  SHIPPING_FEE: {
    label: "Cước vận chuyển",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: null,
    hint: "Cước ĐVVC đã tính theo từng đơn / bảng kê, dòng này chỉ để đối chiếu.",
  },
  RETURN_FEE: {
    label: "Phí hoàn hàng",
    direction: "OUT",
    cashClass: "BUSINESS_OUTFLOW",
    linkTo: null,
    hint: "Phí hoàn đã tính theo vận đơn, dòng này chỉ để đối chiếu.",
  },
  INTERNAL_TRANSFER: {
    label: "Chuyển giữa tài khoản của mình",
    direction: "ANY",
    cashClass: "INTERNAL_TRANSFER",
    linkTo: null,
    hint: "Tiền chỉ đổi túi. Nếu tính vào dòng tiền thì cùng một đồng vừa là tiền ra vừa là tiền vào.",
  },
  LOAN_PRINCIPAL: {
    label: "Trả nợ gốc vay",
    direction: "OUT",
    cashClass: "CAPITAL",
    linkTo: null,
    hint: "Trả gốc là giảm nợ, không phải chi phí. Phần lãi tách sang nhóm Lãi vay.",
  },
  OWNER_DRAW: {
    label: "Rút vốn / chia lợi nhuận",
    direction: "OUT",
    cashClass: "OWNER",
    linkTo: null,
    hint: "Chủ shop rút tiền ra. Là phân phối lợi nhuận, không phải chi phí kinh doanh.",
  },
  ASSET_PURCHASE: {
    label: "Mua tài sản",
    direction: "OUT",
    cashClass: "OTHER",
    linkTo: null,
    hint: "Máy móc, thiết bị dùng nhiều năm. Không trừ trọn vào một kỳ; khi có khấu hao thì khai ở bảng Chi phí theo kỳ.",
  },
  SUPPLIER_DEPOSIT: {
    label: "Đặt cọc nhà cung cấp",
    direction: "OUT",
    cashClass: "OTHER",
    linkTo: "STOCK_RECEIPT",
    hint: "Tiền cọc chưa phải chi phí, thành giá vốn khi hàng về và lập phiếu nhập.",
  },
  NOT_BUSINESS: {
    label: "Không thuộc kinh doanh",
    direction: "ANY",
    cashClass: "OTHER",
    linkTo: null,
    hint: "Chi tiêu cá nhân đi nhờ tài khoản shop. Giữ lại để sao kê khớp số dư, nhưng không vào báo cáo nào.",
  },
};

/**
 * Nhóm có phải DÒNG TIỀN KINH DOANH không.
 *
 * Chuyển giữa hai tài khoản của mình mà tính vào thì cùng một đồng vừa là tiền ra vừa là tiền vào:
 * chênh lệch vẫn đúng nhưng cả hai con số tổng đều bị thổi phồng.
 */
export function isBusinessCash(group: BankGroup): boolean {
  const c = BANK_GROUP_SPEC[group].cashClass;
  return c === "BUSINESS_INFLOW" || c === "BUSINESS_OUTFLOW" || c === "TAX" || c === "UNCLASSIFIED";
}

/**
 * Vì sao giao dịch này KHÔNG tự tạo chi phí trong lợi nhuận — hiện thẳng trên giao diện, vì "bấm mà
 * không thấy gì đổi" là cách nhanh nhất làm người dùng mất tin vào con số.
 */
export const BANK_NOT_A_COST_NOTE =
  "Sao kê là sự thật về TIỀN, không phải về chi phí. Phân loại một dòng tiền không tạo ra khoản chi nào: chi phí được ghi nhận theo kỳ ở nguồn có thẩm quyền. Dùng nút Nối để đối chiếu dòng tiền này với chứng từ đã có.";

/** Thứ tự hiển thị trong ô chọn — gom theo bản chất, không xếp theo bảng chữ cái */
export const BANK_GROUP_SECTIONS: { title: string; groups: BankGroup[] }[] = [
  { title: "Chưa phân loại", groups: ["UNCLASSIFIED"] },
  { title: "Tiền vào", groups: ["SALES_REVENUE", "COD_SETTLEMENT", "OTHER_INCOME", "CAPITAL_IN", "LOAN_IN"] },
  { title: "Chi phí vận hành (vào lợi nhuận)", groups: ["PAYROLL_SALARY", "PAYROLL_COMMISSION", "RENT_UTILITIES", "SOFTWARE", "PACKAGING", "TAX", "BANK_FEE", "LOAN_INTEREST", "OTHER_EXPENSE"] },
  { title: "Đã có nguồn khác (chỉ đối chiếu)", groups: ["ADS_SPEND", "PURCHASE", "SHIPPING_FEE", "RETURN_FEE"] },
  { title: "Không ảnh hưởng lãi lỗ", groups: ["INTERNAL_TRANSFER", "LOAN_PRINCIPAL", "OWNER_DRAW", "ASSET_PURCHASE", "SUPPLIER_DEPOSIT", "NOT_BUSINESS"] },
];

export const BANK_GROUP_TONE: Record<BankGroup, string> = {
  UNCLASSIFIED: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  SALES_REVENUE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  COD_SETTLEMENT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  OTHER_INCOME: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CAPITAL_IN: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LOAN_IN: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  PAYROLL_SALARY: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PAYROLL_COMMISSION: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  RENT_UTILITIES: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  SOFTWARE: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  PACKAGING: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  TAX: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  BANK_FEE: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  LOAN_INTEREST: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  OTHER_EXPENSE: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ADS_SPEND: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  PURCHASE: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  SHIPPING_FEE: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  RETURN_FEE: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  INTERNAL_TRANSFER: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  LOAN_PRINCIPAL: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  OWNER_DRAW: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  ASSET_PURCHASE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  SUPPLIER_DEPOSIT: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  NOT_BUSINESS: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
};

export const BANK_GROUP_LABEL = Object.fromEntries(BANK_GROUPS.map((g) => [g, BANK_GROUP_SPEC[g].label])) as Record<BankGroup, string>;

export function isBankGroup(value: string): value is BankGroup {
  return (BANK_GROUPS as readonly string[]).includes(value);
}

/** Tiền tố mã tham chiếu khi đẩy giao dịch sang bảng Chi phí — dùng để chống đẩy trùng */
export const BANK_EXPENSE_PREFIX = "MB ";

export const BANK_DIRECTIONS = ["ANY", "IN", "OUT"] as const;
export type BankDirection = (typeof BANK_DIRECTIONS)[number];

export const BANK_DIRECTION_LABEL: Record<BankDirection, string> = {
  ANY: "Vào + ra",
  IN: "Chỉ tiền vào",
  OUT: "Chỉ tiền ra",
};

/**
 * ═══════════ THẺ CỦA MÀN HÌNH SỔ NGÂN HÀNG ═══════════
 *
 * Nằm Ở ĐÂY, không nằm trong `bank-tabs.tsx`, và lý do là một sự cố thật.
 *
 * `BANK_TABS` từng khai trong `bank-tabs.tsx` — tệp có `"use client"`. Server Component
 * `bank/page.tsx` import nó về gọi `.includes()` để lọc tham số `?tab=`. Qua ranh giới `"use client"`
 * Next KHÔNG chuyển giá trị thật sang máy chủ: nó thay module bằng một *client reference proxy*.
 * Phía máy chủ `BANK_TABS` là đối tượng tham chiếu chứ không phải mảng, nên `.includes` không tồn
 * tại và CẢ TRANG hỏng: `TypeError: f.BANK_TABS.includes is not a function`.
 *
 * `tsc`, `eslint` và `next build` đều xanh — phép thay module xảy ra lúc dựng, không có trong mã
 * nguồn. Chỉ người mở trang mới thấy, và người đó là chủ shop.
 *
 * `tests/client-boundary-exports.test.ts` nay khoá điều này cho CẢ kho mã.
 */
export const BANK_TABS = ["giao-dich", "doi-khop", "nhap-sao-ke", "quy-tac", "doi-chieu"] as const;
export type BankTab = (typeof BANK_TABS)[number];

export const BANK_TAB_LABEL: Record<BankTab, string> = {
  "giao-dich": "Giao dịch",
  "doi-khop": "Đối khớp chứng từ",
  "nhap-sao-ke": "Nhập sao kê",
  "quy-tac": "Quy tắc gán nhãn",
  "doi-chieu": "Đối chiếu",
};
