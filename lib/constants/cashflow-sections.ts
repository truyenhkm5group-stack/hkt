import { BANK_GROUPS, BANK_GROUP_SPEC, type BankGroup } from "@/lib/constants/bank";

/**
 * ═══════════ BỐN KHOANG CỦA MỘT BÁO CÁO DÒNG TIỀN ═══════════
 *
 * Báo cáo dòng tiền chuẩn chia tiền theo VIỆC SINH RA NÓ, không theo dấu của số tiền: bán hàng thu
 * tiền và vay tiền về đều là tiền vào, nhưng trộn chúng lại thì một shop đang lỗ mà đi vay trông
 * như một shop đang bán tốt. Đó chính là cách một chủ shop tiêu hết tiền vay mà tưởng mình lãi.
 *
 * ─── VÌ SAO SUY RA TỪ `BANK_GROUP_SPEC`, KHÔNG KHAI LẠI ───
 *
 * Mỗi nhóm kế toán đã khai `cashClass` ở `lib/constants/bank.ts`. Khai lại danh sách nhóm ở đây là
 * tạo nguồn sự thật thứ hai: thêm một nhóm mới bên kia mà quên bên này thì nhóm đó lặng lẽ rơi
 * khỏi báo cáo dòng tiền — tiền thật biến mất khỏi màn hình mà không có gì báo.
 *
 * Nên ở đây chỉ khai phép ÁNH XẠ `cashClass → khoang`, rồi suy danh sách nhóm ra từ đó. Hai ngoại
 * lệ được gọi tên tường minh vì `cashClass` của chúng là `OTHER` (không đủ để phân khoang): mua tài
 * sản và đặt cọc nhà cung cấp là ĐẦU TƯ, không phải vận hành.
 */

export const CASHFLOW_SECTIONS = ["OPERATING", "INVESTING", "FINANCING", "EXCLUDED"] as const;
export type CashflowSection = (typeof CASHFLOW_SECTIONS)[number];

export const CASHFLOW_SECTION_LABEL: Record<CashflowSection, string> = {
  OPERATING: "Hoạt động kinh doanh",
  INVESTING: "Đầu tư",
  FINANCING: "Vốn & vay",
  EXCLUDED: "Không tính vào dòng tiền",
};

export const CASHFLOW_SECTION_HINT: Record<CashflowSection, string> = {
  OPERATING:
    "Tiền sinh ra từ việc bán hàng và chi cho việc bán hàng. Đây là khoang DUY NHẤT nói lên shop có tự nuôi được mình không — vay tiền về hay bơm vốn vào đều không nằm ở đây.",
  INVESTING: "Mua tài sản dùng nhiều năm và tiền cọc nhà cung cấp. Tiền ra hôm nay nhưng không phải chi phí của hôm nay.",
  FINANCING: "Góp vốn, nhận vay, trả gốc, rút lợi nhuận. KHÔNG phải doanh thu và KHÔNG phải chi phí — chỉ là tiền đổi chủ.",
  EXCLUDED:
    "Chuyển giữa hai tài khoản của mình và chi tiêu không thuộc kinh doanh. Gộp hai đầu của một lần chuyển nội bộ thì tổng bằng 0; nếu KHÔNG bằng 0 thì sổ đang thiếu một đầu.",
};

/** Ngoại lệ: `cashClass = OTHER` không đủ để phân khoang, nên gọi tên tường minh. */
const INVESTING_GROUPS: BankGroup[] = ["ASSET_PURCHASE", "SUPPLIER_DEPOSIT"];

export function sectionOf(group: BankGroup): CashflowSection {
  if (INVESTING_GROUPS.includes(group)) return "INVESTING";
  switch (BANK_GROUP_SPEC[group].cashClass) {
    case "BUSINESS_INFLOW":
    case "BUSINESS_OUTFLOW":
    case "TAX":
    // Chưa phân loại VẪN là tiền đã vào / ra tài khoản, nên vẫn thuộc dòng tiền vận hành. Đẩy nó
    // ra khỏi báo cáo sẽ khiến đầu kỳ + vào − ra ≠ cuối kỳ, và phần lệch không có chỗ nào giải thích.
    case "UNCLASSIFIED":
      return "OPERATING";
    case "CAPITAL":
    case "OWNER":
      return "FINANCING";
    case "INTERNAL_TRANSFER":
      return "EXCLUDED";
    default:
      return "EXCLUDED";
  }
}

/** Nhóm kế toán thuộc từng khoang — suy ra, không khai tay, nên không nhóm nào rơi mất. */
export const GROUPS_BY_SECTION: Record<CashflowSection, BankGroup[]> = CASHFLOW_SECTIONS.reduce(
  (acc, s) => ({ ...acc, [s]: BANK_GROUPS.filter((g) => sectionOf(g) === s) }),
  {} as Record<CashflowSection, BankGroup[]>,
);

/**
 * NHÓM KHÔNG PHẢI CHI PHÍ — dùng để lọc "tiền ra" khi vẽ biểu đồ / xếp hạng nhà cung cấp.
 *
 * Trả nợ gốc, rút vốn, chuyển giữa tài khoản của mình và chi tiêu cá nhân đều làm tài khoản vơi
 * đi, nhưng KHÔNG khoản nào là chi phí. Vẽ chúng lên biểu đồ chi phí sẽ tạo những đỉnh không ứng
 * với khoản chi nào, và người đọc đi tìm một khoản không tồn tại.
 *
 * SUY RA từ phép phân khoang thay vì gõ tay danh sách: thêm một nhóm "vốn / vay" mới ở
 * `lib/constants/bank.ts` thì nó tự bị loại đúng như các nhóm cùng loại, không cần ai nhớ sửa
 * thêm chỗ này. Đây đúng là chỗ mà một danh sách gõ tay đã từng bỏ sót hai nhóm cước và phí hoàn.
 */
export const NON_EXPENSE_GROUPS: BankGroup[] = [...GROUPS_BY_SECTION.EXCLUDED, ...GROUPS_BY_SECTION.FINANCING];
