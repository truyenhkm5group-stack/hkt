import { CS_KINDS, type CsKind } from "@/lib/constants/cs";

/**
 * ═══════════ HÀNG ĐỢI PHẢI LÀM ĐƯỢC VIỆC, KHÔNG CHỈ LIỆT KÊ VIỆC ═══════════
 *
 * Bảng CSKH cũ có đúng bốn thứ bấm được: đổi trạng thái, đổi người phụ trách, sửa, xoá. Mọi thao
 * tác thật (nhắn khách, hẹn lại, ghi kết quả gọi) đều phải mở hộp thoại sửa hoặc mở Pancake ở tab
 * khác. Một người xử lý 40 case buổi sáng phải bấm ~120 lần chỉ để tới được chỗ làm việc.
 *
 * Ở đây mỗi loại case khai 1–3 việc THƯỜNG LÀM NHẤT, hiện thẳng trên dòng.
 *
 * ─── HAI KIỂU HÀNH ĐỘNG, KHÔNG TRỘN ───
 *
 *  · `MUTATE` — ERP tự ghi được: nhận việc, đã liên hệ, đã xong, hẹn lại, ghi chú.
 *  · `LINK`   — ERP KHÔNG làm thay được, chỉ đưa người tới đúng chỗ kèm bối cảnh.
 *
 * ─── VÌ SAO "TẠO ĐƠN" LÀ `LINK`, KHÔNG PHẢI NÚT TẠO ĐƠN THẬT ───
 *
 * `PancakeClient.createOrder` có tồn tại, nhưng nó đòi `items[{ variationId, quantity }]` — mẫu mã
 * đã chốt. Case "đủ thông tin · chưa tạo đơn" chỉ có SĐT và địa chỉ khách nhắn trong chat; mẫu mã
 * nằm trong đoạn hội thoại, chưa ai chốt thành dòng hàng. Dựng một nút "Tạo đơn" rồi đoán mẫu mã
 * là tạo đơn sai trên POS thật của shop — và AGENTS.md mục 11 đã cấm đúng việc đoán đó.
 *
 * Nên nút ghi đúng cái nó làm: **Mở tạo đơn** — mở thẳng hội thoại Pancake của khách, nơi POS tạo
 * đơn. Không hứa cái không làm được.
 */
export type CsQuickActionKey = "CLAIM" | "OPEN_POS" | "OPEN_ORDER" | "CHAT" | "CONTACTED" | "INFO_FIXED" | "DONE" | "SNOOZE" | "OPEN_CARE";

export type CsQuickActionSpec = {
  key: CsQuickActionKey;
  label: string;
  /** `MUTATE` ghi thẳng vào case; `LINK` chỉ mở đúng chỗ kèm bối cảnh. */
  mode: "MUTATE" | "LINK";
  /** Câu giải thích cho tooltip — người mới vào ca phải hiểu nút làm gì trước khi bấm. */
  hint: string;
};

export const CS_QUICK_ACTION: Record<CsQuickActionKey, CsQuickActionSpec> = {
  CLAIM: { key: "CLAIM", label: "Nhận việc", mode: "MUTATE", hint: "Gán case cho mình và chuyển sang Đang xử lý." },
  OPEN_POS: { key: "OPEN_POS", label: "Mở tạo đơn", mode: "LINK", hint: "Mở hội thoại Pancake của khách — nơi lên đơn trên POS. ERP không tự tạo đơn vì chưa có mẫu mã đã chốt." },
  OPEN_ORDER: { key: "OPEN_ORDER", label: "Mở đơn", mode: "LINK", hint: "Mở trang đơn hàng trong ERP để xem dòng hàng, tiền và vận đơn." },
  CHAT: { key: "CHAT", label: "Chat Pancake", mode: "LINK", hint: "Mở đúng hội thoại của khách trên Pancake." },
  CONTACTED: { key: "CONTACTED", label: "Đã liên hệ", mode: "MUTATE", hint: "Ghi nhận đã gọi / nhắn khách: case sang Đang xử lý và ghi một dòng lịch sử." },
  INFO_FIXED: { key: "INFO_FIXED", label: "Đã bổ sung", mode: "MUTATE", hint: "Khách đã cho thông tin đúng và đã cập nhật — đóng case." },
  DONE: { key: "DONE", label: "Đã xử lý", mode: "MUTATE", hint: "Đóng case: người đã làm xong phần việc của mình." },
  SNOOZE: { key: "SNOOZE", label: "Hẹn lại", mode: "MUTATE", hint: "Hẹn giờ quay lại case. Tới hạn thì case nổi lên đầu hàng đợi." },
  OPEN_CARE: { key: "OPEN_CARE", label: "Mở care vận đơn", mode: "LINK", hint: "Việc này thuộc Vận đơn & care — mở đúng kiện ở đó." },
};

/**
 * 1–3 việc thường làm nhất của từng loại case, theo đúng thứ tự hiện trên dòng.
 *
 * `CLAIM` KHÔNG nằm trong danh sách này: nó thuộc cột Phụ trách và chỉ hiện khi chưa có người thật
 * cầm case, nên gộp vào đây sẽ đếm hai lần cùng một nút.
 *
 * `DELIVERY_FAILED` cố ý rỗng: nó là case giao vận, hàng đợi CSKH không sở hữu nó. Khi người dùng
 * mở bộ lọc Miền = Vận đơn để tra cứu, dòng chỉ có một lối ra là sang đúng chỗ xử lý.
 */
export const CS_QUICK_ACTIONS_BY_KIND: Record<CsKind, readonly CsQuickActionKey[]> = {
  ORDER_NOT_CREATED: ["OPEN_POS", "DONE"],
  PHONE_VERIFY: ["CHAT", "INFO_FIXED", "SNOOZE"],
  WRONG_ADDRESS: ["CHAT", "INFO_FIXED"],
  WRONG_PHONE: ["CHAT", "INFO_FIXED"],
  EXCHANGE_SIZE: ["OPEN_ORDER", "CONTACTED", "DONE"],
  EXCHANGE_COLOR: ["OPEN_ORDER", "CONTACTED", "DONE"],
  SIZE_ADVICE: ["CHAT", "CONTACTED", "DONE"],
  COMPLAINT: ["CHAT", "CONTACTED", "DONE"],
  WRONG_PRICE: ["OPEN_ORDER", "CONTACTED", "DONE"],
  URGE_DELIVERY: ["CHAT", "CONTACTED", "SNOOZE"],
  RETURN: ["OPEN_ORDER", "CONTACTED", "DONE"],
  OTHER: ["CONTACTED", "DONE", "SNOOZE"],
  DELIVERY_FAILED: [],
};

/** Việc ghi thẳng vào case — dùng cho zod ở Server Action và cho lá chắn kiểm thử. */
export const CS_MUTATE_ACTIONS = (Object.keys(CS_QUICK_ACTION) as CsQuickActionKey[]).filter((k) => CS_QUICK_ACTION[k].mode === "MUTATE");

/** Mọi loại case phải khai bộ hành động — thêm loại mới mà quên thì lá chắn kiểm thử đỏ. */
export const CS_KINDS_WITHOUT_ACTIONS: readonly CsKind[] = CS_KINDS.filter((k) => !CS_QUICK_ACTIONS_BY_KIND[k]?.length);

/**
 * Bốn kiểu hẹn bấm một phát — cùng ý tưởng với `FOLLOW_UP_PRESETS` của care vận đơn, nhưng khung
 * giờ của CSKH khác: khách nhắn ban ngày, hẹn "+2 giờ" là hẹn trong ca, không phải hẹn sang hôm sau.
 * `hours: -1` = 8 giờ sáng hôm sau (giờ Việt Nam), tính ở nơi dùng vì phụ thuộc "bây giờ".
 */
export const CS_SNOOZE_PRESETS: { key: string; label: string; hours: number }[] = [
  { key: "2h", label: "+2 giờ", hours: 2 },
  { key: "4h", label: "+4 giờ", hours: 4 },
  { key: "tomorrow", label: "Sáng mai", hours: -1 },
  { key: "2d", label: "+2 ngày", hours: 48 },
];

/**
 * Hành động ghi vào lịch sử case (`cs_case_events`). Cùng bộ tên với `CARE_EVENT_ACTIONS` ở phần
 * giao nhau, để hai bàn làm việc kể chuyện bằng cùng một từ vựng.
 */
export const CS_EVENT_ACTIONS = ["NOTE", "STATUS", "ASSIGN", "FOLLOW_UP"] as const;
export type CsEventAction = (typeof CS_EVENT_ACTIONS)[number];

export const CS_EVENT_ACTION_LABEL: Record<CsEventAction, string> = {
  NOTE: "Ghi chú",
  STATUS: "Đổi trạng thái",
  ASSIGN: "Đổi người phụ trách",
  FOLLOW_UP: "Hẹn lại",
};

/** Nguồn gây ra sự kiện — giống `CARE_EVENT_SOURCES`. */
export const CS_EVENT_SOURCES = ["UI", "API", "AI", "SYSTEM"] as const;
export type CsEventSource = (typeof CS_EVENT_SOURCES)[number];
