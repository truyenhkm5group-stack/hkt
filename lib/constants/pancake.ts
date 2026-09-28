import type { OrderStage, ShipmentStage } from "@/db/schema";

/** Bảng trạng thái đơn hàng Pancake POS (theo OpenAPI chính thức) */
export const PANCAKE_ORDER_STATUS: Record<number, { name: string; stage: OrderStage }> = {
  0: { name: "Mới", stage: "NEW" },
  17: { name: "Chờ xác nhận", stage: "NEW" },
  11: { name: "Chờ hàng", stage: "WAITING" },
  20: { name: "Đã đặt hàng", stage: "WAITING" },
  1: { name: "Đã xác nhận", stage: "CONFIRMED" },
  12: { name: "Chờ in", stage: "CONFIRMED" },
  13: { name: "Đã in", stage: "CONFIRMED" },
  8: { name: "Đang đóng hàng", stage: "PACKING" },
  9: { name: "Chờ chuyển hàng", stage: "READY_TO_SHIP" },
  2: { name: "Đã gửi hàng", stage: "SHIPPED" },
  3: { name: "Đã nhận", stage: "DELIVERED" },
  16: { name: "Đã thu tiền", stage: "PAID" },
  4: { name: "Đang hoàn", stage: "RETURNING" },
  15: { name: "Hoàn một phần", stage: "PARTIAL_RETURN" },
  5: { name: "Đã hoàn", stage: "RETURNED" },
  6: { name: "Đã hủy", stage: "CANCELLED" },
  7: { name: "Đã xóa", stage: "DELETED" },
};

export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  NEW: "Mới",
  WAITING: "Chờ hàng",
  CONFIRMED: "Đã xác nhận",
  PACKING: "Đang đóng hàng",
  READY_TO_SHIP: "Chờ chuyển hàng",
  SHIPPED: "Đã gửi hàng",
  DELIVERED: "Đã nhận",
  PAID: "Đã thu tiền",
  RETURNING: "Đang hoàn",
  PARTIAL_RETURN: "Hoàn một phần",
  RETURNED: "Đã hoàn",
  CANCELLED: "Đã hủy",
  DELETED: "Đã xóa",
};

export const ORDER_STAGE_ORDER: OrderStage[] = [
  "NEW",
  "WAITING",
  "CONFIRMED",
  "PACKING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "PAID",
  "RETURNING",
  "PARTIAL_RETURN",
  "RETURNED",
  "CANCELLED",
  "DELETED",
];

/**
 * PHẠM VI ĐƠN DÙNG CHUNG cho mọi KPI quản trị: các trạng thái Pancake đã được chốt
 * (bỏ đơn Mới chưa xác nhận, đơn huỷ, đơn xoá). Tổng quan, Báo cáo lợi nhuận, Lương,
 * Quảng cáo và Chất lượng dữ liệu phải dùng CHUNG danh sách này, nếu không thì cùng một
 * kỳ sẽ ra số đơn khác nhau ở mỗi màn hình.
 */
export const CONFIRMED_STAGES = ["CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"] as const;

/** Các giai đoạn tính là "đơn thành công" (đã giao/đã thu tiền) */
export const SUCCESS_STAGES: OrderStage[] = ["DELIVERED", "PAID"];
/** Các giai đoạn tính là "đơn thất bại" */
export const FAILED_STAGES: OrderStage[] = ["RETURNING", "RETURNED", "CANCELLED", "DELETED", "PARTIAL_RETURN"];
/** Đơn đang trong luồng xử lý/giao */
export const ACTIVE_STAGES: OrderStage[] = ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP", "SHIPPED"];

/**
 * ĐƠN CHƯA GỬI ĐI — khách đã đặt, hàng còn trong tay shop.
 *
 * Bằng `ACTIVE_STAGES` trừ `SHIPPED`, và sự khác nhau đó chính là điều kiện "còn chặn kịp": mọi
 * luật soát trước khi gửi, dò đơn trùng và phát hiện nút thắt chỉ có nghĩa trên tập này.
 *
 * Danh sách này đã bị gõ lại nguyên văn ở vài nơi trước khi có tên (xem `lib/alerts/rules.ts`).
 * Mã mới dùng hằng số; thấy một mảng gõ tay giống hệt ở đâu thì thay bằng nó, đừng chép thêm.
 */
export const PRE_SHIP_STAGES: OrderStage[] = ["NEW", "WAITING", "CONFIRMED", "PACKING", "READY_TO_SHIP"];

/** Đơn đã chết: huỷ hoặc xoá. Không luật vận hành nào được coi chúng là việc phải làm. */
export const DEAD_ORDER_STAGES: OrderStage[] = ["CANCELLED", "DELETED"];

export function pancakeStatusToStage(status: number): OrderStage {
  return PANCAKE_ORDER_STATUS[status]?.stage ?? "NEW";
}

export function pancakeStatusName(status: number) {
  return PANCAKE_ORDER_STATUS[status]?.name ?? `Trạng thái ${status}`;
}

/** Nguồn đơn hàng theo mã (order_sources / marketplace_id) */
export const PANCAKE_ORDER_SOURCES: Record<string, string> = {
  "-1": "Facebook",
  "-2": "Website",
  "-3": "Shopee",
  "-4": "Lazada",
  "-5": "Tiki",
  "-6": "Sendo",
  "-7": "TikTok Shop",
  "-8": "Zalo",
  "-9": "TikTok Shop",
  "-10": "Khác",
  "-16": "WooCommerce",
  "-17": "Shopify",
};

/** partner_status của ĐVVC trong Pancake → mô tả & giai đoạn vận đơn */
export const PANCAKE_PARTNER_STATUS: Record<string, { name: string; stage: ShipmentStage }> = {
  waiting: { name: "Chờ xử lý", stage: "PENDING" },
  request_received: { name: "ĐVVC đã tiếp nhận đơn", stage: "PENDING" },
  processing_picked_up: { name: "Đang xử lý lấy hàng", stage: "PENDING" },
  picking_up: { name: "Đang lấy hàng", stage: "PENDING" },
  delay_pickup: { name: "Trễ lấy hàng", stage: "PENDING" },
  picked_up: { name: "Đã lấy hàng", stage: "PICKED_UP" },
  waiting_on_the_way: { name: "Chờ trung chuyển", stage: "IN_TRANSIT" },
  on_the_way: { name: "Đang trung chuyển", stage: "IN_TRANSIT" },
  contact_delivery_company: { name: "Liên hệ ĐVVC", stage: "IN_TRANSIT" },
  out_for_delivery: { name: "Đang giao hàng", stage: "OUT_FOR_DELIVERY" },
  delay_delivery: { name: "Trễ giao hàng", stage: "OUT_FOR_DELIVERY" },
  inform_recipient: { name: "Thông báo cho người nhận", stage: "OUT_FOR_DELIVERY" },
  undeliverable: { name: "Giao không thành", stage: "DELIVERY_FAILED" },
  waiting_for_return: { name: "Chờ chuyển hoàn", stage: "RETURNING" },
  delivered: { name: "Đã giao hàng", stage: "DELIVERED" },
  delivered_cod: { name: "Đã giao hàng, đã đối soát COD", stage: "DELIVERED" },
  returning: { name: "Đang chuyển hoàn", stage: "RETURNING" },
  returned: { name: "Đã chuyển hoàn", stage: "RETURNED" },
  returned_cod: { name: "Đã chuyển hoàn, đã đối soát COD", stage: "RETURNED" },
  canceled: { name: "Đã hủy vận đơn", stage: "CANCELLED" },
};

export const SOURCE_COLORS: Record<string, string> = {
  Facebook: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Shopee: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  "TikTok Shop": "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  Lazada: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  Website: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Zalo: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  Instagram: "bg-pink-50 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
};

/**
 * ═══════════ ĐƯỜNG DẪN WEB POS PANCAKE — MỘT CHỖ DUY NHẤT ═══════════
 *
 * Mọi liên kết sang pos.pancake.vn dựng ở đây. Bản cũ gõ tay ở từng trang và SAI ở cả bốn nơi:
 * `/shop/<id>/orders?id=…` trả 404 (web POS không có trang "orders" số nhiều), `/shop/<id>/products`
 * cũng 404, còn `/shop/orders?search=` thiếu mã shop nên POS đọc chữ "orders" thành mã shop.
 *
 * Mẫu đúng đọc từ CHÍNH mã web POS (27/09/2026, bản dựng ea924942): trang đơn là `/shop/<id>/order`,
 * hàm `getOrderUrl` của POS dựng `…/order?order_id=<MÃ NỘI BỘ POS>` — KHÔNG phải `orders.id` (xem
 * `pancakePosOrderUrlFromLink`: mã ấy chỉ có trong `order_link` Pancake gửi kèm đơn), còn
 * `?o_c_i=<từ khoá>` là tham số POS đọc từ URL để lọc danh sách đơn. Trang sản phẩm là
 * `/shop/<id>/product/management`. `tests/pancake-links.test.ts` chặn đường dẫn gõ tay ở nơi khác.
 */
export const PANCAKE_POS_WEB = "https://pos.pancake.vn";

function posShop(shopId: string | null | undefined): string | null {
  const shop = shopId?.trim();
  return shop ? `${PANCAKE_POS_WEB}/shop/${encodeURIComponent(shop)}` : null;
}

/**
 * MỘT ĐƠN TRÊN POS — dựng từ `order_link` PANCAKE TỰ GỬI trong mỗi đơn (`orders.raw.order_link`),
 * KHÔNG từ `orders.id`.
 *
 * Web POS mở một đơn bằng MÃ NỘI BỘ, khác mã của API. Đo production 28/09/2026: đơn API `id = 4063`
 * (`system_id` cũng 4063) có `order_link = …/shop/408063069/order?order_id=10920003274`; mở bằng
 * `order_id=4063` thì POS ra danh sách trống. Mã nội bộ không nằm ở cột nào khác, nhưng 3.866/3.866
 * đơn đều có `order_link`. Nên hàm này KHÔNG nhận `orders.id` — không có đường nào để dùng nhầm lại.
 *
 * Chỉ nhận đường dẫn đúng hình dạng `/shop/<số>/order?order_id=<số>` trên pos.pages.fm hoặc
 * pos.pancake.vn, rồi dựng lại trên `PANCAKE_POS_WEB` (pos.pages.fm vốn chỉ chuyển hướng sang đó).
 * Sai hình dạng ⇒ `null`: nơi gọi rơi về `pancakePosOrderSearchUrl` (tìm theo số đơn).
 */
export function pancakePosOrderUrlFromLink(orderLink: unknown): string | null {
  if (typeof orderLink !== "string" || !orderLink.trim()) return null;
  let u: URL;
  try {
    u = new URL(orderLink.trim());
  } catch {
    return null;
  }
  if (!["pos.pages.fm", "pos.pancake.vn"].includes(u.hostname)) return null;
  const shop = /^\/shop\/(\d+)\/order\/?$/.exec(u.pathname)?.[1];
  const posOrderId = u.searchParams.get("order_id");
  if (!shop || !posOrderId || !/^\d+$/.test(posOrderId)) return null;
  return `${posShop(shop)}/order?order_id=${posOrderId}`;
}

/** Cùng hàm trên, đọc thẳng từ bản ghi thô Pancake của đơn (`orders.raw`). */
export function pancakePosOrderUrlFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return pancakePosOrderUrlFromLink((raw as { order_link?: unknown }).order_link);
}

/** DANH SÁCH ĐƠN của shop, lọc sẵn theo một từ khoá (số đơn, SĐT…). Không có từ khoá ⇒ danh sách trần. */
export function pancakePosOrderSearchUrl(shopId: string | null | undefined, keyword?: string | number | null): string | null {
  const shop = posShop(shopId);
  if (!shop) return null;
  const k = keyword === null || keyword === undefined ? "" : String(keyword).trim();
  return k ? `${shop}/order?o_c_i=${encodeURIComponent(k)}` : `${shop}/order`;
}

/**
 * Số đơn tối đa trên MỘT link lọc nhiều đơn. URL quá dài bị trình duyệt / máy chủ cắt, và danh sách
 * đơn của POS phân trang — chia lượt thì mỗi lượt vừa một trang để chọn tất cả rồi đẩy một lần.
 */
export const POS_MULTI_ORDER_CHUNK = 50;

/**
 * NHIỀU ĐƠN MỘT LƯỢT TRÊN POS — để chọn tất cả rồi dùng tính năng đẩy nhiều đơn sang ĐVVC của POS.
 *
 * `o_c_i` được POS đưa thẳng vào ô tìm kiếm của danh sách đơn (`fetchListOfOrders({ search })`), và
 * chính POS tìm nhiều đơn một lượt bằng cách NỐI CÁC MÃ BẰNG DẤU CÁCH (`search = ids.join(" ")` trong
 * công cụ đối soát đơn — đọc từ mã web POS 28/09/2026). Nên từ khoá ở đây là các SỐ ĐƠN nối bằng dấu
 * cách, cùng loại số mà `pancakePosOrderSearchUrl` dùng cho một đơn.
 *
 * Chia theo SHOP (một link chỉ mở được một shop) rồi theo `POS_MULTI_ORDER_CHUNK`. Đơn thiếu shop hoặc
 * thiếu số đơn thì KHÔNG dựng được — trả riêng trong `skipped` để màn hình nói ra, không lặng lẽ rơi.
 */
export function pancakePosOrderBatches(
  orders: readonly { shopId: string | null | undefined; systemId: number | string | null | undefined }[],
  chunk: number = POS_MULTI_ORDER_CHUNK,
): { batches: { shopId: string; systemIds: string[]; url: string }[]; skipped: number } {
  const byShop = new Map<string, string[]>();
  let skipped = 0;
  for (const o of orders) {
    const shop = o.shopId?.trim();
    const id = o.systemId === null || o.systemId === undefined ? "" : String(o.systemId).trim();
    if (!shop || !id) {
      skipped += 1;
      continue;
    }
    const list = byShop.get(shop) ?? [];
    if (!list.includes(id)) list.push(id);
    byShop.set(shop, list);
  }
  const size = Math.max(1, Math.floor(chunk));
  const batches: { shopId: string; systemIds: string[]; url: string }[] = [];
  for (const [shopId, ids] of byShop) {
    for (let i = 0; i < ids.length; i += size) {
      const systemIds = ids.slice(i, i + size);
      batches.push({ shopId, systemIds, url: pancakePosOrderSearchUrl(shopId, systemIds.join(" ")) as string });
    }
  }
  return { batches, skipped };
}

/** Trang quản lý sản phẩm của shop trên POS. */
export function pancakePosProductsUrl(shopId: string | null | undefined): string | null {
  const shop = posShop(shopId);
  return shop ? `${shop}/product/management` : null;
}

/** HỘI THOẠI CỦA KHÁCH trên Pancake (inbox). Thiếu trang hoặc mã hội thoại ⇒ `null`. */
export function pancakeConversationUrl(pageId: string | null | undefined, conversationId: string | null | undefined): string | null {
  if (!pageId?.trim() || !conversationId?.trim()) return null;
  return `https://pancake.vn/${pageId.trim()}?c_id=${conversationId.trim()}`;
}
