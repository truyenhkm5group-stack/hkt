/**
 * ════════════ HỢP ĐỒNG NGUỒN SỰ THẬT CỦA CHI PHÍ — CHỐNG TRỪ HAI LẦN ════════════
 *
 * Một khoản chi phí kinh tế có thể xuất hiện ở NHIỀU nơi trong ERP:
 * lương vừa nằm ở bảng Lương vừa có thể bị gõ tay vào bảng Chi phí; tiền quảng cáo vừa về từ tài
 * khoản Meta vừa hiện trên sao kê ngân hàng; tiền hàng vừa nằm ở phiếu nhập vừa nằm ở sao kê.
 *
 * Nếu mỗi nơi đều được trừ vào lợi nhuận thì cùng một đồng bị trừ hai, ba lần — lợi nhuận thấp giả,
 * và không ai biết vì sao. Đây là lỗi nguy hiểm hơn thiếu dữ liệu: thiếu thì thấy ngay, còn trừ hai
 * lần thì con số vẫn "trông hợp lý".
 *
 * Luật: MỖI loại chi phí kinh tế có ĐÚNG MỘT nguồn được quyền đưa vào lợi nhuận (`COST_AUTHORITY`).
 * Các nguồn còn lại vẫn được GHI NHẬN và hiển thị (để đối chiếu dòng tiền), nhưng KHÔNG được trừ
 * lần thứ hai. ERP không tự xoá dữ liệu của nguồn phụ — chỉ loại nó khỏi phép tính lợi nhuận.
 */
import type { ExpenseCategory } from "@/db/schema";

/** Nơi dữ liệu chi phí đi vào ERP */
export const COST_SOURCES = ["PAYROLL", "EXPENSES", "ADS", "INVENTORY", "SHIPMENT", "BANK", "ASSUMPTION"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const COST_SOURCE_LABEL: Record<CostSource, string> = {
  PAYROLL: "Bảng lương",
  EXPENSES: "Bảng Chi phí",
  ADS: "Tài khoản quảng cáo",
  INVENTORY: "Phiếu kho",
  SHIPMENT: "Vận đơn / bảng kê ĐVVC",
  BANK: "Sao kê ngân hàng",
  ASSUMPTION: "Giả định báo cáo",
};

/** Loại chi phí kinh tế — đơn vị mà luật "một nguồn duy nhất" áp lên */
export const ECONOMIC_COSTS = [
  "SALARY",
  "COMMISSION",
  "RENT",
  "SOFTWARE",
  "PACKAGING",
  "OTHER_OPEX",
  "ADS",
  "COGS",
  "SHIPPING",
  "RETURN_FEE",
] as const;
export type EconomicCost = (typeof ECONOMIC_COSTS)[number];

export const ECONOMIC_COST_LABEL: Record<EconomicCost, string> = {
  SALARY: "Lương cố định",
  COMMISSION: "Hoa hồng",
  RENT: "Mặt bằng / điện nước",
  SOFTWARE: "Phần mềm",
  PACKAGING: "Đóng gói",
  OTHER_OPEX: "Chi phí vận hành khác",
  ADS: "Quảng cáo",
  COGS: "Giá vốn hàng bán",
  SHIPPING: "Cước vận chuyển",
  RETURN_FEE: "Phí hoàn",
};

/**
 * NGUỒN CÓ THẨM QUYỀN của từng loại chi phí. Chỉ nguồn này được đưa vào lợi nhuận.
 *
 * Vì sao chọn như vậy:
 *  - `ADS` từ tài khoản quảng cáo: có số thực chi THEO NGÀY, chính xác hơn mọi bản gõ tay.
 *  - `COGS` từ phiếu kho: gắn được với từng mẫu mã, sao kê chỉ có tổng tiền một lần chuyển.
 *  - `SHIPPING` / `RETURN_FEE` từ bảng kê ĐVVC: cước bị trừ thẳng trên bảng kê, gắn theo vận đơn.
 *  - `SALARY` / `COMMISSION` từ bảng Lương: có cơ chế tính, có kỳ, gắn được với từng nhân sự.
 *  - Còn lại (mặt bằng, phần mềm, đóng gói, khác) không có nguồn chuyên biệt ⇒ bảng Chi phí.
 */
export const COST_AUTHORITY: Record<EconomicCost, CostSource> = {
  SALARY: "EXPENSES",
  COMMISSION: "EXPENSES",
  RENT: "EXPENSES",
  SOFTWARE: "EXPENSES",
  PACKAGING: "EXPENSES",
  OTHER_OPEX: "EXPENSES",
  ADS: "ADS",
  COGS: "INVENTORY",
  SHIPPING: "SHIPMENT",
  RETURN_FEE: "SHIPMENT",
};

/**
 * VÌ SAO LƯƠNG / HOA HỒNG THUỘC `EXPENSES` CHỨ KHÔNG PHẢI `PAYROLL`
 *
 * Module Lương của ERP **tính ra** số phải trả (cơ chế lương, % chủ mã, hoa hồng marketer) nhưng
 * KHÔNG ghi khoản chi nào vào lợi nhuận — nó ĐỌC lợi nhuận từ báo cáo để chia. Đường duy nhất đưa
 * tiền lương vào lãi lỗ hôm nay là khoản chi nhóm `SALARY` ở bảng Chi phí.
 *
 * Nếu đặt thẩm quyền cho `PAYROLL` rồi loại `SALARY` khỏi bảng Chi phí thì lương sẽ BIẾN MẤT khỏi
 * lợi nhuận — sai nặng hơn hẳn cái nó định sửa. Khi nào module Lương thực sự ghi khoản chi (post)
 * thì đổi dòng này, cùng lúc với việc loại `SALARY` khỏi bảng Chi phí.
 */

/**
 * ─── CHI PHÍ CÓ SẴN ƯỚC TÍNH THEO ĐƠN TRONG BÁO CÁO LỢI NHUẬN ───
 *
 * Báo cáo lợi nhuận đã tự tính cước gửi / cước hoàn cho TỪNG đơn (`shipCost`) từ bộ giả định — và
 * cước bao giờ cũng có (giả định có giá trị dự phòng 17.000đ). Ghi thêm khoản `SHIPPING` /
 * `RETURN_FEE` ở bảng Chi phí là trừ ĐÚNG MỘT ĐỒNG ĐÓ hai lần.
 *
 * `PACKAGING` KHÔNG nằm ở đây: giả định đóng hàng/đơn có thể đặt về 0, nên chứng từ thật vẫn phải
 * được tính. Chỗ đó xử lý bằng CẢNH BÁO chồng lấn (`lib/queries/cost-quality.ts`, luật `DUPLICATE_COST_SOURCE`), không
 * bằng loại trừ cứng — loại trừ cứng khi giả định đang tắt sẽ làm mất tiền thật.
 */
export const ESTIMATED_PER_ORDER_ECONOMIC: EconomicCost[] = ["SHIPPING", "RETURN_FEE"];

/**
 * Nhóm chi phí ở bảng Chi phí → loại chi phí kinh tế.
 * `PURCHASE` là tiền hàng ⇒ COGS; `SALARY` gộp cả lương và hoa hồng nên quy về `SALARY`
 * (bảng Lương mới là nơi tách được hai thứ đó).
 */
export const EXPENSE_CATEGORY_ECONOMIC: Record<ExpenseCategory, EconomicCost> = {
  ADS: "ADS",
  SHIPPING: "SHIPPING",
  RETURN_FEE: "RETURN_FEE",
  SALARY: "SALARY",
  RENT: "RENT",
  SOFTWARE: "SOFTWARE",
  PACKAGING: "PACKAGING",
  PURCHASE: "COGS",
  OTHER: "OTHER_OPEX",
};

/** Bảng Chi phí có được quyền đưa nhóm này vào lợi nhuận không? */
export function expensesOwnCategory(category: ExpenseCategory): boolean {
  return COST_AUTHORITY[EXPENSE_CATEGORY_ECONOMIC[category]] === "EXPENSES";
}

/**
 * Nhóm chi phí bị loại khỏi phép cộng chi phí vận hành vì nguồn khác mới có thẩm quyền.
 * Đây chính là danh sách đang được dùng trong SQL (`category not in (...)`) — khai ở một chỗ để
 * không còn ai gõ tay `('ADS','PURCHASE')` rồi quên cập nhật khi hợp đồng đổi.
 */
export const EXPENSE_CATEGORIES_NOT_OWNED = (Object.keys(EXPENSE_CATEGORY_ECONOMIC) as ExpenseCategory[]).filter((c) => !expensesOwnCategory(c));
