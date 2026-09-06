/** Case chăm sóc khách hàng (CSKH) */
export const CS_KINDS = ["ORDER_NOT_CREATED", "EXCHANGE_SIZE", "EXCHANGE_COLOR", "WRONG_ADDRESS", "WRONG_PHONE", "RETURN", "COMPLAINT", "SIZE_ADVICE", "WRONG_PRICE", "URGE_DELIVERY", "DELIVERY_FAILED", "PHONE_VERIFY", "OTHER"] as const;
export type CsKind = (typeof CS_KINDS)[number];

export const CS_KIND_LABEL: Record<CsKind, string> = {
  ORDER_NOT_CREATED: "Đã chốt trong chat · chưa tạo đơn",
  EXCHANGE_SIZE: "Đổi size",
  EXCHANGE_COLOR: "Đổi màu / mẫu",
  WRONG_ADDRESS: "Sai địa chỉ",
  WRONG_PHONE: "Sai số điện thoại",
  RETURN: "Trả hàng / hoàn",
  COMPLAINT: "Khiếu nại chất lượng",
  SIZE_ADVICE: "Tư vấn size chưa đúng",
  WRONG_PRICE: "Chốt sai giá tiền",
  URGE_DELIVERY: "Khách giục giao hàng",
  DELIVERY_FAILED: "Giao không thành · liên hệ khách",
  PHONE_VERIFY: "SĐT mới · xác nhận số & xin số phụ",
  OTHER: "Khác",
};

export const CS_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type CsStatus = (typeof CS_STATUSES)[number];
export const CS_STATUS_LABEL: Record<CsStatus, string> = { OPEN: "Mới", IN_PROGRESS: "Đang xử lý", DONE: "Đã xong", CANCELLED: "Huỷ" };
export const CS_STATUS_TONE: Record<CsStatus, string> = {
  OPEN: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  IN_PROGRESS: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  DONE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export const CS_SOURCE_LABEL: Record<string, string> = {
  PANCAKE_TAG: "Thẻ đơn Pancake",
  PANCAKE_NOTE: "Ghi chú đơn Pancake",
  PANCAKE_RETURN: "Phiếu đổi/trả Pancake",
  PANCAKE_CHAT: "Thẻ hội thoại Pancake",
  AUTO_FAILED_DELIVERY: "Tự động · giao không thành",
  MANUAL: "Nhập tay",
};

/** Quy tắc nhận diện: từ khoá (không dấu, chữ thường) trong thẻ / ghi chú đơn → loại case. Chỉnh trong settings "cs.rules". */
/** Lý do giao không thành, đọc từ ghi chú bưu tá / trạng thái Viettel Post */
export const FAILED_REASONS = ["RESCHEDULED", "NO_CONTACT", "NOT_HOME", "REFUSED", "WRONG_ADDRESS", "SHOP_ADDRESS", "COD_ISSUE", "OTHER"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];
export const FAILED_REASON_LABEL: Record<FailedReason, string> = {
  RESCHEDULED: "Khách hẹn phát lại",
  NO_CONTACT: "Không liên lạc được",
  NOT_HOME: "Khách đi vắng / không có nhà",
  REFUSED: "Khách từ chối nhận",
  WRONG_ADDRESS: "Sai / không tìm thấy địa chỉ",
  SHOP_ADDRESS: "Shop lên sai địa chỉ / SĐT",
  COD_ISSUE: "Vấn đề tiền COD / muốn kiểm hàng",
  OTHER: "Lý do khác",
};

export type CsRules = {
  /** Số ngày quét lùi các đơn mới cập nhật */
  lookbackDays: number;
  /** Thẻ đơn (tên thẻ, không phân biệt hoa thường) → loại case */
  tagRules: { keyword: string; kind: CsKind }[];
  /** Từ khoá trong ghi chú đơn → loại case */
  noteRules: { keyword: string; kind: CsKind }[];
  /** Từ khoá trong tin nhắn KHÁCH gửi (Pancake chat) → loại case */
  chatRules: { keyword: string; kind: CsKind }[];
  /** Số giờ quét lùi hội thoại Pancake */
  chatLookbackHours: number;
  /** Chỉ quét các page này (id); rỗng = mọi page có quyền */
  chatPageIds: string[];
  /** Ghi chú / thẻ chứa các cụm này thì bỏ qua (vd ghi chú tự động của bot Pancake) */
  ignorePatterns: string[];
  /** Tự nhắn khách qua Pancake khi vận đơn giao không thành (chờ xử lý / hẹn phát lại) */
  failedDeliveryAuto: boolean;
  /** Mẫu tin theo LÝ DO bưu tá ghi. Biến: {ten} {ma_van_don} {san_pham} {buu_ta} {sdt_buu_ta} {ly_do} {gio_hen} {shop} */
  failedDeliveryTemplates: Record<FailedReason, string>;
  failedDeliveryShopName: string;
  /** SĐT mới (Pancake tô xanh: chưa có lịch sử mua) → tự nhắn khách xác nhận SĐT và xin số phụ trước khi gửi hàng */
  phoneVerifyAuto: boolean;
  /** Số ngày quét lùi đơn mới lên chưa gửi ĐVVC */
  phoneVerifyLookbackDays: number;
  /** Mẫu tin xác nhận SĐT. Biến: {ten} {sdt} {san_pham} {shop} */
  phoneVerifyTemplate: string;
  /**
   * Nhắn khách "SĐT mới" theo lịch sử TẠI SHOP (Pancake customers + ERP). Mặc định TẮT vì số GTC/hoàn Pancake hiển thị cạnh SĐT là lịch sử
   * toàn hệ thống Pancake (nhiều shop) mà Open API không trả về → khách quen nơi khác vẫn bị coi là mới.
   */
  phoneVerifyNewPhone: boolean;
  /** Nhắn xác nhận SĐT & xin số phụ với khách rủi ro (tỷ lệ hoàn / cảnh báo cao theo ngưỡng ở Cảnh báo) */
  phoneVerifyRisky: boolean;
  /** Thẻ đơn Pancake (không dấu, thường) để nhân viên đánh dấu cần xác nhận SĐT → bot nhắn */
  phoneVerifyTags: string[];
  /**
   * Cụm trong tin nhắn của SHOP nghĩa là đã chốt đơn với khách (không dấu, thường). Nếu hội thoại có cụm này mà chưa
   * thấy đơn mới thì mở case "đã chốt chưa tạo đơn" — hay gặp với khách cũ mua lại, chỉ nhắn "gửi địa chỉ cũ".
   */
  closingKeywords: string[];
};

export const CS_RULES_KEY = "cs.rules";

export const DEFAULT_CS_RULES: CsRules = {
  lookbackDays: 14,
  tagRules: [
    { keyword: "doi size", kind: "EXCHANGE_SIZE" },
    { keyword: "doi mau", kind: "EXCHANGE_COLOR" },
    { keyword: "doi hang", kind: "EXCHANGE_COLOR" },
    { keyword: "sai dia chi", kind: "WRONG_ADDRESS" },
    { keyword: "sai sdt", kind: "WRONG_PHONE" },
    { keyword: "sai so dien thoai", kind: "WRONG_PHONE" },
    { keyword: "tra hang", kind: "RETURN" },
    { keyword: "hoan hang", kind: "RETURN" },
    { keyword: "khieu nai", kind: "COMPLAINT" },
    { keyword: "loi", kind: "COMPLAINT" },
  ],
  noteRules: [
    { keyword: "doi size", kind: "EXCHANGE_SIZE" },
    { keyword: "doi sz", kind: "EXCHANGE_SIZE" },
    { keyword: "doi mau", kind: "EXCHANGE_COLOR" },
    { keyword: "doi mau khac", kind: "EXCHANGE_COLOR" },
    { keyword: "sai dia chi", kind: "WRONG_ADDRESS" },
    { keyword: "dia chi sai", kind: "WRONG_ADDRESS" },
    { keyword: "doi dia chi", kind: "WRONG_ADDRESS" },
    { keyword: "sai sdt", kind: "WRONG_PHONE" },
    { keyword: "sai so dien thoai", kind: "WRONG_PHONE" },
    { keyword: "doi sdt", kind: "WRONG_PHONE" },
    { keyword: "tra hang", kind: "RETURN" },
    { keyword: "hoan hang", kind: "RETURN" },
    { keyword: "khieu nai", kind: "COMPLAINT" },
    { keyword: "hang loi", kind: "COMPLAINT" },
  ],
  chatRules: [
    { keyword: "chat qua", kind: "SIZE_ADVICE" },
    { keyword: "rong qua", kind: "SIZE_ADVICE" },
    { keyword: "khong vua", kind: "SIZE_ADVICE" },
    { keyword: "ko vua", kind: "SIZE_ADVICE" },
    { keyword: "sai size", kind: "SIZE_ADVICE" },
    { keyword: "size khong dung", kind: "SIZE_ADVICE" },
    { keyword: "tu van sai size", kind: "SIZE_ADVICE" },
    { keyword: "bao lay", kind: "SIZE_ADVICE" },
    { keyword: "doi size", kind: "EXCHANGE_SIZE" },
    { keyword: "doi sz", kind: "EXCHANGE_SIZE" },
    { keyword: "doi mau", kind: "EXCHANGE_COLOR" },
    { keyword: "sai mau", kind: "EXCHANGE_COLOR" },
    { keyword: "mau khac", kind: "EXCHANGE_COLOR" },
    { keyword: "sai gia", kind: "WRONG_PRICE" },
    { keyword: "tinh sai", kind: "WRONG_PRICE" },
    { keyword: "thu sai", kind: "WRONG_PRICE" },
    { keyword: "so tien khong dung", kind: "WRONG_PRICE" },
    { keyword: "chot voi", kind: "WRONG_PRICE" },
    { keyword: "gia chot", kind: "WRONG_PRICE" },
    { keyword: "thu them tien", kind: "WRONG_PRICE" },
    { keyword: "bao gio nhan", kind: "URGE_DELIVERY" },
    { keyword: "bao gio giao", kind: "URGE_DELIVERY" },
    { keyword: "khi nao giao", kind: "URGE_DELIVERY" },
    { keyword: "khi nao nhan", kind: "URGE_DELIVERY" },
    { keyword: "sao chua nhan", kind: "URGE_DELIVERY" },
    { keyword: "chua nhan duoc", kind: "URGE_DELIVERY" },
    { keyword: "chua thay hang", kind: "URGE_DELIVERY" },
    { keyword: "mai chua", kind: "URGE_DELIVERY" },
    { keyword: "lau qua", kind: "URGE_DELIVERY" },
    { keyword: "giao chua", kind: "URGE_DELIVERY" },
    { keyword: "den chua", kind: "URGE_DELIVERY" },
    { keyword: "gui chua", kind: "URGE_DELIVERY" },
    { keyword: "sai dia chi", kind: "WRONG_ADDRESS" },
    { keyword: "doi dia chi", kind: "WRONG_ADDRESS" },
    { keyword: "dia chi moi", kind: "WRONG_ADDRESS" },
    { keyword: "sai sdt", kind: "WRONG_PHONE" },
    { keyword: "doi sdt", kind: "WRONG_PHONE" },
    { keyword: "doi so dien thoai", kind: "WRONG_PHONE" },
    { keyword: "tra hang", kind: "RETURN" },
    { keyword: "hoan hang", kind: "RETURN" },
    { keyword: "khong nhan", kind: "RETURN" },
    { keyword: "ko nhan", kind: "RETURN" },
    { keyword: "khong lay nua", kind: "RETURN" },
    { keyword: "huy don", kind: "RETURN" },
    { keyword: "hang loi", kind: "COMPLAINT" },
    { keyword: "bi rach", kind: "COMPLAINT" },
    { keyword: "bi ban", kind: "COMPLAINT" },
    { keyword: "khac hinh", kind: "COMPLAINT" },
    { keyword: "khong giong", kind: "COMPLAINT" },
    { keyword: "ko giong", kind: "COMPLAINT" },
    { keyword: "chat luong", kind: "COMPLAINT" },
    { keyword: "that vong", kind: "COMPLAINT" },
  ],
  chatLookbackHours: 48,
  chatPageIds: [],
  closingKeywords: ["em chot", "chot don", "chot cho minh", "chot them", "da chot", "em len don", "len don cho", "gui ve dia chi cu", "dia chi cu"],
  ignorePatterns: ["bot da tu dong sua", "bot da tu dong", "tu dong sua lai dia chi"],
  failedDeliveryAuto: true,
  failedDeliveryShopName: "Shop",
  phoneVerifyAuto: true,
  phoneVerifyLookbackDays: 3,
  phoneVerifyNewPhone: false,
  phoneVerifyRisky: true,
  phoneVerifyTags: ["sdt moi", "xac nhan sdt", "kiem tra sdt", "check sdt"],
  phoneVerifyTemplate:
    "Dạ {ten} ơi, shop đã lên đơn {san_pham} cho mình rồi ạ. Mình xem giúp shop số điện thoại nhận hàng {sdt} đã đúng chưa nhé? Nếu mình có số khác hoặc số phụ (người thân) thì gửi thêm để bưu tá dễ liên hệ lúc giao ạ. Hàng được kiểm tra trước khi thanh toán, shop cảm ơn mình 💛",
  failedDeliveryTemplates: {
    RESCHEDULED:
      "Dạ chào {ten} ơi, bưu tá báo mình hẹn nhận đơn {san_pham} (mã {ma_van_don}) lúc {gio_hen} ạ. Shop nhắn để mình nhớ giữ máy giúp bưu tá nhé. Bưu tá phụ trách: {buu_ta} – {sdt_buu_ta}, nếu mình muốn đổi giờ thì gọi trực tiếp bưu tá cho nhanh ạ. Hàng được kiểm tra thoải mái trước khi thanh toán 💛",
    NO_CONTACT:
      "Dạ chào {ten} ơi, bưu tá mang đơn {san_pham} (mã {ma_van_don}) tới nhưng gọi chưa liên lạc được với mình ạ 😢 Mình để ý điện thoại giúp shop, hoặc gọi lại bưu tá {buu_ta} – {sdt_buu_ta} để hẹn giờ nhận nhé. Nếu số này không tiện nghe, mình cho shop số khác để shop báo bưu tá ạ 💛",
    NOT_HOME:
      "Dạ chào {ten} ơi, bưu tá ghé giao đơn {san_pham} (mã {ma_van_don}) nhưng mình không có nhà ạ. Mình cho shop khung giờ thuận tiện, hoặc gọi bưu tá {buu_ta} – {sdt_buu_ta} hẹn giao lại giúp shop nhé. Hàng được kiểm tra trước khi thanh toán ạ 💛",
    REFUSED:
      "Dạ chào {ten} ơi, bưu tá báo đơn {san_pham} (mã {ma_van_don}) mình chưa nhận ạ. Mình cho shop hỏi lý do được không ạ — mình đổi ý, đặt nhầm mẫu/size, chờ lâu hay còn băn khoăn điểm nào? Nếu mình vẫn muốn nhận, shop báo bưu tá giao lại ngay; mình được kiểm hàng thoải mái trước khi thanh toán ạ 💛",
    WRONG_ADDRESS:
      "Dạ chào {ten} ơi, bưu tá chưa tìm được địa chỉ giao đơn {san_pham} (mã {ma_van_don}) ạ. Mình gửi giúp shop địa chỉ chi tiết (số nhà, ngõ, mốc dễ tìm) hoặc gọi bưu tá {buu_ta} – {sdt_buu_ta} chỉ đường giúp nhé. Shop cảm ơn mình nhiều ạ 💛",
    SHOP_ADDRESS:
      "Dạ chào {ten} ơi, shop xin lỗi vì đơn {san_pham} (mã {ma_van_don}) bị lên sai địa chỉ / số điện thoại nên bưu tá chưa giao được ạ 🙏 Mình xác nhận giúp shop địa chỉ và SĐT nhận chính xác, shop chuyển ngay cho bưu tá {buu_ta} – {sdt_buu_ta} hoặc gửi lại đơn mới sớm nhất ạ 💛",
    COD_ISSUE:
      "Dạ chào {ten} ơi, bưu tá báo đơn {san_pham} (mã {ma_van_don}) chưa nhận được ạ. Mình yên tâm là được xem và kiểm tra hàng trước khi thanh toán, chưa ưng có thể trả lại bưu tá tại chỗ. Mình muốn shop hẹn bưu tá giao lại lúc nào tiện ạ? Bưu tá: {buu_ta} – {sdt_buu_ta} 💛",
    OTHER:
      "Dạ chào {ten} ơi, đơn {san_pham} (mã {ma_van_don}) bưu tá giao tới nhưng chưa thành công ạ (bưu tá ghi: {ly_do}). Mình cho shop hỏi lý do và giờ thuận tiện để bưu tá {buu_ta} – {sdt_buu_ta} giao lại nhé. Hàng được kiểm tra trước khi thanh toán ạ 💛",
  },
};
