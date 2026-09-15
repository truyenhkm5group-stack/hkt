import type { CasePriority } from "@/lib/constants/action-queue";

/**
 * ═══════════ KHÁCH HẸN NGÀY GIAO ═══════════
 *
 * ─── VẤN ĐỀ NÓ SỬA ───
 *
 * Khách chốt mua hôm nay nhưng xin giao ngày 20: "gửi giúp em ngày 20 nhé, giờ em đi công tác".
 * Trước cột `orders.customer_promised_at`, ERP không phân biệt được đơn đó với một đơn bị bỏ quên —
 * cả hai đều là "đã xác nhận mà chưa gửi". Hệ quả đo được trên production 15/09/2026: luật
 * `ORDER_CONFIRMATION_STALE` (24 giờ) và hàng đợi nút thắt kho đều đếm đơn có hẹn là TRỄ HẠN từ
 * ngày thứ hai, và người trực phải nhớ trong đầu đơn nào là hẹn thật.
 *
 * Một hàng đợi mà người dùng phải nhớ "cái này không tính" là hàng đợi sẽ bị bỏ qua cả cụm.
 *
 * ─── HẸN KHÔNG PHẢI LÀ HOÃN VÔ THỜI HẠN ───
 *
 * Đây là điểm dễ làm sai nhất. Một cái hẹn KHÔNG được biến đơn thành tàng hình: nếu chỉ lọc "còn
 * hạn thì ẩn đi" thì ngày 20 tới, đơn im lặng nằm lại đúng chỗ cũ và không ai biết phải gói nó.
 *
 * Nên cái hẹn là một ĐỒNG HỒ NGƯỢC, không phải một cái công tắc:
 *
 *   FUTURE    còn hơn một ngày nữa   → KHÔNG cảnh báo, không nằm trong hàng đợi.
 *   DUE_SOON  còn trong 24 giờ cuối  → quay lại hàng đợi ở mức P2: chuẩn bị gói.
 *   DUE       tới ngày hẹn           → P1: phải gửi hôm nay.
 *   BREACHED  quá ngày hẹn           → trễ hạn THẬT, và trễ với KHÁCH chứ không phải trễ nội bộ.
 *
 * ─── LỜI HỨA VỚI KHÁCH NẶNG HƠN HẠN NỘI BỘ ───
 *
 * `BREACHED` ở đây khác hẳn `ORDER_CONFIRMATION_STALE`: một cái là shop chậm với chính mình, cái
 * kia là shop đã hứa một ngày cụ thể với một người cụ thể rồi lỡ. Nên nó xếp `URGENT`, không phải
 * `HIGH` — và mức đó KHÔNG phụ thuộc đơn để lâu bao nhiêu, vì lỡ hẹn một ngày cũng đã là lỡ.
 */

export const PROMISED_STATES = ["NONE", "FUTURE", "DUE_SOON", "DUE", "BREACHED"] as const;
export type PromisedState = (typeof PROMISED_STATES)[number];

export const PROMISED_STATE_LABEL: Record<PromisedState, string> = {
  NONE: "Khách không hẹn ngày",
  FUTURE: "Còn trong hẹn",
  DUE_SOON: "Sắp tới ngày hẹn",
  DUE: "Đến ngày hẹn",
  BREACHED: "LỠ HẸN VỚI KHÁCH",
};

export const PROMISED_STATE_TONE: Record<PromisedState, string> = {
  NONE: "bg-muted text-muted-foreground",
  // Xanh lá CÓ CHỦ Ý: đơn này đang đúng kế hoạch, người trực không cần làm gì cả.
  FUTURE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DUE_SOON: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  DUE: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  BREACHED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

export const PROMISED_NEXT_ACTION: Record<PromisedState, string> = {
  NONE: "Không có lời hẹn nào — đơn đi theo hạn xử lý thông thường.",
  FUTURE: "Chưa phải việc của hôm nay. Đơn sẽ tự quay lại hàng đợi trước ngày hẹn một ngày.",
  DUE_SOON: "Còn dưới một ngày là tới hẹn: soát lại hàng, đóng gói sẵn để mai bưu tá tới là đi được ngay.",
  DUE: "Hôm nay là ngày khách hẹn. Tạo vận đơn và bàn giao ĐVVC trong hôm nay.",
  BREACHED: "ĐÃ LỠ HẸN. Gọi khách xin lỗi và báo mốc mới TRƯỚC khi họ phải hỏi — khách tự phát hiện mới là lúc mất khách.",
};

/**
 * MỨC ƯU TIÊN THEO TRẠNG THÁI HẸN. `null` = cái hẹn KHÔNG nói gì về mức ưu tiên, nên luật thường
 * quyết định — khác hẳn "mức thấp".
 *
 * `BREACHED` là `URGENT` và KHÔNG phụ thuộc đơn để lâu bao nhiêu: lỡ hẹn một ngày cũng đã là lỡ,
 * và người đang chờ ở đầu kia không quan tâm đơn nằm trong kho bao lâu.
 */
export const PROMISED_PRIORITY: Record<PromisedState, CasePriority | null> = {
  NONE: null,
  FUTURE: null,
  DUE_SOON: "NORMAL",
  DUE: "HIGH",
  BREACHED: "URGENT",
};

/** Cửa sổ "sắp tới hạn" — đúng một ngày, theo yêu cầu của chủ shop (T-1). */
export const PROMISED_DUE_SOON_HOURS = 24;

export type PromisedVerdict = {
  state: PromisedState;
  /** Mốc hết hạn lời hứa. `null` khi không có hẹn. */
  promisedAt: Date | null;
  /** Giờ còn lại; âm = đã lỡ hẹn bấy nhiêu giờ. `null` khi không có hẹn. */
  hoursRemaining: number | null;
  priority: CasePriority | null;
  label: string;
  nextAction: string;
};

/**
 * TRẠNG THÁI LỜI HẸN. Hàm THUẦN — không đọc CSDL, không đọc đồng hồ hệ thống (`now` truyền vào).
 *
 * `alreadyShipped` là lối thoát duy nhất: đơn đã rời kho thì lời hẹn đã được thực hiện xong phần
 * của shop, và giữ nó trong hàng đợi là tạo một việc không ai làm được nữa. Chặng sau đó do ĐVVC
 * quyết, và nó đã có đồng hồ riêng (`lib/constants/shipment-status-age.ts`).
 */
export function promisedVerdict(promisedAt: Date | null | undefined, now: Date, alreadyShipped = false): PromisedVerdict {
  const mo = (state: PromisedState, hoursRemaining: number | null, at: Date | null): PromisedVerdict => ({
    state,
    promisedAt: at,
    hoursRemaining,
    priority: PROMISED_PRIORITY[state],
    label: PROMISED_STATE_LABEL[state],
    nextAction: PROMISED_NEXT_ACTION[state],
  });

  if (!(promisedAt instanceof Date) || !Number.isFinite(promisedAt.getTime())) return mo("NONE", null, null);
  // Đơn đã rời kho: phần việc của shop xong, lời hẹn thôi sinh việc. Vẫn trả mốc để màn hình in ra.
  if (alreadyShipped) return mo("FUTURE", (promisedAt.getTime() - now.getTime()) / 3_600_000, promisedAt);

  const hoursRemaining = (promisedAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursRemaining < 0) return mo("BREACHED", hoursRemaining, promisedAt);
  // "Đến ngày hẹn" = còn trong chính ngày đó. Mốc lưu là CUỐI ngày VN nên còn < 24 giờ tức là hôm nay.
  if (hoursRemaining <= PROMISED_DUE_SOON_HOURS) return mo("DUE", hoursRemaining, promisedAt);
  if (hoursRemaining <= PROMISED_DUE_SOON_HOURS * 2) return mo("DUE_SOON", hoursRemaining, promisedAt);
  return mo("FUTURE", hoursRemaining, promisedAt);
}

/**
 * CÓ ĐƯỢC TẠM THA KHỎI HẠN NỘI BỘ KHÔNG.
 *
 * Đây là hàm mà các luật cảnh báo trước khi gửi gọi tới. `true` nghĩa là: đơn này CÓ hẹn, và cái
 * hẹn còn ở tương lai xa, nên mọi hạn nội bộ ("đã chốt mà chưa gửi") KHÔNG áp dụng.
 *
 * Chỉ tha ở `FUTURE`. Từ `DUE_SOON` trở đi đơn quay lại hàng đợi bình thường — vì lúc đó việc gói
 * hàng là việc thật, và một cái hẹn không được che nó đi.
 */
export function promiseSuppressesInternalSla(promisedAt: Date | null | undefined, now: Date): boolean {
  return promisedVerdict(promisedAt, now).state === "FUTURE";
}

/**
 * BIỂU THỨC SQL CÙNG NGHĨA với `promiseSuppressesInternalSla` — dùng trong `where` của các luật
 * cảnh báo, để phép lọc chạy ở CSDL thay vì kéo cả kỳ về rồi lọc trong Node.
 *
 * `col` là tên cột đã đủ điều kiện (ví dụ `o.customer_promised_at`). Trả về vị ngữ "đơn này KHÔNG
 * được tha" — tức là dùng trực tiếp trong `and (...)`.
 *
 * `is null` nằm trong phép hoặc là CỐ Ý: đơn không có hẹn thì không được tha, và đó là đa số tuyệt
 * đối. Quên vế đó đi là làm mọi đơn bình thường biến mất khỏi mọi cảnh báo.
 */
export function sqlPromiseNotSuppressing(col: string): string {
  return `(${col} is null or ${col} <= now() + interval '${PROMISED_DUE_SOON_HOURS * 2} hours')`;
}

/* ═══════════════════ KIỂM ĐẦU VÀO ═══════════════════ */

/** Hẹn xa nhất chấp nhận được. 180 ngày: xa hơn thế gần như chắc chắn là gõ nhầm năm. */
export const PROMISED_MAX_DAYS_AHEAD = 180;
/**
 * Lùi về quá khứ được bao nhiêu ngày. 7 ngày: người trực có thể ghi lại một lời hẹn đã lỡ để đơn
 * hiện đúng trạng thái `BREACHED`, nhưng không được dựng một lịch sử tuỳ ý.
 */
export const PROMISED_MAX_DAYS_BEHIND = 7;
