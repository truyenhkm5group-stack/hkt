/** Case chăm sóc khách hàng (CSKH) */
export const CS_KINDS = ["EXCHANGE_SIZE", "EXCHANGE_COLOR", "WRONG_ADDRESS", "WRONG_PHONE", "RETURN", "COMPLAINT", "OTHER"] as const;
export type CsKind = (typeof CS_KINDS)[number];

export const CS_KIND_LABEL: Record<CsKind, string> = {
  EXCHANGE_SIZE: "Đổi size",
  EXCHANGE_COLOR: "Đổi màu / mẫu",
  WRONG_ADDRESS: "Sai địa chỉ",
  WRONG_PHONE: "Sai số điện thoại",
  RETURN: "Trả hàng / hoàn",
  COMPLAINT: "Khiếu nại chất lượng",
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
};
