/**
 * KẾT LUẬN SAU KHI ĐẾM MỘT KIỆN HÀNG HOÀN.
 *
 * Bốn kết luận này là thứ quyết định hàng có vào lại tồn hay không — nên chúng nằm ở hằng số dùng
 * chung, để màn hình kho và lớp truy vấn không bao giờ hiểu khác nhau về cùng một chữ.
 */
export const RETURN_CONDITIONS = ["RESTOCKABLE", "UNSELLABLE", "DAMAGED", "MISSING"] as const;

export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const CONDITION_LABEL: Record<ReturnCondition, string> = {
  RESTOCKABLE: "Bán lại được",
  UNSELLABLE: "Không bán được",
  DAMAGED: "Hỏng",
  MISSING: "Thiếu hàng",
};
