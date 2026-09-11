/**
 * ═══════════ VÒNG ĐỜI MỘT KIỆN HÀNG HOÀN ═══════════
 *
 *   EXPECTED_RETURN ──→ RECEIVED_AT_WAREHOUSE ──→ INSPECTED ──→ RESTOCKABLE
 *   (ĐVVC báo trả về)    (kho bấm đã nhận)        (đã đếm)   └─→ NON_RESTOCKABLE
 *                                                             (+ cờ DISCREPANCY nếu lệch)
 *
 * BA MỐC LÀ BA VIỆC CỦA BA LÚC KHÁC NHAU, và đây là lý do chúng không được gộp:
 *
 *  · ĐVVC báo "đã hoàn" chỉ nói hàng rời kho của họ. Hàng có thể còn trên đường cả tuần.
 *  · Kho bấm "đã nhận" nói kiện đã nằm trên bàn. VẪN CHƯA ai mở ra xem bên trong có gì.
 *  · Chỉ khi ĐẾM XONG mới biết thực nhận bao nhiêu món, món nào còn bán được.
 *
 * Gộp bất kỳ hai mốc nào là ghi vào sổ một lượng hàng chưa ai nhìn thấy. Phần chênh nằm im trong
 * số tồn tới kỳ kiểm kê, và suốt thời gian đó kế hoạch sản xuất đặt thiếu đúng bằng phần chênh ấy.
 *
 * ───────── CÁI GÌ LƯU, CÁI GÌ SUY RA ─────────
 *
 * Chỉ HAI trạng thái được LƯU trong `return_inspections.status`: `RECEIVED` và `INSPECTED`. Chúng
 * đã có sẵn, đã có ràng buộc CHECK, và mọi truy vấn hiện tại đang đọc chúng.
 *
 * Bốn mốc còn lại SUY RA, không lưu thêm cột:
 *  · EXPECTED_RETURN  — vận đơn đang hoàn mà CHƯA có dòng `return_inspections` nào.
 *  · RESTOCKABLE / NON_RESTOCKABLE — đọc từ kết quả đếm.
 *  · DISCREPANCY      — có lệch giữa hàng kỳ vọng và hàng thực nhận.
 *
 * Vì sao không thêm trạng thái vào cột `status`: hai nguồn cho cùng một sự thật thì sớm muộn lệch
 * nhau, và lúc đó không ai biết nguồn nào đúng. Trạng thái suy ra luôn khớp với dữ liệu sinh ra nó.
 */

export const RETURN_LIFECYCLE = ["EXPECTED_RETURN", "RECEIVED_AT_WAREHOUSE", "INSPECTED_RESTOCKABLE", "INSPECTED_NON_RESTOCKABLE"] as const;
export type ReturnLifecycle = (typeof RETURN_LIFECYCLE)[number];

export const LIFECYCLE_LABEL: Record<ReturnLifecycle, string> = {
  EXPECTED_RETURN: "Chờ kho nhận",
  RECEIVED_AT_WAREHOUSE: "Đã nhận · chờ kiểm",
  INSPECTED_RESTOCKABLE: "Đã kiểm · vào lại tồn",
  INSPECTED_NON_RESTOCKABLE: "Đã kiểm · không vào tồn",
};

export const LIFECYCLE_HINT: Record<ReturnLifecycle, string> = {
  EXPECTED_RETURN: "Đơn vị vận chuyển báo đã trả về shop, chưa ai ở kho bấm nhận. Hàng có thể còn trên đường.",
  RECEIVED_AT_WAREHOUSE: "Kiện đã nằm ở kho nhưng CHƯA ai mở ra đếm. Tồn kho chưa thay đổi một món nào.",
  INSPECTED_RESTOCKABLE: "Đã đếm và có ít nhất một món còn bán lại được — phần đó đã vào tồn qua phiếu tái nhập.",
  INSPECTED_NON_RESTOCKABLE: "Đã đếm nhưng không món nào vào lại tồn được. Đây là thất thoát có tên, không phải hàng biến mất.",
};

export const LIFECYCLE_TONE: Record<ReturnLifecycle, "amber" | "blue" | "green" | "rose"> = {
  EXPECTED_RETURN: "amber",
  RECEIVED_AT_WAREHOUSE: "blue",
  INSPECTED_RESTOCKABLE: "green",
  INSPECTED_NON_RESTOCKABLE: "rose",
};

/**
 * ═══════════ KẾT LUẬN THEO TỪNG MÓN ═══════════
 *
 * KHÁC với `RETURN_CONDITIONS` (kết luận cho CẢ KIỆN, đã có từ trước và vẫn dùng cho đường đếm
 * nhanh). Một kiện ba món có thể vừa đủ một món, vừa thiếu một món, vừa hỏng một món — ép cả kiện
 * về một kết luận là làm mất đúng thông tin mà kho vừa bỏ công đếm ra.
 */
export const ITEM_CONDITIONS = ["OK", "SHORT", "WRONG_ITEM", "DAMAGED", "DIRTY", "UNSELLABLE", "OTHER"] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const ITEM_CONDITION_LABEL: Record<ItemCondition, string> = {
  OK: "Đủ",
  SHORT: "Thiếu",
  WRONG_ITEM: "Sai hàng",
  DAMAGED: "Hỏng",
  DIRTY: "Bẩn",
  UNSELLABLE: "Không bán lại được",
  OTHER: "Khác",
};

/**
 * MÓN NÀO ĐƯỢC CỘNG LẠI TỒN.
 *
 * CHỈ `OK`. Sáu kết luận còn lại là hàng có thật trên bàn nhưng không bán lại được ngay — chúng
 * phải hiện ra thành một khoản thất thoát có tên, không được lặng lẽ cộng vào tồn cho sổ đẹp.
 *
 * "Bẩn" cố ý KHÔNG cộng tồn dù nhiều món giặt lại là bán được: hàng chỉ vào tồn khi nó thực sự sẵn
 * sàng bán. Muốn đưa vào sau khi làm sạch thì lập phiếu nhập riêng — có người ký, nhìn thấy được.
 */
export const ITEM_CONDITION_RESTOCKS: Record<ItemCondition, boolean> = {
  OK: true,
  SHORT: false,
  WRONG_ITEM: false,
  DAMAGED: false,
  DIRTY: false,
  UNSELLABLE: false,
  OTHER: false,
};

/** Kết luận nào BẮT BUỘC ghi lý do: mọi kết luận không cộng tồn đều phải nói vì sao. */
export const ITEM_CONDITION_NEEDS_NOTE: Record<ItemCondition, boolean> = {
  OK: false,
  SHORT: true,
  WRONG_ITEM: true,
  DAMAGED: true,
  DIRTY: true,
  UNSELLABLE: true,
  OTHER: true,
};

export const ITEM_CONDITION_TONE: Record<ItemCondition, "green" | "amber" | "rose"> = {
  OK: "green",
  SHORT: "rose",
  WRONG_ITEM: "amber",
  DAMAGED: "rose",
  DIRTY: "amber",
  UNSELLABLE: "amber",
  OTHER: "amber",
};

export function isItemCondition(value: unknown): value is ItemCondition {
  return typeof value === "string" && (ITEM_CONDITIONS as readonly string[]).includes(value);
}

/**
 * LỆCH là gì: hàng thực nhận không khớp hàng kỳ vọng.
 *
 * Hai loại lệch, và cả hai đều cần người quyết chứ không phải chỉ ghi nhận:
 *  · lệch SỐ LƯỢNG — đếm được ít hơn (hoặc nhiều hơn) số kỳ vọng;
 *  · lệch KẾT LUẬN — món về nhưng không ở trạng thái bán lại được.
 */
export function itemHasDiscrepancy(item: { expectedQty: number; actualQty: number; condition: ItemCondition }): boolean {
  return item.condition !== "OK" || item.actualQty !== item.expectedQty;
}
