/**
 * ═══ CỬA NỘI BỘ bot nhà → ERP: chặng vận đơn theo CHỨNG TỪ Viettel Post (23/10/2026) ═══
 *
 * Bot nhà (container erp-chatbot) dựng câu trạng thái đơn từ đơn POS Pancake. `partner_status` của Pancake KHÔNG phải chứng từ ĐVVC
 * (AGENTS 47); với vận đơn TẠO LẠI trên web VTP nó còn mô tả vận đơn GỐC, và đơn Pancake thường đứng «Đã hủy» trong khi kiện gửi lại
 * đang đi / đã giao (pilot pos-reship-link 23/10/2026: 326 đơn như vậy). Cửa này cho bot đọc góc nhìn ERP dựng từ sự kiện VTP.
 *
 * Hợp đồng HẸP: CHỈ ĐỌC · theo mã vận đơn (`codes`) và / hoặc mã đơn Pancake (`orders`), mỗi loại ≤ SHIPMENT_STATE_MAX_CODES · trả mã VTP +
 * chặng + cờ kết thúc + mốc chứng từ (+ với đơn: lần gửi có phải lần gửi KẾ không) · không số tiền · không người nhận · chỉ vận đơn CÓ
 * chứng từ VTP · xác thực bằng khoá nội bộ ERP ↔ bot (`CHATBOT_ADMIN_TOKEN`) qua header, so theo thời gian hằng.
 */

export const SHIPMENT_STATE_PATH = "/api/internal/shipment-state";
export const SHIPMENT_STATE_TOKEN_HEADER = "x-chatbot-token";
export const SHIPMENT_STATE_MAX_CODES = 20;

/** Mã vận đơn VTP: chữ in hoa + số, 8–24 ký tự (PKE…, số 12 chữ, chặng hoàn …P…). */
const VTP_CODE_RE = /^[A-Z0-9]{8,24}$/;
/** Mã đơn Pancake: số nguyên dạng chuỗi (có thể vượt 2^53 — AGENTS 4), không nhận đơn ERP `erp-…`. */
const ORDER_ID_RE = /^[0-9]{1,24}$/;

function parseList(raw: string | null | undefined, re: RegExp, what: string, upper: boolean): string[] | { error: string } {
  const items = [...new Set(String(raw ?? "").split(",").map((c) => (upper ? c.trim().toUpperCase() : c.trim())).filter(Boolean))];
  if (items.length > SHIPMENT_STATE_MAX_CODES) return { error: `tối đa ${SHIPMENT_STATE_MAX_CODES} ${what} mỗi lượt` };
  if (items.some((c) => !re.test(c))) return { error: `${what} không hợp lệ` };
  return items;
}

/** `codes=…&orders=…` ⇒ hai danh sách đã soát, hoặc lỗi. Cả hai rỗng / quá trần / phần tử lạ ⇒ lỗi — không lọc ngầm. HÀM THUẦN. */
export function parseShipmentQuery(codesRaw: string | null | undefined, ordersRaw: string | null | undefined): { codes: string[]; orders: string[] } | { error: string } {
  const codes = parseList(codesRaw, VTP_CODE_RE, "mã vận đơn", true);
  if ("error" in codes) return codes;
  const orders = parseList(ordersRaw, ORDER_ID_RE, "mã đơn", false);
  if ("error" in orders) return orders;
  if (!codes.length && !orders.length) return { error: "thiếu codes hoặc orders" };
  return { codes, orders };
}

export type ShipmentStateRow = { code: string; stage: string; final: boolean; at: string | null };
/** Lần gửi CHÍNH của đơn theo ERP (`PRIMARY_ATTEMPT`). `reship` = lần gửi do luật gắn vận đơn tạo lại của ERP tạo / gắn (`raw.reship`). */
export type OrderShipmentRow = ShipmentStateRow & { orderId: string; reship: boolean };
