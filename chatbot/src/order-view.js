/**
 * Mo ta don POS cho bot noi voi khach + goc nhin ERP (chung tu Viettel Post) — module THUAN: khong import config / logger, nen nap
 * no khong lam config.js chot DATA_DIR (ESM chi nap mot lan — bai kiem nap orders.js truoc da lam testChatbotImportGuards ghi nham
 * thu muc, 23/10/2026). orders.js xuat lai ORDER_STATUS_VI / describeOrder va boc erpOrderView voi khoa + ham log that.
 */

/** Ten trang thai don POS (khop audit.js) va trang thai ben van chuyen -> tieng Viet de bot noi voi khach */
export const ORDER_STATUS_VI = { 0: "Mới (chưa xác nhận)", 1: "Đã xác nhận, đang chuẩn bị hàng", 2: "Đã gửi hàng cho đơn vị vận chuyển", 3: "Đang giao hàng", 4: "Đã nhận hàng", 5: "Đã đối soát", 6: "Đã hủy", 7: "Đang hoàn", 8: "Đã hoàn", 9: "Đã xóa", 11: "Chờ hàng", 12: "Đang đóng hàng", 15: "Đang chuyển hàng", 16: "Giao không thành công", 17: "Đã thu tiền", 20: "Đã đối soát" };
const PARTNER_STATUS_VI = { on_the_way: "đang trên đường giao", picked_up: "đã lấy hàng", delivering: "đang giao", delivered: "đã giao thành công", waiting_pickup: "chờ lấy hàng", returning: "đang chuyển hoàn", returned: "đã hoàn về shop", delivery_failed: "giao không thành công" };

function fmtNgay(s) {
  const t = Date.parse(String(s || "").replace(/(\.\d+)?Z?$/, "Z"));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }) : "";
}

/*
  GOC NHIN ERP (chung tu Viettel Post) cho cac don POS — cua noi bo /api/internal/shipment-state (lib/constants/shipment-state-api.ts).
  partner_status cua Pancake KHONG phai chung tu DVVC (AGENTS 47), va voi van don TAO LAI tren web VTP no con mo ta van don GOC: don
  Pancake dung "Da huy" trong khi kien gui lai dang di / da giao (do 23/10/2026: 326 don). ERP co chung tu ⇒ noi theo ERP; ERP khong
  co / goi loi / cham ⇒ noi nhu cu, NHUNG trang thai ket thuc tieu cuc cua Pancake khong bao gio noi thang (chi ma + tra cuu VTP).
*/
const ERP_VIEW_TTL_MS = 90_000;
const ERP_VIEW_TIMEOUT_MS = 1500;
const ERP_VIEW_MAX = 20;
const EMPTY_ERP_VIEW = Object.freeze({ byCode: {}, byOrder: {} });
const erpViewCache = new Map();

/** Chang ERP -> tieng Viet (lib/constants: shipment_stage). */
const ERP_STAGE_VI = { PENDING: "chờ bưu tá lấy hàng", PICKED_UP: "bưu tá đã lấy hàng", IN_TRANSIT: "đang vận chuyển", OUT_FOR_DELIVERY: "đang giao", DELIVERED: "đã giao thành công", DELIVERY_FAILED: "giao chưa thành công, đang chờ giao lại", RETURNING: "đang chuyển hoàn", RETURNED: "đã hoàn về shop", CANCELLED: "vận đơn đã huỷ" };
/** Trang thai DVVC tieu cuc cua Pancake — khong bao gio noi thang khi ERP khong co chung tu. */
const PANCAKE_NEGATIVE = new Set(["canceled", "cancelled", "returning", "returned", "delivery_failed"]);

/** Hoi ERP mot luot cho ca danh sach don (ma VTP + ma don). Loi / khong khoa ⇒ rong (bot noi nhu cu). Loi KHONG duoc dem. */
export async function erpOrderView(orders, { fetchImpl = fetch, now = Date.now, baseUrl = process.env.ERP_INTERNAL_URL || "http://app:3000", token = "", warn = () => {} } = {}) {
  if (!token || !Array.isArray(orders) || !orders.length) return EMPTY_ERP_VIEW;
  const codes = [...new Set(orders.map((o) => String(o?.partner?.order_number_vtp || "").trim().toUpperCase()).filter((c) => /^[A-Z0-9]{8,24}$/.test(c)))].slice(0, ERP_VIEW_MAX);
  const ids = [...new Set(orders.map((o) => String(o?.id ?? "")).filter((x) => /^[0-9]{1,24}$/.test(x)))].slice(0, ERP_VIEW_MAX);
  if (!codes.length && !ids.length) return EMPTY_ERP_VIEW;
  const key = `${codes.join(",")}|${ids.join(",")}`;
  const hit = erpViewCache.get(key);
  if (hit && now() - hit.at < ERP_VIEW_TTL_MS) return hit.value;
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/internal/shipment-state?codes=${encodeURIComponent(codes.join(","))}&orders=${encodeURIComponent(ids.join(","))}`;
    const res = await fetchImpl(url, { headers: { "x-chatbot-token": token }, signal: AbortSignal.timeout(ERP_VIEW_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ERP tra ${res.status}`);
    const body = await res.json();
    const value = {
      byCode: Object.fromEntries((Array.isArray(body?.states) ? body.states : []).map((s) => [String(s.code).toUpperCase(), s])),
      byOrder: Object.fromEntries((Array.isArray(body?.orders) ? body.orders : []).map((s) => [String(s.orderId), s])),
    };
    erpViewCache.set(key, { at: now(), value });
    if (erpViewCache.size > 500) erpViewCache.delete(erpViewCache.keys().next().value);
    return value;
  } catch (e) {
    warn(`Khong doc duoc goc nhin ERP cho ${ids.length} don: ${e instanceof Error ? e.message : e}`);
    return EMPTY_ERP_VIEW;
  }
}

/**
 * Mo ta 1 don POS thanh 1 dong cho bot doc (trang thai, van don, ngay gui, tien thu ho). `erp` = ket qua erpOrderView (mac dinh rong ⇒
 * noi nhu truoc). Don Pancake "Da huy" ma lan gui CHINH theo ERP la lan gui KE con song / da giao ⇒ "da duoc gui lai", ma moi + chang ERP,
 * KHONG in moc gui / lay hang cua van don cu.
 */
export function describeOrder(o, erp = EMPTY_ERP_VIEW) {
  const view = erp?.byOrder?.[String(o.id)];
  const resent = Number(o.status) === 6 && Boolean(view?.reship) && view.stage !== "CANCELLED" && (view.stage === "DELIVERED" || !view.final);
  const st = resent ? "Đơn đã được gửi lại" : ORDER_STATUS_VI[Number(o.status)] || o.status_name || `trạng thái ${o.status}`;
  const items = (o.items || []).map((it) => `${it.quantity || 1} x ${it.variation_info?.display_id || it.variation_info?.name || it.product_name || "sp"}`).join(", ");
  const parts = [`Đơn #${o.id}: ${st}`];
  if (items) parts.push(`gồm ${items}`);
  const p = o.partner;
  if (resent) parts.push(`mã vận đơn mới ${view.code} (Viettel Post, ${ERP_STAGE_VI[view.stage] || "đang xử lý"})`);
  else if (p && (p.order_number_vtp || p.extend_code)) {
    const ma = p.order_number_vtp || p.extend_code;
    const dvvc = p.order_number_vtp ? "Viettel Post" : "đơn vị vận chuyển";
    const evid = p.order_number_vtp ? erp?.byCode?.[String(p.order_number_vtp).trim().toUpperCase()] : null;
    const negative = PANCAKE_NEGATIVE.has(p.partner_status);
    const tt = evid ? ERP_STAGE_VI[evid.stage] || "" : negative ? "" : PARTNER_STATUS_VI[p.partner_status] || "";
    const hint = !evid && negative && p.order_number_vtp ? "trạng thái mới nhất xem trên trang tra cứu Viettel Post" : "";
    parts.push(`mã vận đơn ${ma} (${dvvc}${tt ? ", " + tt : ""}${hint ? ", " + hint : ""})`);
  }
  if (resent) {
    // moc gui / lay hang tren POS la cua van don GOC — khong noi cho kien gui lai
  } else if (p?.picked_up_at) parts.push(`bưu tá đã lấy hàng ngày ${fmtNgay(p.picked_up_at)}`);
  else if (o.time_send_partner) parts.push(`gửi đi ngày ${fmtNgay(o.time_send_partner)}`);
  else if (o.inserted_at) parts.push(`tạo ngày ${fmtNgay(o.inserted_at)}`);
  if (!resent && o.estimate_delivery_date) parts.push(`dự kiến giao ${fmtNgay(o.estimate_delivery_date)}`);
  const thu = Number(o.money_to_collect ?? o.cod ?? 0);
  if (thu > 0) parts.push(`thu hộ ${thu.toLocaleString("vi-VN")}đ`);
  return parts.join(" – ");
}
