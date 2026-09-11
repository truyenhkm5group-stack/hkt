import type { CaseTeam } from "@/lib/constants/action-queue";

/**
 * ═══════════ THÁP ĐIỀU KHIỂN GIAO VẬN: RỔ NGOẠI LỆ, KHÔNG PHẢI DANH SÁCH ═══════════
 *
 * Trang Vận đơn hiện mở ra bằng một bảng 554 dòng xếp theo ngày tạo. Muốn biết "hôm nay phải gọi
 * ai" thì phải tự lọc, tự đọc, tự nhớ — và việc đó không ai làm mỗi sáng.
 *
 * Ở đây đảo lại: mở ra là các RỔ NGOẠI LỆ, mỗi rổ trả lời một câu hỏi vận hành, kèm số kiện và số
 * tiền đang nằm trong đó. Bảng đầy đủ vẫn còn nguyên bên dưới cho người cần tra cứu.
 *
 * ─── MỖI KIỆN ĐÚNG MỘT RỔ ───
 *
 * Rổ xét theo THỨ TỰ `order`, kiện rơi vào rổ đầu tiên khớp rồi dừng. Nếu một kiện nằm hai rổ thì
 * tổng các rổ sẽ lớn hơn số kiện thật, và người đọc không biết phải tin số nào. Riêng "CẦN CARE
 * HÔM NAY" cố ý là RỔ TỔNG HỢP của ba rổ đầu — được khai rõ bằng `rollupOf` để không ai cộng nó
 * vào tổng.
 *
 * ─── RỔ KHÔNG PHẢI KẾT LUẬN ───
 *
 * "Quá lâu không cập nhật" nói DỮ LIỆU cũ, KHÔNG nói đơn hỏng. Kết quả đơn vẫn theo chứng từ cuối
 * cùng của `ORDER_OUTCOME`, dù chứng từ đó cũ tới đâu. Rổ này sinh ra việc phải HỎI, không sinh ra
 * một kết luận.
 */

export type BucketKey =
  | "CARE_TODAY"
  | "NO_CONTACT"
  | "DELIVERY_FAILED"
  | "AWAITING_REDELIVERY"
  | "STALE_NO_UPDATE"
  | "RETURNING"
  | "RETURN_AT_SHOP"
  | "DATA_GAP";

export type BucketSpec = {
  key: BucketKey;
  label: string;
  order: number;
  team: CaseTeam;
  /** Câu hỏi vận hành rổ này trả lời. */
  question: string;
  /** Việc nên làm cho một kiện trong rổ — gợi ý, không tự chạy. */
  nextAction: string;
  /** Tiền trong rổ có nghĩa gì. Không rổ nào được gọi tiền của mình là "sẽ thu được". */
  moneyMeaning: string;
  /** Rổ tổng hợp thì khai rõ nó gộp từ đâu, để không bị cộng hai lần. */
  rollupOf?: BucketKey[];
  tone: "rose" | "amber" | "sky" | "slate";
};

export const DELIVERY_BUCKETS: BucketSpec[] = [
  {
    key: "CARE_TODAY",
    label: "Cần care hôm nay",
    order: 0,
    team: "CS",
    question: "Hôm nay phải gọi những khách nào?",
    nextAction: "Gọi khách theo thứ tự tiền COD giảm dần; ghi lại kết quả gọi ngay trên kiện.",
    moneyMeaning: "COD của kiện còn cứu được. ĐANG TREO, chưa phải tiền sẽ về.",
    rollupOf: ["NO_CONTACT", "DELIVERY_FAILED", "AWAITING_REDELIVERY"],
    tone: "rose",
  },
  {
    key: "NO_CONTACT",
    label: "Khách không nghe máy",
    order: 1,
    team: "CS",
    question: "Bưu tá không gọi được ai?",
    nextAction: "Nhắn Pancake trước (khách hay đọc tin hơn nghe máy lạ), xin số phụ, rồi hẹn lại giờ giao.",
    moneyMeaning: "COD đang treo. Đây là nhóm rơi thành hoàn nhanh nhất nếu để quá 24 giờ.",
    tone: "rose",
  },
  {
    key: "DELIVERY_FAILED",
    label: "Giao thất bại",
    order: 2,
    team: "CS",
    question: "Kiện nào bưu tá đã giao hụt và chưa ai xử lý?",
    nextAction: "Đọc lý do bưu tá ghi, xử lý đúng lý do: sai địa chỉ thì sửa, từ chối thì xác nhận hoàn sớm để đỡ cước.",
    moneyMeaning: "COD đang treo. Từ chối nhận thì phần cứu được gần như bằng 0 — đừng gộp với nhóm hẹn lại.",
    tone: "rose",
  },
  {
    key: "AWAITING_REDELIVERY",
    label: "Chờ giao lại",
    order: 3,
    team: "CS",
    question: "Kiện nào đã hẹn giao lại, tới hạn chưa?",
    nextAction: "Nhắc khách trước giờ hẹn; quá hẹn mà chưa có mốc mới thì hỏi bưu cục.",
    moneyMeaning: "COD đang treo nhưng còn hẹn — khả năng cứu cao nhất trong các rổ.",
    tone: "amber",
  },
  {
    key: "STALE_NO_UPDATE",
    label: "Quá lâu không cập nhật",
    order: 4,
    team: "LOGISTICS",
    question: "Kiện nào ERP không biết đang ở đâu?",
    nextAction: "Tra mã trên trang Viettel Post; có mốc mới thì nhập tay để vá lại lịch sử, không có thì mở khiếu nại.",
    moneyMeaning: "COD của kiện KHÔNG RÕ TÌNH TRẠNG. Đây là vấn đề ĐỘ TƯƠI DỮ LIỆU, không phải kết luận đơn hỏng.",
    tone: "amber",
  },
  {
    key: "RETURNING",
    label: "Đang chuyển hoàn",
    order: 5,
    team: "LOGISTICS",
    question: "Hàng nào đang trên đường về shop?",
    nextAction: "Theo dõi tới khi kho nhận; quá 7 ngày chưa về thì hỏi bưu cục — hàng hoàn cũng thất lạc được.",
    moneyMeaning: "COD KHÔNG còn cứu được. Tiền ở đây là GIÁ VỐN đang đi ngoài kho.",
    tone: "sky",
  },
  {
    key: "RETURN_AT_SHOP",
    label: "Hoàn đã về shop, chờ kiểm đếm",
    order: 6,
    team: "WAREHOUSE",
    question: "Hàng nào đã về mà chưa ai đếm?",
    nextAction: "Kho lập phiếu kiểm đếm. Hàng hoàn KHÔNG tự vào tồn cho tới khi có phiếu.",
    moneyMeaning: "GIÁ VỐN đang nằm ngoài sổ tồn — không bán được vì ERP chưa biết nó đã về.",
    tone: "sky",
  },
  {
    key: "DATA_GAP",
    label: "Chưa rõ / thiếu dữ liệu",
    order: 7,
    team: "LOGISTICS",
    question: "Kiện nào ERP chưa từng nhận được tin gì?",
    nextAction: "Kiểm tra vận đơn có thật trên Viettel Post không; webhook có tới không.",
    moneyMeaning: "CHƯA BIẾT. Không ghi 0, không đoán — đây đúng nghĩa là lỗ hổng dữ liệu.",
    tone: "slate",
  },
];

export const BUCKET_BY_KEY = Object.fromEntries(DELIVERY_BUCKETS.map((b) => [b.key, b])) as Record<BucketKey, BucketSpec>;

/** Rổ thật (không tính rổ tổng hợp) — tổng của chúng đúng bằng số kiện ngoại lệ. */
export const EXCLUSIVE_BUCKETS = DELIVERY_BUCKETS.filter((b) => !b.rollupOf);

export const BUCKET_TONE: Record<BucketSpec["tone"], string> = {
  rose: "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20",
  amber: "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20",
  sky: "border-sky-300/70 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20",
  slate: "border-border bg-muted/30",
};

/**
 * ═══════════ LOẠI HÀNH ĐỘNG CHĂM SÓC ═══════════
 *
 * Cố ý CHIA NHỎ "đã gọi" thành gọi ĐƯỢC và gọi KHÔNG được. Gộp làm một là đánh mất đúng thứ cần
 * biết: một đội gọi 100 cuộc mà 80 cuộc không ai bắt máy thì vấn đề nằm ở số điện thoại, không nằm
 * ở kịch bản chăm sóc — và hai vấn đề đó sửa bằng hai cách khác nhau.
 *
 * KHÔNG có loại nào tự chạy. ERP ghi lại việc NGƯỜI đã làm; nó không tự nhắn khách.
 */
export const CARE_ACTION_KINDS = [
  "CALLED_REACHED",
  "CALLED_NO_ANSWER",
  "MESSAGED",
  "ADDRESS_FIXED",
  "RESCHEDULED",
  "CUSTOMER_REFUSED",
  "ESCALATED_CARRIER",
  "OTHER",
] as const;
export type CareActionKind = (typeof CARE_ACTION_KINDS)[number];

export const CARE_ACTION_LABEL: Record<CareActionKind, string> = {
  CALLED_REACHED: "Đã gọi · nói chuyện được",
  CALLED_NO_ANSWER: "Đã gọi · không bắt máy",
  MESSAGED: "Đã nhắn tin",
  ADDRESS_FIXED: "Đã sửa địa chỉ / SĐT",
  RESCHEDULED: "Đã hẹn lại giờ giao",
  CUSTOMER_REFUSED: "Khách xác nhận không lấy",
  ESCALATED_CARRIER: "Đã báo bưu cục / khiếu nại",
  OTHER: "Việc khác",
};

/** Hành động có TIẾP XÚC ĐƯỢC với khách — mẫu số của "chăm có tác dụng không". */
export const CARE_REACHED: CareActionKind[] = ["CALLED_REACHED", "MESSAGED", "ADDRESS_FIXED", "RESCHEDULED", "CUSTOMER_REFUSED"];
