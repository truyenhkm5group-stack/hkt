/** Case chăm sóc khách hàng (CSKH) */
export const CS_KINDS = ["EXCHANGE_SIZE", "EXCHANGE_COLOR", "WRONG_ADDRESS", "WRONG_PHONE", "RETURN", "COMPLAINT", "SIZE_ADVICE", "WRONG_PRICE", "URGE_DELIVERY", "OTHER"] as const;
export type CsKind = (typeof CS_KINDS)[number];

export const CS_KIND_LABEL: Record<CsKind, string> = {
  EXCHANGE_SIZE: "Đổi size",
  EXCHANGE_COLOR: "Đổi màu / mẫu",
  WRONG_ADDRESS: "Sai địa chỉ",
  WRONG_PHONE: "Sai số điện thoại",
  RETURN: "Trả hàng / hoàn",
  COMPLAINT: "Khiếu nại chất lượng",
  SIZE_ADVICE: "Tư vấn size chưa đúng",
  WRONG_PRICE: "Chốt sai giá tiền",
  URGE_DELIVERY: "Khách giục giao hàng",
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
  MANUAL: "Nhập tay",
};

/** Quy tắc nhận diện: từ khoá (không dấu, chữ thường) trong thẻ / ghi chú đơn → loại case. Chỉnh trong settings "cs.rules". */
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
  ignorePatterns: ["bot da tu dong sua", "bot da tu dong", "tu dong sua lai dia chi"],
};
