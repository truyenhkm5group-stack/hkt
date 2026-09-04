import type { ShipmentStage, CodStatus } from "@/db/schema";

export type VtpStatusMeta = { name: string; stage: ShipmentStage; final?: boolean };

/** Bảng mã trạng thái vận đơn Viettel Post (ORDER_STATUS) */
export const VTP_STATUS: Record<number, VtpStatusMeta> = {
  [-110]: { name: "Đơn hàng được chuyển qua bưu điện", stage: "PENDING" },
  [-109]: { name: "Đơn hàng đã được gửi tại điểm thu tiền", stage: "PENDING" },
  [-108]: { name: "Đơn hàng gửi tại bưu cục", stage: "PENDING" },
  [-100]: { name: "Đơn hàng mới tạo, chờ lấy hàng", stage: "PENDING" },
  100: { name: "Tiếp nhận đơn hàng", stage: "PENDING" },
  101: { name: "Viettel Post hủy lấy hàng", stage: "CANCELLED", final: true },
  102: { name: "Lấy hàng thất bại / chờ xử lý", stage: "PENDING" },
  103: { name: "Điều phối bưu cục lấy hàng", stage: "PENDING" },
  104: { name: "Điều phối bưu tá lấy hàng", stage: "PENDING" },
  105: { name: "Bưu tá đã nhận hàng", stage: "PICKED_UP" },
  106: { name: "Đối tác yêu cầu lấy lại hàng", stage: "PENDING" },
  107: { name: "Đối tác yêu cầu hủy qua API", stage: "CANCELLED", final: true },
  200: { name: "Lấy hàng thành công - nhập bưu cục gốc", stage: "PICKED_UP" },
  201: { name: "Viettel Post hủy đơn hàng", stage: "CANCELLED", final: true },
  202: { name: "Sửa phiếu gửi", stage: "PICKED_UP" },
  300: { name: "Đóng tải - vận chuyển đi", stage: "IN_TRANSIT" },
  301: { name: "Đóng túi gói", stage: "IN_TRANSIT" },
  302: { name: "Đóng chuyến thư", stage: "IN_TRANSIT" },
  303: { name: "Đóng tuyến xe", stage: "IN_TRANSIT" },
  320: { name: "Thông tin sai / chờ xử lý", stage: "IN_TRANSIT" },
  400: { name: "Nhận bàn giao - đến bưu cục phát", stage: "IN_TRANSIT" },
  401: { name: "Nhận túi gói", stage: "IN_TRANSIT" },
  402: { name: "Nhận chuyến thư", stage: "IN_TRANSIT" },
  403: { name: "Nhận chuyến xe", stage: "IN_TRANSIT" },
  500: { name: "Phân công bưu tá đi giao hàng", stage: "OUT_FOR_DELIVERY" },
  501: { name: "Phát thành công", stage: "DELIVERED", final: true },
  502: { name: "Chuyển hoàn bưu cục gốc", stage: "RETURNING" },
  503: { name: "Hủy theo yêu cầu khách hàng", stage: "CANCELLED", final: true },
  504: { name: "Chuyển hoàn thành công cho người gửi", stage: "RETURNED", final: true },
  505: { name: "Yêu cầu chuyển hoàn", stage: "RETURNING" },
  506: { name: "Phát thất bại - khách nghỉ, không có nhà", stage: "DELIVERY_FAILED" },
  507: { name: "Phát thất bại - khách đến bưu cục nhận", stage: "DELIVERY_FAILED" },
  508: { name: "Đơn vị yêu cầu phát tiếp", stage: "OUT_FOR_DELIVERY" },
  509: { name: "Chuyển tiếp bưu cục khác", stage: "IN_TRANSIT" },
  510: { name: "Hủy phân công phát", stage: "IN_TRANSIT" },
  515: { name: "Bưu cục phát duyệt hoàn", stage: "RETURNING" },
  550: { name: "Khách hàng yêu cầu phát tiếp", stage: "OUT_FOR_DELIVERY" },
};

export const VTP_FINAL_STATUSES = new Set([101, 107, 201, 501, 503, 504]);

export const VTP_REASON_CODES: Record<number, string> = {
  1: "Người nhận hẹn phát lại",
  2: "Không liên lạc được khách nhận",
  3: "Khách nhận đến bưu cục nhận",
  4: "Khách từ chối nhận",
  5: "Sai màu sắc",
  6: "Sai kích thước",
  7: "Sai kiểu dáng",
  8: "Sai số lượng",
  9: "Sai tiền thu hộ",
  10: "Sai địa chỉ",
  11: "Chất lượng kém",
  12: "Không cho xem hàng",
  13: "Khách không có nhu cầu nhận",
  14: "Khách không đặt đơn",
  15: "Sai định dạng số điện thoại người nhận",
  16: "Phát thất bại nhiều lần",
  17: "Người gửi yêu cầu chuyển hoàn",
};

export function vtpStatusMeta(code: number | null | undefined, fallbackName = ""): VtpStatusMeta {
  if (code === null || code === undefined) return { name: fallbackName || "Chưa có trạng thái", stage: "UNKNOWN" };
  const meta = VTP_STATUS[code];
  if (meta) return { ...meta, name: fallbackName || meta.name };
  // suy luận theo nhóm mã
  if (code >= 500 && code < 600) return { name: fallbackName || `Đang phát (${code})`, stage: "OUT_FOR_DELIVERY" };
  if (code >= 300 && code < 500) return { name: fallbackName || `Đang trung chuyển (${code})`, stage: "IN_TRANSIT" };
  if (code >= 200 && code < 300) return { name: fallbackName || `Đã lấy hàng (${code})`, stage: "PICKED_UP" };
  return { name: fallbackName || `Trạng thái ${code}`, stage: code < 200 ? "PENDING" : "UNKNOWN" };
}

export const SHIPMENT_STAGE_LABEL: Record<ShipmentStage, string> = {
  PENDING: "Chờ lấy hàng",
  PICKED_UP: "Đã lấy hàng",
  IN_TRANSIT: "Đang trung chuyển",
  OUT_FOR_DELIVERY: "Đang giao",
  DELIVERED: "Giao thành công",
  DELIVERY_FAILED: "Giao thất bại",
  RETURNING: "Đang hoàn",
  RETURNED: "Đã hoàn",
  CANCELLED: "Đã hủy",
  UNKNOWN: "Chưa rõ",
};

export const SHIPMENT_STAGE_ORDER: ShipmentStage[] = [
  "PENDING",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
];

export const COD_STATUS_LABEL: Record<CodStatus, string> = {
  NOT_APPLICABLE: "Không thu hộ",
  PENDING: "Chưa thu",
  COLLECTED: "Đã thu",
  RECONCILED: "ĐVVC đã đối soát",
  PAID_TO_BANK: "Đã về ngân hàng",
  DISPUTED: "Có chênh lệch",
};
