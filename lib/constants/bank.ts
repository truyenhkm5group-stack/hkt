/**
 * ════════════ NHÓM KẾ TOÁN CHO GIAO DỊCH SAO KÊ ════════════
 *
 * Sao kê là nguồn TIỀN THẬT. Nhưng "tiền ra" KHÔNG đồng nghĩa "chi phí", và "tiền vào" KHÔNG đồng
 * nghĩa "doanh thu":
 *  - chuyển giữa hai tài khoản của chính mình: tiền ra ở đây, tiền vào ở kia, lãi lỗ không đổi;
 *  - trả nợ gốc: tiền ra thật nhưng không phải chi phí (chỉ lãi vay mới là);
 *  - tiền COD Viettel Post trả về: tiền vào thật nhưng doanh thu đã được ghi từ lúc giao hàng.
 *
 * Nên mỗi giao dịch phải được gán một NHÓM KẾ TOÁN, và chính nhóm đó (không phải dấu của số tiền)
 * quyết định giao dịch đi vào báo cáo nào.
 *
 * ─── LUẬT CHỐNG TRỪ HAI LẦN ───
 * Nhiều nhóm đã có NGUỒN CHUYÊN BIỆT đưa vào lợi nhuận rồi (xem `lib/constants/cost-sources.ts`):
 * quảng cáo từ tài khoản QC, tiền hàng từ phiếu kho, cước từ bảng kê ĐVVC, doanh thu từ đơn hàng.
 * Với những nhóm đó, dòng sao kê **chỉ tính vào dòng tiền và đối chiếu**, KHÔNG được đẩy sang bảng
 * Chi phí — nếu không, cùng một đồng bị trừ hai lần và lợi nhuận thấp giả.
 */
import type { ExpenseCategory } from "@/db/schema";
import { COST_AUTHORITY, type CostSource, type EconomicCost } from "@/lib/constants/cost-sources";

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

/** Giao dịch đi vào lãi lỗ theo cách nào */
export type BankPnlEffect =
  | { kind: "NONE" }
  | { kind: "REVENUE" }
  | { kind: "EXPENSE"; category: ExpenseCategory; economic: EconomicCost };

export type BankGroupSpec = {
  label: string;
  /** Chiều tiền tự nhiên của nhóm — dùng để cảnh báo khi gán sai chiều, KHÔNG chặn cứng */
  direction: "IN" | "OUT" | "ANY";
  /** Có phải dòng tiền KINH DOANH không. Chuyển nội bộ = false: tiền chỉ đổi túi, không vào/ra shop. */
  businessCash: boolean;
  pnl: BankPnlEffect;
  /** Nguồn có thẩm quyền đưa khoản này vào lợi nhuận. `null` = không vào lợi nhuận. */
  authority: CostSource | "ORDER" | null;
  hint: string;
};

const SOURCE_OWNER_LABEL: Record<CostSource | "ORDER", string> = {
  PAYROLL: "bảng Lương",
  EXPENSES: "bảng Chi phí",
  ADS: "tài khoản quảng cáo",
  INVENTORY: "phiếu kho (giá vốn)",
  SHIPMENT: "vận đơn / bảng kê ĐVVC",
  BANK: "sao kê ngân hàng",
  ASSUMPTION: "giả định báo cáo",
  ORDER: "đơn hàng",
};

const expense = (category: ExpenseCategory, economic: EconomicCost): BankPnlEffect => ({ kind: "EXPENSE", category, economic });

export const BANK_GROUP_SPEC: Record<BankGroup, BankGroupSpec> = {
  UNCLASSIFIED: {
    label: "Chưa phân loại",
    direction: "ANY",
    // TIỀN VẪN LÀ TIỀN THẬT. Chưa biết nó thuộc khoản gì không có nghĩa nó không rời tài khoản —
    // loại khỏi tổng dòng tiền sẽ khiến "tiền ra" nhỏ hơn sao kê mà không chỗ nào giải thích.
    // Cái CHƯA BIẾT là NHÓM, và điều đó được nói riêng bằng thẻ "Chưa phân loại".
    businessCash: true,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Chưa gán nhóm nên KHÔNG vào lãi lỗ. Vẫn tính vào dòng tiền vì tiền đã thật sự vào/ra tài khoản.",
  },
  SALES_REVENUE: {
    label: "Doanh thu bán hàng",
    direction: "IN",
    businessCash: true,
    pnl: { kind: "REVENUE" },
    authority: "ORDER",
    hint: "Khách chuyển khoản trả tiền hàng. Doanh thu đã ghi từ đơn hàng nên dòng này chỉ dùng đối chiếu tiền về.",
  },
  COD_SETTLEMENT: {
    label: "Tiền COD ĐVVC trả về",
    direction: "IN",
    businessCash: true,
    pnl: { kind: "REVENUE" },
    authority: "SHIPMENT",
    hint: "Viettel Post trả tiền theo bảng kê. Đối chiếu với module Đối soát COD; không cộng thêm vào doanh thu.",
  },
  OTHER_INCOME: {
    label: "Thu nhập khác",
    direction: "IN",
    businessCash: true,
    pnl: { kind: "REVENUE" },
    authority: "BANK",
    hint: "Lãi ngân hàng, hoàn tiền nhà cung cấp, thanh lý tài sản.",
  },
  CAPITAL_IN: {
    label: "Góp vốn",
    direction: "IN",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Chủ shop bơm vốn vào. Là nguồn vốn, không phải doanh thu.",
  },
  LOAN_IN: {
    label: "Nhận tiền vay",
    direction: "IN",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Tiền vay về tài khoản. Không phải doanh thu; chỉ phần LÃI vay mới là chi phí.",
  },
  PAYROLL_SALARY: {
    label: "Lương cố định",
    direction: "OUT",
    businessCash: true,
    pnl: expense("SALARY", "SALARY"),
    authority: COST_AUTHORITY.SALARY,
    hint: "Lương tháng. Nên khai KỲ HIỆU LỰC để báo cáo tuần chia đúng theo ngày, không dồn vào ngày trả lương.",
  },
  PAYROLL_COMMISSION: {
    label: "Hoa hồng / thưởng",
    direction: "OUT",
    businessCash: true,
    pnl: expense("SALARY", "COMMISSION"),
    authority: COST_AUTHORITY.COMMISSION,
    hint: "Hoa hồng theo doanh số / đơn. Bản chất đi theo ĐƠN chứ không theo ngày, nên tách riêng khỏi lương cố định để không bị chia đều oan.",
  },
  RENT_UTILITIES: {
    label: "Mặt bằng · điện nước",
    direction: "OUT",
    businessCash: true,
    pnl: expense("RENT", "RENT"),
    authority: COST_AUTHORITY.RENT,
    hint: "Thuê mặt bằng, điện, nước, internet. Khai kỳ hiệu lực để chia theo số ngày.",
  },
  SOFTWARE: {
    label: "Phần mềm · dịch vụ",
    direction: "OUT",
    businessCash: true,
    pnl: expense("SOFTWARE", "SOFTWARE"),
    authority: COST_AUTHORITY.SOFTWARE,
    hint: "Thuê bao phần mềm, máy chủ, tên miền. Gói năm phải khai kỳ 12 tháng, không ném trọn vào tháng trả tiền.",
  },
  PACKAGING: {
    label: "Đóng gói",
    direction: "OUT",
    businessCash: true,
    pnl: expense("PACKAGING", "PACKAGING"),
    authority: COST_AUTHORITY.PACKAGING,
    hint: "Túi, thùng, băng keo, tem. Nếu đã dùng chứng từ thật thì đặt giả định đóng hàng/đơn về 0 để không trừ hai lần.",
  },
  TAX: {
    label: "Thuế · lệ phí",
    direction: "OUT",
    businessCash: true,
    pnl: expense("OTHER", "OTHER_OPEX"),
    authority: "EXPENSES",
    hint: "Thuế khoán, lệ phí môn bài. Khác với dự trù thuế % trong giả định báo cáo: đây là tiền đã nộp thật.",
  },
  BANK_FEE: {
    label: "Phí ngân hàng",
    direction: "OUT",
    businessCash: true,
    pnl: expense("OTHER", "OTHER_OPEX"),
    authority: "EXPENSES",
    hint: "Phí chuyển khoản, phí duy trì tài khoản, phí SMS.",
  },
  LOAN_INTEREST: {
    label: "Lãi vay",
    direction: "OUT",
    businessCash: true,
    pnl: expense("OTHER", "OTHER_OPEX"),
    authority: "EXPENSES",
    hint: "Chỉ phần LÃI là chi phí. Phần gốc phải gán nhóm Trả nợ gốc.",
  },
  OTHER_EXPENSE: {
    label: "Chi phí vận hành khác",
    direction: "OUT",
    businessCash: true,
    pnl: expense("OTHER", "OTHER_OPEX"),
    authority: "EXPENSES",
    hint: "Văn phòng phẩm, sửa chữa, chi phí lẻ.",
  },
  ADS_SPEND: {
    label: "Chi quảng cáo",
    direction: "OUT",
    businessCash: true,
    pnl: expense("ADS", "ADS"),
    authority: COST_AUTHORITY.ADS,
    hint: "Meta / TikTok trừ thẻ. Số thực chi THEO NGÀY đã về từ tài khoản quảng cáo, dòng này chỉ để đối chiếu tiền ra.",
  },
  PURCHASE: {
    label: "Nhập hàng · trả tiền xưởng",
    direction: "OUT",
    businessCash: true,
    pnl: expense("PURCHASE", "COGS"),
    authority: COST_AUTHORITY.COGS,
    hint: "Tiền hàng đã nằm trong giá vốn qua phiếu nhập kho, dòng này chỉ để đối chiếu công nợ xưởng.",
  },
  SHIPPING_FEE: {
    label: "Cước vận chuyển",
    direction: "OUT",
    businessCash: true,
    pnl: expense("SHIPPING", "SHIPPING"),
    authority: COST_AUTHORITY.SHIPPING,
    hint: "Cước ĐVVC đã tính theo từng đơn / bảng kê, dòng này chỉ để đối chiếu.",
  },
  RETURN_FEE: {
    label: "Phí hoàn hàng",
    direction: "OUT",
    businessCash: true,
    pnl: expense("RETURN_FEE", "RETURN_FEE"),
    authority: COST_AUTHORITY.RETURN_FEE,
    hint: "Phí hoàn đã tính theo vận đơn, dòng này chỉ để đối chiếu.",
  },
  INTERNAL_TRANSFER: {
    label: "Chuyển giữa tài khoản của mình",
    direction: "ANY",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Tiền chỉ đổi túi. Nếu tính vào dòng tiền thì cùng một đồng vừa là tiền ra vừa là tiền vào.",
  },
  LOAN_PRINCIPAL: {
    label: "Trả nợ gốc vay",
    direction: "OUT",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Trả gốc là giảm nợ, không phải chi phí. Phần lãi tách sang nhóm Lãi vay.",
  },
  OWNER_DRAW: {
    label: "Rút vốn / chia lợi nhuận",
    direction: "OUT",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Chủ shop rút tiền ra. Là phân phối lợi nhuận, không phải chi phí kinh doanh.",
  },
  ASSET_PURCHASE: {
    label: "Mua tài sản",
    direction: "OUT",
    businessCash: true,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Máy móc, thiết bị dùng nhiều năm. Không trừ trọn vào một kỳ; khi có khấu hao thì khai ở bảng Chi phí theo kỳ.",
  },
  SUPPLIER_DEPOSIT: {
    label: "Đặt cọc nhà cung cấp",
    direction: "OUT",
    businessCash: true,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Tiền cọc chưa phải chi phí, thành giá vốn khi hàng về và lập phiếu nhập.",
  },
  NOT_BUSINESS: {
    label: "Không thuộc kinh doanh",
    direction: "ANY",
    businessCash: false,
    pnl: { kind: "NONE" },
    authority: null,
    hint: "Chi tiêu cá nhân đi nhờ tài khoản shop. Giữ lại để sao kê khớp số dư, nhưng không vào báo cáo nào.",
  },
};

/** Nhóm nào được đẩy sang bảng Chi phí để vào Báo cáo lợi nhuận — chỉ khi bảng Chi phí có thẩm quyền */
export function canPostToExpenses(group: BankGroup): boolean {
  const spec = BANK_GROUP_SPEC[group];
  return spec.pnl.kind === "EXPENSE" && spec.authority === "EXPENSES";
}

/** Vì sao một nhóm KHÔNG được đẩy sang Chi phí — hiện thẳng trên giao diện thay vì để nút mờ đi im lặng */
export function postBlockedReason(group: BankGroup): string | null {
  const spec = BANK_GROUP_SPEC[group];
  if (spec.pnl.kind === "NONE") return `${spec.label} không ảnh hưởng lãi lỗ, chỉ là dòng tiền.`;
  if (spec.pnl.kind === "REVENUE") return "Doanh thu đã được ghi nhận từ đơn hàng / bảng kê COD. Ghi thêm ở đây là đếm hai lần.";
  if (spec.authority !== "EXPENSES") {
    const owner = spec.authority ? SOURCE_OWNER_LABEL[spec.authority] : "nguồn khác";
    return `Khoản này đã vào lợi nhuận từ ${owner}. Đẩy thêm sang bảng Chi phí là trừ hai lần.`;
  }
  return null;
}

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
