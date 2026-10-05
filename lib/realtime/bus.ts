import { EventEmitter } from "node:events";
import { currentOrganization, peekOrganization } from "@/lib/platform/context";

export type RealtimeEvent =
  | { type: "sync"; source: string; job: string; status: string }
  /** `source`: PANCAKE (đồng bộ) hay ERP (đơn tạo / sửa trong ERP — form, bot, khung chat). Thiếu = PANCAKE (bản cũ). */
  | { type: "order"; orderId: string; action: "created" | "updated"; source?: "PANCAKE" | "ERP" }
  /** Hộp thư khách (M8): khách vừa nhắn / nhân viên vừa gửi — trang hộp thư đang mở làm mới ngay. */
  | { type: "chat"; conversationId: string | null }
  | { type: "shipment"; shipmentId: string; status?: string }
  /** Một lượt ghi của đội care (trạng thái · người · hẹn · note · kết quả) — xem `lib/care/service.ts`. */
  | { type: "care"; shipmentId: string }
  | { type: "stock"; variantId: string }
  | { type: "ads" }
  | { type: "notification"; open: number }
  | { type: "ping" };

/** Sự kiện đã đóng dấu tổ chức — thứ duy nhất được chuyển xuống trình duyệt. */
export type OrganizationEvent = RealtimeEvent & { at: number; org: string };

/**
 * ═══════════ MỖI SỰ KIỆN MANG TỔ CHỨC; SSE CHỈ CHUYỂN CHO PHIÊN CÙNG TỔ CHỨC ═══════════
 *
 * Audit ISO-08 · target-architecture P13. Bus là MỘT `EventEmitter` cho cả tiến trình. Trước nền
 * tảng `/api/events` chuyển MỌI sự kiện cho MỌI phiên: người của tổ chức B thấy mã đơn, mã vận
 * đơn, số cảnh báo đang mở và nhịp đơn của VNX, và trang của B tự dựng lại mỗi lần VNX có đơn.
 *
 * Hai kênh:
 *  · `"event"` — kênh THÔ, phát ĐỒNG BỘ, không lọc. Chỉ để kiểm thử/chẩn đoán trong tiến trình
 *    (`subscribe`). Máy quét cấm mã trong `lib/` `app/` nghe kênh này.
 *  · `"org-event"` — sự kiện ĐÃ ĐÓNG DẤU tổ chức. `/api/events` nghe kênh này qua
 *    `subscribeOrganization(mã của kết nối)`, và bộ lọc `eventVisibleTo` là hàm thuần.
 *
 * Đóng dấu: ngữ cảnh tường minh (job, webhook — `withOrganization`) có sẵn ĐỒNG BỘ; request của
 * người dùng thì phải hỏi `currentOrganization()` (đọc cookie phiên) nên sự kiện đi muộn vài
 * micro-giây. Không xác định được tổ chức (`OrgContextError`) ⇒ BỎ sự kiện và ghi log — không
 * chuyển cho ai, vì chuyển cho "nhà" là đúng kiểu rò rỉ mà tệp này sinh ra để chặn.
 *
 * `publish` vẫn là fire-and-forget: không đổi chữ ký cho các nơi gọi.
 */

const globalForBus = globalThis as unknown as { erpBus?: EventEmitter };
const bus = globalForBus.erpBus ?? new EventEmitter();
bus.setMaxListeners(500);
if (!globalForBus.erpBus) globalForBus.erpBus = bus;

const RAW = "event";
const STAMPED = "org-event";

function stamp(payload: RealtimeEvent & { at: number }, org: string): OrganizationEvent {
  return { ...payload, org };
}

/**
 * Phát một sự kiện. `orgCode` CHỈ dành cho `lib/cache.ts` — nơi đã phân giải tổ chức trước khi
 * lượt làm mới nền chạy (máy quét cấm đối số thứ hai ở mọi nơi khác).
 */
export function publish(event: RealtimeEvent, orgCode?: string) {
  const payload = { ...event, at: Date.now() };
  bus.emit(RAW, payload);
  const known = orgCode ?? peekOrganization()?.code;
  if (known) {
    bus.emit(STAMPED, stamp(payload, known));
    return;
  }
  void currentOrganization().then(
    (org) => {
      bus.emit(STAMPED, stamp(payload, org.code));
    },
    (error: unknown) => {
      console.warn(`[realtime] bỏ sự kiện "${event.type}": không xác định được tổ chức (${error instanceof Error ? error.message : String(error)})`);
    },
  );
}

/**
 * Hàm lọc DUY NHẤT của SSE. Sự kiện thiếu dấu tổ chức ⇒ KHÔNG chuyển (phía hẹp), không bao giờ
 * suy ra "chắc là của nhà".
 */
export function eventVisibleTo(connectionOrg: string, event: { org?: unknown }): boolean {
  return typeof event.org === "string" && event.org !== "" && connectionOrg !== "" && event.org === connectionOrg;
}

/**
 * Nghe sự kiện của ĐÚNG MỘT tổ chức. Người nghe chạy trong ngữ cảnh của NGƯỜI PHÁT (EventEmitter
 * gọi đồng bộ) — nên người nghe KHÔNG được truy vấn CSDL; cần thì tự bọc
 * `withOrganization(orgCode, …)`.
 */
export function subscribeOrganization(orgCode: string, listener: (event: OrganizationEvent) => void) {
  const handler = (event: OrganizationEvent) => {
    if (eventVisibleTo(orgCode, event)) listener(event);
  };
  bus.on(STAMPED, handler);
  return () => bus.off(STAMPED, handler);
}

/**
 * Kênh THÔ — MỌI tổ chức, không lọc. Chỉ cho kiểm thử/chẩn đoán trong tiến trình; máy quét cấm dùng
 * trong `lib/` và `app/` (dùng `subscribeOrganization`).
 */
export function subscribe(listener: (event: RealtimeEvent & { at: number }) => void) {
  bus.on(RAW, listener);
  return () => bus.off(RAW, listener);
}
