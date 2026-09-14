/**
 * KẾT LUẬN SAU KHI ĐẾM MỘT KIỆN HÀNG HOÀN.
 *
 * Những kết luận này quyết định hàng có vào lại tồn hay không — nên chúng nằm ở hằng số dùng chung,
 * để màn hình kho và lớp truy vấn không bao giờ hiểu khác nhau về cùng một chữ.
 *
 * `WRONG_ITEM` thêm 10/09/2026 theo yêu cầu vận hành: khách trả về MỘT MÓN KHÁC với món đã gửi. Nó
 * không phải "hỏng" cũng không phải "thiếu" — hàng vẫn nguyên vẹn, chỉ là không phải hàng của mình.
 * Gộp nó vào "không bán được" sẽ giấu mất một loại thất thoát cần người xử lý riêng.
 */
export const RETURN_CONDITIONS = ["RESTOCKABLE", "UNSELLABLE", "DAMAGED", "MISSING", "WRONG_ITEM"] as const;

export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const CONDITION_LABEL: Record<ReturnCondition, string> = {
  RESTOCKABLE: "Bán lại được",
  UNSELLABLE: "Không bán được",
  DAMAGED: "Hỏng",
  MISSING: "Thiếu hàng",
  WRONG_ITEM: "Không đúng hàng",
};

/** Nhãn NGẮN cho nút bấm một chạm ở màn hình kho — người đếm nhìn nút, không đọc câu. */
export const CONDITION_ACTION_LABEL: Record<ReturnCondition, string> = {
  RESTOCKABLE: "Nhận đủ",
  UNSELLABLE: "Không bán được",
  DAMAGED: "Hỏng",
  MISSING: "Thiếu",
  WRONG_ITEM: "Không đúng hàng",
};

/**
 * Kết luận nào CÓ cộng lại tồn kho.
 *
 * Chỉ `RESTOCKABLE`. Bốn kết luận còn lại là hàng có thật trong kho nhưng KHÔNG bán lại được, nên
 * chúng phải hiện ra như một khoản thất thoát có tên — không được lặng lẽ cộng vào tồn để sổ đẹp.
 */
export const CONDITION_RESTOCKS: Record<ReturnCondition, boolean> = {
  RESTOCKABLE: true,
  UNSELLABLE: false,
  DAMAGED: false,
  MISSING: false,
  WRONG_ITEM: false,
};

/** Kết luận BẮT BUỘC ghi lý do: mọi kết luận không cộng tồn đều phải nói vì sao. */
export const CONDITION_NEEDS_NOTE: Record<ReturnCondition, boolean> = {
  RESTOCKABLE: false,
  UNSELLABLE: true,
  DAMAGED: true,
  MISSING: true,
  WRONG_ITEM: true,
};

export const CONDITION_TONE: Record<ReturnCondition, "green" | "amber" | "rose" | "slate"> = {
  RESTOCKABLE: "green",
  UNSELLABLE: "amber",
  DAMAGED: "rose",
  MISSING: "rose",
  WRONG_ITEM: "amber",
};

export function isReturnCondition(value: unknown): value is ReturnCondition {
  return typeof value === "string" && (RETURN_CONDITIONS as readonly string[]).includes(value);
}
