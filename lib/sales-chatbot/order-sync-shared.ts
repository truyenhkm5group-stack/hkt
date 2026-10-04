/**
 * ═══════════ GHI ĐƠN TỪ HỘI THOẠI FANPAGE — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Chủ shop HSLC 03/10/2026: «tách riêng phần bật/tắt chatbot và đồng bộ đơn hàng — bật/tắt chatbot không ảnh hưởng đến việc
 * đồng bộ đơn hàng». Trước đây đơn của tổ chức khách CHỈ vào ERP khi bot tự chốt trong hội thoại: tắt bot ⇒ `chatTurn` trả
 * «Shop chưa mở chat» ⇒ nhân viên chốt đơn trên Pancake mà ERP không có dòng nào.
 *
 * Nên đây là MỘT công tắc RIÊNG (`settings['ai.salesOrderSync']`, KHÔNG nằm trong cấu hình bot): bật thì job 5 phút đọc
 * những hội thoại fanpage do NGƯỜI phụ trách (bot tắt, hoặc hội thoại đang ở «Cần người xử lý»), AI của shop đọc lại và chỉ
 * ra lời chốt; MÁY CHỦ kiểm từng thứ (mã sản phẩm có thật, lời chốt nằm SAU đơn gần nhất, SĐT có trong hội thoại, địa chỉ
 * có trong hội thoại hoặc là địa chỉ đơn cũ của chính khách) rồi lên đơn ở trạng thái «Mới» — nhân viên kiểm và chốt.
 * Logic chạy: `lib/sales-chatbot/order-sync.ts`.
 */
import { z } from "zod";
import { formatVND } from "@/lib/format";

export const ORDER_SYNC_SETTING_KEY = "ai.salesOrderSync";

/** `enabledAt` = lúc bật gần nhất: tin TRƯỚC mốc này không bao giờ thành đơn (bật lên không quét ngược lịch sử). */
export const orderSyncConfigZ = z.object({ enabled: z.boolean(), enabledAt: z.string().nullable() }).strict();
export type OrderSyncConfig = z.infer<typeof orderSyncConfigZ>;
export const DEFAULT_ORDER_SYNC_CONFIG: OrderSyncConfig = { enabled: false, enabledAt: null };

/** Sai hình / thiếu ⇒ TẮT — hỏng về phía không ghi đơn. HÀM THUẦN. */
export function parseOrderSyncConfig(raw: unknown): OrderSyncConfig {
  const parsed = orderSyncConfigZ.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_ORDER_SYNC_CONFIG;
}

/**
 * Trần KỸ THUẬT (không phải ngưỡng nghiệp vụ): `quietMinutes` = hội thoại phải yên chừng này mới đọc (khách / nhân viên còn
 * đang gõ thì chưa có gì để chốt); `threadsPerRun` = số hội thoại đọc mỗi lượt job (mỗi hội thoại một lời gọi AI).
 */
export const ORDER_SYNC_LIMITS = { quietMinutes: 10, lookbackHours: 24, threadsPerRun: 8, candidates: 60, messages: 40, messageChars: 500, catalog: 200, recentOrderGuardMinutes: 30 } as const;

/** Nhãn kênh của đơn ghi từ hội thoại do người chốt — tách khỏi «Chatbot fanpage» (đơn bot tự chốt). */
export const ORDER_SYNC_CHANNEL = "Fanpage (nhân viên chốt)";

export type SyncedOrderSummary = {
  code: string;
  name: string;
  phone: string;
  address: string;
  province: string;
  lines: readonly { name: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  /** `null` = chưa báo phí ship. */
  shippingFee: number | null;
  /** Câu ship hiện cho nhân viên (miễn ship / miễn ship nếu đúng khu vực) — `null` = theo số `shippingFee`. */
  shipText: string | null;
  /** Ghi chú cần kiểm (SĐT / địa chỉ lấy từ đơn trước…). */
  warnings: readonly string[];
  /** Đơn đã ghi thẳng «Đã xác nhận» (tổ chức bật «đơn đủ thông tin = đã xác nhận») — tin không bảo «chốt đơn» nữa. */
  confirmed?: boolean;
};

/**
 * Tin nhóm vận hành cho đơn ghi từ hội thoại nhân viên — ĐỦ như tin «ĐƠN MỚI» của bot: tên, SĐT, địa chỉ, từng món × SL × đơn
 * giá, tiền hàng, ship, tiền thu. Chủ shop Hải Sản Làng Chài 04/10/2026: tin cũ chỉ có tên · SĐT · tên món · tổng — thiếu địa
 * chỉ và giá, kho không đóng gói được. HÀM THUẦN.
 */
export function syncedOrderGroupText(o: SyncedOrderSummary): string {
  const address = o.province && !o.address.toLowerCase().includes(o.province.toLowerCase()) ? [o.address, o.province].filter(Boolean).join(", ") : o.address;
  const ship = o.shipText ?? (o.shippingFee === null ? "chưa báo" : formatVND(o.shippingFee));
  return [
    `🧾 ĐƠN MỚI TỪ FANPAGE ${o.code} — nhân viên chốt, ${o.confirmed ? "ĐÃ TÍNH ĐƠN (đủ thông tin)" : "chờ kiểm"}`,
    `Khách: ${o.name} · ${o.phone}`,
    `Địa chỉ: ${address || "—"}`,
    ...o.lines.map((l) => `• ${l.name} × ${l.quantity} × ${formatVND(l.unitPrice)} = ${formatVND(l.lineTotal)}`),
    `Tiền hàng: ${formatVND(o.subtotal)} · Ship: ${ship}`,
    `THU: ${formatVND(o.subtotal + (o.shippingFee ?? 0))}${o.shippingFee === null ? " + ship" : ""}`,
    ...o.warnings,
    o.confirmed ? "Đơn đã tính — sai thì sửa / huỷ trên ERP." : "Kiểm thông tin rồi chốt đơn trên ERP.",
  ].join("\n");
}

export type OrderSyncOutcome = "CREATED" | "CHANGE" | "NONE" | "SKIPPED" | "BOT" | "ERROR";
export const ORDER_SYNC_OUTCOME_LABEL: Record<OrderSyncOutcome, string> = {
  CREATED: "Đã lên đơn",
  CHANGE: "Khách sửa đơn đã ghi — báo nhân viên",
  NONE: "Chưa có đơn mới",
  SKIPPED: "Không lên đơn",
  BOT: "Bot đang phụ trách",
  ERROR: "Lỗi",
};

/** Nhật ký ghi đơn của MỘT hội thoại — `sales_chat_conversations.state.orderSync`. Bot không bao giờ ghi khoá này. */
export type OrderSyncThreadState = {
  /** Mốc tin mới nhất đã đọc — hội thoại chỉ đọc lại khi có tin mới hơn. */
  checkedUntil: string;
  lastRunAt: string;
  lastOutcome: OrderSyncOutcome;
  lastResult: string;
  /** Đơn đã ghi từ hội thoại này (mới nhất cuối), tối đa 10. `at` = lúc ghi; `agreementAt` = mốc tin chốt. */
  orders: { orderId: string; at: string; agreementAt: string; agreementId: string; total: number }[];
  /** Khách của đơn gần nhất — lần mua sau trong cùng hội thoại không phải hỏi lại SĐT / địa chỉ. */
  customer?: { id: string; name: string; phone: string; address: string; province: string };
};
